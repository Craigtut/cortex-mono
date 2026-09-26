/**
 * DuplexRouter: the facade's control-tool dispatch surface, wake policy,
 * and backpressure between the resident loops (communication.md; decisions
 * D8, D10, D17, D18, D19, D20).
 *
 * Producer proposes, router disposes: the reasoner proposes a wake class
 * per delivery and the router may demote it. Wake classes describe intent,
 * not rate; the router bounds rate with an interrupt token bucket,
 * content-hash dedup over recent deliveries, per-turn and per-exchange
 * delegation caps, dispatch dedup (absorbing retry-induced double
 * dispatch), and a facade-enforced minimum inter-delivery spacing that an
 * always-idle or never-idle consumer signal cannot collapse.
 *
 * The router also owns the conversation-delta buffer (D18): both sides of
 * the conversation are buffered facade-side and flushed as a context-only
 * block INSIDE the next dispatch message, so a directive can never reach
 * the reasoner without the conversation it points at (a directive parked
 * behind a busy reasoner is delivered by a sweep run, which never flushes
 * the loop's silent queue; carrying the block in the dispatch message makes
 * the pairing exact in every loop state). Only a dispatch starts a reasoner
 * turn; deltas alone never do.
 */

import type { CortexLogger } from '../types.js';
import type { WakeClass } from '../session-log.js';
import { NOOP_LOGGER } from '../noop-logger.js';
import { errorMessageOf } from '../error-classifier.js';
import {
  buildCancelDirective,
  buildLookupResultText,
  buildSpawnDirective,
  buildSteerDirective,
  buildWorkInputDirective,
  composeDispatchMessage,
  wrapDeliveryForTalker,
} from './prompts.js';
import type { CauseTag } from './cause-tags.js';
import { DispatchPolicy } from './dispatch-policy.js';
import { DeliveryScheduler } from './delivery-scheduler.js';
import { LivenessWatchdog } from './watchdog.js';
import { DelegationRegistry } from './delegations.js';
import type { DelegationRegistryState, DelegationSnapshot } from './delegations.js';
import { ConversationDeltas } from './conversation-deltas.js';
import type { ConversationDeltasState } from './conversation-deltas.js';
import { asTrimmedString } from './control-tools.js';
import type { ControlDispatchTarget } from './control-tools.js';
import { PERMISSION_BROKER_DEFAULTS } from './permission-broker.js';
import type { AskAnswerOutcome } from './permission-broker.js';
import type { DeliveryIntakeResult, DeliveryTarget } from './reasoner-tools.js';
import type { QuickLookupOutcome, QuickLookupRequestResult } from './quick-lookups.js';

// ---------------------------------------------------------------------------
// Ports and options
// ---------------------------------------------------------------------------

/** Log entry input the router produces (a subset of the facade's schema). */
export interface RouterLogInput {
  type: 'directive' | 'delivery' | 'lifecycle' | 'ask' | 'ask_answer' | 'lookup_result';
  loopPath: string;
  content: string;
  wake?: WakeClass;
  causedBy?: number;
  data?: Record<string, unknown>;
}

/** What the router needs from the facade. */
export interface DuplexRouterPorts {
  /**
   * Hand content to the talker: wake true starts or parks a turn, wake
   * false lands in the talker's silent queue (never pi's steering queue;
   * the loop's deliver() enforces that).
   */
  deliverToTalker(content: string, wake: boolean): void;
  /** Whether the conversation surface is idle (the default lull signal). */
  talkerIdle(): boolean;
  /**
   * Wake-deliver a composed dispatch message to the reasoner. causeSeq is
   * the log seq of the directive (or work utterance) for causation binding
   * of the run it starts (or, with atTurnBoundary, the live run it joins).
   */
  dispatchToReasoner(message: string, causeSeq: number | null, options?: ReasonerDispatchOptions): void;
  /** Append a session log entry; returns its seq. */
  appendLog(input: RouterLogInput): number;
  /**
   * Latest cause seq on the talker's live run, or null. This is the
   * LOG-STAMPING collapse; anything deciding behavior from causation (the
   * exchange rollover here, the D16 consent check in the broker) must read
   * the full set via {@link currentTalkerCauseTags} instead.
   */
  currentTalkerCauseSeq(): number | null;
  /**
   * The FULL discriminated cause set of the talker's live run (empty when
   * no run is live or its content carried no tags). The set carries NO
   * ordering guarantee: readers must scan it, never assume ascending seq
   * order or read only the last element. This is the surface the D16
   * consent check reads (does the chain include a user utterance newer than
   * the voiced ask), where the collapsing helper above would misread a
   * mixed-kind set in both directions.
   */
  currentTalkerCauseTags(): readonly CauseTag[];
  /**
   * The FULL discriminated cause set of the reasoner's live run, with the
   * same no-ordering contract as {@link currentTalkerCauseTags}. Delegation
   * retirement reads it: a run routinely consumes several directives (a spawn
   * with a steer parked behind it), and a collapse to the newest would leave
   * the delegation the result actually answers listed as live forever.
   *
   * There is deliberately NO `currentReasonerCauseSeq` beside this. The
   * reasoner's log-stamping collapse is computed from this same set inside
   * the router ({@link DuplexRouter.reasonerCause}), so the pair cannot
   * disagree and a port implementation cannot supply a stamping seq while
   * reporting no tags. The talker keeps both ports because two different
   * consumers read them for two different purposes, with the D16 warning
   * attached; here there is one array and one reader of each derivation.
   */
  currentReasonerCauseTags(): readonly CauseTag[];
  /**
   * Settle a permission ask from the talker's answer_ask (the broker's
   * answer, where the D16 consent rules live).
   */
  answerAsk(askId: unknown, decision: unknown, reason: unknown): AskAnswerOutcome;
  /** Asks blocked on the user right now (the watchdog reports a wait). */
  pendingAsks(): ReadonlyArray<{ toolName: string; requestedAt: number }>;
  /**
   * Start a facade-spawned quick lookup (D13): an ephemeral read-only
   * sub-agent, never a reasoner directive. causeSeq is the log seq of the
   * quick_lookup directive; the outcome carries it back for causation. The
   * verdict is synchronous so a cap refusal reaches the talker's receipt in
   * the same dispatch.
   */
  spawnLookup(question: string, causeSeq: number | null): QuickLookupRequestResult;
  /**
   * Why new work cannot be dispatched right now, or null when it can. Set
   * after the session's aggregate spending limit is breached: a spawn,
   * steer or lookup would only start a run the guard stops at once, so the
   * talker gets a receipt it can relay instead. Cancels and permission
   * answers stay open (they reduce work, or unblock it being wound down).
   */
  workRefusal?(): string | null;
  /** Consumer idle signal (advisory, facade-api.md). */
  idleSignal?: (() => boolean) | undefined;
  logger?: CortexLogger;
  /** Loop-path labels for log entries. Defaults: 'talker' / 'reasoner'. */
  talkerLoopPath?: string;
  reasonerLoopPath?: string;
}

