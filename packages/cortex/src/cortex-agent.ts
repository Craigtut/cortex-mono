/**
 * CortexAgent: the composite facade over the AgentLoop primitive
 * (docs/cortex/duplex/facade-api.md, architecture.md).
 *
 * Consumers interact with one CortexAgent. Internally it owns the resident
 * loop(s), the session log, the duplex router, settlement predicates, and
 * composite persistence. Two modes:
 *
 * - `duplex` (the default, decisions.md D14): a fast talker loop fronting
 *   the persistent reasoner. The talker carries the fixed control toolset
 *   only; the reasoner does all real work and reports back through the
 *   router's wake policy.
 * - `passthrough`: a single reasoner loop, reproducing direct AgentLoop
 *   behavior exactly. This is the consumer opt-out and the parity baseline
 *   for tests.
 *
 * The talker/reasoner split is never exposed in this API; consumer config
 * is routed internally per the routing table below.
 */

import { AgentLoop } from './agent-loop.js';
import { buildReasonerConfig, DEFAULT_MODE } from './facade/config.js';
import { normalizePersistedState } from './facade/persisted-state.js';
import type {
  CortexAgentPersistedState,
  CortexAgentStateV2,
} from './facade/persisted-state.js';
import { UsageLedger } from './facade/usage-ledger.js';
import { StateEmitter } from './facade/state-emitter.js';
import { LogRecorder } from './facade/log-recorder.js';
import { DuplexSession } from './duplex/session.js';
import { LoopSurface, loopTopology } from './facade/loop-surface.js';
import type { ForwardedLoopMember } from './facade/loop-delegation.js';
import { ResolutionRecorder } from './facade/resolution-recorder.js';
import {
  gateTerm,
  loopAsksTerm,
  parkedWakesTerm,
  PromptTracker,
  Settlement,
  subAgentsTerm,
} from './facade/settlement.js';
import type { UsageReadings } from './facade/usage-ledger.js';
import type {
  CortexAgentConfig,
  CortexAgentMode,
  ResolvedCortexAgentConfig,
} from './facade/config.js';
import type {
  DeliverResult,
  DirectCompletionOptions,
} from './agent-loop.js';
import type {
  CortexLogger,
  PendingAsk,
  SessionUsage,
  SkillConfig,
} from './types.js';
import type { CortexModel } from './model-wrapper.js';
import type { AgentMessage } from './context-manager.js';
import type { ContextManager } from './context-manager.js';
import { EventBridge } from './event-bridge.js';
import { BudgetGuard } from './budget-guard.js';
import type {
  ObservationalMemoryState,
} from './compaction/index.js';
import type {
  SessionLogEntry,
  SessionLogEvent,
  SessionLogSubscriber,
} from './session-log.js';
import { NOOP_LOGGER } from './noop-logger.js';
import type { ResolutionNote } from './resolution-report.js';
import type {
  DuplexRouterState,
} from './duplex/router.js';
import { latestCauseSeq } from './duplex/cause-tags.js';
import type { ResolveNetworkAccess, SandboxRung } from './sandbox/types.js';
import type { SandboxState } from './sandbox/options.js';
import { isSandboxProvider } from './sandbox/options.js';
import { SandboxSession } from './sandbox/session.js';
import {
  assembleDuplexLoops,
} from './duplex/assembly.js';

// ---------------------------------------------------------------------------
// Modes and config
// ---------------------------------------------------------------------------

export { CONFIG_ROUTING, DEFAULT_MODE, buildReasonerConfig } from './facade/config.js';
export type {
  CortexAgentConfig,
  CortexAgentMode,
  CortexSessionLogConfig,
  ConfigDestination,
  DuplexTuningConfig,
  TalkerConfig,
} from './facade/config.js';

/** Scope for {@link CortexAgent.abort} (facade-api.md abort table). */
export type CortexAbortScope = 'conversation' | 'work' | 'all';

// ---------------------------------------------------------------------------
// Delegation surface
// ---------------------------------------------------------------------------

export { AGENT_LOOP_DELEGATION } from './facade/loop-delegation.js';
export type { AgentLoopMemberDisposition, ForwardedLoopMember } from './facade/loop-delegation.js';

type AssertExtends<A extends B, B> = A;

/**
 * Compile-time check: every forwarded member exists on CortexAgent. Fails
 * to typecheck when a member marked 'forwarded' has no facade counterpart.
 */
export type _ForwardedMembersExistOnFacade = AssertExtends<
  ForwardedLoopMember,
  keyof CortexAgent
>;

// ---------------------------------------------------------------------------
// Persisted state (versioned composite artifact)
// ---------------------------------------------------------------------------

export type {
  CortexAgentPersistedState,
  CortexAgentStateV1,
  CortexAgentStateV2,
  CortexAgentUsageBreakdown,
  _V1OptionalFieldsAcceptNull,
} from './facade/persisted-state.js';

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
  /**
   * Who is speaking. Only 'user' mints a consent-qualifying cause tag, so a
   * caller relaying actual human speech must say so; everything else
   * (notifications, status, anything the application itself says) defaults
   * to 'system' and cannot satisfy a permission ask.
   *
   * The default is deliberately not 'user'. Defaulting the other way makes
   * every notification path a silent consent source: voice an escalation
   * ask, wait for any routine "your build finished", and a persuaded talker
   * can grant permission whose audit trail points at the build message.
   * Defaulting to 'system' costs at most one re-voice when a consumer
   * forgets to mark real speech. See docs/cortex/duplex/decisions.md D16.
   *
   * `prompt()` is unambiguous user speech and always mints the user tag.
   */
  speaker?: 'user' | 'system';
}

