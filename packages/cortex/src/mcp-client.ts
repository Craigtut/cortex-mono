/**
 * McpClientManager: connects to MCP servers and wraps discovered tools
 * as AgentTool objects for registration with pi-agent-core.
 *
 * Handles two transport types:
 * - Stdio: spawns a subprocess, communicates via stdin/stdout
 * - HTTP: connects to an already-running Streamable HTTP server
 *
 * Tool discovery via tools/list, tool execution via tools/call.
 * Connections are persistent (kept alive between ticks) with health monitoring.
 * Reconnect on subprocess crash (3 attempts before deregistering).
 *
 * References:
 *   - docs/cortex/mcp-integration.md
 *   - docs/cortex/plans/phase-3-plugin-tools.md
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Type } from 'typebox';
import type {
  McpTransportConfig,
  McpConnectionState,
  McpRedactedTransportConfig,
  McpStdioConfig,
  McpHttpConfig,
  McpToolCallProgress,
  CortexLogger,
} from './types.js';
import type { CortexTool } from './tool-contract.js';
import type { SandboxProvider } from './sandbox/types.js';
import { NOOP_LOGGER } from './noop-logger.js';
import { buildSafeEnv } from './tools/shared/safe-env.js';

// ---------------------------------------------------------------------------
// Tool contract
// ---------------------------------------------------------------------------

/**
 * Backward-compatible export name for Cortex's canonical tool contract.
 */
export type AgentTool = CortexTool;

// ---------------------------------------------------------------------------
// Internal connection record
// ---------------------------------------------------------------------------

interface McpConnection {
  serverName: string;
  config: McpTransportConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: AgentTool[];
  connected: boolean;
  reconnectAttempts: number;
  /** Subprocess PID for stdio transports (used for process cleanup). */
  pid: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RECONNECT_ATTEMPTS = 3;

/**
 * Providers constrain tool names to `^[a-zA-Z0-9_-]{1,128}$` (Anthropic
 * enforces this strictly and rejects the whole request with a 400 before the
 * model runs). MCP servers, however, may name their tools with any characters
 * (dots, colons, slashes, spaces), and server names come from user config, so
 * the namespaced `serverName__toolName` can easily fall outside that pattern.
 * Replace every disallowed character with `_` and cap the length at 128. The
 * original MCP tool name is preserved separately for `tools/call`, so this only
 * rewrites the provider-facing identifier, not what we send back to the server.
 */
const TOOL_NAME_MAX_LENGTH = 128;
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, TOOL_NAME_MAX_LENGTH);
}

/**
 * Append a deterministic numeric suffix (`_2`, `_3`, ...) to a tool name while
 * keeping it within the provider's {@link TOOL_NAME_MAX_LENGTH} cap. The base
 * name is truncated as needed so the suffix always fits.
 */
function appendToolNameSuffix(name: string, ordinal: number): string {
  const suffix = `_${ordinal}`;
  const maxBase = TOOL_NAME_MAX_LENGTH - suffix.length;
  const base = name.length > maxBase ? name.slice(0, maxBase) : name;
  return `${base}${suffix}`;
}

/**
 * Redact secret-bearing fields from a transport config before it leaves the
 * manager. Stdio `env` and HTTP `headers` carry credentials (API keys, auth
 * tokens); they are dropped entirely and replaced with a boolean presence flag
 * so callers can still tell whether the server was configured with them.
 */
function redactTransportConfig(config: McpTransportConfig): McpRedactedTransportConfig {
  if (config.transport === 'stdio') {
    const { env, ...rest } = config;
    return { ...rest, hasEnv: env !== undefined && Object.keys(env).length > 0 };
  }
  const { headers, ...rest } = config;
  return { ...rest, hasHeaders: headers !== undefined && Object.keys(headers).length > 0 };
}

/**
 * Deep structural equality for two full MCP transport configs, INCLUDING the
 * secret-bearing fields (`env`, `headers`). Used only inside the manager by
 * {@link McpClientManager.configMatches}, so secrets take part in the
 * comparison but never leave the manager.
 */