/** How a dispatch should reach a reasoner that may be mid-run. */
export interface ReasonerDispatchOptions {
  /**
   * The directive redirects work the live run may be doing (steer, cancel):
   * a live run takes it at its next turn boundary instead of the next run.
   */
  atTurnBoundary?: boolean;
  /**
   * Every piece of work the live run serves has just been cancelled: stop
   * that run, then deliver. The facade may decline (it will not destroy
   * other content parked behind the run) and fall back to atTurnBoundary.
   */
  abortLiveRun?: boolean;
}

/** Router tunables; every default is overridable for tests and consumers. */
export interface DuplexRouterOptions {
  /** Minimum ms between talker-waking deliveries. */
  minDeliverySpacingMs?: number;
  /** Ms after which a held when_idle delivery degrades to interrupt. */
  whenIdleDegradeMs?: number;
  /** Poll interval while a when_idle delivery waits for a lull. */
  idlePollMs?: number;
  /** Interrupt token bucket capacity (D19). */
  interruptBucketCapacity?: number;
  /** Ms to earn one interrupt token back. */
  interruptRefillMs?: number;
  /** Window for content-hash dedup across recent deliveries. */
  deliveryDedupWindowMs?: number;
  /** Cap on remembered delivery hashes. */
  deliveryDedupMaxEntries?: number;
  /** Delegation dispatches allowed per talker turn. */
  maxDispatchesPerTurn?: number;
  /** Delegation dispatches allowed per exchange (user utterance). */
  maxDispatchesPerExchange?: number;
  /** Reasoner-run silence that triggers a synthesized progress delivery. */
  watchdogIntervalMs?: number;
  /**
   * How long a delegation may stay tracked without a result before it is
   * dropped. The backstop behind result-driven retirement, for work whose
   * conclusion never produces a delivery the router can attribute.
   */
  delegationMaxAgeMs?: number;
  /** Char bound on the buffered conversation deltas. */
  deltaBufferMaxChars?: number;
  /**
   * Timeout for tool and network permission asks; on expiry the ask
   * settles as deny with a reason. Null disables the timeout.
   */
  askTimeoutMs?: number | null;
  /**
   * Timeout for sandbox escalation asks: long rather than absent, since no
   * bound at all lets a talker that never relays the request block the
   * asking run indefinitely (PERMISSION_BROKER_DEFAULTS). Null disables it.
   */
  escalationAskTimeoutMs?: number | null;
  /**
   * Coalescing window before a settled ask lets the next queued one be
   * voiced, so one talker turn settling several asks still produces exactly
   * one voicing (PERMISSION_BROKER_DEFAULTS).
   */
  settleVoiceDelayMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

export const DUPLEX_ROUTER_DEFAULTS = {
  minDeliverySpacingMs: 2_000,
  whenIdleDegradeMs: 30_000,
  idlePollMs: 250,
  interruptBucketCapacity: 3,
  interruptRefillMs: 20_000,
  deliveryDedupWindowMs: 120_000,
  deliveryDedupMaxEntries: 32,
  maxDispatchesPerTurn: 4,
  maxDispatchesPerExchange: 8,
  watchdogIntervalMs: 90_000,
  delegationMaxAgeMs: 1_800_000,
  deltaBufferMaxChars: 16_000,
  // Ask timeouts and voicing cadence are read by the session's permission
  // broker; they sit here because consumer duplex tuning is one record.
  askTimeoutMs: PERMISSION_BROKER_DEFAULTS.askTimeoutMs,
  escalationAskTimeoutMs: PERMISSION_BROKER_DEFAULTS.escalationAskTimeoutMs,
  settleVoiceDelayMs: PERMISSION_BROKER_DEFAULTS.settleVoiceDelayMs,
} as const;

type ResolvedOptions = typeof DUPLEX_ROUTER_DEFAULTS;

/**
 * Bound on delivery_absorbed lifecycle entries per reasoner run (the N4
 * rule applied to the intake side): a reasoner (or its retry ladder)
 * re-emitting the same content arbitrarily many times in one run must not
 * write an entry per repeat. The dedup itself still absorbs every repeat;
 * past the bound only the log stays quiet, with the last written entry
 * marking the suppression.
 */
const MAX_ABSORBED_ENTRIES_PER_RUN = 3;

/**
 * Whether a delivery reports the work reaching a conclusion: it retires the
 * delegation it answers, and an explicit one stands in for the run's
 * implicit final-text delivery.
 *
 * `silent` is a milestone or progress note by contract (the reasoner's
 * role prompt says so), and the watchdog's synthetic delivery says
 * explicitly that the work is STILL running, so neither concludes
 * anything. A facade-synthesized terminal delivery (a failed run) does:
 * nothing further is coming for that task. The router may demote
 * `interrupt` to `when_idle` but never to or from `silent`, so the
 * proposed and the applied wake class give the same answer here.
 */
export function deliveryConcludes(
  wake: WakeClass | undefined,
  meta?: { implicit?: boolean; synthetic?: boolean; terminal?: boolean },
): boolean {
  if (meta?.terminal) return true;
  if (meta?.synthetic) return false;
  return wake !== 'silent';
}

/**
 * The router state that has to survive a persist/restore round trip
 * (CortexAgentStateV2.router). Everything else the router holds (caps,
 * dedup, the token bucket, spacing) describes the moment, not the session,
 * and restarts clean.
 */
export interface DuplexRouterState extends DelegationRegistryState, ConversationDeltasState {
  /**
   * Talker-waking deliveries already logged but not yet handed to the
   * talker. The log records them as delivered content, so dropping them at
   * restore would leave a result the user never heard looking delivered.
   */
  pendingDeliveries: string[];
}

// ---------------------------------------------------------------------------
// DuplexRouter
// ---------------------------------------------------------------------------

export type { DelegationSnapshot } from './delegations.js';

export class DuplexRouter implements ControlDispatchTarget, DeliveryTarget {
  private readonly ports: DuplexRouterPorts;
  private readonly options: ResolvedOptions;
  private readonly logger: CortexLogger;
  private readonly now: () => number;
  private readonly talkerLoopPath: string;
  private readonly reasonerLoopPath: string;

