/**
 * A mode is a static configuration bundle that determines how the agent behaves.
 * Switching modes reconfigures the agent; it does not require a separate agent instance.
 */
export interface Mode {
  /** Display name for the mode (shown in footer badge). */
  name: string;

  /** Base system prompt: identity, domain instructions, behavioral rules. */
  systemPrompt: string;

  /** Which built-in tool names are enabled. */
  tools: string[];

  /** Named context slots to create on the agent. */
  contextSlots: string[];

  /** Paths to scan for SKILL.md files. */
  skillDiscoveryPaths: string[];

  /** Paths to scan for mcp.json config files. */
  mcpConfigPaths: string[];
}
