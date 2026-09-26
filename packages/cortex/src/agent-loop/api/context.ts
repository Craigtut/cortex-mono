/**
 * AgentLoop's public surface, the context the model sees (slots, history,
 * the transformContext hook, the headline feed, token tracking,
 * compaction, observational memory). AgentLoop implements this interface;
 * the member docs here are AgentLoop's documentation.
 */

import type { CompactionManager } from '../../compaction/index.js';
import type { ObservationEvent, ObservationalMemoryState, ReflectionEvent } from '../../compaction/observational/types.js';
import type { AgentContext, AgentMessage, ContextManager } from '../../context-manager.js';
import type { CompactionDegradedInfo, CompactionExhaustedInfo, CompactionResult, CompactionTarget, LoopOriginContext } from '../../types.js';

export interface LoopContextApi {
  /**
   * Feed a consumer-built headline block (live task status, activity lines)
   * into this loop's context. The provider is called on EVERY LLM call and
   * its result is view-injected after the built-in background-task state,
   * OUTSIDE the BP3 cache boundary: it churns per tick, so it must never
   * extend the cached prefix, never enter the transcript, and is absent on
   * compaction turns by design (like all view injections).
   *
   * The block is hard token-capped (default 2000 tokens; override via
   * options.maxTokens): injected user-role content is never trimmed by
   * microcompaction, so an unbounded block would inflate utilization and
   * trigger early source compaction without itself shrinking.
   *
   * Pass null to stop injecting. A provider that throws or returns
   * null/whitespace injects nothing for that call.
   */
  setHeadlineProvider(
    provider: (() => string | null) | null,
    options?: { maxTokens?: number },
  ): void;

  /**
   * Get the ContextManager for slot and ephemeral context management.
   */
  getContextManager(): ContextManager;

  /**
   * Get conversation history, excluding the slot region.
   *
   * Returns messages from position slotCount through the end of the array.
   * The consumer snapshots this to their storage.
   *
   * @returns Conversation history messages (everything after slots)
   */
  getConversationHistory(): AgentMessage[];

  /**
   * Restore conversation history after the slot region.
   *
   * Splices saved messages into the array starting at position slotCount,
   * replacing any existing conversation history.
   *
   * @param messages - Previously saved conversation history
   */
  restoreConversationHistory(messages: AgentMessage[]): void;

  /**
   * Register a handler called before compaction starts.
   * Handler is awaited. The consumer should flush critical state
   * (e.g., observational memory) before history is compacted.
   *
   * NOT called during mid-loop emergency truncation (Layer 3).
   */
  onBeforeCompaction(
    handler: (target: CompactionTarget, origin: LoopOriginContext) => Promise<void>,
  ): void;

  /**
   * Register a handler called after compaction completes.
   * The consumer uses this to re-seed messages from messages.db,
   * update internal state, or perform other post-compaction work.
   */
  onPostCompaction(
    handler: (result: CompactionResult, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Register a handler for compaction errors.
   */
  onCompactionError(
    handler: (error: Error, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Register a handler called when Layer 2 compaction failed and Layer 3
   * (emergency truncation) was used as fallback. The session continues
   * but context quality is degraded.
   */
  onCompactionDegraded(
    handler: (info: CompactionDegradedInfo, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Register a handler called when all compaction layers have failed.
   * The consumer should take recovery action (e.g., pause heartbeat,
   * abort the session, or notify the user).
   */
  onCompactionExhausted(
    handler: (info: CompactionExhaustedInfo, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Update the post-hoc current-context token count from LLM usage data.
   * Called by the consumer after each LLM call with the input_tokens
   * from AssistantMessage.usage.
   */
  updateCurrentContextTokenCount(inputTokens: number): void;

  /**
   * Get the post-hoc current-context token count from the most recent parent turn.
   */
  readonly currentContextTokenCount: number;

  /**
   * Estimate the current context tokens Cortex would send on the next parent LLM call.
   *
   * This is a heuristic estimate of the transformed context snapshot built from:
   * - the current system prompt
   * - slots and conversation history
   * - ephemeral context
   * - background task state
   * - loaded skills
   *
   * The estimate is compared against the most recent post-hoc parent turn usage
   * and the larger value is returned. This matches the compaction manager's
   * internal decision logic.
   */
  estimateCurrentContextTokens(): number;

  /**
   * Signal how recently the user last interacted.
   * Used by the compaction system to adjust thresholds:
   * - Recent interaction: use normal thresholds
   * - No interaction for a while: compact more aggressively
   *
   * The backend calls this during GATHER when a message-triggered tick fires
   * (set to Date.now()). For interval ticks, it is not called, so the
   * timestamp ages naturally.
   */
  setLastInteractionTime(timestamp: number): void;

  /**
   * Cap a tool result at insertion time. If the result exceeds
   * maxResultTokens, truncates to head+tail bookend format.
   * Call this when tool results enter conversation history.
   */
  capToolResult(content: string): string;

  /**
   * Get the observational memory state for session persistence.
   * Returns null if not using the observational strategy.
   */
  getObservationalMemoryState(): ObservationalMemoryState | null;

  /**
   * Restore observational memory state from a previous session.
   * Must be called after restoreConversationHistory().
   */
  restoreObservationalMemoryState(state: ObservationalMemoryState): void;

  /**
   * Force a synchronous observation cycle.
   * Useful after critical user corrections.
   */
  triggerObservation(): Promise<void>;

  /**
   * Register a handler for observation events.
   * Fires when messages are compressed into observations.
   */
  onObservation(
    handler: (event: ObservationEvent, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Register a handler for reflection events.
   * Fires when the reflector condenses observations.
   */
  onReflection(
    handler: (event: ReflectionEvent, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Run end-of-tick compaction check. Call after EXECUTE completes,
   * before the next tick starts. Returns the CompactionResult if
   * Layer 2 compaction ran, null otherwise.
   */
  checkAndRunCompaction(): Promise<CompactionResult | null>;

  /**
   * Get the CompactionManager for advanced use.
   */
  getCompactionManager(): CompactionManager;

  /**
   * Get the composed transformContext hook for the pi-agent-core Agent.
   *
   * Composes five steps in order:
   * 0. Tier 1 insertion-time cap (mutates source messages)
   * 1. Insert ephemeral + skill buffer at the boundary position
   *    (after old history, before new tick content) for cache optimization
   * 2. Message sanitization
   * 3. Compaction (all three layers: microcompaction, summarization, failsafe)
   * 4. Compute API message indices for cache breakpoints BP2 and BP3
   *
   * Cache breakpoint strategy:
   *   Anthropic allows 4 cache_control breakpoints. Pi-ai sets up to 3
   *   (system prompt, last tool definition, last user message). The
   *   onPayload hook strips the tool breakpoint and adds BP2 (after last
   *   slot) and BP3 (old history boundary), keeping the total at 4.
   *
   *   By inserting ephemeral at the boundary instead of the end, the
   *   conversation history prefix becomes stable across ticks, enabling
   *   cache reads on ~128K of tokens instead of only ~5.5K.
   *
   * The hook is async because Layer 2 compaction may require an LLM call
   * for summarization. Pi-agent-core's transformContext supports async hooks.
   *
   * @returns An async transformContext function for the Agent constructor
   */
  getTransformContextHook(): (context: AgentContext) => Promise<AgentContext>;
}