  // Delegation registry: human-friendly aliases so a fast-tier model never
  // reproduces UUIDs (communication.md).
  private readonly delegations: DelegationRegistry;

  // Conversation deltas (D18), flushed into the next dispatch message.
  private readonly deltas: ConversationDeltas;

  // Dispatch backpressure (D19).
  private readonly policy: DispatchPolicy;
  /** Absorbed-duplicate lifecycle entries written this reasoner run (bounded). */
  private absorbedEntriesThisRun = 0;

  // Delivery backpressure and pacing (D19).
  private readonly scheduler: DeliveryScheduler;

  // Liveness watchdog over reasoner runs (communication.md).
  private reasonerRunning = false;
  private reasonerRunStartAt = 0;
  private lastReasonerOutputAt = 0;
  private readonly watchdog: LivenessWatchdog;

  private destroyed = false;

  constructor(ports: DuplexRouterPorts, options?: DuplexRouterOptions) {
    this.ports = ports;
    this.options = { ...DUPLEX_ROUTER_DEFAULTS, ...pruneUndefined(options) };
    this.logger = ports.logger ?? NOOP_LOGGER;
    this.now = options?.now ?? Date.now;
    this.talkerLoopPath = ports.talkerLoopPath ?? 'talker';
    this.reasonerLoopPath = ports.reasonerLoopPath ?? 'reasoner';
    this.deltas = new ConversationDeltas(this.options.deltaBufferMaxChars);
    this.policy = new DispatchPolicy(
      {
        appendLog: (input) => this.ports.appendLog(input),
        currentTalkerCauseTags: () => this.ports.currentTalkerCauseTags(),
        talkerCause: () => this.talkerCause(),
        talkerLoopPath: this.talkerLoopPath,
      },
      {
        maxPerTurn: this.options.maxDispatchesPerTurn,
        maxPerExchange: this.options.maxDispatchesPerExchange,
      },
    );
    this.delegations = new DelegationRegistry({
      now: this.now,
      maxAgeMs: this.options.delegationMaxAgeMs,
    });
    this.scheduler = new DeliveryScheduler(
      {
        deliver: (content) => ports.deliverToTalker(wrapDeliveryForTalker(content), true),
        talkerIdle: () => ports.talkerIdle(),
        // A getter: the consumer's signal is read at every check.
        get idleSignal() {
          return ports.idleSignal;
        },
      },
      {
        minDeliverySpacingMs: this.options.minDeliverySpacingMs,
        whenIdleDegradeMs: this.options.whenIdleDegradeMs,
        idlePollMs: this.options.idlePollMs,
        interruptBucketCapacity: this.options.interruptBucketCapacity,
        interruptRefillMs: this.options.interruptRefillMs,
        deliveryDedupWindowMs: this.options.deliveryDedupWindowMs,
        deliveryDedupMaxEntries: this.options.deliveryDedupMaxEntries,
        now: this.now,
        logger: this.logger,
      },
    );

    this.watchdog = new LivenessWatchdog(
      {
        runStartedAt: () => (this.reasonerRunning ? this.reasonerRunStartAt : null),
        lastOutputAt: () => this.lastReasonerOutputAt,
        activeAliases: () => this.delegations.activeAliases(),
        pendingAsks: () => this.ports.pendingAsks(),
        // Rides the normal intake (log entry, dedup, spacing); marks itself
        // synthetic and resets the silence clock through lastReasonerOutputAt.
        reportProgress: (text) => {
          this.deliverFromReasoner(text, 'when_idle', { synthetic: true });
        },
      },
      { intervalMs: this.options.watchdogIntervalMs, now: this.now },
    );
  }

