/**
 * Buffering coordinator for the observational memory system.
 *
 * Manages the async lifecycle of observer and reflector operations,
 * ensuring at-most-one-in-flight per operation type, computing dynamic
 * buffer intervals, and handling abort/cleanup.
 *
 * The coordinator does not own the observation slot or conversation
 * history. It produces observation chunks and buffered reflections that
 * the ObservationalMemoryEngine consumes during activation.
 *
 * References:
 *   - observational-memory-architecture.md (Observer System, Reflector System)
 *   - observer.ts (runObserver)
 *   - reflector.ts (runReflector)
 */

import type { CompleteFn } from '../compaction.js';
import type { AgentMessage } from '../../context-manager.js';
import type { ObservationChunk, ObserverOutput, ReflectorOutput } from './types.js';
import { runObserver } from './observer.js';
import { runReflector } from './reflector.js';
import { estimateTokens } from '../../token-estimator.js';

// ---------------------------------------------------------------------------
// BufferingCoordinator
// ---------------------------------------------------------------------------

/**
 * Coordinates async observer and reflector operations for the
 * observational memory system.
 *
 * Ensures at-most-one observer and at-most-one reflector call are
 * in-flight at any time. Completed observer results are stored as
 * {@link ObservationChunk}s until the engine activates them. Completed
 * reflector results are stored until the engine swaps them in.
 *
 * All in-flight operations are fire-and-forget from the caller's
 * perspective. The coordinator attaches `.then()` / `.catch()` handlers
 * internally and never surfaces unhandled rejections.
 */
export class BufferingCoordinator {
  // --- Internal state ---

  private chunks: ObservationChunk[] = [];
  private bufferWatermark: number = 0;
  private inFlightObserver: Promise<ObserverOutput> | null = null;
  private inFlightObserverEndIndex: number | null = null;
  private inFlightReflector: Promise<ReflectorOutput> | null = null;
  private bufferedReflection: string | null = null;
  private bufferedReflectionCompressionLevel: number = 0;
  private aborted: boolean = false;

  /**
   * Activation epoch. Incremented each time activation consumes chunks or
   * a sync observer trims messages. In-flight observers capture the epoch
   * at launch and discard their result if the epoch has changed by the time
   * they complete. This prevents stale chunks from landing after sync
   * activation has already processed those messages.
   */
  private activationEpoch: number = 0;

  // -------------------------------------------------------------------------
  // Buffer Interval Calculation
  // -------------------------------------------------------------------------

  /**
   * Compute the dynamic buffer interval based on current context state.
   *
   * The interval targets `bufferTargetCycles` observer calls between the
   * current utilization and the activation threshold. It is clamped between
   * `bufferMinTokens` and `effectiveBufferCap` (the lesser of
   * `bufferTokenCap` and 60% of the utility model's context window).
   *
   * @param tokensUntilActivation - tokens remaining before activation threshold
   * @param config - buffer interval configuration
   * @returns the buffer interval in tokens
   */
  computeBufferInterval(
    tokensUntilActivation: number,
    config: {
      bufferTargetCycles: number;
      bufferTokenCap: number;
      bufferMinTokens: number;
      utilityModelContextWindow: number;
    },
  ): number {
    const effectiveBufferCap = Math.min(
      config.bufferTokenCap,
      config.utilityModelContextWindow * 0.6,
    );
    const dynamicInterval = tokensUntilActivation / config.bufferTargetCycles;
    return Math.max(
      Math.min(dynamicInterval, effectiveBufferCap),
      config.bufferMinTokens,
    );
  }

  // -------------------------------------------------------------------------
  // Observer Buffering
  // -------------------------------------------------------------------------

  /**
   * Check if a buffer observation should be triggered based on
   * unobserved tokens.
   *
   * Returns true when the unobserved token count meets or exceeds the
   * buffer interval, no observer call is currently in flight, and the
   * coordinator has not been aborted.
   *
   * @param unobservedTokens - estimated tokens of messages after the buffer watermark
   * @param bufferInterval - computed from {@link computeBufferInterval}
   * @returns true if a buffer observation should launch
   */
  shouldBuffer(unobservedTokens: number, bufferInterval: number): boolean {
    return (
      unobservedTokens >= bufferInterval &&
      !this.isObserverInFlight() &&
      !this.aborted
    );
  }