function transportConfigsEqual(a: McpTransportConfig, b: McpTransportConfig): boolean {
  if (a.transport !== b.transport) return false;
  if (a.transport === 'stdio' && b.transport === 'stdio') {
    if (a.command !== b.command) return false;
    if (a.cwd !== b.cwd) return false;
    if (a.toolTimeoutMs !== b.toolTimeoutMs) return false;
    if (!stringArrayEqual(a.args ?? [], b.args ?? [])) return false;
    return stringRecordEqual(a.env ?? {}, b.env ?? {});
  }
  if (a.transport === 'http' && b.transport === 'http') {
    if (a.url !== b.url) return false;
    if (a.toolTimeoutMs !== b.toolTimeoutMs) return false;
    return stringRecordEqual(a.headers ?? {}, b.headers ?? {});
  }
  return false;
}

function stringArrayEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function stringRecordEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// McpClientManager
// ---------------------------------------------------------------------------

export class McpClientManager {
  private connections = new Map<string, McpConnection>();

  /**
   * Callback invoked whenever the aggregate tool set changes.
   * CortexAgent uses this to resync live tools after connect/disconnect/reconnect.
   */
  onToolsChanged?: () => void;

  /**
   * Callback invoked when a subprocess is spawned (for PID tracking).
   * The consumer (CortexAgent) uses this to track PIDs for exit cleanup.
   */
  onSubprocessSpawned?: (pid: number) => void;

  /**
   * Callback invoked when a subprocess exits (for PID tracking).
   */
  onSubprocessExited?: (pid: number) => void;

  /**
   * Consumer-set environment variable overrides that bypass the security blocklist.
   * Merged ON TOP of the sanitized environment for all stdio subprocesses.
   * Used for macOS dock icon suppression vars (DYLD_INSERT_LIBRARIES, etc.).
   */
  envOverrides?: Record<string, string>;

  /**
   * Optional OS-level sandbox. When present and it implements wrapExec, each
   * stdio MCP server subprocess is wrapped so it runs inside the same OS
   * boundary as shell commands, enforcing denyRead over secrets. Without it a
   * stdio server spawns uncontained and bypasses the sandbox. Set by CortexAgent
   * from its config. HTTP transports are unaffected (no subprocess to contain).
   */
  sandbox?: SandboxProvider;

  /**
   * Optional callback fired when an MCP server emits a
   * `notifications/progress` during a long-running `tools/call`. The MCP
   * SDK's `resetTimeoutOnProgress` is enabled whenever a per-tool timeout is
   * configured, so a server that keeps emitting progress can stay alive past
   * the wall-clock window. Consumers wire this to whatever UI affordance
   * they have ("still waiting…" banners, log lines).
   *
   * Failures inside the callback are swallowed so a buggy consumer cannot
   * tear down an in-flight tool call.
   */
  onToolCallProgress?: (progress: McpToolCallProgress) => void;

  /** Logger for MCP diagnostics. Set by CortexAgent after construction. */
  logger: CortexLogger = NOOP_LOGGER;