  // -------------------------------------------------------------------------
  // Conversation flow bookkeeping
  // -------------------------------------------------------------------------

  /**
   * A new user utterance arrived: buffer the delta. The exchange rollover
   * (caps, dedup, turn index) deliberately does NOT happen here: arrival
   * can be mid talker turn (a barge-in parks behind the live run), and
   * resetting at arrival would clear the dedup map under the batch still
   * running, so its retry-induced duplicate spawn would dispatch identical
   * work twice, and a talker that had exhausted its caps would earn a
   * fresh budget inside the very turn that was capped. The rollover
   * happens when a talker run CONSUMES the utterance instead: its cause
   * tag appears on the run and the next dispatch, or the turn boundary at
   * the latest, sees it (DispatchPolicy.beginDispatch).
   *
   * Open question (review N1): the per-exchange cap refreshes only on a
   * consumed user utterance, so a long autonomous stretch (deliveries
   * waking the talker with no new user input) runs against one fixed
   * delegation budget until the user next speaks. Whether autonomous
   * turns should ever refresh the cap is a policy call deferred until
   * real usage data exists.
   */
  noteUserUtterance(text: string): void {
    this.deltas.push({ speaker: 'user', text });
  }

  /** A talker reply: the other half of the conversation delta (F4). */
  noteTalkerReply(text: string): void {
    this.deltas.push({ speaker: 'assistant', text });
  }

  /** Consumer-provided context for the work surface (no-wake work input). */
  noteWorkContext(text: string): void {
    this.deltas.push({ speaker: 'consumer', text });
  }

  /**
   * A silent conversation input (facade deliver, wake false): conversation
   * context without opening a new exchange.
   */
  noteUserContext(text: string): void {
    this.deltas.push({ speaker: 'user', text });
  }

  /**
   * Compose a consumer work-input dispatch: the pending conversation block
   * ahead of the directive, exactly like a control-tool dispatch. The
   * facade delivers the returned message to the reasoner itself (it owns
   * the causation binding for the run).
   */
  composeWorkDispatch(content: string): string {
    return composeDispatchMessage(this.deltas.consumeBlock(), buildWorkInputDirective(content));
  }

  /**
   * A talker turn boundary: resets the per-turn dispatch cap, and rolls the
   * exchange if the ending run consumed a new utterance (DispatchPolicy).
   */
  noteTalkerTurnEnd(): void {
    this.policy.noteTurnEnd();
  }

  /** Reasoner run lifecycle, for the liveness watchdog. */
  noteReasonerRunStart(): void {
    this.reasonerRunning = true;
    this.absorbedEntriesThisRun = 0;
    const now = this.now();
    this.reasonerRunStartAt = now;
    this.lastReasonerOutputAt = now;
  }

  noteReasonerRunEnd(): void {
    this.reasonerRunning = false;
  }

  // -------------------------------------------------------------------------
  // Control-tool dispatch (D8/D17: every return is a voiceable receipt)
  // -------------------------------------------------------------------------

