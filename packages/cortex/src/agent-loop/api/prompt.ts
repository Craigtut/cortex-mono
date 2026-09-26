/**
 * AgentLoop's public surface, the system prompt (the consumer base prompt
 * plus Cortex operational sections). AgentLoop implements this interface;
 * the member docs here are AgentLoop's documentation.
 */


export interface LoopPromptApi {
  /**
   * Compose a system prompt from the application/base prompt plus
   * Cortex operational sections.
   *
   * Base prompt content comes FIRST (identity, persona, domain instructions).
   * Cortex appends operational rules AFTER (system rules, tool guidance,
   * safety, environment info).
   *
   * @param basePrompt - The application/base prompt content
   * @returns The assembled system prompt
   */
  composeSystemPrompt(basePrompt: string): string;

  /**
   * Set the application/base prompt and update the live agent state.
   *
   * Preserves conversation history. Non-destructive.
   */
  setBasePrompt(basePrompt: string): string;

  /**
   * Get the current application/base prompt.
   */
  getBasePrompt(): string;

  /**
   * Get the current assembled system prompt.
   */
  getCurrentSystemPrompt(): string;

  /**
   * Get the Cortex operational system prompt sections as structured data.
   * Useful for context snapshot / inspector tooling.
   */
  getSystemPromptSections(): Array<{ name: string; content: string }>;

  readonly isWorkingTagsEnabled: boolean;

  setWorkingTagsEnabled(enabled: boolean): void;
}