  /**
   * Launch an async observer call. Does NOT await it.
   *
   * Stores the in-flight promise and tracks the end index of messages
   * being processed. When the observer completes, its output is converted
   * to an {@link ObservationChunk} and appended to the internal chunk
   * list. If the coordinator has been aborted before the observer
   * completes, the result is discarded.
   *
   * @param complete - the LLM completion function
   * @param messages - the unobserved messages to process (snapshot)
   * @param endIndex - the index in conversation history where these messages end
   * @param previousObservations - current observation text for context
   * @param config - observer config
   * @param logger - optional logger for error reporting
   */
  launchObserver(
    complete: CompleteFn,
    messages: AgentMessage[],
    endIndex: number,
    previousObservations: string | null,
    config: { previousObserverTokens: number; observerInstruction?: string },
    logger?: { warn: (msg: string) => void },
  ): void {
    if (this.aborted) return;

    // Estimate tokens from the message snapshot for the chunk metadata
    const messageTokensObserved = messages.reduce((sum, msg) => {
      if (typeof msg.content === 'string') {
        return sum + estimateTokens(msg.content);
      }
      if (Array.isArray(msg.content)) {
        const text = msg.content
          .map((part) => {
            if (typeof part.text === 'string') return part.text;
            return JSON.stringify(part);
          })
          .join(' ');
        return sum + estimateTokens(text);
      }
      return sum;
    }, 0);

    const promise = runObserver(complete, messages, previousObservations, config);
    this.inFlightObserver = promise;
    this.inFlightObserverEndIndex = endIndex;

    // Capture the activation epoch at launch. If activation fires (sync or
    // chunk-based) before this observer completes, the epoch will have
    // advanced and the result is stale (those messages were already observed).
    const launchEpoch = this.activationEpoch;

    promise
      .then((output: ObserverOutput) => {
        if (this.aborted) return;

        // Discard if activation already processed these messages
        if (this.activationEpoch !== launchEpoch) {
          this.inFlightObserver = null;
          this.inFlightObserverEndIndex = null;
          return;
        }

        const chunk: ObservationChunk = {
          observations: output.observations,
          messageTokensObserved,
          createdAt: new Date(),
        };

        if (output.currentTask) {
          chunk.currentTask = output.currentTask;
        }
        if (output.suggestedResponse) {
          chunk.suggestedResponse = output.suggestedResponse;
        }

        this.chunks.push(chunk);
        this.bufferWatermark = this.inFlightObserverEndIndex ?? endIndex;
        this.inFlightObserver = null;
        this.inFlightObserverEndIndex = null;
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (logger) {
          logger.warn(`Observer buffer call failed: ${message}`);
        }
        this.inFlightObserver = null;
        this.inFlightObserverEndIndex = null;
      });
  }

  /**
   * Check if there are completed buffer chunks ready for activation.
   */
  hasCompletedChunks(): boolean {
    return this.chunks.length > 0;
  }

  /**
   * Get all completed chunks and the watermark up to which messages
   * are covered.
   *
   * Does NOT clear state. Call {@link commitActivation} after
   * successfully activating.
   */
  getCompletedChunks(): { chunks: ObservationChunk[]; watermark: number } {
    return { chunks: [...this.chunks], watermark: this.bufferWatermark };
  }

  /**
   * Called after successful activation to reset buffer state.
   *
   * Clears accumulated chunks and resets the watermark to 0 since the
   * messages it pointed to have been removed from the conversation
   * history.
   */
  commitActivation(): void {
    this.chunks = [];
    this.bufferWatermark = 0;
    this.activationEpoch++;
  }

  // -------------------------------------------------------------------------
  // Reflector Buffering
  // -------------------------------------------------------------------------