  dispatchSpawn(instructionsRaw: unknown): string {
    this.policy.beginDispatch();
    const refused = this.refuseWhenWorkBlocked('spawn_task');
    if (refused !== null) return refused;
    const instructions = asTrimmedString(instructionsRaw);
    if (!instructions) {
      return this.policy.refuse('spawn_task', 'missing instructions',
        'Could not start the task: no instructions given.');
    }
    const dedupKey = this.policy.key('spawn_task', instructions);
    const replay = this.policy.replay(dedupKey);
    if (replay !== undefined) return replay;
    const capRefusal = this.policy.admit('spawn_task');
    if (capRefusal) return capRefusal;

    const alias = this.delegations.reserveAlias();
    const seq = this.ports.appendLog({
      type: 'directive',
      loopPath: this.talkerLoopPath,
      content: `spawn_task ${alias}: ${instructions}`,
      data: { tool: 'spawn_task', alias, instructions },
      ...this.talkerCause(),
    });
    this.delegations.open(alias, instructions, seq);
    if (!this.dispatch(buildSpawnDirective(alias, instructions), seq)) {
      // Never handed over: do not track it as live work (headlines and
      // steer/cancel must not target a task the reasoner never received),
      // and never memoize a success receipt for it.
      this.delegations.remove(alias);
      return 'Could not start that: the handoff failed. Tell the user and try again.';
    }
    const receipt = `Started ${alias}.`;
    this.policy.remember(dedupKey, receipt);
    return receipt;
  }

  dispatchSteer(taskAliasRaw: unknown, messageRaw: unknown): string {
    this.policy.beginDispatch();
    const refused = this.refuseWhenWorkBlocked('steer_task');
    if (refused !== null) return refused;
    const message = asTrimmedString(messageRaw);
    if (!message) {
      return this.policy.refuse('steer_task', 'missing message',
        'Nothing to send: the redirect was empty.');
    }
    const aliasName = asTrimmedString(taskAliasRaw);
    let alias: string | null = null;
    if (aliasName) {
      const delegation = this.delegations.resolve(aliasName);
      if (!delegation) {
        return this.policy.refuse('steer_task', `unknown task "${aliasName}"`,
          `No task called "${aliasName}" is tracked right now.`);
      }
      if (delegation.cancelled) {
        return `Task ${delegation.alias} was already cancelled; start a new task if the work is wanted again.`;
      }
      alias = delegation.alias;
    }
    const dedupKey = this.policy.key('steer_task', alias ?? '', message);
    const replay = this.policy.replay(dedupKey);
    if (replay !== undefined) return replay;
    const capRefusal = this.policy.admit('steer_task');
    if (capRefusal) return capRefusal;

    const seq = this.ports.appendLog({
      type: 'directive',
      loopPath: this.talkerLoopPath,
      content: `steer_task${alias ? ` ${alias}` : ''}: ${message}`,
      data: { tool: 'steer_task', ...(alias ? { alias } : {}), message },
      ...this.talkerCause(),
    });
    // At the live run's next turn boundary: a redirect that waits for the
    // run to finish arrives after the work it was meant to change.
    if (!this.dispatch(buildSteerDirective(alias, message), seq, { atTurnBoundary: true })) {
      return 'The redirect did not go through. Tell the user and try again.';
    }
    // The redirected run will deliver under the STEER's causation, not the
    // spawn's, so without this the result cannot be matched back to the
    // task it belongs to and the delegation never retires.
    if (alias) this.delegations.addSteer(alias, seq);
    const receipt = `Redirect sent${alias ? ` to ${alias}` : ''}.`;
    this.policy.remember(dedupKey, receipt);
    return receipt;
  }

  dispatchCancel(taskAliasRaw: unknown): string {
    this.policy.beginDispatch();
    const aliasName = asTrimmedString(taskAliasRaw);
    if (!aliasName) {
      return this.policy.refuse('cancel_task', 'missing task alias',
        'Could not cancel: no task named.');
    }
    const delegation = this.delegations.resolve(aliasName);
    if (!delegation) {
      return this.policy.refuse('cancel_task', `unknown task "${aliasName}"`,
        `No task called "${aliasName}" is tracked right now.`);
    }
    if (delegation.cancelled) {
      return `Task ${delegation.alias} is already cancelled.`;
    }
    // No delegation caps: a cancel reduces work, and refusing a user's stop
    // request on a rate cap would be the worse failure.
    const seq = this.ports.appendLog({
      type: 'directive',
      loopPath: this.talkerLoopPath,
      content: `cancel_task ${delegation.alias}`,
      data: { tool: 'cancel_task', alias: delegation.alias },
      ...this.talkerCause(),
    });
    this.delegations.markCancelled(delegation.alias, seq);
    // A live run doing nothing but cancelled work is stopped outright; one
    // that also serves live work gets the stop at its next turn boundary.
    const liveRunCancelled = this.delegations.servesOnlyCancelled(this.ports.currentReasonerCauseTags());
    this.dispatch(buildCancelDirective(delegation.alias, delegation.instructions), seq, {
      atTurnBoundary: true,
      ...(liveRunCancelled ? { abortLiveRun: true } : {}),
    });
    return `Cancelling ${delegation.alias}.`;
  }

