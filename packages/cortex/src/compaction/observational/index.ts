/**
 * ObservationalMemoryEngine: core orchestrator for the observational memory
 * system.
 *
 * Ties together the observer, reflector, and buffering coordinator. Manages
 * the observation slot, handles activation and reflection, and exposes the
 * state management API.
 *
 * The engine runs inside CompactionManager's transformContext hook. It does
 * NOT directly call ContextManager.setSlot(); instead, it manages the slot
 * content string and the integration layer handles writing it to the slot.
 *
 * References:
 *   - observational-memory-architecture.md
 *   - compaction-strategy.md
 *   - context-manager.md
 */

import type { CompleteFn } from '../compaction.js';
import type { AgentMessage, AgentContext } from '../../context-manager.js';
import type {
  ObservationalMemoryConfig,
  ObservationalMemoryState,
  ObservationChunk,
  ObservationEvent,
  ReflectionEvent,
  ContinuationHint,
  RecallConfig,
} from './types.js';
import {
  OBSERVATIONAL_MEMORY_DEFAULTS,
  OBSERVATION_CONTEXT_PREAMBLE,
  OBSERVATION_RECALL_INSTRUCTIONS,
} from './constants.js';
import { runObserver } from './observer.js';
import { runReflector, computeEffectiveReflectionThreshold } from './reflector.js';
import { BufferingCoordinator } from './buffering.js';
import { estimateTokens } from '../../token-estimator.js';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { BufferingCoordinator } from './buffering.js';
export { runObserver } from './observer.js';
export { runReflector, computeEffectiveReflectionThreshold } from './reflector.js';
export { createRecallTool } from './recall-tool.js';

export type {
  ObservationalMemoryConfig,
  ObservationalMemoryState,
  ObservationChunk,
  ObservationEvent,
  ReflectionEvent,
  ContinuationHint,
  RecallConfig,
  RecallResult,
  ObserverOutput,
  ReflectorOutput,
  BufferState,
} from './types.js';

// ---------------------------------------------------------------------------
// ObservationalMemoryEngine
// ---------------------------------------------------------------------------

/**
 * Core orchestrator for the observational memory system.
 *
 * Coordinates the observer, reflector, and buffering coordinator to maintain
 * a compressed observation log of the conversation. Called from
 * CompactionManager during transformContext.
 */
export class ObservationalMemoryEngine {
  private config: Required<Omit<ObservationalMemoryConfig, 'observerInstruction' | 'reflectorInstruction' | 'recall'>> & {
    observerInstruction?: string;
    reflectorInstruction?: string;
    recall?: RecallConfig;
  };
  private buffering: BufferingCoordinator;
  private completeFn: CompleteFn | null = null;
  private observations: string = '';
  private continuationHint: ContinuationHint | null = null;
  private observationTokenCount: number = 0;
  private generationCount: number = 0;
  private contextWindow: number = 0;
  private utilityModelContextWindow: number = 0;
  private slotIndex: number;
  private logger: { warn: (msg: string) => void; info: (msg: string) => void } | null = null;

  // Event handler arrays (method-level registration, multiple handlers)
  private observationHandlers: Array<(event: ObservationEvent) => void> = [];
  private reflectionHandlers: Array<(event: ReflectionEvent) => void> = [];