  /**
   * Check if reflection should be triggered based on observation token count.
   *
   * Returns:
   * - `'sync'` when observation tokens are at or above the effective threshold
   *   (the caller decides whether to use a buffered reflection or force a sync call)
   * - `'async'` when observation tokens are between the buffer activation point
   *   and the threshold, and no reflector is currently in flight
   * - `'none'` otherwise
   *
   * @param observationTokens - current observation slot token count
   * @param effectiveThreshold - from computeEffectiveReflectionThreshold
   * @param reflectionBufferActivation - fraction at which to start async reflection
   * @returns action indicator
   */
  shouldReflect(
    observationTokens: number,
    effectiveThreshold: number,
    reflectionBufferActivation: number,
  ): 'none' | 'async' | 'sync' {
    if (observationTokens >= effectiveThreshold) {
      return 'sync';
    }

    const asyncTrigger = effectiveThreshold * reflectionBufferActivation;
    if (
      observationTokens >= asyncTrigger &&
      !this.isReflectorInFlight() &&
      !this.aborted
    ) {
      return 'async';
    }

    return 'none';
  }

  /**
   * Launch an async reflector call. Does NOT await it.
   *
   * When the reflector completes, its result is stored in
   * `bufferedReflection` for later consumption via
   * {@link consumeBufferedReflection}. If the coordinator has been
   * aborted before the reflector completes, the result is discarded.
   *
   * @param complete - the LLM completion function
   * @param observations - the current observation text to consolidate
   * @param config - reflector config
   * @param logger - optional logger for error reporting
   */
  launchReflector(
    complete: CompleteFn,
    observations: string,
    config: { reflectionThreshold: number; reflectorInstruction?: string },
    logger?: { warn: (msg: string) => void },
  ): void {
    if (this.aborted) return;

    const promise = runReflector(complete, observations, config);
    this.inFlightReflector = promise;

    promise
      .then((output: ReflectorOutput) => {
        if (this.aborted) return;

        this.bufferedReflection = output.observations;
        this.bufferedReflectionCompressionLevel = output.compressionLevel;
        this.inFlightReflector = null;
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (logger) {
          logger.warn(`Reflector buffer call failed: ${message}`);
        }
        this.inFlightReflector = null;
      });
  }

  /**
   * Check if a buffered reflection is ready to swap in.
   */
  hasBufferedReflection(): boolean {
    return this.bufferedReflection !== null;
  }

  /**
   * Get the buffered reflection and clear it.
   *
   * Returns the consolidated observations and the compression level that
   * was applied, or null if no buffered reflection is available.
   */
  consumeBufferedReflection(): {
    observations: string;
    compressionLevel: number;
  } | null {
    if (this.bufferedReflection === null) return null;

    const result = {
      observations: this.bufferedReflection,
      compressionLevel: this.bufferedReflectionCompressionLevel,
    };

    this.bufferedReflection = null;
    this.bufferedReflectionCompressionLevel = 0;

    return result;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Get the current state for session persistence.
   *
   * In-flight operations are NOT included (they are lost on session
   * save). Only completed chunks and the watermark are persisted.
   */
  getState(): { chunks: ObservationChunk[]; watermark: number } {
    return { chunks: [...this.chunks], watermark: this.bufferWatermark };
  }

  /**
   * Restore state from a previous session.
   */
  restoreState(state: { chunks: ObservationChunk[]; watermark: number }): void {
    this.chunks = [...state.chunks];
    this.bufferWatermark = state.watermark;
  }

  /**
   * Abort all in-flight operations. Called on agent destruction.
   *
   * Sets the aborted flag so that any in-flight promise handlers
   * discard their results when they eventually resolve.
   */
  abort(): void {
    this.aborted = true;
    this.inFlightObserver = null;
    this.inFlightObserverEndIndex = null;
    this.inFlightReflector = null;
  }

  /**
   * Whether an observer call is currently in flight.
   */
  isObserverInFlight(): boolean {
    return this.inFlightObserver !== null;
  }

  /**
   * Whether a reflector call is currently in flight.
   */
  isReflectorInFlight(): boolean {
    return this.inFlightReflector !== null;
  }

  /**
   * Get the buffer watermark (index into conversation history marking
   * where the last completed observation ended).
   */
  getWatermark(): number {
    return this.bufferWatermark;
  }

  /**
   * Set the watermark. Used during initialization or after manual
   * adjustments to the conversation history.
   */
  setWatermark(index: number): void {
    this.bufferWatermark = index;
  }

  /**
   * Advance the activation epoch. Called when a sync activation trims
   * messages outside of the normal commitActivation() flow (e.g., the
   * engine's Step 2 sync observer path). This invalidates any in-flight
   * observers that were launched before the sync activation.
   */
  advanceEpoch(): void {
    this.activationEpoch++;
  }
}