// ---------------------------------------------------------------------------
// CortexAgent
// ---------------------------------------------------------------------------

const DEFAULT_STATE_DEBOUNCE_MS = 500;

export class CortexAgent extends LoopSurface {
  private readonly reasoner: AgentLoop;
  /** The talker loop; null in passthrough. */
  private readonly talker: AgentLoop | null;
  private readonly mode: CortexAgentMode;
  private readonly recorder: LogRecorder;
  private readonly logger: CortexLogger;

  /** The duplex session; null in passthrough. */
  private readonly duplex: DuplexSession | null;
  /**
   * The network egress decision function the facade actually enforces: the
   * broker-routed wrapper in duplex, the consumer's own function in
   * passthrough. Exposed via getNetworkAccessResolver() for the sandbox
   * ask-callback wiring.
   */
  private readonly networkResolver: ResolveNetworkAccess | null;
  private ownedSandbox: SandboxSession | undefined;
  /** Serializes facade prompt() calls (concurrent prompts queue, never throw). */
  private promptChain: Promise<void> = Promise.resolve();
  /** Facade prompts accepted but not yet settled (chain-queued or running). */
  private readonly prompts = new PromptTracker();
  private readonly settlement: Settlement;

  /**
   * Passthrough only: seq of the utterance whose facade-initiated reasoner
   * run is currently live. Entries produced by that run (replies, errors,
   * spawn lifecycle) carry it as their causation stamp; entries produced
   * while no facade-initiated run is live (e.g. by a background delivery
   * run) carry no stamp rather than a guessed one.
   *
   * Duplex does not use this field: causation there is bound to the run
   * inside the loop (deliver() causeTags read back via activeRunCauseTags),
   * so a parked barge-in keeps its stamp through the sweep and a sweep run
   * can never inherit a previous run's stamp from a facade field raced
   * against the loop gate.
   */
  private activeCauseSeq: number | null = null;

  private readonly usage = new UsageLedger();
  /**
   * Talker-side artifact content carried through a passthrough session
   * opaquely: passthrough has no talker loop to hydrate, but a restored
   * duplex artifact must round-trip getState() without losing that side.
   */
  private retainedTalkerHistory: AgentMessage[] = [];
  /** A restored duplex artifact's router state, carried through passthrough. */
  private retainedRouterState: DuplexRouterState | null = null;
  private retainedTalkerMemory: ObservationalMemoryState | null = null;

  private readonly stateEmitter: StateEmitter;

  private destroyPromise: Promise<void> | null = null;
  private destroyed = false;

  private readonly resolution: ResolutionRecorder;

  private constructor(reasoner: AgentLoop, config: ResolvedCortexAgentConfig, talker?: AgentLoop) {
    const mode = config.mode ?? DEFAULT_MODE;
    if (mode === 'duplex' && !talker) {
      throw new Error('CortexAgent duplex mode requires a talker loop.');
    }
    super(loopTopology(reasoner, mode === 'duplex' ? talker! : null));
    this.mode = mode;
    this.reasoner = reasoner;
    this.talker = this.mode === 'duplex' ? talker! : null;
    const baseLogger = config.logger ?? NOOP_LOGGER;
    this.logger = {
      debug: (message, data) => baseLogger.debug(`[CortexAgent] ${message}`, data),
      info: (message, data) => baseLogger.info(`[CortexAgent] ${message}`, data),
      warn: (message, data) => baseLogger.warn(`[CortexAgent] ${message}`, data),
      error: (message, data) => baseLogger.error(`[CortexAgent] ${message}`, data),
    };

    this.recorder = new LogRecorder({
      ...(config.sessionLog?.maxEntries !== undefined
        ? { maxEntries: config.sessionLog.maxEntries }
        : {}),
      ...(config.sessionLog?.maxSubscriberBuffer !== undefined
        ? { maxSubscriberBuffer: config.sessionLog.maxSubscriberBuffer }
        : {}),
      defaultCause: (loopPath) => this.defaultCauseSeqFor(loopPath),
      persistResult: config.persistResult,
      spillLoopPath: reasoner.loopPath,
      logger: this.logger,
    });

    this.stateEmitter = new StateEmitter({
      snapshot: () => this.getState(),
      shuttingDown: () => this.topology.resident.some(
        (loop) => loop.state === 'destroying' || loop.state === 'destroyed',
      ),
      debounceMs: config.stateChangeDebounceMs ?? DEFAULT_STATE_DEBOUNCE_MS,
      logger: this.logger,
    });
    this.recorder.onAppend(() => this.stateEmitter.markDirty());
    // In duplex, create() has already wrapped this in the broker pipeline.
    this.networkResolver = config.resolveNetworkAccess ?? null;
    this.resolution = new ResolutionRecorder({
      observe: () => ({
        mode: this.mode,
        requestedTalkerModel: config.talker?.model,
        talkerModel: this.talker?.getModel() ?? null,
        reasonerModel: this.reasoner.getModel(),
        configuredUtilityModel: config.utilityModel,
        talkerUtilityModel: this.talker?.getUtilityModel() ?? null,
        aggregateCostCap: this.duplex?.aggregateBudgetGuard.getMaxCost() ?? null,
        perPromptMaxCost: config.budgetGuard?.maxCost,
      }),
      brokeredEgressResolver: this.mode === 'duplex'
        && config.sandbox !== undefined
        && this.networkResolver !== null,
      append: (input) => this.recorder.append(input),
      logger: this.logger,
    });

    if (this.talker) {
      this.duplex = new DuplexSession(reasoner, this.talker, config, {
        recorder: this.recorder,
        prompts: this.prompts,
        logger: this.logger,
        markStateDirty: () => this.stateEmitter.markDirty(),
        destroyed: () => this.destroyed,
        conversationIdle: () => this.conversationIdle,
        prompt: (input) => this.prompt(input),
        noteInputArriving: () => this.resolution.noteUnwiredIfNeeded(),
        refreshModelNotes: () => this.resolution.refreshModelNotes(),
      });
    } else {
      this.duplex = null;
      this.wireLogProducers();
    }
    this.wireStateTriggers();
    this.settlement = this.buildSettlement();
    // Last, because it reads the assembly back: the loops are built, the
    // aggregate guard exists, and every note below is a statement about what
    // this constructor just produced.
    this.resolution.collectAssembly();
  }

