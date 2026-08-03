/**
 * CortexAgent: the composite facade over the AgentLoop primitive
 * (docs/cortex/duplex/facade-api.md, architecture.md).
 *
 * Consumers interact with one CortexAgent. Internally it owns the resident
 * loop(s), the session log, settlement predicates, and composite
 * persistence. Two modes:
 *
 * - `passthrough` (the default until Phase 2b lands): a single reasoner
 *   loop, reproducing direct AgentLoop behavior exactly. This is the
 *   consumer opt-out and the parity baseline for tests.
 * - `duplex`: a fast talker loop fronting the reasoner. NOT IMPLEMENTED
 *   YET; constructing with it throws until Phase 2b.
 *
 * The talker/reasoner split is never exposed in this API; consumer config
 * is routed internally per the routing table below.
 */

import { AgentLoop } from './agent-loop.js';
import type {
  DeliverResult,
  DirectCompletionOptions,
  IdleDigestionOptions,
  IdleDigestionResult,
} from './agent-loop.js';
import type { DirectCompletionContext } from './cache-breakpoints.js';
import type {
  AgentLoopConfig,
  AgentTextOutput,
  ClassifiedError,
  CompactionDegradedInfo,
  CompactionExhaustedInfo,
  CompactionResult,
  CompactionTarget,
  CortexLifecycleState,
  CortexLogger,
  CortexUsage,
  DeadLetteredBackgroundResult,
  LoopOriginContext,
  McpConnectionState,
  McpToolCallProgress,
  McpTransportConfig,
  ModelThinkingCapabilities,
  PendingAsk,
  RetryExhaustedInfo,
  RetryScheduledInfo,
  RetrySucceededInfo,
  SessionUsage,
  SubAgentSnapshot,
  SubAgentSpawnConfig,
  ThinkingLevel,
} from './types.js';
import type { CortexTool } from './tool-contract.js';
import type { CortexModel } from './model-wrapper.js';
import type { AgentMessage } from './context-manager.js';
import type { ContextManager } from './context-manager.js';
import type { EventBridge } from './event-bridge.js';
import type { BudgetGuard } from './budget-guard.js';
import type { SkillRegistry } from './skill-registry.js';
import type {
  ObservationEvent,
  ObservationalMemoryState,
  ReflectionEvent,
} from './compaction/index.js';
import { SessionLog } from './session-log.js';
import type { SessionLogEntry, SessionLogSubscriber } from './session-log.js';
import { NOOP_LOGGER } from './noop-logger.js';

// ---------------------------------------------------------------------------
// Modes and config
// ---------------------------------------------------------------------------

/**
 * Facade mode. `passthrough` routes everything to the single reasoner loop
 * and reproduces direct AgentLoop behavior exactly. `duplex` (talker +
 * reasoner) is the planned default once Phase 2b lands (decisions.md D14);
 * until then requesting it throws rather than silently degrading to
 * passthrough.
 */
export type CortexAgentMode = 'passthrough' | 'duplex';

/** Scope for {@link CortexAgent.abort} (facade-api.md abort table). */
export type CortexAbortScope = 'conversation' | 'work' | 'all';

/** Talker-loop overrides (consumed in duplex mode, Phase 2b). */
export interface TalkerConfig {
  /**
   * Talker model. Default: a fast tier resolved from the primary provider.
   * The talker's toolset is fixed (control tools only, decisions.md D5/D8);
   * consumer tools never route to it.
   */
  model?: CortexModel;
}

/** Session log tuning (retention and subscriber buffering). */
export interface CortexSessionLogConfig {
  /** Retention cap on held entries (see SessionLogOptions.maxEntries). */
  maxEntries?: number;
  /** Per-subscriber buffer bound (see SessionLogOptions.maxSubscriberBuffer). */
  maxSubscriberBuffer?: number;
}

/**
 * Configuration for CortexAgent.create(). Everything AgentLoopConfig has,
 * plus the facade's own keys, routed per {@link CONFIG_ROUTING}.
 */
export interface CortexAgentConfig extends AgentLoopConfig {
  /** Consumer tools. Routed to the reasoner only (decisions.md D5). */
  tools?: CortexTool[];
  /** Facade mode. Default: 'passthrough' until Phase 2b. */
  mode?: CortexAgentMode;
  /** Talker overrides (duplex mode, Phase 2b). */
  talker?: TalkerConfig;
  /**
   * Consumer idle signal for the wake policy (duplex mode, Phase 2b): is
   * the user/channel idle right now? Advisory; the facade enforces its own
   * minimum inter-delivery spacing.
   */
  idleSignal?: () => boolean;
  /** Session log retention and subscription tuning. */
  sessionLog?: CortexSessionLogConfig;
  /**
   * Debounce for the onStateChanged persistence trigger, in ms.
   * Default: 500.
   */
  stateChangeDebounceMs?: number;
}