  /**
   * Connect to an MCP server and discover its tools.
   *
   * Spawns a subprocess (stdio) or connects to a URL (http), performs
   * the MCP handshake, calls tools/list, and wraps each discovered
   * tool as an AgentTool with namespaced name.
   *
   * @param serverName - Unique name for this server (used for tool namespacing)
   * @param config - Transport configuration
   * @throws Error if connection or tool discovery fails
   */
  async connect(serverName: string, config: McpTransportConfig): Promise<void> {
    // Disconnect existing connection with this name first
    if (this.connections.has(serverName)) {
      await this.disconnect(serverName);
    }

    this.logger.info('[MCP] connecting', { serverName, transport: config.transport });

    const transport = await this.createTransport(config);
    const client = new Client(
      { name: `cortex-${serverName}`, version: '1.0.0' },
      { capabilities: {} },
    );

    try {
      await client.connect(transport as Transport);
    } catch (err) {
      this.logger.error('[MCP] connection failed', { serverName, error: err instanceof Error ? err.message : String(err) });
      throw new Error(`MCP connection failed for "${serverName}": ${err instanceof Error ? err.message : String(err)}`);
    }

    // Track subprocess PID for stdio transports
    let pid: number | null = null;
    if (transport instanceof StdioClientTransport) {
      pid = transport.pid;
      if (pid != null) {
        this.onSubprocessSpawned?.(pid);
      }
    }

    // Discover tools
    let tools: AgentTool[];
    try {
      tools = await this.discoverTools(serverName, config, client);
    } catch (err) {
      this.logger.error('[MCP] tool discovery failed', { serverName, error: err instanceof Error ? err.message : String(err) });
      // Close the connection since tool discovery failed
      try {
        await client.close();
      } catch {
        // Best-effort cleanup
      }
      if (pid != null) {
        this.onSubprocessExited?.(pid);
      }
      throw new Error(`MCP tool discovery failed for "${serverName}": ${err instanceof Error ? err.message : String(err)}`);
    }

    const connection: McpConnection = {
      serverName,
      config,
      client,
      transport,
      tools,
      connected: true,
      reconnectAttempts: 0,
      pid,
    };

    // Wire close handler for reconnect on unexpected disconnect
    transport.onclose = () => {
      this.handleDisconnect(serverName);
    };

    this.connections.set(serverName, connection);
    this.logger.info('[MCP] connected', { serverName, toolCount: tools.length, tools: tools.map(t => t.name) });
    this.onToolsChanged?.();
  }

  /**
   * Disconnect from a specific MCP server.
   * Closes the transport and removes all tools from that server.
   *
   * @param serverName - The server name to disconnect
   */
  async disconnect(serverName: string): Promise<void> {
    const conn = this.connections.get(serverName);
    if (!conn) return;

    this.logger.info('[MCP] disconnecting', { serverName });
    conn.connected = false;

    try {
      await conn.client.close();
    } catch (err) {
      this.logger.warn('[MCP] error closing client', { serverName, error: err instanceof Error ? err.message : String(err) });
    }

    if (conn.pid != null) {
      this.onSubprocessExited?.(conn.pid);
    }

    this.connections.delete(serverName);
    this.onToolsChanged?.();
  }

  /**
   * Close all MCP connections.
   * Kills all stdio subprocesses and closes HTTP connections.
   */
  async closeAll(): Promise<void> {
    const names = [...this.connections.keys()];
    const results = await Promise.allSettled(
      names.map(name => this.disconnect(name)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === 'rejected') {
        this.logger.warn('[MCP] failed to disconnect', { serverName: names[i], error: String((result as PromiseRejectedResult).reason) });
      }
    }
  }

  /**
   * Get all AgentTool objects from all connected MCP servers.
   * Returns tools namespaced as serverName__toolName.
   */
  getTools(): AgentTool[] {
    const allTools: AgentTool[] = [];
    // Tool names are made unique at discovery time (see discoverTools), so the
    // aggregate set should already be collision-free. Guard defensively here
    // anyway: a duplicate name in the provider-facing list can make the
    // provider reject the whole request (Anthropic 400s) or silently shadow a
    // tool. Skip any residual duplicate rather than emit an invalid tool list.
    const seen = new Set<string>();
    for (const conn of this.connections.values()) {
      if (!conn.connected) continue;
      for (const tool of conn.tools) {
        if (seen.has(tool.name)) {
          this.logger.debug('[MCP] dropping duplicate tool name from aggregate set', {
            serverName: conn.serverName,
            toolName: tool.name,
          });
          continue;
        }
        seen.add(tool.name);
        allTools.push(tool);
      }
    }
    return allTools;
  }

