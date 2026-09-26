/**
 * DuplexSession: a fast talker loop fronting the persistent reasoner
 * (docs/cortex/duplex/architecture.md). Builds the duplex subsystem (router,
 * quick lookups, headlines, guards, run outcomes, budget, digestion) over the
 * assembled loop pair and wires it in one explicit, ordered pass, and owns
 * the duplex semantics of the facade's interaction surface.
 *
 * Handler registration order is semantics here, not style: on a shared
 * event the handler registered first runs first, so wire() states the order
 * outright (the reply entry before its conversation delta, a dead-letter
 * entry before the broker's recovery, an error entry before the delivery
 * announcing it, run outcomes before the headline run end before
 * digestion). duplex-session-wiring.test.ts pins the observable ones.
 */

import { AgentLoop } from '../agent-loop.js';
import type { DeliverResult, DirectCompletionOptions } from '../agent-loop.js';
import type { McpClientManager } from '../mcp-client.js';
import type { CortexLogger, PendingAsk, SessionUsage } from '../types.js';
import type { CortexModel } from '../model-wrapper.js';
import type { AgentMessage, ContextManager } from '../context-manager.js';
import type { ObservationalMemoryState } from '../compaction/index.js';
import type { BudgetGuard } from '../budget-guard.js';
import type { EventBridge } from '../event-bridge.js';
import type { SessionLogEntryType } from '../session-log.js';
import type { LogRecorder } from '../facade/log-recorder.js';
import { yieldMacrotask } from '../facade/settlement.js';
import type { PromptTracker, SettlementTerm } from '../facade/settlement.js';
import { routerOptionsFrom } from '../facade/config.js';
import type { ResolvedCortexAgentConfig } from '../facade/config.js';
import { collectCauseTags, latestCauseSeq } from './cause-tags.js';
import type { CauseTag } from './cause-tags.js';
import { DuplexRouter } from './router.js';
import type { DuplexRouterPorts, DuplexRouterState } from './router.js';
import { PermissionBroker } from './permission-broker.js';
import type { PermissionBrokerPorts } from './permission-broker.js';
import { FanOutContextManager } from './fanout-context-manager.js';
import { DuplexHeadlines, summarizeHeadlineArgs } from './headlines.js';
import { stripAskFence } from './ask-fence.js';
import { buildControlTools } from './control-tools.js';
import { buildDeliverTool, buildSteerSubAgentTool } from './reasoner-tools.js';
import { QuickLookupManager } from './quick-lookups.js';
import type { QuickLookupOutcome } from './quick-lookups.js';
import { highestTaskAlias } from './delegations.js';
import {
  appendRolePrompt,
  buildQuickLookupConfig,
  TALKER_HEADLINE_MAX_TOKENS,
  TALKER_SESSION_ID_SUFFIX,
} from './assembly.js';
import { REASONER_ROLE_PROMPT, TALKER_ROLE_PROMPT, wrapExternalContent } from './prompts.js';
import { TalkerGuards } from './talker-guards.js';
import { MergedEvents } from './merged-events.js';
import { IdleDigestion } from './idle-digestion.js';
import { AggregateBudget } from './aggregate-budget.js';
import { ReasonerDispatcher } from './reasoner-dispatch.js';
import { ReasonerOutcomeReporter } from './reasoner-outcomes.js';
import { errorMessageOf } from '../error-classifier.js';
import type { CortexAbortScope, CortexDeliverOptions } from '../cortex-agent.js';

/**
 * Why a voicing hand-off was refused. Surfaces in the broker's delivery-failed
 * log line, so a deliberate hold reads as one rather than as a talker fault.
 */
const ASK_VOICING_HELD_REASON =
  'conversation aborted; the permission request is held until the conversation reopens';

/**
 * Cap on remembered ask-voicing texts. They exist only to recognize the
 * session's own content among the talker's PARKED deliveries, which a run
 * drains at the next turn, so the live window is a handful at most. An
 * evicted text degrades to "not recognized as a voicing", which leaves a
 * moot request readable rather than dropping something else: the safe
 * direction for a bounded cache to fail in.
 */
const MAX_TRACKED_ASK_VOICINGS = 32;

/** What the session needs of the facade that hosts it. */
export interface DuplexSessionServices {
  readonly recorder: LogRecorder;
  readonly prompts: PromptTracker;
  readonly logger: CortexLogger;
  markStateDirty(): void;
  destroyed(): boolean;
  /** Whether the conversation surface is quiet (facade settlement). */
  conversationIdle(): boolean;
  /** The facade's own prompt(), validation included. */
  prompt(input: string): Promise<unknown>;
  /** The first input is the moment an unwired egress resolver is noted. */
  noteInputArriving(): void;
  /** setModel re-resolved the talker's model: its resolution notes change. */
  refreshModelNotes(): void;
}

