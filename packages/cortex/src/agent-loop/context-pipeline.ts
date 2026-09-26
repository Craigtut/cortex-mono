/**
 * The context pipeline: what the model sees on each call. The composed
 * transformContext hook (insertion cap, view injections at the history
 * boundary, sanitization, compaction, cache-breakpoint indices), the
 * consumer-fed headline block, and idle digestion (the same pipeline run
 * outside a prompt, in idle windows).
 *
 * The digestion generation guards abandoned passes: a timed-out or
 * preempted digestion pass is abandoned, not cancelled (nothing can
 * cancel its utility call), so it can settle minutes later, after the gate
 * released and a real prompt appended messages. Advancing the generation
 * at abandonment makes that late continuation discard itself: it must
 * neither rewrite history from its stale snapshot nor lower the blocking
 * flag under a later pass.
 *
 * Reference: context-manager.md, observational-memory-architecture.md
 */

import { computeCacheBreakpointIndices } from '../cache-breakpoints.js';
import type { CacheBreakpointIndices } from '../cache-breakpoints.js';
import type { CompactionManager } from '../compaction/index.js';
import { DEFAULT_IDLE_DIGESTION_OBSERVER_TIMEOUT_MS } from '../compaction/observational/index.js';
import type { AgentContext, AgentMessage, ContextManager } from '../context-manager.js';
import { errorMessageOf } from '../error-classifier.js';
import { withPlaceholderContent } from '../pi-message.js';
import { estimateTokens } from '../token-estimator.js';
import type { CortexLogger } from '../types.js';
import { ABORTED, raceAbort, raceTimeout } from './run-control.js';
import type { LoopGate } from './run-control.js';

/** Options for {@link AgentLoop.digestIdle}. */
export interface IdleDigestionOptions {
  /**
   * Wall-clock budget applied to EACH bounded phase of the digestion
   * (default 60s): the observer catch-up waits, and then the blocking
   * threshold pass (activation, reflection, classic summarization). Idle
   * digestion holds the loop gate, so a hung utility request in either
   * phase must time the digestion out (the hung call left in flight)
   * rather than wedge the gate: while the gate is wedged, prompt() fails
   * fast and parked wake deliveries wait on the sweep behind it. The
   * timed-out pass is invalidated: if the hung call settles later, its
   * history mutations are discarded rather than applied over live state.
   */
  observerTimeoutMs?: number;
  /**
   * Preempts the digestion: when it aborts, the pass stops waiting exactly
   * as a timeout would (the in-flight call is left to settle and its
   * mutations are discarded) and releases the gate at once. An owner that
   * digests in idle windows aborts it when input arrives, so a user's next
   * words never wait behind background compaction.
   */
  signal?: AbortSignal;
}

/** Result of {@link AgentLoop.digestIdle}. */
export interface IdleDigestionResult {
  /**
   * Whether an observer call ran to completion to buffer unobserved
   * history. False also covers a wait abandoned at observerTimeoutMs.
   */
  observerRan: boolean;
  /**
   * Whether the threshold pass changed the durable history (observation
   * activation trimmed it, or summarization rewrote it).
   */
  historyCompacted: boolean;
  /** Whether the pass was cut short by {@link IdleDigestionOptions.signal}. */
  preempted?: boolean;
}

/**
 * Default hard token cap for the consumer-fed headline block. Injected
 * user-role content is never trimmed by microcompaction, so an unbounded
 * block would inflate utilization (triggering early source compaction)
 * without itself shrinking; the cap is enforced here, not downstream.
 */
const DEFAULT_HEADLINE_MAX_TOKENS = 2_000;

/** Marker appended when a headline block is cut at its token cap. */
const HEADLINE_TRUNCATION_MARKER = '\n[headline block truncated]';

/**
 * The consumer-fed headline block: rebuilt from the provider on every LLM
 * call, view-injected after the BP3 cache boundary (never in the cached
 * prefix, never in the transcript), hard token-capped.
 */
export class HeadlineFeed {
  private provider: (() => string | null) | null = null;
  private maxTokens = DEFAULT_HEADLINE_MAX_TOKENS;

  constructor(private readonly logger: CortexLogger) {}

  get current(): (() => string | null) | null {
    return this.provider;
  }

  set(
    provider: (() => string | null) | null,
    options?: { maxTokens?: number },
  ): void {
    this.provider = provider;
    if (options?.maxTokens !== undefined) {
      if (!Number.isFinite(options.maxTokens) || options.maxTokens <= 0) {
        throw new Error('setHeadlineProvider maxTokens must be a positive finite number');
      }
      this.maxTokens = options.maxTokens;
    }
  }

