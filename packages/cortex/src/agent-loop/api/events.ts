/**
 * AgentLoop's public surface, loop events (completion, errors, retries,
 * turns) and the raw event bridge and budget guard. AgentLoop implements
 * this interface; the member docs here are AgentLoop's documentation.
 */

import type { BudgetGuard } from '../../budget-guard.js';
import type { EventBridge } from '../../event-bridge.js';
import type { AgentTextOutput, ClassifiedError, LoopOriginContext, RetryExhaustedInfo, RetryScheduledInfo, RetrySucceededInfo } from '../../types.js';

export interface LoopEventApi {
  /**
   * Register a handler for when a logical turn's agentic loop completes
   * (pi's agent_end, once per turn: not for a failed attempt a retry may
   * follow). A good point to checkpoint conversation history. The origin
   * context identifies which loop completed.
   */
  onLoopComplete(handler: (origin: LoopOriginContext) => void): void;

  /**
   * Register a handler for classified errors during the agentic loop.
   * The origin context identifies which loop produced the error.
   */
  onError(handler: (error: ClassifiedError, origin: LoopOriginContext) => void): void;

  /**
   * Register a handler fired before each background retry's backoff wait.
   * Consumers use this to render a compact, in-place retry status (countdown,
   * attempt count) instead of a hard error. See {@link RetryPolicy}.
   */
  onRetryScheduled(
    handler: (info: RetryScheduledInfo, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Register a handler fired when a background retry resolves the turn.
   * The consumer clears the retry status.
   */
  onRetrySucceeded(
    handler: (info: RetrySucceededInfo, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Register a handler fired when background retries are given up on. The
   * matching fatal `onError` fires immediately after, so the consumer shows a
   * terminal state.
   */
  onRetryExhausted(
    handler: (info: RetryExhaustedInfo, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Register a handler for turn completion with parsed working tag output.
   * The origin context identifies which loop completed the turn.
   */
  onTurnComplete(handler: (output: AgentTextOutput, origin: LoopOriginContext) => void): void;

  /**
   * Get the EventBridge for direct event access.
   * Consumers that need raw event data (for logging) can subscribe directly.
   */
  getEventBridge(): EventBridge;

  /** Get the BudgetGuard for inspecting turn/cost state. */
  getBudgetGuard(): BudgetGuard;
}