  constructor(config: Partial<ObservationalMemoryConfig>, slotIndex: number) {
    this.slotIndex = slotIndex;
    this.buffering = new BufferingCoordinator();

    // Merge with defaults. Optional fields (observerInstruction,
    // reflectorInstruction, recall) are only included when provided.
    this.config = {
      ...OBSERVATIONAL_MEMORY_DEFAULTS,
      ...config,
    };
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Set the LLM completion function (wired to utilityComplete on CortexAgent).
   */
  setCompleteFn(fn: CompleteFn): void {
    this.completeFn = fn;
  }

  /**
   * Update the context window size.
   */
  setContextWindow(contextWindow: number): void {
    this.contextWindow = contextWindow;
  }

  /**
   * Update the utility model context window (for clamps).
   */
  setUtilityModelContextWindow(utilityModelContextWindow: number): void {
    this.utilityModelContextWindow = utilityModelContextWindow;
  }

  /**
   * Set the logger.
   */
  setLogger(logger: { warn: (msg: string) => void; info: (msg: string) => void }): void {
    this.logger = logger;
  }

  // -------------------------------------------------------------------------
  // Event Registration
  // -------------------------------------------------------------------------

  /**
   * Register an observation event handler.
   */
  onObservation(handler: (event: ObservationEvent) => void): void {
    this.observationHandlers.push(handler);
  }

  /**
   * Register a reflection event handler.
   */
  onReflection(handler: (event: ReflectionEvent) => void): void {
    this.reflectionHandlers.push(handler);
  }

  // -------------------------------------------------------------------------
  // Core: applyInTransformContext
  // -------------------------------------------------------------------------

  /**
   * Core method called from CompactionManager during transformContext.
   *
   * Handles observation activation and reflection when context utilization
   * exceeds the activation threshold. Updates the observation slot and
   * trims observed messages from history.
   *
   * @param context - The AgentContext from transformContext
   * @param utilization - Current total context utilization (0-1)
   * @param slotCount - Number of slot messages at the start of the array
   * @param getHistory - Get conversation history from the context (post-slot)
   * @param setHistory - Set conversation history in the context (post-slot)
   * @param getSourceHistory - Get the original transcript history (agent.state.messages post-slot)
   * @param setSourceHistory - Replace the original transcript history
   * @returns Modified context with updated observations and trimmed history
   */
  async applyInTransformContext(
    context: AgentContext,
    utilization: number,
    slotCount: number,
    getHistory: (ctx: AgentContext) => AgentMessage[],
    setHistory: (ctx: AgentContext, history: AgentMessage[]) => AgentContext,
    getSourceHistory: () => AgentMessage[],
    setSourceHistory: (history: AgentMessage[]) => void,
  ): Promise<AgentContext> {
    if (utilization < this.config.activationThreshold) {
      return context;
    }

    // --- Activation ---
    const sourceHistory = getSourceHistory();
    const watermark = this.buffering.getWatermark();
    let compactedMessages: AgentMessage[] = [];
    let newObservationText = '';
    let activatedSync = false;

    // Step 1: Activate completed buffer chunks
    if (this.buffering.hasCompletedChunks()) {
      const { chunks, watermark: chunkWatermark } = this.buffering.getCompletedChunks();
      const merged = this.mergeChunks(chunks);
      newObservationText = merged.observations;

      if (merged.hint) {
        this.continuationHint = merged.hint;
      }

      // Messages covered by completed chunks (from start of source to watermark)
      compactedMessages = sourceHistory.slice(0, chunkWatermark);

      // Remove observed messages from source, keep unbuffered tail
      setSourceHistory(sourceHistory.slice(chunkWatermark));
      this.buffering.commitActivation();
    }

    // Step 2: Check if still over threshold after chunk activation
    // Recompute utilization after trimming. Account for the full slot
    // overhead (preamble, XML wrappers, continuation hints) rather than
    // just the raw observation text, since the slot is always larger.
    const postChunkSource = getSourceHistory();
    const trimmedMessageTokens = estimateTokens(
      compactedMessages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n'),
    );
    // Estimate the actual slot size including overhead, not just the raw
    // observation text. buildSlotContent() wraps observations in the
    // preamble, <observations> tags, and optional continuation hints.
    const slotOverheadTokens = newObservationText
      ? estimateTokens(this.buildSlotContentForEstimate(newObservationText))
      : 0;
    // Net change: removed messages, added observation slot content
    const netTokenReduction = trimmedMessageTokens - slotOverheadTokens;
    const postChunkUtilization = utilization - (this.contextWindow > 0 ? netTokenReduction / this.contextWindow : 0);

    if (postChunkUtilization >= this.config.activationThreshold && this.completeFn) {
      // Force sync observer on remaining unbuffered messages
      const unbufferedMessages = postChunkSource;

      if (unbufferedMessages.length > 0) {
        activatedSync = true;

        const output = await runObserver(
          this.completeFn,
          unbufferedMessages,
          this.observations || null,
          this.buildObserverConfig(),
        );

        // Append sync observations
        if (newObservationText) {
          newObservationText += '\n\n' + output.observations;
        } else {
          newObservationText = output.observations;
        }

        if (output.currentTask || output.suggestedResponse) {
          this.continuationHint = {
            currentTask: output.currentTask ?? '',
            suggestedResponse: output.suggestedResponse ?? '',
          };
        }

        // All unbuffered messages are now observed
        compactedMessages = [...compactedMessages, ...unbufferedMessages];
        setSourceHistory([]);
        this.buffering.setWatermark(0);
        // Invalidate any in-flight observers that were processing messages
        // we just observed synchronously
        this.buffering.advanceEpoch();
      }
    }

    // Step 3: Merge new observations into existing
    if (newObservationText) {
      if (this.observations) {
        this.observations += '\n\n' + newObservationText;
      } else {
        this.observations = newObservationText;
      }
      this.observationTokenCount = estimateTokens(this.observations);
    }

    // Step 4: Fire observation event
    if (compactedMessages.length > 0) {
      this.fireObservationEvent({
        compactedMessages,
        observations: this.observations,
        contextUtilization: utilization,
        sync: activatedSync,
        timestamp: new Date(),
      });
    }

    // Step 5: Handle reflection (may replace this.observations with condensed version)
    await this.handleReflection();

    // Step 6: Build slot content AFTER reflection so it contains post-reflection
    // observations. Previously this was captured before reflection, requiring
    // an external patch in cortex-agent.ts to correct stale content.
    const slotContent = this.buildSlotContent();

    // Step 7: Rebuild context with updated observations and trimmed history
    const updatedSourceHistory = getSourceHistory();

    // Build new message array: slot region + observation slot + remaining source messages
    const slotRegion = context.messages.slice(0, this.slotIndex);
    const observationSlotMessage: AgentMessage = {
      role: 'user',
      content: slotContent,
    };
    // Messages after the slot region that are not part of the observation slot
    const postSlotMessages = updatedSourceHistory;

    const newMessages: AgentMessage[] = [
      ...slotRegion,
      observationSlotMessage,
      ...context.messages.slice(this.slotIndex + 1, slotCount),
      ...postSlotMessages,
    ];

    return setHistory(
      { ...context, messages: newMessages },
      postSlotMessages,
    );
  }

  // -------------------------------------------------------------------------
  // Turn-end handler
  // -------------------------------------------------------------------------

  /**
   * Called at each turn_end event. Handles async buffer triggering.
   *
   * Computes the dynamic buffer interval and launches an async observer
   * if enough unobserved tokens have accumulated.
   *
   * @param totalTokens - Total tokens from the last LLM response
   * @param contextWindow - Current context window size
   * @param messages - Current conversation messages (post-slot)
   * @param slotCount - Number of slot messages
   */
  onTurnEnd(
    totalTokens: number,
    contextWindow: number,
    messages: AgentMessage[],
    slotCount: number,
  ): void {
    if (!this.completeFn || contextWindow <= 0) return;

    const currentUtilization = totalTokens / contextWindow;
    const tokensUntilActivation = (this.config.activationThreshold - currentUtilization) * contextWindow;

    // Already past threshold, activation will handle it in transformContext
    if (tokensUntilActivation <= 0) return;

    const bufferInterval = this.buffering.computeBufferInterval(tokensUntilActivation, {
      bufferTargetCycles: this.config.bufferTargetCycles,
      bufferTokenCap: this.config.bufferTokenCap,
      bufferMinTokens: this.config.bufferMinTokens,
      utilityModelContextWindow: this.utilityModelContextWindow,
    });

    // Skip slot messages to avoid processing them as conversation content
    const history = messages.slice(slotCount);

    // Compute unobserved tokens (messages after buffer watermark)
    const watermark = this.buffering.getWatermark();
    const unobservedMessages = history.slice(watermark);
    const unobservedTokens = unobservedMessages.reduce((sum, msg) => {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      return sum + estimateTokens(content);
    }, 0);

    if (this.buffering.shouldBuffer(unobservedTokens, bufferInterval)) {
      // Snapshot the unobserved messages
      const snapshot = [...unobservedMessages];
      const endIndex = watermark + unobservedMessages.length;

      this.buffering.launchObserver(
        this.completeFn,
        snapshot,
        endIndex,
        this.observations || null,
        this.buildObserverConfig(),
        this.logger ?? undefined,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Slot content
  // -------------------------------------------------------------------------

  /**
   * Build the full observation slot content.
   *
   * Assembles the preamble, optional recall instructions, observation block,
   * and optional continuation hints into a single string.
   */
  buildSlotContent(): string {
    let content = OBSERVATION_CONTEXT_PREAMBLE;

    if (this.config.recall) {
      content += OBSERVATION_RECALL_INSTRUCTIONS;
    }

    content += '\n\n<observations>\n' + this.observations + '\n</observations>';

    if (this.continuationHint) {
      content += '\n\n<current-task>\n' + this.continuationHint.currentTask + '\n</current-task>';
      content += '\n\n<suggested-response>\n' + this.continuationHint.suggestedResponse + '\n</suggested-response>';
    }

    return content;
  }

  /**
   * Estimate the full slot content size for a given observation text.
   *
   * Used by the post-chunk utilization estimate to account for slot
   * overhead (preamble, XML wrappers, continuation hints) rather than
   * just the raw observation text.
   */
  private buildSlotContentForEstimate(observationText: string): string {
    let content = OBSERVATION_CONTEXT_PREAMBLE;

    if (this.config.recall) {
      content += OBSERVATION_RECALL_INSTRUCTIONS;
    }

    content += '\n\n<observations>\n' + observationText + '\n</observations>';

    if (this.continuationHint) {
      content += '\n\n<current-task>\n' + this.continuationHint.currentTask + '\n</current-task>';
      content += '\n\n<suggested-response>\n' + this.continuationHint.suggestedResponse + '\n</suggested-response>';
    }

    return content;
  }

  // -------------------------------------------------------------------------
  // Manual trigger
  // -------------------------------------------------------------------------

  /**
   * Force a synchronous observation cycle.
   *
   * Used by consumers after critical corrections to ensure the observation
   * log captures the correction immediately.
   *
   * @param messages - The full message array (may include slot messages)
   * @param slotCount - Number of slot messages to skip
   */
  async triggerObservation(
    messages: AgentMessage[],
    slotCount: number,
  ): Promise<void> {
    const history = messages.slice(slotCount);
    if (!this.completeFn || history.length === 0) return;

    const output = await runObserver(
      this.completeFn,
      history,
      this.observations || null,
      this.buildObserverConfig(),
    );

    // Merge observations
    if (this.observations) {
      this.observations += '\n\n' + output.observations;
    } else {
      this.observations = output.observations;
    }

    if (output.currentTask || output.suggestedResponse) {
      this.continuationHint = {
        currentTask: output.currentTask ?? '',
        suggestedResponse: output.suggestedResponse ?? '',
      };
    }

    this.observationTokenCount = estimateTokens(this.observations);

    // Fire observation event
    this.fireObservationEvent({
      compactedMessages: history,
      observations: this.observations,
      contextUtilization: 0, // manual trigger, utilization unknown
      sync: true,
      timestamp: new Date(),
    });
  }

  // -------------------------------------------------------------------------
  // Kickstart buffer (session resumption)
  // -------------------------------------------------------------------------

  /**
   * Kick off an initial async buffer on unobserved messages.
   * Called during session resumption for a head start before the first prompt().
   */
  kickstartBuffer(messages: AgentMessage[], slotCount: number): void {
    if (!this.completeFn) return;
    const history = messages.slice(slotCount);
    if (history.length === 0) return;
    const watermark = this.buffering.getWatermark();
    const unobserved = history.slice(watermark);
    if (unobserved.length === 0) return;
    const unobservedTokens = unobserved.reduce(
      (sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)),
      0,
    );
    if (unobservedTokens < this.config.bufferMinTokens) return;
    // Launch async observer on the unobserved messages (non-blocking)
    this.buffering.launchObserver(
      this.completeFn,
      unobserved,
      watermark + unobserved.length,
      this.observations || null,
      this.buildObserverConfig(),
      this.logger ?? undefined,
    );
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  /**
   * Returns the current state for session persistence.
   */
  getState(): ObservationalMemoryState {
    return {
      observations: this.observations,
      continuationHint: this.continuationHint,
      observationTokenCount: this.observationTokenCount,
      generationCount: this.generationCount,
      bufferedChunks: this.buffering.getState().chunks,
    };
  }

  /**
   * Restore state from a previous session.
   *
   * Sets observations, continuation hint, token count, and generation count.
   * Restores buffering state. If a completeFn is available and observations
   * exist, updates the slot content. Kicks off an initial async buffer on
   * unobserved messages as a non-blocking head start.
   */
  restoreState(state: ObservationalMemoryState): void {
    this.observations = state.observations;
    this.continuationHint = state.continuationHint;
    this.observationTokenCount = state.observationTokenCount;
    this.generationCount = state.generationCount;

    // Discard buffered chunks from the previous session. Chunks represent
    // observations that completed async but were never activated (merged
    // into this.observations + messages trimmed). Restoring them with
    // watermark=0 would merge their observations without trimming any
    // messages, duplicating context. The observer will re-observe
    // unobserved messages naturally on the next buffer cycle.
    this.buffering.restoreState({
      chunks: [],
      watermark: 0,
    });
  }

  /**
   * Returns the current slot content string.
   */
  getSlotContent(): string {
    return this.buildSlotContent();
  }

  /**
   * Returns just the observation text.
   */
  getObservations(): string {
    return this.observations;
  }

  /**
   * Current token count of the observation content.
   */
  getObservationTokenCount(): number {
    return this.observationTokenCount;
  }

  /**
   * Whether the observer or reflector is currently running in the background.
   */
  isProcessing(): boolean {
    return this.buffering.isObserverInFlight() || this.buffering.isReflectorInFlight();
  }

  /**
   * Whether the observer specifically is in-flight.
   */
  isObserverInFlight(): boolean {
    return this.buffering.isObserverInFlight();
  }

  /**
   * Whether the reflector specifically is in-flight.
   */
  isReflectorInFlight(): boolean {
    return this.buffering.isReflectorInFlight();
  }

  /**
   * Abort all in-flight operations. Delegates to buffering.abort().
   */
  abort(): void {
    this.buffering.abort();
  }

  /**
   * Whether recall is configured.
   */
  hasRecall(): boolean {
    return this.config.recall !== undefined;
  }

  /**
   * Get the recall config if provided.
   */
  getRecallConfig(): RecallConfig | undefined {
    return this.config.recall;
  }

  // -------------------------------------------------------------------------
  // Private: Reflection handling
  // -------------------------------------------------------------------------

  /**
   * Check and handle reflection after observation activation.
   *
   * Determines whether reflection should run (sync, async, or none) based
   * on the current observation token count relative to the effective
   * reflection threshold.
   */
  private async handleReflection(): Promise<void> {
    if (!this.completeFn) return;

    const effectiveThreshold = computeEffectiveReflectionThreshold(
      this.contextWindow,
      this.config.reflectionThreshold,
      this.utilityModelContextWindow,
    );

    const reflectionAction = this.buffering.shouldReflect(
      this.observationTokenCount,
      effectiveThreshold,
      this.config.reflectionBufferActivation,
    );

    if (reflectionAction === 'none') return;

    if (reflectionAction === 'sync') {
      const previousObservations = this.observations;

      // Check for a ready buffered reflection first
      if (this.buffering.hasBufferedReflection()) {
        const buffered = this.buffering.consumeBufferedReflection();
        if (buffered) {
          this.observations = buffered.observations;
          this.observationTokenCount = estimateTokens(this.observations);
          this.generationCount++;

          this.fireReflectionEvent({
            previousObservations,
            newObservations: this.observations,
            generationCount: this.generationCount,
            compressionLevel: buffered.compressionLevel,
            timestamp: new Date(),
          });
          return;
        }
      }

      // No buffered reflection, run synchronously
      const output = await runReflector(
        this.completeFn,
        this.observations,
        this.buildReflectorConfig(effectiveThreshold),
      );

      this.observations = output.observations;
      this.observationTokenCount = estimateTokens(this.observations);
      this.generationCount++;

      this.fireReflectionEvent({
        previousObservations,
        newObservations: this.observations,
        generationCount: this.generationCount,
        compressionLevel: output.compressionLevel,
        timestamp: new Date(),
      });
      return;
    }

    if (reflectionAction === 'async') {
      // Launch async reflector
      const effectiveThresholdForReflector = computeEffectiveReflectionThreshold(
        this.contextWindow,
        this.config.reflectionThreshold,
        this.utilityModelContextWindow,
      );

      this.buffering.launchReflector(
        this.completeFn,
        this.observations,
        this.buildReflectorConfig(effectiveThresholdForReflector),
        this.logger ?? undefined,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private: Config builders (exactOptionalPropertyTypes safe)
  // -------------------------------------------------------------------------

  /**
   * Build the observer config object without assigning undefined to optional
   * properties (exactOptionalPropertyTypes is enabled).
   */
  private buildObserverConfig(): { previousObserverTokens: number; observerInstruction?: string } {
    const config: { previousObserverTokens: number; observerInstruction?: string } = {
      previousObserverTokens: this.config.previousObserverTokens,
    };
    if (this.config.observerInstruction !== undefined) {
      config.observerInstruction = this.config.observerInstruction;
    }
    return config;
  }

  /**
   * Build the reflector config object without assigning undefined to optional
   * properties (exactOptionalPropertyTypes is enabled).
   */
  private buildReflectorConfig(threshold: number): { reflectionThreshold: number; reflectorInstruction?: string } {
    const config: { reflectionThreshold: number; reflectorInstruction?: string } = {
      reflectionThreshold: threshold,
    };
    if (this.config.reflectorInstruction !== undefined) {
      config.reflectorInstruction = this.config.reflectorInstruction;
    }
    return config;
  }

  // -------------------------------------------------------------------------
  // Private: Chunk merging
  // -------------------------------------------------------------------------

  /**
   * Merge buffered observation chunks into a single observation text.
   *
   * Concatenates all chunk observation texts with double newlines. Uses
   * the latest chunk's currentTask and suggestedResponse (latest wins).
   */
  private mergeChunks(
    chunks: ObservationChunk[],
  ): { observations: string; hint: ContinuationHint | null } {
    const observationParts: string[] = [];
    let hint: ContinuationHint | null = null;

    for (const chunk of chunks) {
      observationParts.push(chunk.observations);

      // Latest chunk wins for continuation hint
      if (chunk.currentTask || chunk.suggestedResponse) {
        hint = {
          currentTask: chunk.currentTask ?? '',
          suggestedResponse: chunk.suggestedResponse ?? '',
        };
      }
    }

    return {
      observations: observationParts.join('\n\n'),
      hint,
    };
  }

  // -------------------------------------------------------------------------
  // Private: Event firing
  // -------------------------------------------------------------------------

  /**
   * Fire all observation handlers. Each handler is individually try/catch
   * wrapped to prevent one handler from breaking others.
   */
  private fireObservationEvent(event: ObservationEvent): void {
    for (const handler of this.observationHandlers) {
      try {
        handler(event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger?.warn(`Observation handler threw: ${message}`);
      }
    }
  }

  /**
   * Fire all reflection handlers. Each handler is individually try/catch
   * wrapped to prevent one handler from breaking others.
   */
  private fireReflectionEvent(event: ReflectionEvent): void {
    for (const handler of this.reflectionHandlers) {
      try {
        handler(event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger?.warn(`Reflection handler threw: ${message}`);
      }
    }
  }
}