export class DuplexSession {
  readonly reasoner: AgentLoop;
  readonly talker: AgentLoop;
  readonly router: DuplexRouter;
  /** The consent boundary for every permission ask in the session (D16). */
  readonly broker: PermissionBroker;
  private readonly services: DuplexSessionServices;
  private readonly recorder: LogRecorder;
  private readonly logger: CortexLogger;
  private readonly lookups: QuickLookupManager;
  private readonly headlines: DuplexHeadlines;
  private readonly merged: MergedEvents;
  private readonly aggregate: AggregateBudget;
  private readonly guards: TalkerGuards;
  private readonly digestion: IdleDigestion;
  private readonly dispatcher: ReasonerDispatcher;
  private readonly outcomes: ReasonerOutcomeReporter;
  /**
   * The facade-minted shared MCP manager: loops sharing it never close it,
   * so the session does at destroy. Null when the consumer supplied their
   * own manager (their lifecycle, not ours).
   */
  private ownedMcpManager: McpClientManager | null = null;
  /**
   * Whether the consumer pinned `talker.model`. An unpinned talker mirrors
   * the reasoner's auto-resolved fast tier, at assembly and again on every
   * facade setModel(); a pinned one keeps the consumer's choice.
   */
  private readonly talkerModelPinned: boolean;
  /** The consumer's base prompt without the appended role prompts. */
  private consumerBasePrompt: string | null;
  /** Lazily-built D6 fan-out view over both loops' context managers. */
  private fanOutContextManager: FanOutContextManager | null = null;
  /**
   * Ask-voicing texts handed to the talker, so the session can recognize
   * its own voicings among the talker's parked deliveries and retract the
   * ones an abort has made moot. Bounded; see MAX_TRACKED_ASK_VOICINGS.
   */
  private readonly trackedAskVoicings = new Set<string>();
  /** True while a conversation abort is refusing voicing hand-offs. */
  private askVoicingHeld = false;
  /**
   * A voicing was withheld by a conversation abort and the request is now
   * pending and silent. It is read out again the next time the conversation
   * surface receives input, which is the next moment the agent is talking to
   * the user anyway.
   */
  private deferredAskVoicing = false;

  constructor(
    reasoner: AgentLoop,
    talker: AgentLoop,
    config: ResolvedCortexAgentConfig,
    services: DuplexSessionServices,
  ) {
    this.reasoner = reasoner;
    this.talker = talker;
    this.services = services;
    this.recorder = services.recorder;
    this.logger = services.logger;
    this.talkerModelPinned = config.talker?.model !== undefined;
    this.consumerBasePrompt = config.initialBasePrompt ?? null;
    const destroyed = (): boolean => services.destroyed();

    // The facade-owned quick-lookup fleet (D13): ephemeral read-only loops
    // on the talker's fast model, spawned on the talker's behalf, with their
    // own small pool. Created before the router so its ports can dispatch
    // into it synchronously.
    this.lookups = new QuickLookupManager(
      {
        createLoop: async (alias) => {
          const loop = await AgentLoop.create(
            buildQuickLookupConfig(config, talker.getModel(), alias),
          );
          return { loop, cleanup: this.merged.forwardLookup(loop) };
        },
        onOutcome: (outcome) => this.handleLookupOutcome(outcome),
        logger: this.logger,
      },
      {
        ...(config.duplex?.maxConcurrentLookups !== undefined
          ? { maxConcurrent: config.duplex.maxConcurrentLookups }
          : {}),
        ...(config.duplex?.lookupTimeoutMs !== undefined
          ? { timeoutMs: config.duplex.lookupTimeoutMs }
          : {}),
      },
    );
    this.digestion = new IdleDigestion(
      {
        talker,
        reasoner,
        quiet: () => services.conversationIdle() && this.router.pendingDeliveryCount === 0,
        destroyed,
        logger: this.logger,
      },
      config.duplex?.idleDigestionDelayMs ?? 10_000,
    );
    this.dispatcher = new ReasonerDispatcher({
      reasoner,
      append: (input) => this.recorder.append(input),
      beforeInput: () => this.digestion.preempt(),
      cancelAbortStarting: () => this.outcomes.expectAbort('cancel'),
      cancelAbortFinished: () => this.outcomes.abortUnwound('cancel'),
      destroyed,
      logger: this.logger,
    });
    const routerOptions = routerOptionsFrom(config.duplex);
    this.broker = new PermissionBroker(this.brokerPorts(), {
      ...(routerOptions.askTimeoutMs !== undefined ? { askTimeoutMs: routerOptions.askTimeoutMs } : {}),
      ...(routerOptions.escalationAskTimeoutMs !== undefined
        ? { escalationAskTimeoutMs: routerOptions.escalationAskTimeoutMs }
        : {}),
      ...(routerOptions.settleVoiceDelayMs !== undefined
        ? { settleVoiceDelayMs: routerOptions.settleVoiceDelayMs }
        : {}),
    });
    this.router = new DuplexRouter(this.routerPorts(config), routerOptions);
    this.headlines = new DuplexHeadlines({
      reasonerRunning: () => reasoner.isPrompting,
      reasonerUsage: () => reasoner.getSessionUsage(),
      activeSubAgents: () => reasoner.getActiveSubAgents(),
      delegations: () => this.router.getDelegations(),
      // The BROKER, not the facade's merged consumer view. The broker holds
      // every ask (tool, escalation, network, so a blocked egress wait is
      // visible here too) and is the authority on whether one has actually
      // been read out: the loop registry's `voiced` is set at hand-off and
      // never cleared, so a voicing the broker later withdrew still reads as
      // heard there, and the block would offer a request as answerable that
      // the router would refuse an answer for.
      pendingAsks: () => this.broker.getPendingAsks(),
    });
    this.outcomes = new ReasonerOutcomeReporter({
      reasoner,
      router: this.router,
      headlines: this.headlines,
      aggregateBreached: () => this.aggregate.guard.isBreached(),
      destroyed,
    });
    this.guards = new TalkerGuards(this.logger);
    this.wire();
    // The merged stream forwards through catch-all listeners, which a bridge
    // runs after every typed handler: consumers see an event only once the
    // session has handled it, whatever the registration order.
    this.merged = new MergedEvents(talker, reasoner, this.logger);
    this.aggregate = new AggregateBudget(config.duplex?.maxTotalCost, this.merged.bridge, {
      append: (input) => this.recorder.append(input),
      stopAllWork: () => this.stopAllWork(),
      retireAllDelegations: () => this.router.retireAllDelegations(),
      announce: (text) => {
        this.router.deliverFromReasoner(text, 'interrupt', { synthetic: true, terminal: true });
      },
      destroyed,
      workLoopPath: reasoner.loopPath,
      logger: this.logger,
    });
  }