  /**
   * Get tool names from a specific server.
   */
  getServerToolNames(serverName: string): string[] {
    const conn = this.connections.get(serverName);
    if (!conn || !conn.connected) return [];
    return conn.tools.map(t => t.name);
  }

  /**
   * Get the connection state for all servers.
   */
  getConnectionStates(): McpConnectionState[] {
    const states: McpConnectionState[] = [];
    for (const conn of this.connections.values()) {
      states.push({
        serverName: conn.serverName,
        // Redact secrets: env (stdio) and headers (http) never leave the manager.
        config: redactTransportConfig(conn.config),
        connected: conn.connected,
        reconnectAttempts: conn.reconnectAttempts,
        toolNames: conn.tools.map(t => t.name),
      });
    }
    return states;
  }

  /**
   * Whether the live config for `serverName` structurally matches `desired`.
   *
   * Compares every field of the stored connection config, INCLUDING the
   * secret-bearing `env` (stdio) and `headers` (http). The secrets take part in
   * the comparison but never leave the manager: only a boolean is returned.
   * Consumers (e.g. cortex-code's MCP reconciler and `/mcp-reload`) call this to
   * decide whether a server must be reconnected after its on-disk config
   * changed, without ever reading the stored secrets back out via
   * {@link getConnectionStates} (which is redacted).
   *
   * Returns false when no server is registered under `serverName`; there is
   * nothing to match, so the caller should treat it as a change.
   */
  configMatches(serverName: string, desired: McpTransportConfig): boolean {
    const conn = this.connections.get(serverName);
    if (!conn) return false;
    return transportConfigsEqual(conn.config, desired);
  }

  /**
   * Check if a specific server is connected.
   */
  isConnected(serverName: string): boolean {
    const conn = this.connections.get(serverName);
    return conn?.connected ?? false;
  }

