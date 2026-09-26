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
   * Make a direct LLM completion call using the primary model. Not an
   * agentic loop: one response, no tools run, nothing added to the
   * transcript.
   *
   * Accepts either a raw context ({ systemPrompt, messages }) passed to
   * pi-ai verbatim, or a structured context ({ systemPrompt, slots?,
   * history?, ephemeral?, prompt }) that Cortex assembles with the same
   * cache breakpoint strategy the agentic loop uses. See
   * StructuredCompletionContext for the caching contract.
   *
   * @param context - Raw or structured completion context
   * @returns The response text from the LLM
   * @throws Error if pi-ai is not installed or the call fails; an Error named
   *   'AbortError' when `options.signal` cancels it
   */
  directComplete(context: DirectCompletionContext, options?: DirectCompletionOptions): Promise<string>;

  /**
   * Make a structured output LLM call. Providers with native JSON-schema
   * output use it; the rest get a forced tool whose input schema is the
   * desired shape, and the tool call's arguments are the result.
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
   * Make a completion call using the utility model (smaller, cheaper).
   * Same contexts and behavior as directComplete(); Cortex uses it for
   * internal work such as WebFetch summarization.
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
   * Reset to null at the start of each call, so read it right after the
   * call whose usage you want to persist.
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