  /**
   * Create a CortexAgent. Routes consumer config per {@link CONFIG_ROUTING}
   * and constructs the resident loop(s): the reasoner alone in passthrough
   * (reproducing direct AgentLoop behavior exactly), or the talker plus the
   * persistent reasoner in duplex.
   */
  static async create(config: CortexAgentConfig): Promise<CortexAgent> {
    const { sandbox, ...rest } = config;
    // The facade owns the managed session; loops only receive its provider wrapper.
    const managed = sandbox !== undefined && !isSandboxProvider(sandbox)
      ? await SandboxSession.create(sandbox, config.workingDirectory, config.resolveNetworkAccess)
      : undefined;
    const resolved: ResolvedCortexAgentConfig = {
      ...rest,
      ...(managed ? { sandbox: managed, resolveNetworkAccess: managed.resolveNetworkAccess }
        : isSandboxProvider(sandbox) ? { sandbox } : {}),
    };
    try {
      const agent = await CortexAgent.createResolved(resolved, managed);
      agent.ownedSandbox = managed;
      return agent;
    } catch (error) {
      await managed?.dispose().catch(() => {});
      throw error;
    }
  }

  private static async createResolved(config: ResolvedCortexAgentConfig, managed?: SandboxSession): Promise<CortexAgent> {
    if ((config.mode ?? DEFAULT_MODE) === 'duplex') {
      const loops = await assembleDuplexLoops(config, managed);
      const agent = new CortexAgent(loops.reasoner, loops.config, loops.talker);
      if (managed) agent.resolution.handOutNetworkResolver();
      loops.bindBroker(agent.duplex?.broker ?? null);
      if (loops.ownedMcp) agent.duplex?.adoptMcpManager(loops.ownedMcp);
      return agent;
    }
    const reasoner = await AgentLoop.create(buildReasonerConfig(config));
    return new CortexAgent(reasoner, config);
  }

  // -------------------------------------------------------------------------
  // Log producers
  // -------------------------------------------------------------------------

  /** The facade's own log producers on the single loop (passthrough). */
  private wireLogProducers(): void {
    this.recorder.wireConversation(this.reasoner);
    this.recorder.wireErrors(this.reasoner);
    this.recorder.wireWork(this.reasoner);
  }

  /**
   * History can change without a log entry (compaction rewrites,
   * observation activation trims, a run completing); these mark the
   * composite state dirty so onStateChanged fires for them too. Log
   * appends mark it through the recorder's append listener.
   */
  private wireStateTriggers(): void {
    for (const loop of this.topology.resident) {
      loop.onLoopComplete(() => this.stateEmitter.markDirty());
      loop.onPostCompaction(() => this.stateEmitter.markDirty());
      loop.onObservation(() => this.stateEmitter.markDirty());
      loop.onReflection(() => this.stateEmitter.markDirty());
    }
  }

  /**
   * Which live-run causation track a producer's entries default to. Duplex
   * reads the producing loop's live-run cause tags (bound to the run inside
   * the loop, so parked content keeps its stamp through the sweep);
   * passthrough keeps the facade-field stamp around its serialized prompt.
   */
  private defaultCauseSeqFor(loopPath: string): number | null {
    if (this.talker) {
      if (loopPath !== this.talker.loopPath) {
        return latestCauseSeq(this.reasoner.activeRunCauseTags);
      }
      return latestCauseSeq(this.talker.activeRunCauseTags);
    }
    return this.activeCauseSeq;
  }

  // -------------------------------------------------------------------------
  // Interaction surface
  // -------------------------------------------------------------------------