  /**
   * Get the number of active connections.
   */
  get connectionCount(): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.connected) count++;
    }
    return count;
  }

  // -----------------------------------------------------------------------
  // Private: Transport creation
  // -----------------------------------------------------------------------

  private async createTransport(config: McpTransportConfig): Promise<StdioClientTransport | StreamableHTTPClientTransport> {
    if (config.transport === 'stdio') {
      return this.createStdioTransport(config);
    }
    return this.createHttpTransport(config);
  }

  private async createStdioTransport(config: McpStdioConfig): Promise<StdioClientTransport> {
    // Sanitize environment variables for the subprocess.
    // Strip dangerous vars (LD_PRELOAD, NODE_OPTIONS, etc.) to prevent
    // injection via environment. Uses the same blocklist as the Bash tool.
    // envOverrides are merged ON TOP, bypassing the blocklist for
    // consumer-specified variables (e.g., macOS dock icon suppression).
    const baseEnv = config.env ?? process.env;
    const safeEnv = buildSafeEnv(baseEnv, undefined, this.envOverrides);

    let command = config.command;
    let args = config.args ?? [];
    let env = safeEnv;

    // Contain the MCP server subprocess in the same OS sandbox as shell commands
    // when a wrapExec-capable provider is configured. Without this the server
    // spawns uncontained and bypasses the sandbox's denyRead over secrets.
    // Pass-through when the provider is not enforcing (wrapExec returns the spec
    // unchanged), so behavior is identical with no provider or on Windows.
    if (this.sandbox?.wrapExec) {
      const cwd = config.cwd ?? process.cwd();
      const wrapped = await this.sandbox.wrapExec({ file: command, args, cwd, env });
      command = wrapped.file;
      args = wrapped.args;
      env = wrapped.env;
    }

    // Build params object, only including defined optional fields to satisfy
    // exactOptionalPropertyTypes
    const params: {
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
      stderr: 'pipe';
    } = {
      command,
      args,
      env,
      stderr: 'pipe',
    };
    if (config.cwd !== undefined) params.cwd = config.cwd;

    return new StdioClientTransport(params);
  }

  private createHttpTransport(config: McpHttpConfig): StreamableHTTPClientTransport {
    const url = new URL(config.url);

    if (config.headers && Object.keys(config.headers).length > 0) {
      return new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: config.headers,
        },
      });
    }

    return new StreamableHTTPClientTransport(url);
  }

  // -----------------------------------------------------------------------
  // Private: Tool discovery and wrapping
  // -----------------------------------------------------------------------

  /**
   * Discover tools from a connected MCP server and wrap them as AgentTools.
   */
  private async discoverTools(
    serverName: string,
    config: McpTransportConfig,
    client: Client,
  ): Promise<AgentTool[]> {
    const response = await client.listTools();
    const tools: AgentTool[] = [];

    // Seed the used-name set with names already claimed by OTHER connected
    // servers so a new server cannot shadow an existing tool. The connecting
    // server itself is excluded (on reconnect its old tools are still in the
    // map and would otherwise collide with themselves).
    const usedNames = this.collectUsedToolNames(serverName);

    for (const mcpTool of response.tools) {
      const tool = this.wrapMcpTool(
        serverName,
        config,
        {
          name: mcpTool.name,
          description: mcpTool.description,
          inputSchema: mcpTool.inputSchema as Record<string, unknown> | undefined,
        },
        client,
      );

      // Sanitization and the 128-char cap can collapse distinct MCP tool names
      // to the same provider-facing name (within this server or against another
      // server). Assign a unique name so both tools remain callable.
      const uniqueName = this.dedupeToolName(usedNames, tool.name, serverName, mcpTool.name);
      tools.push(uniqueName === tool.name ? tool : { ...tool, name: uniqueName });
    }

    return tools;
  }

  /**
   * Collect the provider-facing names of every tool on all connected servers
   * except `excludeServer`. Used to seed collision detection at discovery time.
   */
  private collectUsedToolNames(excludeServer: string): Set<string> {
    const used = new Set<string>();
    for (const [name, conn] of this.connections) {
      if (name === excludeServer) continue;
      for (const tool of conn.tools) {
        used.add(tool.name);
      }
    }
    return used;
  }

  /**
   * Return a unique provider-facing tool name, appending a deterministic
   * numeric suffix on collision and recording the result in `used`. Logs a
   * warning (once, at discovery) whenever a rename is required.
   */
  private dedupeToolName(
    used: Set<string>,
    name: string,
    serverName: string,
    mcpToolName: string,
  ): string {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }

    let ordinal = 2;
    let candidate = appendToolNameSuffix(name, ordinal);
    while (used.has(candidate)) {
      ordinal++;
      candidate = appendToolNameSuffix(name, ordinal);
    }
    used.add(candidate);

    this.logger.warn('[MCP] tool name collision after sanitization; renamed to avoid shadowing', {
      serverName,
      mcpTool: mcpToolName,
      collidingName: name,
      assignedName: candidate,
    });
    return candidate;
  }

  /**
   * Wrap a single MCP tool definition as an AgentTool.
   *
   * Key details:
   * - Name is prefixed with serverName__ for namespacing
   * - JSON Schema from MCP is wrapped via Type.Unsafe() for TypeBox
   * - execute() calls tools/call on the MCP connection using the original name
   * - Errors are caught and returned as error results (not thrown)
   */
  private wrapMcpTool(
    serverName: string,
    serverConfig: McpTransportConfig,
    mcpTool: { name: string; description?: string | undefined; inputSchema?: Record<string, unknown> | undefined },
    client: Client,
  ): AgentTool {
    const namespacedName = sanitizeToolName(`${serverName}__${mcpTool.name}`);

      // Wrap the MCP JSON Schema as a TypeBox type via Type.Unsafe()
    const inputSchema = mcpTool.inputSchema ?? { type: 'object', properties: {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parameters = Type.Unsafe(inputSchema as any);

    // Capture the per-server timeout (if any). `resetTimeoutOnProgress` is
    // enabled whenever a timeout is configured so a server that emits regular
    // progress can outlive its wall-clock window. The execute closure below is
    // an arrow function, so reads of `this.onToolCallProgress` stay in sync
    // with whatever the consumer wires up after this wrapper is created.
    const toolTimeoutMs = serverConfig.toolTimeoutMs;

    return {
      name: namespacedName,
      description: mcpTool.description ?? '',
      parameters,
      // Marks this tool as MCP-sourced so CortexAgent's deferred-tool
      // partitioning can identify it without rechecking by name prefix.
      isMcp: true,
      execute: async (args: unknown): Promise<unknown> => {
        try {
          const hasTimeout = typeof toolTimeoutMs === 'number' && toolTimeoutMs > 0;
          const hasProgressCallback = this.onToolCallProgress !== undefined;
          let result;
          if (hasTimeout || hasProgressCallback) {
            const callOptions: Parameters<typeof client.callTool>[2] = {};
            if (hasTimeout) {
              callOptions.timeout = toolTimeoutMs;
              callOptions.resetTimeoutOnProgress = true;
            }
            if (hasProgressCallback) {
              callOptions.onprogress = (progress) => {
                const payload: McpToolCallProgress = {
                  serverName,
                  toolName: mcpTool.name,
                  progress: progress.progress,
                };
                if (progress.total !== undefined) payload.total = progress.total;
                if (progress.message !== undefined) payload.message = progress.message;
                try {
                  this.onToolCallProgress?.(payload);
                } catch (err) {
                  this.logger.warn?.(
                    `onToolCallProgress threw for ${namespacedName}`,
                    { error: err instanceof Error ? err.message : String(err) },
                  );
                }
              };
            }
            result = await client.callTool(
              {
                name: mcpTool.name,  // Original name (no prefix)
                arguments: (args ?? {}) as Record<string, unknown>,
              },
              undefined,
              callOptions,
            );
          } else {
            result = await client.callTool({
              name: mcpTool.name,  // Original name (no prefix)
              arguments: (args ?? {}) as Record<string, unknown>,
            });
          }

          // Return text content from MCP result
          if (result.isError) {
            const errorText = Array.isArray(result.content)
              ? result.content
                  .filter((c): c is { type: 'text'; text: string } =>
                    typeof c === 'object' && c !== null && 'type' in c && c.type === 'text')
                  .map(c => c.text)
                  .join('\n')
              : String(result.content);
            throw new Error(errorText || 'MCP tool call failed');
          }

          const normalizedContent: Array<
            | { type: 'text'; text: string }
            | { type: 'image'; data: string; mimeType: string }
          > = [];

          if (Array.isArray(result.content)) {
            for (const item of result.content) {
              if (!item || typeof item !== 'object') {
                normalizedContent.push({ type: 'text', text: String(item) });
                continue;
              }

              const block = item as Record<string, unknown>;
              const type = block['type'];

              if (type === 'text' && typeof block['text'] === 'string') {
                normalizedContent.push({ type: 'text', text: block['text'] });
                continue;
              }

              if (type === 'image' &&
                  typeof block['data'] === 'string' &&
                  typeof block['mimeType'] === 'string') {
                normalizedContent.push({
                  type: 'image',
                  data: block['data'],
                  mimeType: block['mimeType'],
                });
                continue;
              }

              normalizedContent.push({
                type: 'text',
                text: JSON.stringify(block, null, 2),
              });
            }
          }

          if (normalizedContent.length === 0) {
            const structuredContent = (result as Record<string, unknown>)['structuredContent'];
            if (structuredContent !== undefined) {
              normalizedContent.push({
                type: 'text',
                text: JSON.stringify(structuredContent, null, 2),
              });
            } else {
              normalizedContent.push({
                type: 'text',
                text: String(result.content ?? ''),
              });
            }
          }

          return {
            content: normalizedContent,
            details: {
              structuredContent: (result as Record<string, unknown>)['structuredContent'] ?? null,
              rawContent: result.content ?? null,
            },
          };
        } catch (err) {
          // Re-throw as a standard error for pi-agent-core to handle
          if (err instanceof Error) throw err;
          throw new Error(`MCP tool call "${mcpTool.name}" failed: ${String(err)}`);
        }
      },
    };
  }

  // -----------------------------------------------------------------------
  // Private: Reconnect handling
  // -----------------------------------------------------------------------

  /**
   * Handle unexpected disconnection from an MCP server.
   * Attempts reconnection up to MAX_RECONNECT_ATTEMPTS times.
   */
  private handleDisconnect(serverName: string): void {
    const conn = this.connections.get(serverName);
    if (!conn) return;

    // Already disconnected intentionally
    if (!conn.connected) return;

    conn.connected = false;
    conn.reconnectAttempts++;

    if (conn.pid != null) {
      this.onSubprocessExited?.(conn.pid);
      conn.pid = null;
    }

    this.logger.warn('[MCP] unexpected disconnect', { serverName, attempt: conn.reconnectAttempts, maxAttempts: MAX_RECONNECT_ATTEMPTS });

    if (conn.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.logger.error('[MCP] reconnect exhausted, deregistering', { serverName, maxAttempts: MAX_RECONNECT_ATTEMPTS });
      this.connections.delete(serverName);
      this.onToolsChanged?.();
      return;
    }

    // Attempt reconnect asynchronously
    this.attemptReconnect(serverName, conn.config).catch((err) => {
      this.logger.error('[MCP] reconnect attempt failed', { serverName, error: err instanceof Error ? err.message : String(err) });
    });
  }

  /**
   * Attempt to reconnect to an MCP server.
   */
  private async attemptReconnect(serverName: string, config: McpTransportConfig): Promise<void> {
    // Brief delay before reconnect
    await new Promise(resolve => setTimeout(resolve, 1000));

    const existing = this.connections.get(serverName);
    if (!existing) return; // Was deregistered during delay

    let client: Client | null = null;
    let pid: number | null = null;

    try {
      // Attempt fresh connection
      const transport = await this.createTransport(config);
      client = new Client(
        { name: `cortex-${serverName}`, version: '1.0.0' },
        { capabilities: {} },
      );

      await client.connect(transport as Transport);

      // Track subprocess PID
      if (transport instanceof StdioClientTransport) {
        pid = transport.pid;
        if (pid != null) {
          this.onSubprocessSpawned?.(pid);
        }
      }

      // Rediscover tools using the config passed to attemptReconnect so the
      // toolTimeoutMs and other per-server settings carry across reconnects.
      const tools = await this.discoverTools(serverName, config, client);

      // Wire close handler
      transport.onclose = () => {
        this.handleDisconnect(serverName);
      };

      // Update connection record
      existing.client = client;
      existing.transport = transport;
      existing.tools = tools;
      existing.connected = true;
      existing.pid = pid;
      // Keep reconnectAttempts as-is (reset only on fresh connect)

      this.logger.info('[MCP] reconnected', { serverName, toolCount: tools.length });
      this.onToolsChanged?.();
    } catch (err) {
      // Clean up resources from partial connection
      if (client) {
        try { await client.close(); } catch { /* best-effort */ }
      }
      if (pid != null) {
        this.onSubprocessExited?.(pid);
      }

      this.logger.warn('[MCP] reconnect failed', { serverName, error: err instanceof Error ? err.message : String(err) });
      existing.reconnectAttempts++;
      if (existing.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        this.logger.error('[MCP] max reconnect attempts exceeded, deregistering', { serverName });
        this.connections.delete(serverName);
        this.onToolsChanged?.();
      } else {
        // Schedule another attempt since transport.onclose may not fire
        this.attemptReconnect(serverName, config).catch((retryErr) => {
          this.logger.error('[MCP] subsequent reconnect failed', { serverName, error: retryErr instanceof Error ? retryErr.message : String(retryErr) });
        });
      }
    }
  }
}
