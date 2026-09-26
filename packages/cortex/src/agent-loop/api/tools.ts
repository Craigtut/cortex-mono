/**
 * AgentLoop's public surface, tools (registration, permission exemption,
 * the result interceptor, MCP servers, skills). AgentLoop implements this
 * interface; the member docs here are AgentLoop's documentation.
 */

import type { McpClientManager } from '../../mcp-client.js';
import type { SkillRegistry } from '../../skill-registry.js';
import type { CortexTool } from '../../tool-contract.js';
import type { LoadedSkill, McpConnectionState, McpToolCallProgress, McpTransportConfig } from '../../types.js';
import type { ToolResultInterceptor } from '../pi-hooks.js';

export interface LoopToolApi {
  /**
   * Install a hook over finalized tool results. Runs inside pi's
   * afterToolCall for every executed call (errors included); the return
   * value can replace the result content, override the terminate flag, or
   * suppress the working-tags reminder appendix. One interceptor at a time;
   * pass null to remove. An interceptor that throws is logged and ignored,
   * so it can never fail the tool result path (see duplex D17).
   */
  setToolResultInterceptor(interceptor: ToolResultInterceptor | null): void;

  /**
   * Re-sync the agent's tool set (registered plus MCP tools) and the
   * system prompt sections that depend on it. With deferred tools on, only
   * the loaded set is sent to the API; the rest are announced by name in
   * the `_available_tools` slot.
   */
  refreshTools(): void;

  /**
   * Whether a tool call by this name skips the consumer permission gate:
   * true only for a registered tool carrying `permissionExempt` that is not
   * an MCP wrapper (remote servers cannot self-exempt), and for SubAgent.
   */
  isToolPermissionExempt(toolName: string): boolean;

  /**
   * Register a consumer tool at runtime, replacing one with the same name.
   */
  addConsumerTool(tool: CortexTool): void;

  /**
   * Remove a consumer-provided tool by name at runtime.
   * Built-in tools cannot be removed.
   */
  removeConsumerTool(toolName: string): void;

  /**
   * Get the configured environment variable overrides, for consumers
   * building their own subprocess-spawning tools (e.g. BashToolConfig.envOverrides).
   */
  getEnvOverrides(): Record<string, string> | undefined;

  /**
   * Get the McpClientManager for managing MCP server connections.
   */
  getMcpClientManager(): McpClientManager;

  /**
   * Connect to an MCP server and discover its tools.
   * Convenience wrapper around mcpClientManager.connect().
   *
   * @param serverName - Unique name for this server (used for tool namespacing)
   * @param config - Transport configuration (stdio or http)
   */
  connectMcpServer(serverName: string, config: McpTransportConfig): Promise<void>;

  /**
   * Disconnect from an MCP server and remove its tools.
   * Convenience wrapper around mcpClientManager.disconnect().
   *
   * @param serverName - The server name to disconnect
   */
  disconnectMcpServer(serverName: string): Promise<void>;

  /**
   * Snapshot of every MCP server this agent is connected to (or
   * reconnecting to), with redacted configs. Read-only: use
   * {@link connectMcpServer} / {@link disconnectMcpServer} to mutate.
   */
  getMcpServerStates(): McpConnectionState[];

  /**
   * Whether the live config for a connected MCP server structurally matches
   * `config`, compared including secret `env`/`headers` without exposing
   * them. Use it to decide whether a changed config needs a reconnect, since
   * {@link getMcpServerStates} returns redacted configs. False when no server
   * is connected under `serverName`.
   */
  mcpConfigMatches(serverName: string, config: McpTransportConfig): boolean;

  /**
   * Register a callback fired when MCP tool servers emit
   * `notifications/progress` during a long-running `tools/call`. Replace
   * semantics per loop: setting a handler displaces this loop's
   * previous one (undefined clears it), while other holders of a shared
   * manager keep their own registrations.
   */
  setMcpToolCallProgressHandler(
    handler: ((progress: McpToolCallProgress) => void) | undefined,
  ): void;

  /**
   * Get the MCP-wrapped tools from connected servers. Built-in and
   * consumer tools are not included.
   */
  getMcpTools(): CortexTool[];

  /** Get the SkillRegistry for add/remove/query operations. */
  getSkillRegistry(): SkillRegistry;

  /**
   * Pre-load a skill into the ephemeral context for the current loop.
   * Same path as the load_skill tool, but triggered by the consumer.
   * No LLM turn is consumed.
   */
  loadSkill(name: string, args?: string): Promise<void>;

  /**
   * Clear the skill buffer. Cortex clears it at the end of each logical
   * turn; call this at your own work-unit boundaries, before pre-loading
   * skills for the next one (clearing at prompt() start would wipe them).
   */
  clearSkillBuffer(): void;

  /** Get the current skill buffer contents. */
  getSkillBuffer(): LoadedSkill[];

  /**
   * Set consumer-provided variables for ${VAR} substitution in skills.
   * Merged with Cortex built-ins (SKILL_DIR, ARGUMENTS).
   * Consumer variables take precedence on collision.
   */
  setPreprocessorVariables(variables: Record<string, string>): void;

  /**
   * Set consumer-provided context that will be passed to skill scripts.
   * Merged with Cortex built-in fields (skillDir, args, scriptArgs).
   * Consumer fields take precedence on collision.
   */
  setScriptContext(context: Record<string, unknown>): void;
}