  dispatchLookup(questionRaw: unknown): string {
    this.policy.beginDispatch();
    const refused = this.refuseWhenWorkBlocked('quick_lookup');
    if (refused !== null) return refused;
    const question = asTrimmedString(questionRaw);
    if (!question) {
      return this.policy.refuse('quick_lookup', 'missing question',
        'Could not look that up: the question was empty.');
    }
    const dedupKey = this.policy.key('quick_lookup', question);
    const replay = this.policy.replay(dedupKey);
    if (replay !== undefined) return replay;
    const capRefusal = this.policy.admit('quick_lookup');
    if (capRefusal) return capRefusal;

    // Facade-spawned ephemeral read-only sub-agent (D13), never a reasoner
    // directive: the answer must not wait on the reasoner's turn boundary,
    // and the F12 read restrictions are built into the lookup loop's tools.
    const seq = this.ports.appendLog({
      type: 'directive',
      loopPath: this.talkerLoopPath,
      content: `quick_lookup: ${question}`,
      data: { tool: 'quick_lookup', question },
      ...this.talkerCause(),
    });
    let spawn: QuickLookupRequestResult;
    try {
      spawn = this.ports.spawnLookup(question, seq);
    } catch (err) {
      this.logger.error('quick lookup spawn threw', {
        error: errorMessageOf(err),
      });
      spawn = { accepted: false, reason: 'spawn failed' };
    }
    if (!spawn.accepted) {
      // Visible, logged refusal; never memoized, so a retry after the pool
      // drains can succeed.
      return this.policy.refuse('quick_lookup', spawn.reason,
        `Could not start that lookup (${spawn.reason}). Tell the user; they can ask again shortly or hand it to the background agent.`);
    }
    const receipt = 'Looking into that in the background.';
    this.policy.remember(dedupKey, receipt);
    return receipt;
  }