  /**
   * Mirror AgentLoop.prompt()'s synchronous validation (teardown state and
   * a configured system prompt) before anything is logged or queued, so the
   * log never records an utterance for input the loop rejects. The loop
   * performs the same checks itself; hoisting them keeps phantom entries
   * out of the log, exactly as deliver() validates at the point of misuse.
   */
  private assertPromptable(action: 'prompt' | 'deliver'): void {
    this.assertNotDestroyed();
    const loopState = this.topology.conversation.state;
    if (loopState === 'destroying') {
      throw new Error('Agent is being destroyed');
    }
    if (loopState === 'destroyed') {
      throw new Error('Agent has been destroyed');
    }
    if (this.topology.conversation.getCurrentSystemPrompt().trim().length === 0) {
      throw new Error(
        `CortexAgent prompt is not configured. Call setBasePrompt() before ${action}(), ` +
        'or provide initialBasePrompt during creation.',
      );
    }
  }

  /**
   * Prompt the agent. Routes to the reasoner (passthrough) or the talker
   * (duplex). Never throws on a busy loop. In passthrough, concurrent
   * calls are serialized by the facade, each resolving against the turn
   * that carries its input; the utterance is appended to the log when its
   * run starts (append-then-emit still holds: the entry lands before any
   * event of the run), so log order always matches execution order even
   * when a deliver() issued in the same tick starts its run ahead of a
   * queued prompt(). In duplex the input goes through the talker's
   * deliver() (barge-in is the conversation's core event, so a held gate
   * parks rather than queues behind the turn), and a parked input resolves
   * when the talker next quiesces, which is after the run that carried it.
   */
  async prompt(input: string, options?: DirectCompletionOptions): Promise<unknown> {
    this.assertPromptable('prompt');
    if (this.mode === 'duplex') {
      return this.duplex!.prompt(input, options);
    }
    this.resolution.noteUnwiredIfNeeded();

    this.prompts.begin();
    const run = this.promptChain.then(async () => {
      // Wait for gate quiescence, then act in the SAME frame: between the
      // idle wait resolving and this continuation running, an unrelated
      // continuation (e.g. a background-completion drain) can seize the
      // gate, and AgentLoop.prompt() fails fast on a held gate. The
      // synchronous isLoopActive re-check closes that window exactly.
      for (;;) {
        await this.reasoner.waitForLoopIdle();
        if (this.reasoner.isLoopActive) continue;
        // Re-validate at run start: a teardown that landed while this call
        // was queued must reject it before the utterance is logged.
        this.assertPromptable('prompt');
        // Logged here rather than at call time: the log is the ordering
        // authority, and content that reached the loop first (a same-tick
        // deliver()) must hold the lower seq.
        const entry = this.recorder.append({
          type: 'utterance',
          loopPath: this.reasoner.loopPath,
          content: input,
          causedBy: null,
        });
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
      this.prompts.end();
    };
    this.promptChain = run.then(settle, settle);
    return run;
  }

  /**
   * Fire-and-forget input, with the same non-throwing guarantee as
   * prompt(): the loop's own deliver() state machine decides whether the
   * content starts a turn now ('prompted'), opens the next run ('parked'),
   * or waits silently for the next real prompt ('queued').
   *
   * In duplex, delivered content is fenced in an `<external-update>`
   * wrapper on BOTH surfaces before it reaches a loop, the same way
   * reasoner deliveries and lookup results are fenced: content DELIVERED is
   * content about something. Consumers relay third-party text here, so the
   * fence is what keeps an email body out of a loop's instruction lane. On
   * the work surface the fence sits inside the dispatch, so the directive
   * framing is unchanged and the reasoner is still told to act on the
   * content. The session log keeps the unwrapped content on both paths.
   *
   * The one exception is `speaker: 'user'` on the conversation surface: that
   * is the consumer relaying actual human speech (an ASR transcript), which
   * is prompt()'s trust class, and it arrives bare like prompt() does. See
   * the fencing note at that branch.
   */
  deliver(content: string, options?: CortexDeliverOptions): DeliverResult {
    // Mirror AgentLoop.deliver's synchronous validation before appending,
    // so the log never records an utterance the loop rejected.
    this.assertPromptable('deliver');
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('deliver() requires non-whitespace string content');
    }
    if (this.mode === 'duplex') {
      return this.duplex!.deliver(content, options);
    }
    const entry = this.recorder.append({
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
   * turn boundary). Passthrough matches AgentLoop.steer(), including the
   * no-op while idle. Duplex: the conversation surface (the talker) is what
   * a consumer steers, and with no talker turn in flight the message is
   * handled as the user's next prompt() instead of being queued for a run
   * that may never come; directives reach the reasoner through the router.
   *
   * No-op after destroy, matching AgentLoop.steer(). Teardown races are
   * ordinary here (a keystroke landing while shutdown runs), and the loop
   * has nothing left to steer, so idempotent teardown beats making every
   * consumer guard the call.
   */
  steer(message: string): void {
    if (this.destroyed) return;
    if (this.duplex) {
      this.duplex.steer(message);
      return;
    }
    this.topology.conversation.steer(message);
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
   *
   * No-op after destroy (and once teardown has begun), matching
   * AgentLoop.abort(). Consumers wire abort to Ctrl+C and Escape
   * fire-and-forget, so a throw here lands as an unhandled rejection during
   * shutdown rather than anywhere a catch could see it; destroy() has
   * already aborted every loop, so there is nothing left to stop.
   */
  async abort(scope: CortexAbortScope = 'all'): Promise<void> {
    if (this.destroyed) return;
    this.recorder.append({
      type: 'lifecycle',
      loopPath: scope === 'conversation' ? this.topology.conversation.loopPath : this.reasoner.loopPath,
      content: `Abort requested (scope: ${scope})`,
      data: { event: 'abort', scope },
      causedBy: null,
    });

    if (this.duplex) {
      await this.duplex.abort(scope);
      return;
    }

    // Dropped queued content: silent deliveries, parked wake deliveries
    // (abort() drops those itself too), and pi's steering/follow-up queues.
    this.recorder.recordDroppedQueue(this.reasoner, 'abort', this.reasoner.clearAllQueues());

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
    this.stateEmitter.destroy();
    this.duplex?.beginDestroy();
    this.destroyPromise = (async () => {
      try {
        const teardowns: Array<Promise<void>> = [this.reasoner.destroy(timeoutMs)];
        if (this.talker) teardowns.push(this.talker.destroy(timeoutMs));
        if (this.duplex) teardowns.push(...this.duplex.teardowns());
        const results = await Promise.allSettled(teardowns);
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      } finally {
        await this.duplex?.closeOwnedResources();
        try {
          await this.ownedSandbox?.dispose();
        } finally {
          this.duplex?.finishDestroy();
          this.recorder.destroy();
        }
      }
    })();
    return this.destroyPromise;
  }

  /** Snapshot of the effective managed sandbox policy and enforcement. */
  getSandboxState(): SandboxState | undefined { return this.ownedSandbox?.getState(); }

  /** Host-only policy change. Work must settle before changing an OS boundary. */
  async setSandboxRung(rung: SandboxRung): Promise<void> {
    this.assertNotDestroyed();
    if (!this.ownedSandbox) throw new Error('No Cortex-managed sandbox was configured');
    if (!this.workSettled) throw new Error('Wait for work to settle before changing sandbox policy');
    if (this.getMcpClientManager().getConnectionStates().some((connection) =>
      connection.connected && connection.config.transport === 'stdio',
    )) throw new Error('Disconnect stdio MCP servers before changing sandbox policy, then reconnect them under the new policy');
    await this.ownedSandbox.setRung(rung);
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error('CortexAgent has been destroyed');
    }
  }

  // -------------------------------------------------------------------------
  // Resolution report
  // -------------------------------------------------------------------------

  /**
   * What this assembly resolved to, where that differs from what was asked
   * for: the talker silently on the primary model, a utilityModel the talker
   * could not take, an unwired egress resolver, an uncapped session
   * (resolution-report.ts for the full rationale).
   *
   * Present in both modes. Two of the conditions are not duplex-specific,
   * and a consumer should not have to branch on mode to ask "did I get what
   * I configured?"; passthrough simply earns fewer notes.
   *
   * A snapshot copy, so a consumer cannot mutate the record the log entries
   * were derived from. Readable after destroy() on purpose: the report is an
   * immutable statement about an assembly with no live resource behind it,
   * and "why was that session slow or expensive" is asked after the session,
   * not during it.
   */
  getResolutionReport(): ResolutionNote[] {
    return this.resolution.report();
  }

  // -------------------------------------------------------------------------
  // Session log surface
  // -------------------------------------------------------------------------

  /**
   * Snapshot copy (never a live reference) of log entries with
   * seq >= fromSeq (all retained entries when omitted).
   */
  getLog(fromSeq?: number): SessionLogEntry[] {
    this.assertNotDestroyed();
    return this.recorder.log.getLog(fromSeq);
  }

  /**
   * The same range as {@link getLog}, as an event sequence: retained entries
   * interleaved with a gap marker for every hole, in seq order.
   *
   * This is the hole-aware read, and the one a timeline should use.
   * `getLog()` returns entries and nothing else, so retention that evicted
   * churn from the middle or the end of the range is invisible in it. Built
   * by the same function that builds a subscription's replay, so a one-shot
   * read and a reconnecting subscriber can never disagree about where the
   * holes are.
   */
  getLogEvents(fromSeq?: number): SessionLogEvent[] {
    this.assertNotDestroyed();
    return this.recorder.log.getLogEvents(fromSeq);
  }

  /**
   * Subscribe to log events with replay from a seq, so a reconnecting UI
   * can ask for everything since it last saw. Slow subscribers are
   * buffered to a bound and then dropped with a gap marker rather than
   * applying backpressure to the loops. Returns an idempotent unsubscribe.
   */
  subscribeLog(cb: SessionLogSubscriber, fromSeq?: number): () => void {
    this.assertNotDestroyed();
    return this.recorder.log.subscribeLog(cb, fromSeq);
  }

  // -------------------------------------------------------------------------
  // Composite persistence (v2 artifact)
  // -------------------------------------------------------------------------

  /**
   * Capture the composite state at a consistent point: the log, histories,
   * observational states, and usage are all read in one synchronous frame
   * with the loop gate empty, never mid-run. Resolves once the current run
   * (and any queued gate work) finishes; under continuous activity that is
   * the next quiescence window.
   */
  async getState(): Promise<CortexAgentStateV2> {
    this.assertNotDestroyed();
    for (;;) {
      await this.reasoner.waitForLoopIdle();
      if (this.talker) await this.talker.waitForLoopIdle();
      if (!this.reasoner.isLoopActive && !(this.talker?.isLoopActive ?? false)) {
        return this.captureStateInFrame();
      }
    }
  }

  /** Synchronous composite snapshot; caller guarantees gate quiescence. */
  private captureStateInFrame(): CortexAgentStateV2 {
    const duplex = this.duplex?.captureState();
    return {
      version: 2,
      log: this.recorder.log.getLog(),
      // Duplex reads the live talker; passthrough carries a restored duplex
      // artifact's talker side through unchanged so nothing is lost on
      // round trip. Copied like getLog(): a persistence layer that
      // normalizes the snapshot in place must never mutate live facade
      // state.
      talkerHistory: duplex
        ? duplex.talkerHistory
        : structuredClone(this.retainedTalkerHistory),
      reasonerHistory: this.reasoner.getConversationHistory(),
      talkerMemory: duplex
        ? duplex.talkerMemory
        : structuredClone(this.retainedTalkerMemory),
      reasonerMemory: this.reasoner.getObservationalMemoryState(),
      usage: this.usage.breakdown(this.usageReadings()),
      // Passthrough carries a restored duplex artifact's router state
      // through, like the talker side.
      ...(duplex
        ? { router: duplex.router }
        : this.retainedRouterState ? { router: structuredClone(this.retainedRouterState) } : {}),
    };
  }

  /** Each usage producer's live reading, for the ledger. */
  private usageReadings(): UsageReadings {
    return {
      reasoner: this.reasoner.getSessionUsage(),
      talker: this.talker ? this.talker.getSessionUsage() : null,
      lookups: this.duplex ? this.duplex.lookupUsage() : null,
    };
  }

  /**
   * Restore a persisted artifact: v2 composite, v1 single history, or a
   * bare message array (upgraded transparently). Rejected while any loop
   * is running: a restore under a live run would splice history out from
   * under pi's message mirror and desync the observation watermark.
   *
   * Per-loop restore ordering holds internally: history first, then
   * observational state (whose buffer watermark aligns to the post-slot
   * history length). Usage becomes the restored baseline; live counters
   * accumulate as deltas on top, so repeated restores are idempotent, not
   * additive.
   *
   * Async so every rejection is a rejection: the guards below are the
   * documented failure mode, and a synchronous throw next to the async
   * getState() means `await agent.restore(x).catch(...)` catches nothing.
   * The body still applies in one frame (there is no await inside it), so
   * the all-or-nothing property is unchanged.
   */
  async restore(state: CortexAgentPersistedState): Promise<void> {
    this.assertNotDestroyed();
    if (
      this.reasoner.isLoopActive ||
      (this.talker?.isLoopActive ?? false) ||
      this.prompts.pending ||
      this.reasoner.getSubAgentManager().activeCount > 0 ||
      (this.duplex?.activeLookups ?? 0) > 0
    ) {
      throw new Error(
        'CortexAgent.restore() rejected: a loop is running. Await workSettled before restoring.',
      );
    }
    const v2 = normalizePersistedState(state);

    // Deep copies: the caller's artifact stays the caller's (a later
    // in-place mutation of it must never reach live facade state). Taken
    // before the first mutation below: structuredClone throws on proxies
    // and functions (a reactive-store artifact hands it exactly that), and
    // a clone failure must reject the restore with the facade untouched,
    // never half-applied.
    const talkerHistory = structuredClone(v2.talkerHistory);
    const talkerMemory = structuredClone(v2.talkerMemory);
    const routerState = v2.router ? structuredClone(v2.router) : undefined;

    // History before observational state (restore ordering), per loop.
    this.reasoner.restoreConversationHistory(v2.reasonerHistory);
    if (v2.reasonerMemory) {
      this.reasoner.restoreObservationalMemoryState(v2.reasonerMemory);
    }
    if (this.duplex) {
      // Live talker hydration; the retained fields stay empty in duplex.
      this.duplex.hydrate(talkerHistory, talkerMemory);
      this.retainedTalkerHistory = [];
      this.retainedTalkerMemory = null;
    } else {
      this.retainedTalkerHistory = talkerHistory;
      this.retainedTalkerMemory = talkerMemory;
    }
    this.recorder.log.restore(v2.log);

    this.usage.rebase(v2.usage, this.usageReadings());
    this.recorder.resetForRestore();
    this.activeCauseSeq = null;
    // Pre-restore queued content belongs to the replaced session: left in
    // place, queued silent deliveries would flush into the first
    // post-restore prompt (and stale steer/follow-up content into its run).
    // What gets destroyed is recorded in the restored log, which is the
    // durable record of undelivered content from here on.
    this.recorder.recordDroppedQueue(this.reasoner, 'restore', this.reasoner.clearAllQueues());
    // Everything the duplex session holds describes the replaced session
    // too; what the artifact carries of its router state comes back.
    // Passthrough carries that state through untouched.
    if (this.duplex) {
      this.duplex.resetForRestore(routerState);
    } else {
      this.retainedRouterState = routerState ?? null;
    }
  }

  /**
   * Debounced composite persistence trigger: fires with a consistent
   * getState() snapshot after state-changing activity (log appends, run
   * completions, compaction, observation) settles for stateChangeDebounceMs.
   * This replaces persisting on onLoopComplete, which is ambiguous once
   * multiple loops exist.
   */
  onStateChanged(handler: (state: CortexAgentStateV2) => void): void {
    this.stateEmitter.subscribe(handler);
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
    return this.settlement.conversationIdle;
  }

  /**
   * Whether all work has settled: conversation idle, reasoner gate empty,
   * no active sub-agents or quick lookups, no parked wake deliveries on
   * either loop, no router-held deliveries, no pending permission asks.
   * Queued silent deliveries do not count: silent content deliberately
   * waits for the next prompt.
   *
   * The ask term reads the FACADE's merged registry, never the reasoner's
   * own. A broker-minted network ask (shell egress through the sandbox
   * callback, WebFetch) never enters a loop registry at all, so reading the
   * loop's would report settled with a resolver still blocked, which is the
   * one thing this predicate exists to rule out.
   */
  get workSettled(): boolean {
    return this.settlement.workSettled;
  }

  /** Resolve once {@link conversationIdle} holds. */
  async waitForConversationIdle(): Promise<void> {
    return this.settlement.waitForConversationIdle();
  }

  /**
   * Resolve once {@link workSettled} holds. Event-driven where a signal
   * exists (the loop gate, sub-agent completion promises); a single
   * macrotask yield between checks lets completion cascades (a finished
   * child scheduling its delivery drain) reach the gate before the final
   * verdict.
   */
  async waitForWorkSettled(): Promise<void> {
    return this.settlement.waitForWorkSettled();
  }

  /** The settlement terms, in wait order, for this session's topology. */
  private buildSettlement(): Settlement {
    const { reasoner, talker } = this;
    const duplex = this.duplex?.settlementTerms();
    return new Settlement({
      conversation: [this.prompts.term(), gateTerm(this.topology.conversation)],
      work: [
        this.prompts.term(),
        gateTerm(reasoner),
        ...(talker ? [gateTerm(talker)] : []),
        ...(duplex?.afterTalkerGate ?? []),
        subAgentsTerm(reasoner),
        ...(duplex?.afterSubAgents ?? []),
        // Pending asks block on a settlement signal, never on a polling
        // yield: an ask can outlive the child that raised it, and a
        // setImmediate spin would otherwise run hot for as long as it stays
        // unanswered. Two registries, each with its own signal: the
        // reasoner's (its own and its sub-agents' asks), and in duplex the
        // broker's, which alone holds network and quick-lookup asks.
        loopAsksTerm(reasoner),
        ...(duplex?.afterReasonerAsks ?? []),
        parkedWakesTerm(reasoner),
        ...(talker ? [parkedWakesTerm(talker)] : []),
      ],
    });
  }

  // -------------------------------------------------------------------------
  // Composite surface (the topology-determined forwards are LoopSurface's)
  // -------------------------------------------------------------------------

  /**
   * The merged event stream. In passthrough this is the reasoner's bridge
   * verbatim, so event identity and ordering match direct AgentLoop use
   * exactly. In duplex it is the facade's merged bridge: every event
   * carries its loop path in its own loopPath field ('talker', 'reasoner',
   * 'reasoner/task-7'), while childTaskId keeps meaning "this came from a
   * sub-agent" exactly as on a loop's own bridge.
   */
  getEventBridge(): EventBridge {
    return this.duplex?.eventBridge ?? this.reasoner.getEventBridge();
  }

  /**
   * The context manager. Passthrough returns the reasoner's manager
   * verbatim. Duplex returns a fan-out view (D6: mid-session slot writes
   * reach both loops so they never diverge; reads come from the reasoner;
   * no per-slot routing knob exists).
   */
  getContextManager(): ContextManager {
    return this.duplex?.contextManager ?? this.reasoner.getContextManager();
  }

  /**
   * The facade's aggregate guard: lifetime scope across both resident loops,
   * every sub-agent, quick lookups, and utility spend, capped by
   * `duplex.maxTotalCost`. This is the guard that stops a duplex session, so
   * a consumer showing "the agent halted on budget" reads `isBreached()`
   * here, not on the per-prompt guard above. Null in passthrough, where no
   * aggregate exists and the reasoner's own guard is the whole story.
   */
  getAggregateBudgetGuard(): BudgetGuard | null {
    return this.duplex?.aggregateBudgetGuard ?? null;
  }

  /**
   * Register a skill with every loop that carries skills. The facade
   * registration API (docs/cortex/duplex/sub-agents.md): skills stay
   * per-loop (registry instances are never shared between loops), and this
   * fans the registration out so a consumer never reaches into a specific
   * loop's registry. Today the fan-out set is the reasoner; the talker
   * carries no skills by design (facade-api.md routing table), and any
   * future skill-carrying loop joins here without a consumer-visible
   * change.
   */
  addSkill(config: SkillConfig): void {
    for (const loop of this.skillLoops) {
      loop.getSkillRegistry().addSkill(config);
    }
  }

  /** Remove a skill from every loop that carries skills. */
  removeSkill(name: string): void {
    for (const loop of this.skillLoops) {
      loop.getSkillRegistry().removeSkill(name);
    }
  }

  /** The loops skills fan out to (never the talker). */
  private get skillLoops(): AgentLoop[] {
    return [this.reasoner];
  }

  // Prompt and model surface -----------------------------------------------

  /**
   * Set the consumer base prompt. Duplex appends each loop's role prompt
   * (the consumer supplies one undifferentiated prompt, facade-api.md);
   * the returned composition is the reasoner's, matching passthrough.
   */
  setBasePrompt(basePrompt: string): string {
    return this.duplex?.setBasePrompt(basePrompt) ?? this.reasoner.setBasePrompt(basePrompt);
  }

  /** The consumer's base prompt (role prompts excluded in duplex). */
  getBasePrompt(): string {
    return this.duplex?.getBasePrompt() ?? this.reasoner.getBasePrompt();
  }

  /**
   * Swap the primary (reasoner) model. In duplex an unpinned talker is
   * re-mirrored to the fast tier of the new model, exactly as create()
   * picked it; without that a provider switch would leave the presence loop
   * (and every quick lookup, which builds from the talker's model) on the
   * old provider. A pinned `talker.model` is the consumer's choice and
   * stays.
   */
  setModel(model: CortexModel): void {
    if (this.duplex) this.duplex.setModel(model);
    else this.reasoner.setModel(model);
  }

  /**
   * Set the utility model on every resident loop that can take it
   * (CONFIG_ROUTING utilityModel: per-loop), under the same rule assembly
   * applies: the talker takes it when it shares the talker's provider and
   * skips it otherwise, because a loop rejects a utility model from another
   * provider. The talker's primary model is not affected: it mirrors the
   * reasoner's auto-resolved fast tier, which an override does not change.
   */
  setUtilityModel(model: CortexModel): void {
    if (this.duplex) this.duplex.setUtilityModel(model);
    else this.reasoner.setUtilityModel(model);
  }

  /**
   * Set the cache session id. Duplex derives the talker's stable id from
   * the same value (distinct per-loop prefix caches, log-and-context.md);
   * the reasoner keeps the bare id so mode flips keep its cache warm.
   */
  setSessionId(value: string | null): void {
    if (this.duplex) this.duplex.setSessionId(value);
    else this.reasoner.setSessionId(value);
  }

  /**
   * Accumulated session usage: the composite aggregate across both loops
   * and settled quick lookups (children counted once via each loop's own
   * accounting), under the baseline-plus-delta restore model, so totals
   * survive restores without double-counting.
   */
  getSessionUsage(): SessionUsage {
    return this.usage.total(this.usageReadings());
  }

  // Asks and queues ---------------------------------------------------------

  /**
   * Every permission ask currently blocked on a decision, from both
   * registries, deduplicated by askId.
   *
   * Two registries exist because two different things track asks. The
   * reasoner's holds its own and its sub-agents' (children mirror in through
   * the child resolver wrapper). The broker's holds everything routed
   * through the conversation in duplex, whichever loop raised it. They
   * overlap for reasoner tool asks, which carry the same askId in both, and
   * each holds asks the other never sees.
   *
   * This used to append only the broker's `network` asks, on the reasoning
   * that a loop registry covers everything else. It does not. A quick-lookup
   * loop is built through `AgentLoop.create`, not `createChildAgent`, so
   * there is no mirror into the reasoner, and its asks are `tool` kind, so
   * the network filter dropped them too: a blocked lookup was invisible on
   * every consumer surface while its resolver sat waiting. Taking the union
   * fixes that without a third special case, and it is what the method name
   * has always claimed.
   *
   * Lookup asks are deliberately NOT mirrored into the reasoner's registry
   * the way sub-agent asks are. A lookup is not in the reasoner's subtree:
   * it is a facade-owned peer on the conversation side (D13) with its own
   * pool, its own wall-clock timeout, and cancellation by a *conversation*
   * abort. Mirroring would make `reasoner.waitForAskSettlement()` block on
   * something the reasoner cannot influence and its registry claim work it
   * does not own.
   */
  getPendingAsks(): PendingAsk[] {
    return this.duplex?.pendingAsks() ?? this.reasoner.getPendingAsks();
  }

  /**
   * The network egress decision function this agent actually enforces: in
   * duplex it is the broker-routed wrapper (a consumer `ask` becomes a
   * voiced conversation ask), in passthrough the consumer's own function
   * unchanged, undefined when none was configured. Wire THIS function, not
   * the raw one from config, into the SandboxProvider's ask callback
   * (provider `onNetworkRequest`) with `via: 'shell'`, so shell
   * egress asks flow through the same broker pipeline as WebFetch instead
   * of blocking a loop invisibly.
   */
  getNetworkAccessResolver(): ResolveNetworkAccess | undefined {
    this.resolution.handOutNetworkResolver();
    return this.networkResolver ?? undefined;
  }
}