  /** Adopt the facade-minted MCP manager this session must close. */
  adoptMcpManager(manager: McpClientManager): void {
    this.ownedMcpManager = manager;
  }

  // -------------------------------------------------------------------------
  // Assembly
  // -------------------------------------------------------------------------

  private routerPorts(config: ResolvedCortexAgentConfig): DuplexRouterPorts {
    const { talker, reasoner } = this;
    return {
      deliverToTalker: (content, wake) => {
        if (wake) this.digestion.preempt();
        talker.deliver(content, { wake });
      },
      talkerIdle: () => !talker.isLoopActive,
      spawnLookup: (question, causeSeq) => this.lookups.request(question, causeSeq),
      dispatchToReasoner: (message, causeSeq, options) =>
        this.dispatcher.dispatch(message, causeSeq, options),
      appendLog: (input) => this.recorder.append({
        type: input.type,
        loopPath: input.loopPath,
        content: input.content,
        // The router supplies causation explicitly; entries it cannot
        // attribute carry no stamp rather than a guessed one.
        causedBy: input.causedBy ?? null,
        ...(input.wake !== undefined ? { wake: input.wake } : {}),
        ...(input.data !== undefined ? { data: input.data } : {}),
      }).seq,
      // Read from the loops' live-run cause tags, never from session
      // fields: the tags travel with the content, so a barge-in parked
      // behind a live run keeps its utterance seq through the sweep run (B1).
      currentTalkerCauseSeq: () => latestCauseSeq(talker.activeRunCauseTags),
      currentTalkerCauseTags: () => collectCauseTags(talker.activeRunCauseTags),
      currentReasonerCauseTags: () => collectCauseTags(reasoner.activeRunCauseTags),
      answerAsk: (askId, decision, reason) => this.broker.answer(askId, decision, reason),
      pendingAsks: () => this.broker.getPendingAsks(),
      workRefusal: () => this.aggregate.workRefusal(),
      idleSignal: config.idleSignal,
      logger: this.logger,
      talkerLoopPath: talker.loopPath,
      reasonerLoopPath: reasoner.loopPath,
    };
  }

  private brokerPorts(): PermissionBrokerPorts {
    const { talker, reasoner } = this;
    return {
      appendLog: (input) => this.recorder.append({
        type: input.type,
        loopPath: input.loopPath,
        content: input.content,
        causedBy: input.causedBy ?? null,
        ...(input.wake !== undefined ? { wake: input.wake } : {}),
        ...(input.data !== undefined ? { data: input.data } : {}),
      }).seq,
      // The reserved ask lane: a real wake delivery carrying the ask-kind
      // cause tag, so the run that voices the request is identifiable to
      // the consent check (an answer from that same run cannot bind). No
      // token bucket, no dedup, no queues; it stamps the delivery spacing
      // clock so queued ordinary deliveries hold off behind a fresh ask
      // instead of talking over it.
      voiceToTalker: (content, causeTag) => {
        this.router.stampReservedLane();
        if (this.askVoicingHeld) {
          // A conversation abort just happened: the user said stop, so the
          // request is not read out now. Refusing the hand-off is how the
          // ask stays SAFE while it stays quiet: the broker treats a throw
          // as "nothing reached the user" and withdraws the consent anchor,
          // which is exactly true here. Delivering and then discarding
          // would leave the ask anchored for a voicing nobody heard.
          throw new Error(ASK_VOICING_HELD_REASON);
        }
        this.deferredAskVoicing = false;
        this.trackAskVoicing(content);
        this.digestion.preempt();
        talker.deliver(content, { wake: true, causeTag });
      },
      currentTalkerCauseTags: () => collectCauseTags(talker.activeRunCauseTags),
      // Keep the loop registry's voiced flag truthful for tool asks so
      // headline and consumer surfaces show what has been read out.
      markAskVoiced: (askId) => {
        reasoner.markAskVoiced(askId);
      },
      logger: this.logger,
    };
  }

