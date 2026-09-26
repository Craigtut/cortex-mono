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
   * pass null to remove. General-purpose by design; the duplex facade uses
   * it for the control-tool terminate guards (empty-spoken-text suppression
   * and bare receipts, docs/cortex/duplex/decisions.md D17). An interceptor
   * that throws is logged and ignored so it can never fail the tool result
   * path, which for control tools would reopen the very loop D17 closes.
   */
  setToolResultInterceptor(interceptor: ToolResultInterceptor | null): void;

  /**
   * Update the agent's tool set by adapting Cortex's canonical in-process
   * tool contract to pi-agent-core's raw execute signature.
   *
   * When deferred tools are enabled, this also partitions the union of
   * registered + MCP tools into a "loaded" set (sent to the API) and a
   * "deferred" set (announced by name in the `_available_tools` slot).
   */
  refreshTools(): void;

  /**
   * Whether a tool call by this name skips the consumer permission gate.
   *
   * True only when the REGISTERED tool carries `permissionExempt` and is not
   * an MCP wrapper (a remote server must not self-exempt by declaring the
   * field), plus the legacy SubAgent name check. Exemption is a property of
   * the tool object this loop registered, never of the call: an unknown
   * name, or the same name arriving via MCP, still goes to the resolver.
   */
  isToolPermissionExempt(toolName: string): boolean;

  /**
   * Register an additional consumer-provided tool at runtime.
   * Useful for dynamic tool management (e.g., enabling a tool after agent
   * creation based on user permission changes).
   */
  addConsumerTool(tool: CortexTool): void;

  /**
   * Remove a consumer-provided tool by name at runtime.
   * Built-in tools cannot be removed.
   */
  removeConsumerTool(toolName: string): void;

  /**
   * Get the configured environment variable overrides.
   * Consumers use this when creating built-in tools (e.g., BashToolConfig.envOverrides)
   * to ensure all subprocess environments include these overrides.
   */
  getEnvOverrides(): Record<string, string> | undefined;

  /**
   * Get the McpClientManager for managing MCP server connections.
   * Consumers use this to connect/disconnect plugin tool servers
   * and to retrieve discovered tools.
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
   * Snapshot of every MCP server this agent is currently connected to (or
   * attempting to reconnect to). The shape is deliberately read-only: use
   * {@link connectMcpServer} / {@link disconnectMcpServer} to mutate. The
   * consumer (`cortex-code`'s hot-reload watcher) uses this to compute the
   * diff between desired (config files) and current state between turns.
   */
  getMcpServerStates(): McpConnectionState[];

  /**
   * Whether the live config for a connected MCP server structurally matches
   * `config`. Delegates to the MCP client manager, which compares the full
   * stored config (including secret `env`/`headers`) without exposing it. The
   * hot-reload watcher and `/mcp-reload` use this to decide whether a server
   * needs reconnecting after its on-disk config changed, since
   * {@link getMcpServerStates} deliberately returns redacted configs. Returns
   * false when no server is connected under `serverName`.
   */
  mcpConfigMatches(serverName: string, config: McpTransportConfig): boolean;

  /**
   * Register a callback fired when MCP tool servers emit
   * `notifications/progress` during a long-running `tools/call`. Consumers
   * wire this to whatever UI affordance they have for "still waiting…".
   * Replace semantics per loop: setting a handler displaces this loop's
   * previous one (undefined clears it), while other holders of a shared
   * manager keep their own registrations.
   */
  setMcpToolCallProgressHandler(
    handler: ((progress: McpToolCallProgress) => void) | undefined,
  ): void;

  /**
   * Get all tools from all sources: built-in tools registered on the
   * pi-agent-core Agent, plus MCP-wrapped tools from connected servers.
   *
   * Returns only the MCP-wrapped tools. Built-in tools are registered
   * directly on the Agent and are not included here.
   */
  getMcpTools(): CortexTool[];

  /**
   * Get the SkillRegistry for add/remove/query operations.
   */
  getSkillRegistry(): SkillRegistry;

  /**
   * Pre-load a skill into the ephemeral context for the current loop.
   * Same path as the load_skill tool, but triggered by the consumer.
   * No LLM turn is consumed.
   */
  loadSkill(name: string, args?: string): Promise<void>;

  /**
   * Clear the skill buffer. The consumer should call this at the start
   * of each tick (before pre-loading skills for the new loop).
   * Cortex cannot auto-clear because it has no concept of tick boundaries,
   * and clearing at prompt() start would wipe consumer pre-loaded skills.
   */
  clearSkillBuffer(): void;

  /**
   * Get the current skill buffer contents.
   */
  getSkillBuffer(): LoadedSkill[];

  /**
   * Set consumer-provided variables for ${VAR} substitution in skills.
   * Merged with Cortex built-ins (SKILL_DIR, ARGUMENTS).
   * Consumer variables take precedence on collision.
   * Call this each tick during GATHER to update runtime values.
   */
  setPreprocessorVariables(variables: Record<string, string>): void;

  /**
   * Set consumer-provided context that will be passed to skill scripts.
   * Merged with Cortex built-in fields (skillDir, args, scriptArgs).
   * Consumer fields take precedence on collision.
   * Call this each tick during GATHER to update runtime values.
   */
  setScriptContext(context: Record<string, unknown>): void;
}