// ---------------------------------------------------------------------------
// Config routing
// ---------------------------------------------------------------------------

/**
 * Where a config key lands (docs/cortex/duplex/facade-api.md). In
 * passthrough mode every non-facade destination resolves to the reasoner
 * (it is the only loop); the distinctions below describe what Phase 2b's
 * duplex assembly does with the same key.
 *
 * - `reasoner`: the reasoner loop only; never the talker.
 * - `both-loops`: both resident loops, identical content.
 * - `per-loop`: each loop gets its own value derived from this one.
 * - `shared`: passed to every loop verbatim (environment-level).
 * - `facade`: consumed by the facade itself; never reaches a loop config.
 */
export type ConfigDestination =
  | 'reasoner'
  | 'both-loops'
  | 'per-loop'
  | 'shared'
  | 'facade';

/**
 * The complete config routing table, key by key. This mapped object is the
 * contract: adding a key to AgentLoopConfig or CortexAgentConfig without
 * routing it here is a compile error, so no key can silently diverge
 * (review-findings.md F18). Runtime routing derives from it: 'facade' keys
 * are stripped before the loop config is built.
 */
export const CONFIG_ROUTING: { [K in keyof Required<CortexAgentConfig>]: ConfigDestination } = {
  // Reasoner-only: the talker has its own dial (talker.model + a facade
  // thinking default) in 2b.
  model: 'reasoner',
  thinkingLevel: 'reasoner',
  // Consumer tools are wired to the reasoner only (D5); the talker's
  // toolset is the fixed control tools.
  tools: 'reasoner',
  // Both loops, identical content, no per-slot routing (D6).
  slots: 'both-loops',
  // Both loops in full; the talker's role prompt is appended to it in 2b.
  initialBasePrompt: 'both-loops',
  // Both loops run independent compaction managers in 2b; the talker is
  // forced to a non-blocking posture internally.
  compaction: 'both-loops',
  // Reasoner (and sub-agents by inheritance). In 2b the facade adds an
  // aggregate guard across every loop, and the talker gets a facade-set
  // hard maxTurns that consumer config cannot raise. Not added in
  // passthrough: a facade-level guard on a single loop would double-guard
  // today's behavior and break parity.
  budgetGuard: 'reasoner',
  // Reasoner and sub-agents; the talker gets fail-fast defaults in 2b so a
  // transient error never becomes minutes of silence.
  retryPolicy: 'reasoner',
  // Direct passthrough today; the facade permission broker owns it in
  // duplex (2b), and the talker loop receives no resolver at all.
  resolvePermission: 'reasoner',
  // Same broker pipeline as resolvePermission in 2b.
  resolveNetworkAccess: 'reasoner',
  // Facade broker input in 2b (bypasses voicing when set); reasoner today.
  isAutoApprove: 'reasoner',
  // Reasoner and sub-agents.
  toolExecution: 'reasoner',
  disableTools: 'reasoner',
  deferredTools: 'reasoner',
  toolResultThresholds: 'reasoner',
  webFetch: 'reasoner',
  bash: 'reasoner',
  // Both loops (the talker uses working tags to separate thinking from
  // speech in 2b).
  workingTags: 'both-loops',
  // Per loop, derived from each loop's model in 2b.
  contextWindowLimit: 'per-loop',
  // Per loop in 2b (the same-provider constraint is enforced per loop).
  utilityModel: 'per-loop',
  // Reasoner pool config; quick lookups get a separate facade-owned pool
  // in 2b.
  maxConcurrentSubAgents: 'reasoner',
  subAgentPools: 'reasoner',
  onBeforeSubAgentSpawn: 'reasoner',
  canSpawnSubAgent: 'reasoner',
  // Long-lived loop posture. Consumer value applies to the reasoner; the
  // facade sets the talker's own posture in 2b.
  persistentRuntime: 'reasoner',
  // Shared environment-level wiring, passed to every loop verbatim.
  getApiKey: 'shared',
  sandbox: 'shared',
  envOverrides: 'shared',
  logger: 'shared',
  workingDirectory: 'shared',
  diagnostics: 'shared',
  // Shared; the loop stamps origin (loopPath) into persistence metadata.
  persistResult: 'shared',
  // The facade derives distinct stable per-loop cache ids from it in 2b.
  // The reasoner keeps the bare consumer id in both modes, so a session
  // that flips modes keeps its reasoner prefix cache warm.
  sessionId: 'per-loop',
  // Passthrough keeps the consumer's loop path (default 'main') so origin
  // context matches direct AgentLoop use exactly; the 2b duplex assembly
  // overrides per loop ('talker' / 'reasoner').
  loopPath: 'per-loop',
  // Facade-owned keys, never part of a loop config.
  mode: 'facade',
  talker: 'facade',
  idleSignal: 'facade',
  sessionLog: 'facade',
  stateChangeDebounceMs: 'facade',
};