  /** The capped block for the current LLM call, or null when none was provided. */
  build(): string | null {
    if (!this.provider) return null;
    let content: string | null;
    try {
      content = this.provider();
    } catch (err) {
      this.logger.warn('headline provider threw', {
        error: errorMessageOf(err),
      });
      return null;
    }
    if (!content || content.trim().length === 0) return null;
    if (estimateTokens(content) <= this.maxTokens) return content;
    // Hard cap: cut at the estimator's character budget, marker included.
    const budgetChars = Math.max(
      0,
      this.maxTokens * 4 - HEADLINE_TRUNCATION_MARKER.length,
    );
    return content.slice(0, budgetChars) + HEADLINE_TRUNCATION_MARKER;
  }
}

export interface ContextPipelinePorts {
  agentState(): {
    systemPrompt?: string;
    model?: unknown;
    messages: AgentMessage[];
    tools?: unknown[];
    thinkingLevel?: unknown;
  };
  setAgentMessages(messages: AgentMessage[]): void;
  slots: Pick<ContextManager, 'slotCount' | 'setSlot'>;
  compaction(): CompactionManager;
  /**
   * View injections for the next call: `stable` content (ephemeral context,
   * loaded skills) holds within a turn and may sit inside the cached
   * prefix; `volatile` content (background task state) churns every tick.
   */
  injections(): { stable: string[]; volatile: string[] };
  /** Where old history ends and the current tick's messages begin. */
  boundary(): number;
  setBoundary(boundary: number): void;
  isPrompting(): boolean;
  gate: LoopGate;
  assertNotShuttingDown(): void;
  isShuttingDown(): boolean;
  logger: CortexLogger;
}

export class ContextPipeline {
  readonly headline: HeadlineFeed;
  // Set while digest() runs the transform pipeline, so the compaction
  // manager runs its blocking work (sync observer, summarization) even
  // under the non-blocking posture: the idle window is exactly where that
  // work is supposed to happen.
  private forceBlockingCompaction = false;
  // Generation token for transform/digestion passes (see the module doc).
  private digestionGeneration = 0;
  // Computed in the hook (which has the transformed message array) and read
  // by pi's onPayload (which has the final Anthropic API params): the API
  // message indices where the BP2 and BP3 cache_control breakpoints go.
  private breakpointIndices: CacheBreakpointIndices | null = null;

  constructor(private readonly ports: ContextPipelinePorts) {
    this.headline = new HeadlineFeed(ports.logger);
  }

  get cacheBreakpointIndices(): CacheBreakpointIndices | null {
    return this.breakpointIndices;
  }

  set cacheBreakpointIndices(indices: CacheBreakpointIndices | null) {
    this.breakpointIndices = indices;
  }