  /**
   * A quick lookup settled: append the durable lookup_result entry, join
   * the outcome into the reasoner's conversation deltas (shared context,
   * D13: the reasoner sees everything the talker learned, at its next
   * dispatch), and wake the talker. Cancelled lookups are logged by the
   * facade and never reach here.
   */
  deliverLookupResult(outcome: QuickLookupOutcome): void {
    if (this.destroyed || outcome.status === 'cancelled') return;
    const loopPath = `lookup/${outcome.alias}`;
    const text = buildLookupResultText(
      outcome.alias,
      outcome.question,
      outcome.status,
      outcome.answer,
    );

    // Proposed interrupt (D13: results wake the talker), bounded by the
    // same token bucket as reasoner interrupts (D19): a demoted result
    // arrives at the next lull instead.
    const demoted = !this.scheduler.drawInterrupt();
    const wake: 'interrupt' | 'when_idle' = demoted ? 'when_idle' : 'interrupt';
    if (demoted) this.logger.info('lookup result demoted to when_idle (token bucket empty)');

    this.ports.appendLog({
      type: 'lookup_result',
      loopPath,
      content: text,
      wake,
      data: {
        alias: outcome.alias,
        question: outcome.question,
        status: outcome.status,
        durationMs: outcome.durationMs,
        ...(demoted ? { demoted: true } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      },
      ...(outcome.causeSeq !== null ? { causedBy: outcome.causeSeq } : {}),
    });

    this.deltas.push({ speaker: 'lookup', text });
    this.scheduler.enqueue(text, wake);
  }

  dispatchAnswerAsk(askIdRaw: unknown, decisionRaw: unknown, reasonRaw: unknown): string {
    this.policy.beginDispatch();
    // The D16 consent rules live in the broker; a refused answer is logged
    // through the bounded dispatch_refused path so the anomaly stays in the
    // log (D16) without one spraying turn growing it unboundedly (N4). No
    // delegation caps here: refusing a user's permission answer on a rate
    // cap would be the worse failure, same rule as cancel_task.
    const outcome = this.ports.answerAsk(askIdRaw, decisionRaw, reasonRaw);
    if (outcome.refusal !== undefined) {
      return this.policy.refuse('answer_ask', outcome.refusal, outcome.receipt);
    }
    return outcome.receipt;
  }

  // -------------------------------------------------------------------------
  // Reasoner delivery intake (wake policy, D10/D19)
  // -------------------------------------------------------------------------

  deliverFromReasoner(
    content: string,
    wakeProposed: WakeClass | undefined,
    meta?: { implicit?: boolean; synthetic?: boolean; terminal?: boolean },
  ): DeliveryIntakeResult {
    if (this.destroyed) {
      return { delivered: false, reason: 'router destroyed' };
    }
    const now = this.now();
    this.lastReasonerOutputAt = now;

    // cancel_task is the one discard path (communication.md): a result
    // whose causation is entirely cancelled work never reaches the user.
    // It is still recorded, so the audit trail shows what was withheld.
    const causeTags = this.ports.currentReasonerCauseTags();
    if (this.delegations.servesOnlyCancelled(causeTags)) {
      this.ports.appendLog({
        type: 'lifecycle',
        loopPath: this.reasonerLoopPath,
        content: 'Delivery dropped: its task was cancelled',
        data: {
          event: 'delivery_dropped_cancelled',
          content,
          ...(meta?.implicit ? { implicit: true } : {}),
          ...(meta?.synthetic ? { synthetic: true } : {}),
        },
        ...this.reasonerCause(),
      });
      return { delivered: false, reason: 'the task it answers was cancelled' };
    }

    // Content-hash dedup over recent deliveries: a reasoner (or its retry
    // ladder) emitting the same content repeatedly costs one delivery. The
    // causing directive seq is part of the identity: a repeat the user
    // explicitly asked for ("run it again", new directive) whose result is
    // byte-identical to the previous run's must still be delivered, or the
    // second request looks unanswered.
    const cause = this.reasonerCause();
    const proposed: WakeClass = wakeProposed ?? 'when_idle';
    const admission = this.scheduler.admit(`${cause.causedBy ?? 'uncaused'}:${content.trim()}`, proposed);
    if (admission.duplicate) {
      // An absorbed duplicate still leaves a trace: communication.md says
      // results are never silently dropped from the audit trail. Entries
      // are bounded per reasoner run (same rule as dispatch_refused, N4)
      // so a run re-emitting the same content in a loop cannot grow the
      // log unboundedly.
      if (this.absorbedEntriesThisRun < MAX_ABSORBED_ENTRIES_PER_RUN) {
        this.absorbedEntriesThisRun += 1;
        const atBound = this.absorbedEntriesThisRun === MAX_ABSORBED_ENTRIES_PER_RUN;
        this.ports.appendLog({
          type: 'lifecycle',
          loopPath: this.reasonerLoopPath,
          content: 'Duplicate delivery absorbed',
          data: {
            event: 'delivery_absorbed',
            ...(meta?.implicit ? { implicit: true } : {}),
            ...(meta?.synthetic ? { synthetic: true } : {}),
            ...(atBound ? { furtherAbsorbedSuppressed: true } : {}),
          },
          ...cause,
        });
      }
      return { delivered: false, reason: 'duplicate of a recent delivery' };
    }
    // Producer proposes, router disposes: interrupts draw from the token
    // bucket and demote to when_idle when it is empty.
    const { wake, demoted } = admission;
    if (demoted) this.logger.info('interrupt delivery demoted to when_idle (token bucket empty)');

    // The log is the durable record of the delivery; a delivery dropped
    // later (abort, restore) stays retained here (facade-api.md abort
    // table).
    this.ports.appendLog({
      type: 'delivery',
      loopPath: this.reasonerLoopPath,
      content,
      wake,
      data: {
        proposedWake: proposed,
        ...(demoted ? { demoted: true } : {}),
        ...(meta?.implicit ? { implicit: true } : {}),
        ...(meta?.synthetic ? { synthetic: true } : {}),
        ...(meta?.terminal ? { terminal: true } : {}),
      },
      ...cause,
    });

    // A result retires the work it answers, so the block and the watchdog
    // stop calling finished work live. Read AFTER the log append and before
    // any queueing, while the producing run is still the live one.
    if (deliveryConcludes(wake, meta)) {
      this.delegations.retireFor(this.ports.currentReasonerCauseTags());
    }

    if (wake === 'silent') {
      // Silent never wakes and never waits: it lands in the talker's own
      // silent queue (never pi's steering queue) and surfaces with the next
      // real prompt.
      try {
        this.ports.deliverToTalker(wrapDeliveryForTalker(content), false);
      } catch (err) {
        this.logger.error('silent delivery to talker failed', {
          error: errorMessageOf(err),
        });
      }
      return { delivered: true, wake };
    }

    this.scheduler.enqueue(content, wake);
    return { delivered: true, wake };
  }

  // -------------------------------------------------------------------------
  // Delivery pump (spacing, lull detection, degradation)
  // -------------------------------------------------------------------------

  /** Talker-waking deliveries not yet handed to the talker. */
  get pendingDeliveryCount(): number {
    return this.scheduler.pendingCount;
  }

  /** Resolves once no talker-waking delivery is held by the router. */
  waitForDeliveriesSettled(): Promise<void> {
    return this.scheduler.waitSettled();
  }

  // -------------------------------------------------------------------------
  // Registry and state surfaces
  // -------------------------------------------------------------------------

  /** Snapshot of tracked delegations (copies). */
  getDelegations(): DelegationSnapshot[] {
    return this.delegations.snapshot();
  }

  /**
   * Content just went to the talker through the reserved ask lane: queued
   * deliveries hold off one spacing window behind it (DeliveryScheduler).
   */
  stampReservedLane(): void {
    this.scheduler.stampReservedLane();
  }

  /**
   * The reasoner's live run was stopped (an abort of any origin): the work
   * it served is no longer in progress, so it stops being described as
   * live. Nothing is delivered here; whether the user hears about it is the
   * caller's decision (a user abort is already acknowledged, a budget stop
   * is not).
   */
  retireRunDelegations(): void {
    this.delegations.retireFor(this.ports.currentReasonerCauseTags());
  }

  /**
   * All work was stopped (a work-scope abort, a breached session budget):
   * every outstanding delegation stops being live, including ones whose
   * dispatch was still parked and was dropped with the run. Marked, not
   * removed, like result-driven retirement: the aliases stay steerable.
   */
  retireAllDelegations(): void {
    this.delegations.retireAll();
  }

  /** Number of buffered conversation deltas awaiting a dispatch flush. */
  get deltaBufferSize(): number {
    return this.deltas.size;
  }

  /**
   * Drop held talker-waking deliveries (abort scope 'conversation'/'all').
   * The delivery entries stay in the log: retained, not delivered.
   */
  dropPendingDeliveries(): number {
    return this.scheduler.dropPending();
  }

  /** Drop buffered conversation deltas (abort scope 'work'/'all'). */
  dropWorkContext(): number {
    return this.deltas.drop();
  }

  /**
   * The session-scoped part of the router's state, for the persisted
   * artifact. Copies throughout: the snapshot never aliases live state.
   */
  exportState(): DuplexRouterState {
    return {
      ...this.delegations.exportState(),
      pendingDeliveries: this.scheduler.pendingContents(),
      ...this.deltas.exportState(),
    };
  }

  /**
   * Re-apply persisted router state after {@link resetForRestore}. Returns
   * the delegations that were still outstanding: whatever run served them
   * did not survive the restore, so they are retired here rather than left
   * listed as live, and the caller decides how to tell the conversation.
   *
   * `logAliasFloor` is the highest task alias number the restored log
   * mentions: an artifact written before this state was persisted (or with
   * it stripped) still never reissues an alias its transcript already uses.
   *
   * Held deliveries come back silent: they reach the talker's context and
   * surface with the user's next turn. A restore is a state operation, so
   * it never starts a talker turn on its own (the consumer may not even
   * have wired its event handlers yet), and whatever urgency the results
   * had belonged to the moment they were produced.
   */
  restoreState(state: DuplexRouterState | undefined, logAliasFloor: number): DelegationSnapshot[] {
    const interrupted = this.delegations.restoreState(state, logAliasFloor);
    if (!state) return interrupted;

    this.deltas.restoreState(state);

    for (const content of Array.isArray(state.pendingDeliveries) ? state.pendingDeliveries : []) {
      if (typeof content !== 'string' || content.trim().length === 0) continue;
      try {
        this.ports.deliverToTalker(wrapDeliveryForTalker(content), false);
      } catch (err) {
        this.logger.error('restoring a held delivery to the talker failed', {
          error: errorMessageOf(err),
        });
      }
    }
    return interrupted;
  }

  /** Reset the router wholesale (facade restore()). */
  resetForRestore(): void {
    this.scheduler.reset();
    this.dropWorkContext();
    this.delegations.clear();
    this.policy.reset();
    this.absorbedEntriesThisRun = 0;
    this.reasonerRunning = false;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.watchdog.destroy();
    this.scheduler.destroy();
  }

  // -------------------------------------------------------------------------
  // Dispatch internals
  // -------------------------------------------------------------------------

  /**
   * Flush the conversation block and hand the dispatch to the reasoner.
   * Returns whether the handover happened: a throw is logged as a
   * dispatch_failed lifecycle entry (a user instruction must never vanish
   * silently, F11) and reported to the caller, which must return a failure
   * receipt and must NOT memoize a success one (S2: a memoized "Started"
   * for work that was never handed over would replay on the retry that
   * could have succeeded).
   */
  private dispatch(
    directive: string,
    causeSeq: number | null,
    options?: ReasonerDispatchOptions,
  ): boolean {
    const message = composeDispatchMessage(this.deltas.consumeBlock(), directive);
    try {
      this.ports.dispatchToReasoner(message, causeSeq, options);
      return true;
    } catch (err) {
      this.logger.error('dispatch to reasoner failed', {
        error: errorMessageOf(err),
      });
      this.ports.appendLog({
        type: 'lifecycle',
        loopPath: this.reasonerLoopPath,
        content: 'Dispatch to the reasoner failed',
        data: {
          event: 'dispatch_failed',
          error: errorMessageOf(err),
        },
        ...(causeSeq !== null ? { causedBy: causeSeq } : {}),
      });
      return false;
    }
  }

  private refuseWhenWorkBlocked(tool: string): string | null {
    const reason = this.ports.workRefusal?.() ?? null;
    if (reason === null) return null;
    return this.policy.refuse(tool, reason,
      `Could not do that: ${reason}. Tell the user plainly; no more background work can run in this session.`);
  }

  private talkerCause(): { causedBy?: number } {
    const seq = this.ports.currentTalkerCauseSeq();
    return seq !== null ? { causedBy: seq } : {};
  }

  /**
   * The reasoner's log-stamping collapse, derived from the same tag set
   * retirement reads. Identical to the loop-side `latestCauseSeq` helper
   * (max seq over the validated tags), computed here so the stamp and the
   * retirement can never be told different stories by a port.
   */
  private reasonerCause(): { causedBy?: number } {
    let latest: number | null = null;
    for (const tag of this.ports.currentReasonerCauseTags()) {
      if (latest === null || tag.seq > latest) latest = tag.seq;
    }
    return latest !== null ? { causedBy: latest } : {};
  }
}

/** Drop undefined values so spreads never clobber defaults with undefined. */
function pruneUndefined(
  options: DuplexRouterOptions | undefined,
): Partial<ResolvedOptions> {
  if (!options) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && key !== 'now') out[key] = value;
  }
  return out as Partial<ResolvedOptions>;
}