/**
 * Build the reasoner's AgentLoop config from consumer config by dropping
 * the facade-owned keys. Every other key flows through unchanged: in
 * passthrough the reasoner is the only loop, so 'both-loops', 'per-loop',
 * and 'shared' destinations all resolve to it. Exported for tests.
 */
export function buildReasonerConfig(
  config: CortexAgentConfig,
): AgentLoopConfig & { tools?: CortexTool[] } {
  const routed: Record<string, unknown> = {};
  for (const key of Object.keys(CONFIG_ROUTING) as Array<keyof CortexAgentConfig>) {
    if (CONFIG_ROUTING[key] === 'facade') continue;
    if (key in config) {
      routed[key] = config[key];
    }
  }
  return routed as unknown as AgentLoopConfig & { tools?: CortexTool[] };
}

// ---------------------------------------------------------------------------
// Facade deliver options
// ---------------------------------------------------------------------------

/** Options for {@link CortexAgent.deliver}. */
export interface CortexDeliverOptions {
  /**
   * Whether the delivery may wake an idle loop by starting a turn.
   * Default true. See AgentLoop.deliver.
   */
  wake?: boolean;
  /**
   * Which surface the input addresses. In passthrough both resolve to the
   * reasoner; in duplex (2b) 'conversation' is the talker and 'work' the
   * reasoner. Default: 'conversation'.
   */
  target?: 'conversation' | 'work';
}

// ---------------------------------------------------------------------------
// CortexAgent
// ---------------------------------------------------------------------------

const DEFAULT_STATE_DEBOUNCE_MS = 500;