  hook(): (context: AgentContext) => Promise<AgentContext> {
    const slotCount = this.ports.slots.slotCount;

    return async (context: AgentContext): Promise<AgentContext> => {
      const sourceMessages = context.messages;
      // Generation this pass runs under. digestIdle() advances it when it
      // abandons a timed-out pass; from then on this pass's continuation is
      // stale and must not touch live state (its hung call can settle after
      // a later prompt appended messages to the same live history).
      const passGeneration = this.digestionGeneration;
      const passIsStale = (): boolean => passGeneration !== this.digestionGeneration;

      // Step 0: Apply Tier 1 insertion-time cap to the source messages.
      // Mutate the active transformContext source array, not only
      // agent.state.messages. Pi-agent-core keeps its own in-loop
      // currentContext.messages array and does not replace it with the
      // transformContext return value, so source mutations must hit this
      // array to persist for the next turn in the same loop.
      // passIsStale is threaded in: the aggregate phase awaits a consumer
      // persistResult, and an abandoned pass settling there must not write
      // a stale message back into an array a later splice has changed.
      await this.ports.compaction().applyInsertionCap(
        sourceMessages,
        slotCount,
        passIsStale,
      );
      if (passIsStale()) return context;
      this.ports.setAgentMessages([...sourceMessages]);

      // Step 1: Insert ephemeral and skill buffer at the boundary position
      // (after old history, before new tick content).
      // This keeps the tick prompt as the last message for better model
      // attention and enables cross-tick conversation history caching.
      // Previously, ephemeral was appended at the END of messages, making
      // it the "last user message" where pi-ai places BP4. That meant
      // the entire conversation history was cache-WRITTEN but never
      // cache-READ because the ephemeral prefix changed every tick.
      const boundary = this.ports.boundary();
      let result = this.injectedSnapshot(context, boundary);

      // Step 3: Compaction (all three layers integrated)
      // Source-history compaction operates on the active pi-agent-core loop
      // transcript and syncs that result back to agent.state.messages. The
      // returned context alone only affects the immediate LLM call.
      result = await this.ports.compaction().applyInTransformContext(
        result,
        // getHistory: extract conversation history (post-slot region)
        (ctx) => ctx.messages.slice(slotCount),
        // setHistory: replace conversation history in the context
        (ctx, history) => ({
          ...ctx,
          messages: [...ctx.messages.slice(0, slotCount), ...history],
        }),
        // getSourceHistory: get original transcript history from the active
        // pi-agent-core loop context, not only agent.state.messages.
        () => sourceMessages.slice(slotCount),
        // setSourceHistory: replace original transcript after compaction in
        // both the active loop context and the persisted agent state.
        // Covers the observational activation trim and sync-observer paths
        // and the classic summarizer rewrite: all of them land here.
        (history) => {
          if (passIsStale()) {
            // An abandoned digestIdle() pass settling late: its snapshot
            // predates messages a real prompt has since appended, so this
            // rewrite would silently destroy them. Discard it.
            this.ports.logger.warn('discarding history rewrite from an abandoned digestion pass');
            return;
          }
          // Adjust boundary after compaction. This recalculation is exact
          // only while every rewrite keeps the current tick's messages as a
          // contiguous suffix of `history`; all setSourceHistory callers
          // hold that today, and a strategy that breaks it skews the tick
          // boundary silently.
          const currentTickCount = sourceMessages.length - this.ports.boundary();
          sourceMessages.splice(slotCount, sourceMessages.length - slotCount, ...history);
          this.ports.setAgentMessages([...sourceMessages]);
          // Recalculate boundary: new total minus current-tick messages
          this.ports.setBoundary(Math.max(
            slotCount,
            sourceMessages.length - currentTickCount,
          ));
        },
        // digestIdle() re-enables blocking work for its pass; otherwise the
        // manager's configured posture decides. Staleness is threaded so an
        // abandoned pass suppresses its compaction/observation/reflection
        // event dispatch: its rewrite is discarded (setSourceHistory
        // above), and a consumer must never see a compaction reported for
        // a rewrite that never landed.
        {
          ...(this.forceBlockingCompaction ? { allowBlocking: true } : {}),
          isStale: passIsStale,
        },
      );
      // A pass abandoned while the manager call hung must not mutate the
      // live observation slot or breakpoint state either; its return value
      // goes nowhere.
      if (passIsStale()) return result;

      // After compaction/observation runs, update the observation slot
      if (this.ports.compaction().strategy === 'observational') {
        const slotContent = this.ports.compaction().getObservationSlotContent();
        if (slotContent) {
          this.ports.slots.setSlot('_observations', slotContent);
          // Also update the in-memory context for this LLM call so the
          // returned context reflects post-reflection observation content
          if (this.ports.compaction().hasObservations()) {
            const obsSlotIndex = this.ports.slots.slotCount - 1;
            if (obsSlotIndex >= 0 && obsSlotIndex < result.messages.length) {
              result.messages[obsSlotIndex] = { role: 'user', content: slotContent, timestamp: Date.now() };
            }
          }
        }
      }

      // Step 4: Compute API message indices for cache breakpoints.
      // Count how messages map from our array to the Anthropic API format
      // (convertMessages skips empty messages and merges consecutive
      // toolResults). The indices are consumed by the onPayload hook.
      //
      // BP3 covers old history plus the stable injections (ephemeral and
      // skills, which hold constant across ticks within a turn). Background
      // task state churns every tick, so it is injected after this boundary
      // and stays outside the cached prefix.
      const stableInjectionCount = this.ports.injections().stable.length;
      this.breakpointIndices = computeCacheBreakpointIndices(result.messages, {
        slotCount,
        boundary: this.ports.boundary() + stableInjectionCount,
      });

      return result;
    };
  }

  /** The loop's live context as pi would hand it to transformContext. */
  snapshot(): AgentContext {
    const state = this.ports.agentState();
    return {
      systemPrompt: state.systemPrompt ?? '',
      model: state.model ?? null,
      messages: this.ports.agentState().messages,
      tools: (state.tools ?? []) as unknown[],
      thinkingLevel: typeof state.thinkingLevel === 'string'
        ? state.thinkingLevel
        : 'medium',
    };
  }

  /**
   * `context` with the view injections inserted at `boundary` (after old
   * history, before the current tick's messages), then sanitized.
   */
  private injectedSnapshot(
    context: AgentContext,
    boundary: number,
  ): AgentContext {
    let result = context;
    // Injections are ordered by stability: ephemeral and skills hold
    // constant across ticks within a turn, so the BP3 cache breakpoint can
    // sit after them. Background task state and the headline block churn
    // every tick and come last, outside the cached prefix, while still
    // being built here so token estimation and compaction see them.
    const { stable, volatile } = this.ports.injections();
    const headline = this.headline.build();
    const injections: AgentMessage[] = [...stable, ...volatile, ...(headline ? [headline] : [])]
      .map((content) => ({ role: 'user' as const, content, timestamp: Date.now() }));

    if (injections.length > 0) {
      // Insert at boundary: [...slots + old_history] [injections] [...new_tick_content]
      const messages = [...result.messages];
      // boundary may exceed array length on first tick or after reset
      const insertIdx = Math.min(boundary, messages.length);
      messages.splice(insertIdx, 0, ...injections);
      result = { ...result, messages };
    }

    // Sanitize messages before token estimation or compaction.
    return {
      ...result,
      messages: result.messages.map(withPlaceholderContent),
    };
  }

