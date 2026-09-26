/**
 * AgentLoop's public surface, direct (non-agentic) completions and usage
 * accounting. AgentLoop implements this interface; the member docs here
 * are AgentLoop's documentation.
 */

import type { DirectCompletionContext } from '../../cache-breakpoints.js';
import type { CortexUsage, SessionUsage } from '../../types.js';
import type { DirectCompletionOptions } from '../direct-completion.js';

export interface LoopCompletionApi {
  /**
   * Make a direct LLM completion call using the primary model.
   * NOT an agentic tool-use loop. Used for structured output phases
   * like THOUGHT and REFLECT where a single LLM response is needed
   * without tool execution.
   *
   * Accepts either a raw context ({ systemPrompt, messages }) passed to
   * pi-ai verbatim, or a structured context ({ systemPrompt, slots?,
   * history?, ephemeral?, prompt }) that Cortex assembles with the same
   * cache breakpoint strategy the agentic loop uses. See
   * StructuredCompletionContext for the caching contract.
   *
   * Dynamically imports pi-ai's complete() function. If pi-ai is not
   * installed, throws a clear error.
   *
   * @param context - Raw or structured completion context
   * @returns The response text from the LLM
   * @throws Error if pi-ai is not installed or the call fails
   */
  directComplete(context: DirectCompletionContext, options?: DirectCompletionOptions): Promise<string>;

  /**
   * Make a structured output LLM call using the tool-call-as-structured-output pattern.
   *
   * Defines a tool whose input_schema matches the desired output structure,
   * passes it via pi-ai's complete() with tools, and extracts the tool call
   * arguments as the structured result. This works across all providers that
   * support tool use (Anthropic, OpenAI, Google, Mistral, etc.) without
   * needing provider-specific structured output parameters.
   *
   * Accepts the same raw or structured contexts as directComplete(). Note
   * for cached structured contexts: tool definitions precede the system
   * prompt in Anthropic's cacheable prefix, so keep the schema byte-stable
   * across calls or the whole prefix misses.
   *
   * @param context - Raw or structured completion context
   * @param schema - Tool schema defining the structured output shape (TypeBox or JSON Schema)
   * @param toolName - Name for the virtual tool (default: 'structured_output')
   * @param toolDescription - Description for the virtual tool
   * @returns The parsed tool call arguments, or null if the model didn't call the tool
   */
  structuredComplete(context: DirectCompletionContext, schema: unknown, toolName?: string, toolDescription?: string, options?: DirectCompletionOptions): Promise<Record<string, unknown> | null>;

  /**
   * Make a utility completion call using the utility model.
   * Convenience wrapper for internal operations (WebFetch summarization,
   * safety classification, etc.).
   *
   * Analogous to directComplete() but uses the utility model (smaller, cheaper)
   * instead of the primary model. Accepts the same raw or structured contexts
   * as directComplete(). Dynamically imports pi-ai's complete() function.
   *
   * @param context - Raw or structured completion context
   * @returns The response text from the LLM
   * @throws Error if pi-ai is not installed or the call fails
   */
  utilityComplete(context: DirectCompletionContext, options?: DirectCompletionOptions): Promise<string>;

  /**
   * Get the usage data from the most recent directComplete() or
   * structuredComplete() call. Returns null if no usage was available
   * or no call has been made yet.
   *
   * This is the primary mechanism for consumers (like the backend pipeline)
   * to capture per-phase usage for persistence. The value is reset to null
   * at the start of each directComplete/structuredComplete call.
   */
  getLastDirectUsage(): CortexUsage | null;

  /**
   * Get accumulated session usage (cost, turns, token breakdown).
   *
   * Unlike BudgetGuard (which resets per agentic loop), this accumulates
   * across the entire session lifetime. Consumers can persist this value
   * and restore it via restoreSessionUsage() after loading a saved session.
   */
  getSessionUsage(): SessionUsage;

  /**
   * Restore session usage from consumer-provided data.
   *
   * Call this after restoreConversationHistory() when resuming a saved session.
   * Values are added to any usage already accumulated (in case turns ran
   * before the restore call).
   */
  restoreSessionUsage(usage: SessionUsage): void;
}