  /** Every handler the session installs, in the order they must run. */
  private wire(): void {
    const { talker, reasoner, router, headlines, outcomes } = this;

    // The talker carries exactly the control toolset (D5/D8); the reasoner
    // gains Deliver (F1), which reports through the outcome reporter, and
    // SteerSubAgent (D12).
    for (const tool of buildControlTools(router)) {
      talker.addConsumerTool(tool);
    }
    reasoner.addConsumerTool(buildDeliverTool(outcomes));
    reasoner.addConsumerTool(buildSteerSubAgentTool(reasoner));

    // Conversation-side log producers and delta capture.
    this.recorder.wireConversation(talker, (text) => {
      // The reply entry keeps the raw text on purpose: it is the audit
      // trail and has to record what the talker actually said. Only the
      // reasoner-bound copy is sanitized, so a talker that quotes a
      // permission marker cannot carry the fence nonce to the loop that
      // authors the fenced content.
      router.noteTalkerReply(stripAskFence(text));
    });
    this.recorder.wireErrors(talker);
    this.recorder.wireErrors(reasoner);
    this.recorder.wireWork(reasoner);
    // The talker has no background completions, but its parked wake
    // deliveries (user utterances among them) can dead-letter after
    // repeated failed carrying runs; those drops must reach the log.
    this.recorder.wireDeadLetters(talker, (result) => {
      // A destroyed wake delivery on the conversation surface may be a
      // permission voicing, in which case the user never heard the request
      // the broker still counts as read out. The broker withdraws its
      // consent anchor and reads it again (D16 anchor rules).
      if (result.kind === 'wake_delivery') {
        this.broker.noteDeliveryDestroyed(result.message);
      }
    });

    // The facade-fed headline block (communication.md): live status per
    // loop and running sub-agent, view-injected into the talker every turn
    // outside BP3, hard token cap with truncation, all interpolated values
    // escaped. Session state, never log entries.
    talker.setHeadlineProvider(() => headlines.build(), {
      maxTokens: TALKER_HEADLINE_MAX_TOKENS,
    });
    // After the error log producers: a failure's error entry lands before
    // the delivery that announces it.
    outcomes.wireFailureSurfacing();

    // Run tracking: implicit deliveries, the liveness watchdog, the
    // per-turn dispatch cap, the stop-reason audit, and the headline feed.
    const reasonerBridge = reasoner.getEventBridge();
    reasonerBridge.on('loop_start', (event) => {
      if (event.childTaskId) return;
      outcomes.noteRunStart();
      router.noteReasonerRunStart();
      headlines.noteRunStart();
    });
    reasonerBridge.on('loop_end', (event) => {
      if (event.childTaskId) return;
      outcomes.noteRunEnd(event);
      headlines.noteRunEnd();
      this.digestion.schedule();
    });
    // Headline activity feed: the reasoner's own tool calls and last
    // user-facing output. Child tool activity reaches the block through
    // getActiveSubAgents() (the sub-agent manager tracks it), so only
    // main-loop events feed here.
    reasonerBridge.on('tool_call_start', (event) => {
      if (event.childTaskId) return;
      const payload = event.payload as { toolName?: string; args?: Record<string, unknown> } | undefined;
      if (!payload?.toolName) return;
      headlines.noteToolStart(payload.toolName, summarizeHeadlineArgs(payload.toolName, payload.args));
    });
    reasonerBridge.on('tool_call_end', (event) => {
      if (event.childTaskId) return;
      headlines.noteToolEnd();
    });
    reasonerBridge.on('turn_end', (event) => {
      if (event.childTaskId) return;
      const userFacing = event.textOutput?.userFacing;
      if (userFacing && userFacing.trim().length > 0) {
        headlines.noteOutput(userFacing);
      }
    });
    const talkerBridge = talker.getEventBridge();
    talkerBridge.on('turn_end', (event) => {
      if (event.childTaskId) return;
      router.noteTalkerTurnEnd();
    });
    // D17 terminate guards and the stop-reason audit, after the turn-end
    // dispatch bookkeeping above.
    this.guards.attach(talker);
    talkerBridge.on('loop_end', (event) => {
      if (event.childTaskId) return;
      this.digestion.schedule();
    });
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  /** Duplex prompt path: talker deliver(), never talker prompt() (F15). */
  async prompt(input: string, options?: DirectCompletionOptions): Promise<unknown> {
    const talker = this.talker;
    this.services.noteInputArriving();
    this.digestion.preempt();
    this.services.prompts.begin();
    try {
      const entry = this.recorder.append({
        type: 'utterance',
        loopPath: talker.loopPath,
        content: input,
        causedBy: null,
      });
      // The user's own words reach the reasoner with the next dispatch
      // (D18). The exchange rollover for the delegation caps and dispatch
      // dedup happens when a talker run consumes this utterance (the
      // router reads its cause tag off the run), not here at arrival: a
      // barge-in arriving mid-batch must not reset state under the batch
      // still running.
      this.router.noteUserUtterance(input);
      // The utterance travels with the content as a discriminated cause tag
      // (kind + seq): the run that consumes the input (the turn started
      // here, or the sweep run after a barge-in parks) exposes it through
      // activeRunCauseTags, which is where the router reads directive
      // causation and where D16's consent check will look for a qualifying
      // user utterance among mixed-kind causes (B1/D16).
      const result = talker.deliver(input, {
        wake: true,
        causeTag: { kind: 'utterance', seq: entry.seq } satisfies CauseTag,
        ...(options ? { promptOptions: options } : {}),
      });
      // The user is back, so a request an abort silenced is read out again,
      // behind this input rather than ahead of it.
      this.reopenHeldAskVoicing();
      if (result.outcome === 'prompted' && result.turn) {
        return await result.turn;
      }
      // Parked (barge-in): the input rides the talker's next run. Resolve
      // at the next gate quiescence, which is after that run.
      for (;;) {
        await talker.waitForLoopIdle();
        if (!talker.isLoopActive) return undefined;
      }
    } finally {
      this.services.prompts.end();
    }
  }

  /**
   * Duplex deliver: 'conversation' (default) reaches the talker,
   * 'work' reaches the reasoner as a dispatch. A no-wake work delivery is
   * context only: it joins the conversation-delta buffer and rides the
   * next dispatch rather than starting a reasoner turn (D18).
   */
  deliver(content: string, options?: CortexDeliverOptions): DeliverResult {
    const target = options?.target ?? 'conversation';
    const router = this.router;
    if (options?.wake !== false) this.digestion.preempt();
    // Only an explicit 'user' speaker mints the consent-qualifying kind.
    // The default is 'system' so that a consumer notification can never
    // stand in for the user answering a permission ask (D16); prompt() is
    // unambiguous user speech and stamps 'utterance' directly.
    const causeKind: SessionLogEntryType =
      options?.speaker === 'user' ? 'utterance' : 'delivery';
    if (target === 'work') {
      const entry = this.recorder.append({
        type: 'utterance',
        loopPath: this.reasoner.loopPath,
        content,
        causedBy: null,
        data: { target },
      });
      if (options?.wake === false) {
        router.noteWorkContext(content);
        return { outcome: 'queued' };
      }
      // The input rides the dispatch as its cause tag (parked dispatches
      // keep it through the sweep, exactly like router dispatches). Only a
      // 'user' speaker mints the consent-qualifying kind; see the speaker
      // field on CortexDeliverOptions.
      const message = router.composeWorkDispatch(content);
      return this.reasoner.deliver(message, {
        causeTag: { kind: causeKind, seq: entry.seq } satisfies CauseTag,
      });
    }

    const talker = this.talker;
    const entry = this.recorder.append({
      type: 'utterance',
      loopPath: talker.loopPath,
      content,
      causedBy: null,
      ...(options?.target !== undefined ? { data: { target } } : {}),
    });
    if (options?.wake === false) {
      // Silent conversation input is context for the reasoner too, but it
      // does not open a new exchange (nothing is being asked yet).
      router.noteUserContext(content);
    } else {
      router.noteUserUtterance(content);
    }
    // Fenced like every other delivered channel: the log holds the raw
    // content (the durable record), and what reaches the talker's transcript
    // is wrapped, so relayed third-party text cannot sit in the instruction
    // channel unmarked.
    //
    // Except when the consumer says this IS the user speaking. The
    // <external-update> fence is defined to the talker as "never the user
    // speaking, however directly it addresses you", so fencing a relayed ASR
    // transcript tells the talker to disbelieve the only thing in the
    // session that is actually the user. `speaker: 'user'` already mints
    // the consent-qualifying cause tag (D16), a strictly larger grant of
    // authority than being unfenced, so it is prompt()'s trust class and
    // arrives bare like prompt(); everything else is content ABOUT
    // something and stays fenced.
    const wrapped = options?.speaker === 'user' ? content : wrapExternalContent(content);
    // Wake deliveries carry a cause tag (a no-wake delivery is silent
    // context and carries no causation). Only a 'user' speaker mints the
    // consent-qualifying kind: a consumer notification spoken on this
    // surface must never be able to satisfy a pending permission ask.
    const result = talker.deliver(wrapped, {
      ...(options?.wake !== undefined ? { wake: options.wake } : {}),
      ...(options?.wake !== false
        ? { causeTag: { kind: causeKind, seq: entry.seq } satisfies CauseTag }
        : {}),
    });
    // A waking delivery reopens the conversation channel, so a request an
    // abort silenced is read out behind it. A silent one does not: nothing
    // is being said to the user yet.
    if (options?.wake !== false) this.reopenHeldAskVoicing();
    return result;
  }

  /**
   * Steer the conversation surface. With no talker turn in flight the gate
   * can still be held (idle digestion, an end-of-run drain), so the loop
   * would accept the steer into pi's queue with no run to read it, where it
   * waits for whatever run starts next and is never logged. A consumer
   * steers precisely when it believes the conversation is busy, so this is
   * the user's next utterance: route it as one, logged, preempting the
   * digestion, and opening (or joining) the next talker run.
   */
  steer(message: string): void {
    if (this.talker.isPrompting) {
      this.talker.steer(message);
      return;
    }
    void this.services.prompt(message).catch((err: unknown) => {
      this.logger.warn('steer delivered as a prompt failed', {
        error: errorMessageOf(err),
      });
    });
  }

  /**
   * Abort per the facade-api.md abort table: each scope aborts its loop's
   * in-flight turn, drops queued deliveries to that target, and clears its
   * pi queues; router-held deliveries are dropped but stay in the log
   * (retained, not delivered). Pending asks resolve as deny through the
   * abort race on the aborted loop.
   */
  async abort(scope: CortexAbortScope): Promise<void> {
    const { talker, reasoner, router } = this;
    const work: Array<Promise<unknown>> = [];
    if (scope === 'conversation' || scope === 'all') {
      router.dropPendingDeliveries();
      this.recorder.recordDroppedQueue(talker, 'abort', talker.clearAllQueues());
      // Everything parked is gone, voicings included.
      this.trackedAskVoicings.clear();
      work.push(talker.abort());
      // Quick lookups belong to the conversation surface (abort table):
      // cancelled here, untouched by a 'work' abort.
      work.push(this.lookups.cancelAll());
    }
    if (scope === 'work' || scope === 'all') {
      router.dropWorkContext();
      // Held deliveries are results of the work being stopped: per the
      // abort table they are retained in the log, not delivered, for
      // every scope. Without this a completed-but-undelivered when_idle
      // result from the stopped work would degrade and still be voiced.
      router.dropPendingDeliveries();
      this.recorder.recordDroppedQueue(reasoner, 'abort', reasoner.clearAllQueues());
      this.outcomes.expectAbort('user');
      work.push(reasoner.abort());
      for (const taskId of reasoner.getSubAgentManager().getActiveTaskIds()) {
        work.push(reasoner.cancelSubAgent(taskId));
      }
      // All work is stopped, parked dispatches included, so no task may
      // go on being described as in progress. The user asked for this
      // and it was acknowledged on the conversation surface: retired
      // quietly, never announced back.
      router.retireAllDelegations();
      // Pending asks belong to the stopped work and settle as deny: tool
      // asks through each aborted run's own signal race, network asks
      // (which carry no signal) here. Double settlement is guarded.
      this.broker.settleAll('abort');
      // Settling an ask kills the request; it does not kill the voicing
      // that was already handed to the talker. A voicing parked behind a
      // busy talker outlives its ask, gets read out afterwards, and the
      // user's answer then lands in an empty registry and is told there
      // is nothing pending. Retract the voicings with their asks.
      this.dropMootAskVoicings('abort');
    }
    try {
      await Promise.all(work);
    } finally {
      this.outcomes.abortUnwound('user');
    }
    if (scope === 'conversation') {
      this.holdVoicingForReopen();
    }
  }

  /** Stop every piece of running work (the aggregate budget tripped). */
  private stopAllWork(): Promise<unknown> {
    const swallow = (err: unknown): void => {
      this.logger.warn('budget-breach abort failed', {
        error: errorMessageOf(err),
      });
    };
    const { talker, reasoner } = this;
    const stops: Array<Promise<unknown>> = [];
    stops.push(talker.abort().catch(swallow));
    stops.push(reasoner.abort().catch(swallow));
    for (const taskId of reasoner.getSubAgentManager().getActiveTaskIds()) {
      stops.push(reasoner.cancelSubAgent(taskId).catch(swallow));
    }
    stops.push(this.lookups.cancelAll().catch(swallow));
    return Promise.all(stops);
  }

  /**
   * A quick lookup settled. Non-cancelled outcomes (including timeouts and
   * failures, which must be visible) route through the router: durable
   * lookup_result entry, talker wake, reasoner delta. Cancelled lookups
   * were stopped on purpose (abort, restore, teardown): logged, never
   * delivered.
   */
  private handleLookupOutcome(outcome: QuickLookupOutcome): void {
    if (outcome.status === 'cancelled') {
      if (this.services.destroyed()) return;
      this.recorder.append({
        type: 'lifecycle',
        loopPath: `lookup/${outcome.alias}`,
        content: `Quick lookup ${outcome.alias} cancelled`,
        data: {
          event: 'lookup_cancelled',
          alias: outcome.alias,
          question: outcome.question,
        },
        causedBy: outcome.causeSeq,
      });
      return;
    }
    this.router.deliverLookupResult(outcome);
    this.services.markStateDirty();
  }

  // -------------------------------------------------------------------------
  // Ask voicing on the conversation surface
  // -------------------------------------------------------------------------

  /**
   * Remember a voicing text so the session can recognize it later among the
   * talker's parked deliveries. FIFO-bounded (Sets iterate insertion-order).
   */
  private trackAskVoicing(content: string): void {
    this.trackedAskVoicings.add(content);
    while (this.trackedAskVoicings.size > MAX_TRACKED_ASK_VOICINGS) {
      const oldest = this.trackedAskVoicings.values().next().value;
      if (oldest === undefined) break;
      this.trackedAskVoicings.delete(oldest);
    }
  }

  /**
   * Retract ask voicings still parked on the talker after their asks were
   * settled wholesale. Only the session's own voicing texts are matched, so
   * a parked user utterance (and the cause tag that makes it able to grant
   * consent) is left exactly where it is.
   */
  private dropMootAskVoicings(reason: 'abort' | 'restore'): void {
    const talker = this.talker;
    if (this.trackedAskVoicings.size === 0) return;
    const dropped = talker.dropPendingWakeDeliveries(
      (content) => this.trackedAskVoicings.has(content),
    );
    // Every ask is gone, so every remembered voicing is moot whether or not
    // it was still parked.
    this.trackedAskVoicings.clear();
    if (dropped.length === 0) return;
    this.recorder.append({
      type: 'lifecycle',
      loopPath: talker.loopPath,
      content: `${dropped.length} permission voicing(s) dropped by ${reason}: their requests are settled`,
      data: { event: 'ask_voicing_dropped', reason, count: dropped.length },
      causedBy: null,
    });
  }

  /**
   * Conversation abort with a voiced ask still pending on live work.
   *
   * Two facts have to come apart here. The user never heard this request
   * (its voicing went with the talker's queues, or its read-out turn was
   * aborted mid-sentence), so the consent anchor must be withdrawn NOW:
   * left standing, the user's next words would satisfy D16's "an utterance
   * after the voicing" test for a request nobody read to them. But the user
   * just said stop, and following that with the agent immediately talking
   * again is the opposite of what they asked for.
   *
   * So the anchor is withdrawn and the read-out is not performed. Holding
   * the hand-off is what keeps those consistent: the broker's contract is
   * that a refused hand-off means nothing reached the user, which is
   * literally true, and it leaves the ask pending, silent and answerable
   * with no anchor. The request is read out again at the next conversation
   * opening ({@link reopenHeldAskVoicing}); until then it is still visible
   * in the headline block and still bounded by its own timeout.
   */
  private holdVoicingForReopen(): void {
    const broker = this.broker;
    this.askVoicingHeld = true;
    let held: boolean;
    try {
      held = broker.noteVoicingLost();
    } finally {
      this.askVoicingHeld = false;
    }
    if (!held) return;
    this.deferredAskVoicing = true;
    this.recorder.append({
      type: 'lifecycle',
      loopPath: this.talker.loopPath,
      content: 'Permission request held silent after a conversation abort; ' +
        'it will be read out again when the conversation reopens',
      data: { event: 'ask_voicing_deferred', reason: 'conversation_abort' },
      causedBy: null,
    });
  }

  /**
   * The conversation surface just received input, so the channel is open
   * again: read out any request {@link holdVoicingForReopen} silenced.
   * Called after the input is handed to the talker, so the voicing parks
   * behind that run and arrives carrying its ask cause tag, which is what
   * stops the same run from granting the request it is about to read.
   */
  private reopenHeldAskVoicing(): void {
    if (!this.deferredAskVoicing) return;
    this.deferredAskVoicing = false;
    // noteVoicingLost rather than revoiceCurrent: the anchor is already
    // withdrawn and this re-read must take a fresh one, and it must not be
    // swallowed by the re-voice damping window the abort just stamped.
    this.broker.noteVoicingLost();
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Every permission ask currently blocked on a decision, from both
   * registries, deduplicated by askId.
   *
   * Two registries exist because two different things track asks. The
   * reasoner's holds its own and its sub-agents' (children mirror in through
   * the child resolver wrapper). The broker's holds everything routed
   * through the conversation, whichever loop raised it. They overlap for
   * reasoner tool asks, which carry the same askId in both, and each holds
   * asks the other never sees: a quick-lookup loop is built through
   * `AgentLoop.create`, not `createChildAgent`, so its asks reach the broker
   * and never the reasoner's registry.
   *
   * Lookup asks are deliberately NOT mirrored into the reasoner's registry
   * the way sub-agent asks are. A lookup is not in the reasoner's subtree:
   * it is a facade-owned peer on the conversation side (D13) with its own
   * pool, its own wall-clock timeout, and cancellation by a *conversation*
   * abort. Mirroring would make `reasoner.waitForAskSettlement()` block on
   * something the reasoner cannot influence and its registry claim work it
   * does not own.
   */
  pendingAsks(): PendingAsk[] {
    const asks = this.reasoner.getPendingAsks();
    const mirrored = new Set(asks.map((ask) => ask.askId));
    const brokerOnly = this.broker.getPendingAsks()
      .filter((ask) => !mirrored.has(ask.askId))
      .map(({ kind: _kind, ...ask }) => ask);
    return [...asks, ...brokerOnly];
  }

  /** The duplex-only settlement terms, in wait order. */
  settlementTerms(): {
    afterTalkerGate: SettlementTerm[];
    afterSubAgents: SettlementTerm[];
    afterReasonerAsks: SettlementTerm[];
  } {
    const { router, lookups } = this;
    return {
      // Held wake deliveries start talker runs when they land; wait
      // event-driven on the router rather than spinning.
      afterTalkerGate: [{
        name: 'router-deliveries',
        pending: () => router.pendingDeliveryCount > 0,
        settled: () => router.waitForDeliveriesSettled(),
      }],
      // Active quick lookups: their settlement enqueues router deliveries
      // and talker wakes, so the wait re-checks everything afterwards.
      afterSubAgents: [{
        name: 'quick-lookups',
        pending: () => lookups.activeCount > 0,
        settled: async () => {
          await lookups.waitForIdle();
          await yieldMacrotask();
        },
      }],
      afterReasonerAsks: [{
        name: 'broker-asks',
        pending: () => this.broker.pendingAskCount > 0,
        settled: () => this.broker.waitForSettlement(),
      }],
    };
  }

  /** Quick lookups in flight (restore refuses to run under them). */
  get activeLookups(): number {
    return this.lookups.activeCount;
  }

  /** Settled quick-lookup spend, for the usage ledger. */
  lookupUsage(): SessionUsage {
    return this.lookups.getSettledUsage();
  }

  /**
   * The merged event stream: every event carries its loop path in its own
   * loopPath field ('talker', 'reasoner', 'reasoner/task-7'), while
   * childTaskId keeps meaning "this came from a sub-agent".
   */
  get eventBridge(): EventBridge {
    return this.merged.bridge;
  }

  /**
   * A fan-out view over both loops' context managers (D6: mid-session slot
   * writes reach both loops so they never diverge; reads come from the
   * reasoner; no per-slot routing knob exists).
   */
  get contextManager(): ContextManager {
    this.fanOutContextManager ??= new FanOutContextManager(
      this.reasoner.getContextManager(),
      this.talker.getContextManager(),
    );
    return this.fanOutContextManager;
  }

  get aggregateBudgetGuard(): BudgetGuard {
    return this.aggregate.guard;
  }

  // -------------------------------------------------------------------------
  // Composite setters
  // -------------------------------------------------------------------------

  /**
   * Each loop gets the consumer base prompt with its own role prompt
   * appended (the consumer supplies one undifferentiated prompt,
   * facade-api.md); the returned composition is the reasoner's.
   */
  setBasePrompt(basePrompt: string): string {
    this.consumerBasePrompt = basePrompt;
    const talkerPrompt = appendRolePrompt(basePrompt, TALKER_ROLE_PROMPT);
    this.talker.setBasePrompt(talkerPrompt ?? basePrompt);
    const reasonerPrompt = appendRolePrompt(basePrompt, REASONER_ROLE_PROMPT);
    return this.reasoner.setBasePrompt(reasonerPrompt ?? basePrompt);
  }

  /** The consumer's base prompt, role prompts excluded. */
  getBasePrompt(): string {
    return this.consumerBasePrompt ?? '';
  }

  /**
   * Swap the primary (reasoner) model. An unpinned talker is re-mirrored to
   * the fast tier of the new model, exactly as create() picked it; without
   * that a provider switch would leave the presence loop (and every quick
   * lookup, which builds from the talker's model) on the old provider. A
   * pinned `talker.model` is the consumer's choice and stays.
   */
  setModel(model: CortexModel): void {
    this.reasoner.setModel(model);
    if (this.talkerModelPinned) return;
    this.talker.setModel(this.reasoner.getAutoResolvedUtilityModel());
    this.services.refreshModelNotes();
  }

  /**
   * Set the utility model on both loops under the same rule assembly
   * applies: the talker takes it when it shares the talker's provider and
   * skips it otherwise, because a loop rejects a utility model from another
   * provider. The talker's primary model is not affected.
   */
  setUtilityModel(model: CortexModel): void {
    this.reasoner.setUtilityModel(model);
    if (model.provider === this.talker.getModel().provider) {
      this.talker.setUtilityModel(model);
    } else {
      this.logger.warn('talker keeps its own utility model: the new one is from another provider', {
        utilityProvider: model.provider,
        talkerProvider: this.talker.getModel().provider,
      });
    }
  }

  /**
   * The talker's stable cache id derives from the same value (distinct
   * per-loop prefix caches, log-and-context.md); the reasoner keeps the
   * bare id so mode flips keep its cache warm.
   */
  setSessionId(value: string | null): void {
    this.reasoner.setSessionId(value);
    this.talker.setSessionId(value === null ? null : `${value}${TALKER_SESSION_ID_SUFFIX}`);
  }

  // -------------------------------------------------------------------------
  // Persistence and teardown
  // -------------------------------------------------------------------------

  /** The talker side and router state of the persisted artifact. */
  captureState(): {
    talkerHistory: AgentMessage[];
    talkerMemory: ObservationalMemoryState | null;
    router: DuplexRouterState;
  } {
    return {
      talkerHistory: this.talker.getConversationHistory(),
      talkerMemory: this.talker.getObservationalMemoryState(),
      router: this.router.exportState(),
    };
  }

  /** Hydrate the talker from a restored artifact (history before memory). */
  hydrate(talkerHistory: AgentMessage[], talkerMemory: ObservationalMemoryState | null): void {
    this.talker.restoreConversationHistory(talkerHistory);
    if (talkerMemory) {
      this.talker.restoreObservationalMemoryState(talkerMemory);
    }
  }

  /**
   * Everything the session holds describes the replaced session: queued
   * talker content, router state (delegations, deltas, held deliveries,
   * dedup), the aggregate spend, the repair streak, and the voicings of
   * asks the router reset has already settled. What the artifact carries of
   * the router's state comes back.
   */
  resetForRestore(routerState: DuplexRouterState | undefined): void {
    this.recorder.recordDroppedQueue(this.talker, 'restore', this.talker.clearAllQueues());
    // Pending asks belong to the replaced session; every resolver settles
    // as deny so no loop stays blocked on an ask nobody can answer anymore.
    this.broker.reset();
    this.router.resetForRestore();
    this.restoreRouterState(routerState);
    this.aggregate.resetForRestore();
    this.guards.resetForRestore();
    this.trackedAskVoicings.clear();
    this.deferredAskVoicing = false;
  }

  /**
   * Re-apply the artifact's router state. Tasks that were still outstanding
   * lost the run serving them, so they are reported as interrupted instead
   * of left listed as live work: a lifecycle entry each, and one silent
   * note for the talker, which surfaces with the user's next turn rather
   * than waking the conversation on restore.
   */
  private restoreRouterState(state: DuplexRouterState | undefined): void {
    const router = this.router;
    const logAliases = this.recorder.log.getLog()
      .filter((entry) => entry.type === 'directive')
      .map((entry) => (entry.data as { alias?: unknown } | undefined)?.alias);
    const interrupted = router.restoreState(state, highestTaskAlias(logAliases));
    if (interrupted.length === 0) return;
    for (const delegation of interrupted) {
      this.recorder.append({
        type: 'lifecycle',
        loopPath: this.reasoner.loopPath,
        content: `Task ${delegation.alias} interrupted by the session restore`,
        data: { event: 'delegation_interrupted', alias: delegation.alias },
        causedBy: delegation.seq,
      });
    }
    const list = interrupted
      .map((delegation) => `${delegation.alias} (${delegation.instructions})`)
      .join(', ');
    router.deliverFromReasoner(
      `The session was restored. Background work that was in progress is no longer running: ${list}. ` +
      'If the user asks about it, say it was interrupted and offer to start it again.',
      'silent',
      { synthetic: true },
    );
  }

  /** Stop the session's timers and settle its asks, synchronously. */
  beginDestroy(): void {
    this.digestion.destroy();
    // Settle every pending ask first so no resolver promise outlives the
    // session: a hanging ask would block its loop into the force-kill path.
    this.broker.destroy();
    this.router.destroy();
    this.aggregate.destroy();
  }

  /** The teardowns that run alongside the loops' own. */
  teardowns(): Array<Promise<void>> {
    return [this.lookups.destroy()];
  }

  /**
   * After the loops detach their listeners: the shared connections (and
   * stdio subprocesses) are facade-owned, so the loops never close them.
   */
  async closeOwnedResources(): Promise<void> {
    if (this.ownedMcpManager) {
      await this.ownedMcpManager.closeAll().catch(() => {});
    }
  }

  /** Last: nothing forwards events after teardown. */
  finishDestroy(): void {
    this.merged.destroy();
  }
}