/** One macrotask yield: lets pending microtask cascades finish. */
function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class CortexAgent {
  private readonly reasoner: AgentLoop;
  private readonly mode: CortexAgentMode;
  private readonly log: SessionLog;
  private readonly logger: CortexLogger;

  /** Serializes facade prompt() calls (concurrent prompts queue, never throw). */
  private promptChain: Promise<void> = Promise.resolve();
  /** Facade prompts accepted but not yet settled (chain-queued or running). */
  private pendingFacadePrompts = 0;

  /**
   * Seq of the utterance whose facade-initiated run is currently live.
   * Entries produced by that run (replies, errors, spawn lifecycle) carry
   * it as their causation stamp. Null while no facade-initiated run is
   * live; entries produced then (e.g. by a background delivery run) carry
   * no stamp rather than a guessed one.
   */
  private activeCauseSeq: number | null = null;
  /** Spawn lifecycle seq per live task, for completion causation. */
  private readonly spawnSeqByTaskId = new Map<string, number>();

  private destroyPromise: Promise<void> | null = null;
  private destroyed = false;

  private constructor(reasoner: AgentLoop, config: CortexAgentConfig) {
    this.mode = config.mode ?? 'passthrough';
    if (this.mode === 'duplex') {
      throw new Error(
        'CortexAgent duplex mode is not implemented yet (Phase 2b). ' +
        "Use mode: 'passthrough' (the current default).",
      );
    }
    this.reasoner = reasoner;
    const baseLogger = config.logger ?? NOOP_LOGGER;
    this.logger = {
      debug: (message, data) => baseLogger.debug(`[CortexAgent] ${message}`, data),
      info: (message, data) => baseLogger.info(`[CortexAgent] ${message}`, data),
      warn: (message, data) => baseLogger.warn(`[CortexAgent] ${message}`, data),
      error: (message, data) => baseLogger.error(`[CortexAgent] ${message}`, data),
    };

    this.log = new SessionLog({
      ...(config.sessionLog?.maxEntries !== undefined
        ? { maxEntries: config.sessionLog.maxEntries }
        : {}),
      ...(config.sessionLog?.maxSubscriberBuffer !== undefined
        ? { maxSubscriberBuffer: config.sessionLog.maxSubscriberBuffer }
        : {}),
      logger: this.logger,
      onEvict: (evicted) => this.spillEvictedEntries(evicted, config),
    });

    this.wireLogProducers();
  }

  /**
   * Create a CortexAgent. Routes consumer config per {@link CONFIG_ROUTING}
   * and constructs the reasoner loop. `mode: 'duplex'` throws until Phase
   * 2b lands; passthrough reproduces direct AgentLoop behavior exactly.
   */
  static async create(config: CortexAgentConfig): Promise<CortexAgent> {
    if ((config.mode ?? 'passthrough') === 'duplex') {
      // Checked before any loop is constructed so a rejected mode cannot
      // leak a live AgentLoop.
      throw new Error(
        'CortexAgent duplex mode is not implemented yet (Phase 2b). ' +
        "Use mode: 'passthrough' (the current default).",
      );
    }
    const reasoner = await AgentLoop.create(buildReasonerConfig(config));
    return new CortexAgent(reasoner, config);
  }

  // -------------------------------------------------------------------------
  // Log producers
  // -------------------------------------------------------------------------

  /**
   * Register the facade's own handlers on the reasoner. All registrations
   * are additive (the loop keeps handler arrays), so consumer handlers and
   * their signatures are untouched; passthrough parity holds.
   */
  private wireLogProducers(): void {
    this.reasoner.onTurnComplete((output: AgentTextOutput, origin: LoopOriginContext) => {
      if (output.userFacing.trim().length === 0) return;
      this.appendEntry({
        type: 'reply',
        loopPath: origin.loopPath,
        content: output.userFacing,
      });
    });

    this.reasoner.onError((error: ClassifiedError, origin: LoopOriginContext) => {
      this.appendEntry({
        type: 'error',
        loopPath: origin.loopPath,
        content: error.originalMessage,
        data: {
          category: error.category,
          severity: error.severity,
          ...(error.causeDetail !== undefined ? { causeDetail: error.causeDetail } : {}),
        },
      });
    });

    this.reasoner.onRetryScheduled((info: RetryScheduledInfo) => {
      this.appendEntry({
        type: 'retrying',
        loopPath: this.reasoner.loopPath,
        content: info.originalMessage,
        data: {
          category: info.category,
          attempt: info.attempt,
          maxAttempts: info.maxAttempts,
          delayMs: info.delayMs,
          nextAttemptAt: info.nextAttemptAt,
        },
      });
    });

    this.reasoner.onSubAgentSpawned((taskId, instructions, background) => {
      const entry = this.appendEntry({
        type: 'lifecycle',
        loopPath: this.reasoner.loopPath,
        content: `Sub-agent ${taskId} spawned`,
        data: {
          event: 'sub_agent_spawned',
          taskId,
          background,
          instructions,
        },
      });
      this.spawnSeqByTaskId.set(taskId, entry.seq);
    });

    this.reasoner.onSubAgentCompleted((taskId, _result, status) => {
      const spawnSeq = this.spawnSeqByTaskId.get(taskId);
      this.spawnSeqByTaskId.delete(taskId);
      this.appendEntry({
        type: 'lifecycle',
        loopPath: this.reasoner.loopPath,
        content: `Sub-agent ${taskId} ${status}`,
        data: { event: 'sub_agent_completed', taskId, status },
        ...(spawnSeq !== undefined ? { causedBy: spawnSeq } : {}),
      });
    });

    this.reasoner.onSubAgentFailed((taskId, error) => {
      const spawnSeq = this.spawnSeqByTaskId.get(taskId);
      this.spawnSeqByTaskId.delete(taskId);
      this.appendEntry({
        type: 'lifecycle',
        loopPath: this.reasoner.loopPath,
        content: `Sub-agent ${taskId} failed: ${error}`,
        data: { event: 'sub_agent_failed', taskId, error },
        ...(spawnSeq !== undefined ? { causedBy: spawnSeq } : {}),
      });
    });

    this.reasoner.onBackgroundResultDeadLettered((result: DeadLetteredBackgroundResult) => {
      this.appendEntry({
        type: 'lifecycle',
        loopPath: this.reasoner.loopPath,
        content: `Background ${result.kind} ${result.taskId} delivery dead-lettered after ${result.attempts} attempts`,
        data: {
          event: 'delivery_dead_lettered',
          kind: result.kind,
          taskId: result.taskId,
          attempts: result.attempts,
          lastError: result.lastError,
        },
      });
    });
  }

  /**
   * Append a log entry, stamping causation from the live facade-initiated
   * run unless the caller supplies (or suppresses, with null) its own.
   */
  private appendEntry(input: {
    type: SessionLogEntry['type'];
    loopPath: string;
    content: string;
    causedBy?: number | null;
    data?: Record<string, unknown>;
  }): SessionLogEntry {
    const causedBy = input.causedBy === null
      ? undefined
      : input.causedBy ?? this.activeCauseSeq ?? undefined;
    return this.log.append({
      type: input.type,
      loopPath: input.loopPath,
      content: input.content,
      ...(causedBy !== undefined ? { causedBy } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    });
  }

  /** Spill retention-evicted entries through persistResult when configured. */
  private spillEvictedEntries(evicted: SessionLogEntry[], config: CortexAgentConfig): void {
    const persist = config.persistResult;
    if (!persist) return;
    const payload = evicted.map((entry) => JSON.stringify(entry)).join('\n');
    void persist(payload, {
      toolName: '_session_log',
      category: 'non-reproducible',
      loopPath: this.reasoner.loopPath,
    }).catch((err: unknown) => {
      this.logger.warn('session log spill failed', {
        error: err instanceof Error ? err.message : String(err),
        entries: evicted.length,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Interaction surface
  // -------------------------------------------------------------------------

  /**
   * Prompt the agent. Routes to the reasoner (passthrough) or the talker
   * (duplex, 2b). Never throws on a busy loop: concurrent calls are
   * serialized by the facade, each resolving against the turn that carries
   * its input. The utterance is appended to the log before its run starts
   * (append-then-emit).
   */
  async prompt(input: string, options?: DirectCompletionOptions): Promise<unknown> {
    this.assertNotDestroyed();
    const entry = this.appendEntry({
      type: 'utterance',
      loopPath: this.reasoner.loopPath,
      content: input,
      causedBy: null,
    });

    this.pendingFacadePrompts += 1;
    const run = this.promptChain.then(async () => {
      // Wait for gate quiescence, then act in the SAME frame: between the
      // idle wait resolving and this continuation running, an unrelated
      // continuation (e.g. a background-completion drain) can seize the
      // gate, and AgentLoop.prompt() fails fast on a held gate. The
      // synchronous isLoopActive re-check closes that window exactly.
      for (;;) {
        await this.reasoner.waitForLoopIdle();
        if (this.reasoner.isLoopActive) continue;
        this.activeCauseSeq = entry.seq;
        try {
          return await this.reasoner.prompt(input, options);
        } finally {
          if (this.activeCauseSeq === entry.seq) {
            this.activeCauseSeq = null;
          }
        }
      }
    });
    const settle = (): void => {
      this.pendingFacadePrompts -= 1;
    };
    this.promptChain = run.then(settle, settle);
    return run;
  }

  /**
   * Fire-and-forget input, with the same non-throwing guarantee as
   * prompt(): the loop's own deliver() state machine decides whether the
   * content starts a turn now ('prompted'), opens the next run ('parked'),
   * or waits silently for the next real prompt ('queued').
   */
  deliver(content: string, options?: CortexDeliverOptions): DeliverResult {
    this.assertNotDestroyed();
    // Mirror AgentLoop.deliver's synchronous validation before appending,
    // so the log never records an utterance the loop rejected.
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('deliver() requires non-whitespace string content');
    }
    if (this.reasoner.getCurrentSystemPrompt().trim().length === 0) {
      throw new Error(
        'CortexAgent prompt is not configured. Call setBasePrompt() before deliver(), ' +
        'or provide initialBasePrompt during creation.',
      );
    }
    const entry = this.appendEntry({
      type: 'utterance',
      loopPath: this.reasoner.loopPath,
      content,
      causedBy: null,
      ...(options?.target !== undefined ? { data: { target: options.target } } : {}),
    });

    const result = this.reasoner.deliver(
      content,
      options?.wake !== undefined ? { wake: options.wake } : undefined,
    );
    if (result.outcome === 'prompted' && result.turn) {
      // Bind causation for the run this delivery started. Parked and
      // queued deliveries have no bindable run in passthrough (the sweep
      // batches them); their runs' entries carry no stamp.
      this.activeCauseSeq = entry.seq;
      const clear = (): void => {
        if (this.activeCauseSeq === entry.seq) {
          this.activeCauseSeq = null;
        }
      };
      void result.turn.then(clear, clear);
    }
    return result;
  }

  /**
   * Queue a steering message into the running turn (drained at the next
   * turn boundary). No-op while idle, exactly like AgentLoop.steer().
   */
  steer(message: string): void {
    this.reasoner.steer(message);
  }

  /**
   * Abort per facade-api.md scope semantics. In passthrough the single
   * reasoner is both the conversation surface and the work surface, so
   * every scope aborts its in-flight turn and clears queued deliveries and
   * pi's steering/follow-up queues; 'work' and 'all' additionally cancel
   * running sub-agents. Pending asks resolve as deny through the abort
   * race. Completed-but-undelivered background results follow today's loop
   * behavior (delivered by a later drain); routing them to the log instead
   * is duplex delivery routing (2b).
   */
  async abort(scope: CortexAbortScope = 'all'): Promise<void> {
    this.appendEntry({
      type: 'lifecycle',
      loopPath: this.reasoner.loopPath,
      content: `Abort requested (scope: ${scope})`,
      data: { event: 'abort', scope },
      causedBy: null,
    });
    // Dropped queued content: silent deliveries, parked wake deliveries
    // (abort() drops those itself too), and pi's steering/follow-up queues.
    this.reasoner.clearAllQueues();

    const work: Array<Promise<unknown>> = [this.reasoner.abort()];
    if (scope !== 'conversation') {
      for (const taskId of this.reasoner.getSubAgentManager().getActiveTaskIds()) {
        work.push(this.reasoner.cancelSubAgent(taskId));
      }
    }
    await Promise.all(work);
  }

  /** Tear down the facade and its loops. Idempotent; shares one teardown. */
  async destroy(timeoutMs?: number): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;
    this.destroyPromise = (async () => {
      try {
        await this.reasoner.destroy(timeoutMs);
      } finally {
        this.log.clearSubscribers();
      }
    })();
    return this.destroyPromise;
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error('CortexAgent has been destroyed');
    }
  }

  // -------------------------------------------------------------------------
  // Session log surface
  // -------------------------------------------------------------------------

  /**
   * Snapshot copy (never a live reference) of log entries with
   * seq >= fromSeq (all retained entries when omitted).
   */
  getLog(fromSeq?: number): SessionLogEntry[] {
    return this.log.getLog(fromSeq);
  }

  /**
   * Subscribe to log events with replay from a seq, so a reconnecting UI
   * can ask for everything since it last saw. Slow subscribers are
   * buffered to a bound and then dropped with a gap marker rather than
   * applying backpressure to the loops. Returns an idempotent unsubscribe.
   */
  subscribeLog(cb: SessionLogSubscriber, fromSeq?: number): () => void {
    return this.log.subscribeLog(cb, fromSeq);
  }

  // -------------------------------------------------------------------------
  // Settlement predicates
  // -------------------------------------------------------------------------

  /**
   * Whether the conversation surface is quiet: no facade prompt queued or
   * running and the conversation loop's gate empty. Built on gate depth,
   * not the prompting flag, which reads idle while gate tasks are queued.
   * In passthrough the conversation loop is the reasoner; in duplex (2b)
   * this keys on the talker.
   */
  get conversationIdle(): boolean {
    return this.pendingFacadePrompts === 0 && !this.reasoner.isLoopActive;
  }

  /**
   * Whether all work has settled: conversation idle, reasoner gate empty,
   * no active sub-agents (or quick lookups, 2b), no parked wake
   * deliveries, no pending permission asks. Queued silent deliveries do
   * not count: silent content deliberately waits for the next prompt.
   */
  get workSettled(): boolean {
    return (
      this.conversationIdle &&
      this.reasoner.getSubAgentManager().activeCount === 0 &&
      this.reasoner.pendingWakeDeliveryCount === 0 &&
      this.reasoner.getPendingAsks().length === 0
    );
  }

  /** Resolve once {@link conversationIdle} holds. */
  async waitForConversationIdle(): Promise<void> {
    for (;;) {
      if (this.pendingFacadePrompts > 0) {
        await this.promptChain;
        continue;
      }
      await this.reasoner.waitForLoopIdle();
      if (this.conversationIdle) return;
    }
  }

  /**
   * Resolve once {@link workSettled} holds. Event-driven where a signal
   * exists (the loop gate, sub-agent completion promises); a single
   * macrotask yield between checks lets completion cascades (a finished
   * child scheduling its delivery drain) reach the gate before the final
   * verdict.
   */
  async waitForWorkSettled(): Promise<void> {
    for (;;) {
      if (this.pendingFacadePrompts > 0) {
        await this.promptChain;
        continue;
      }
      await this.reasoner.waitForLoopIdle();

      const manager = this.reasoner.getSubAgentManager();
      const activeIds = manager.getActiveTaskIds();
      if (activeIds.length > 0) {
        const completions = activeIds
          .map((taskId) => manager.get(taskId)?.completion)
          .filter((completion) => completion !== undefined);
        await Promise.all(completions);
        await yieldMacrotask();
        continue;
      }

      if (!this.workSettled) {
        await yieldMacrotask();
        continue;
      }
      // Confirm across one macrotask: a cascade between microtasks may
      // still be about to enqueue gate work for a just-settled child.
      await yieldMacrotask();
      if (this.workSettled) return;
    }
  }

  // -------------------------------------------------------------------------
  // Delegated surface (passthrough: the reasoner loop; labeled per loop in
  // duplex once 2b lands)
  // -------------------------------------------------------------------------

  /**
   * The merged event stream. In passthrough this is the reasoner's bridge
   * verbatim, so event identity and ordering match direct AgentLoop use
   * exactly; 2b labels every event with a loop path.
   */
  getEventBridge(): EventBridge {
    return this.reasoner.getEventBridge();
  }

  getContextManager(): ContextManager {
    return this.reasoner.getContextManager();
  }

  getBudgetGuard(): BudgetGuard {
    return this.reasoner.getBudgetGuard();
  }

  getSkillRegistry(): SkillRegistry {
    return this.reasoner.getSkillRegistry();
  }

  // Prompt and model surface -----------------------------------------------

  setBasePrompt(basePrompt: string): string {
    return this.reasoner.setBasePrompt(basePrompt);
  }

  getBasePrompt(): string {
    return this.reasoner.getBasePrompt();
  }

  getCurrentSystemPrompt(): string {
    return this.reasoner.getCurrentSystemPrompt();
  }

  getModel(): CortexModel {
    return this.reasoner.getModel();
  }

  setModel(model: CortexModel): void {
    this.reasoner.setModel(model);
  }

  getUtilityModel(): CortexModel {
    return this.reasoner.getUtilityModel();
  }

  setUtilityModel(model: CortexModel): void {
    this.reasoner.setUtilityModel(model);
  }

  resetUtilityModel(): void {
    this.reasoner.resetUtilityModel();
  }

  getThinkingLevel(): ThinkingLevel {
    return this.reasoner.getThinkingLevel();
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.reasoner.setThinkingLevel(level);
  }

  async getModelThinkingCapabilities(): Promise<ModelThinkingCapabilities> {
    return this.reasoner.getModelThinkingCapabilities();
  }

  async clampThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> {
    return this.reasoner.clampThinkingLevel(level);
  }

  setCacheRetention(value: 'none' | 'short' | 'long'): void {
    this.reasoner.setCacheRetention(value);
  }

  getCacheRetention(): 'none' | 'short' | 'long' | null {
    return this.reasoner.getCacheRetention();
  }

  setSessionId(value: string | null): void {
    this.reasoner.setSessionId(value);
  }

  getSessionId(): string | null {
    return this.reasoner.getSessionId();
  }

  setContextWindowLimit(limit: number | null): void {
    this.reasoner.setContextWindowLimit(limit);
  }

  get contextWindowLimit(): number | null {
    return this.reasoner.contextWindowLimit;
  }

  get effectiveContextWindow(): number {
    return this.reasoner.effectiveContextWindow;
  }

  get currentContextTokenCount(): number {
    return this.reasoner.currentContextTokenCount;
  }

  estimateCurrentContextTokens(): number {
    return this.reasoner.estimateCurrentContextTokens();
  }

  // Direct completions ------------------------------------------------------

  async directComplete(
    context: DirectCompletionContext,
    options?: DirectCompletionOptions,
  ): Promise<string> {
    return this.reasoner.directComplete(context, options);
  }

  async structuredComplete(
    context: DirectCompletionContext,
    schema: unknown,
    toolName?: string,
    toolDescription?: string,
    options?: DirectCompletionOptions,
  ): Promise<Record<string, unknown> | null> {
    return this.reasoner.structuredComplete(context, schema, toolName, toolDescription, options);
  }

  async utilityComplete(
    context: DirectCompletionContext,
    options?: DirectCompletionOptions,
  ): Promise<string> {
    return this.reasoner.utilityComplete(context, options);
  }

  getLastDirectUsage(): CortexUsage | null {
    return this.reasoner.getLastDirectUsage();
  }

  /**
   * Accumulated session usage. In passthrough this is the reasoner's
   * counters verbatim; the composite persistence work layers the
   * restored-baseline-plus-live-deltas model on top.
   */
  getSessionUsage(): SessionUsage {
    return this.reasoner.getSessionUsage();
  }

  // Tools, MCP, skills ------------------------------------------------------

  addConsumerTool(tool: CortexTool): void {
    this.reasoner.addConsumerTool(tool);
  }

  removeConsumerTool(toolName: string): void {
    this.reasoner.removeConsumerTool(toolName);
  }

  refreshTools(): void {
    this.reasoner.refreshTools();
  }

  async connectMcpServer(serverName: string, config: McpTransportConfig): Promise<void> {
    // Facade service in duplex (one connection multiplexed to the loops
    // that need it, 2b); the reasoner's manager in passthrough.
    return this.reasoner.connectMcpServer(serverName, config);
  }

  async disconnectMcpServer(serverName: string): Promise<void> {
    return this.reasoner.disconnectMcpServer(serverName);
  }

  getMcpServerStates(): McpConnectionState[] {
    return this.reasoner.getMcpServerStates();
  }

  mcpConfigMatches(serverName: string, config: McpTransportConfig): boolean {
    return this.reasoner.mcpConfigMatches(serverName, config);
  }

  setMcpToolCallProgressHandler(
    handler: ((progress: McpToolCallProgress) => void) | undefined,
  ): void {
    this.reasoner.setMcpToolCallProgressHandler(handler);
  }

  async loadSkill(name: string, args?: string): Promise<void> {
    return this.reasoner.loadSkill(name, args);
  }

  setPreprocessorVariables(variables: Record<string, string>): void {
    this.reasoner.setPreprocessorVariables(variables);
  }

  setScriptContext(context: Record<string, unknown>): void {
    this.reasoner.setScriptContext(context);
  }

  // Sub-agents --------------------------------------------------------------

  async spawnBackgroundSubAgent(
    params: Omit<SubAgentSpawnConfig, 'background'>,
  ): Promise<{ taskId: string }> {
    return this.reasoner.spawnBackgroundSubAgent(params);
  }

  async cancelSubAgent(taskId: string): Promise<boolean> {
    return this.reasoner.cancelSubAgent(taskId);
  }

  steerSubAgent(taskId: string, message: string): boolean {
    return this.reasoner.steerSubAgent(taskId, message);
  }

  getActiveSubAgents(): SubAgentSnapshot[] {
    return this.reasoner.getActiveSubAgents();
  }

  // Asks and queues ---------------------------------------------------------

  getPendingAsks(): PendingAsk[] {
    return this.reasoner.getPendingAsks();
  }

  markAskVoiced(askId: string): boolean {
    return this.reasoner.markAskVoiced(askId);
  }

  get queuedDeliveryCount(): number {
    return this.reasoner.queuedDeliveryCount;
  }

  get pendingWakeDeliveryCount(): number {
    return this.reasoner.pendingWakeDeliveryCount;
  }

  getDeadLetteredBackgroundResults(): DeadLetteredBackgroundResult[] {
    return this.reasoner.getDeadLetteredBackgroundResults();
  }

  // History, memory, digestion ---------------------------------------------

  getConversationHistory(): AgentMessage[] {
    return this.reasoner.getConversationHistory();
  }

  getObservationalMemoryState(): ObservationalMemoryState | null {
    return this.reasoner.getObservationalMemoryState();
  }

  async digestIdle(options?: IdleDigestionOptions): Promise<IdleDigestionResult> {
    return this.reasoner.digestIdle(options);
  }

  async checkAndRunCompaction(): Promise<CompactionResult | null> {
    return this.reasoner.checkAndRunCompaction();
  }

  async triggerObservation(): Promise<void> {
    return this.reasoner.triggerObservation();
  }

  // State reads -------------------------------------------------------------

  get isRunning(): boolean {
    return this.reasoner.isRunning;
  }

  get state(): CortexLifecycleState {
    return this.reasoner.state;
  }

  get isWorkingTagsEnabled(): boolean {
    return this.reasoner.isWorkingTagsEnabled;
  }

  setWorkingTagsEnabled(enabled: boolean): void {
    this.reasoner.setWorkingTagsEnabled(enabled);
  }

  setLastInteractionTime(timestamp: number): void {
    this.reasoner.setLastInteractionTime(timestamp);
  }

  // Callback registration (facade-level fan-in with origin context in 2b;
  // direct delegation to the single loop in passthrough) -------------------

  onLoopComplete(handler: () => void): void {
    this.reasoner.onLoopComplete(handler);
  }

  onError(handler: (error: ClassifiedError, origin: LoopOriginContext) => void): void {
    this.reasoner.onError(handler);
  }

  onTurnComplete(handler: (output: AgentTextOutput, origin: LoopOriginContext) => void): void {
    this.reasoner.onTurnComplete(handler);
  }

  onRetryScheduled(handler: (info: RetryScheduledInfo) => void): void {
    this.reasoner.onRetryScheduled(handler);
  }

  onRetrySucceeded(handler: (info: RetrySucceededInfo) => void): void {
    this.reasoner.onRetrySucceeded(handler);
  }

  onRetryExhausted(handler: (info: RetryExhaustedInfo) => void): void {
    this.reasoner.onRetryExhausted(handler);
  }

  onBeforeCompaction(handler: (target: CompactionTarget) => Promise<void>): void {
    this.reasoner.onBeforeCompaction(handler);
  }

  onPostCompaction(handler: (result: CompactionResult) => void): void {
    this.reasoner.onPostCompaction(handler);
  }

  onCompactionError(handler: (error: Error) => void): void {
    this.reasoner.onCompactionError(handler);
  }

  onCompactionDegraded(handler: (info: CompactionDegradedInfo) => void): void {
    this.reasoner.onCompactionDegraded(handler);
  }

  onCompactionExhausted(handler: (info: CompactionExhaustedInfo) => void): void {
    this.reasoner.onCompactionExhausted(handler);
  }

  onSubAgentSpawned(handler: (taskId: string, instructions: string, background: boolean) => void): void {
    this.reasoner.onSubAgentSpawned(handler);
  }

  onSubAgentCompleted(
    handler: (taskId: string, result: string, status: string, usage: unknown) => void,
  ): void {
    this.reasoner.onSubAgentCompleted(handler);
  }

  onSubAgentFailed(handler: (taskId: string, error: string) => void): void {
    this.reasoner.onSubAgentFailed(handler);
  }

  onBackgroundResultDelivery(handler: (taskIds: string[]) => void): void {
    this.reasoner.onBackgroundResultDelivery(handler);
  }

  onBackgroundResultDeadLettered(
    handler: (result: DeadLetteredBackgroundResult) => void,
  ): void {
    this.reasoner.onBackgroundResultDeadLettered(handler);
  }

  onObservation(handler: (event: ObservationEvent) => void): void {
    this.reasoner.onObservation(handler);
  }

  onReflection(handler: (event: ReflectionEvent) => void): void {
    this.reasoner.onReflection(handler);
  }
}