  /** Heuristic token size of the context the next LLM call would send. */
  estimateTokens(): number {
    const boundary = this.ports.isPrompting()
      ? this.ports.boundary()
      : this.ports.agentState().messages.length;
    const snapshot = this.injectedSnapshot(
      this.snapshot(),
      boundary,
    );
    return this.ports.compaction().estimateCurrentContextTokens(snapshot);
  }

  digest(options?: IdleDigestionOptions): Promise<IdleDigestionResult> {
    this.ports.assertNotShuttingDown();
    return this.ports.gate.enqueue(async () => {
      if (this.ports.isShuttingDown()) {
        return { observerRan: false, historyCompacted: false };
      }
      // Every wait below races the owner's preemption signal.
      const signal = options?.signal;
      if (signal?.aborted) {
        return { observerRan: false, historyCompacted: false, preempted: true };
      }

      // 1. Buffer catch-up (observational only): make sure the expensive
      // observer work over the unobserved tail is done and chunked, so the
      // next activation is a cheap merge. Preempting abandons only the
      // wait, like the timeout: the observer lands its chunk when it
      // settles.
      let observerRan = false;
      if (this.ports.compaction().strategy === 'observational') {
        const outcome = await raceAbort(
          this.ports.compaction().digestPendingObservationBuffers(
            this.ports.agentState().messages,
            this.ports.slots.slotCount,
            options?.observerTimeoutMs,
          ),
          signal,
        );
        if (outcome === ABORTED) {
          this.ports.logger.debug('idle digestion preempted during observer catch-up');
          return { observerRan: false, historyCompacted: false, preempted: true };
        }
        observerRan = outcome;
      }
      if (signal?.aborted) {
        return { observerRan, historyCompacted: false, preempted: true };
      }
      return this.runThresholdPass(observerRan, options);
    });
  }

  /**
   * Phase 2 of {@link digest}, under the gate it holds: the threshold
   * pass, bounded by the timeout and by preemption, which abandon it the
   * same way.
   */
  private async runThresholdPass(
    observerRan: boolean,
    options?: IdleDigestionOptions,
  ): Promise<IdleDigestionResult> {
    // 2. Threshold pass: run the same pipeline transformContext runs
    // against the live source history. Source mutations (activation
    // trims, summarization rewrites) persist; the returned view is
    // discarded. _forceBlockingCompaction lets the manager run its
    // synchronous paths regardless of the configured posture; those
    // paths block on utility requests (reflection, summarization), so
    // the pass shares the observer deadline rather than holding the
    // gate indefinitely behind a hung request.
    const lengthBefore = this.ports.agentState().messages.length;
    const hook = this.hook();
    const passGeneration = this.digestionGeneration;
    this.forceBlockingCompaction = true;
    const thresholdPass = (async () => {
      try {
        await hook(this.snapshot());
      } finally {
        // Only the pass that still owns the current generation may lower
        // the flag: an abandoned pass settling here while a LATER pass is
        // mid-flight would otherwise silently degrade that pass to the
        // non-blocking posture.
        if (passGeneration === this.digestionGeneration) {
          this.forceBlockingCompaction = false;
        }
      }
    })();
    const timeoutMs = options?.observerTimeoutMs ?? DEFAULT_IDLE_DIGESTION_OBSERVER_TIMEOUT_MS;
    const outcome = await raceTimeout(thresholdPass, timeoutMs, options?.signal);
    const wasPreempted = outcome === 'aborted';
    if (outcome !== 'settled') {
      // Abandoned (timed out or preempted), not cancelled: nothing can
      // cancel the utility call, so it can still settle minutes from
      // now, after the gate released and a real prompt appended live
      // messages. Advance the generation so that late continuation
      // discards itself instead of replacing live history from its stale
      // snapshot, and lower the flag for the pass (its own finally is now
      // stale). The race already swallows the eventual settlement.
      this.digestionGeneration += 1;
      this.forceBlockingCompaction = false;
      if (wasPreempted) {
        this.ports.logger.debug('idle digestion threshold pass preempted');
      } else {
        this.ports.logger.warn('idle digestion threshold pass timed out', { timeoutMs });
      }
    }
    const historyCompacted = this.ports.agentState().messages.length !== lengthBefore;

    this.ports.logger.debug('idle digestion complete', { observerRan, historyCompacted });
    return { observerRan, historyCompacted, ...(wasPreempted ? { preempted: true } : {}) };
  }
}
