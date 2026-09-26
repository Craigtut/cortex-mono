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
import {
  buildCancelDirective,
  buildConversationBlock,
  buildLookupResultText,
  buildSpawnDirective,
  buildSteerDirective,
  buildWorkInputDirective,
  composeDispatchMessage,
  DELTA_OVERFLOW_MARKER,
  wrapDeliveryForTalker,
} from './prompts.js';
import type { ConversationDelta } from './prompts.js';
import type { CauseTag } from './cause-tags.js';
import type { ControlDispatchTarget } from './control-tools.js';
import { PERMISSION_BROKER_DEFAULTS, PermissionBroker } from './permission-broker.js';
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
   * of the run it starts.
   */
  dispatchToReasoner(message: string, causeSeq: number | null): void;
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
   * Wake-deliver a permission-ask voicing to the talker, carrying its
   * ask-kind cause tag. The reserved ask lane (communication.md): calls
   * arrive from the broker directly and must reach the talker without the
   * delivery token bucket, dedup, spacing hold, or queues, because the loop
   * that raised the ask blocks for as long as the voicing is delayed.
   */
  voiceAskToTalker(content: string, causeTag: CauseTag): void;
  /** Mark a loop-registry pending ask as voiced (broker voicing sync). */
  markAskVoiced?(askId: string): void;
  /**
   * Start a facade-spawned quick lookup (D13): an ephemeral read-only
   * sub-agent, never a reasoner directive. causeSeq is the log seq of the
   * quick_lookup directive; the outcome carries it back for causation. The
   * verdict is synchronous so a cap refusal reaches the talker's receipt in
   * the same dispatch.
   */
  spawnLookup(question: string, causeSeq: number | null): QuickLookupRequestResult;
  /** Consumer idle signal (advisory, facade-api.md). */
  idleSignal?: (() => boolean) | undefined;
  logger?: CortexLogger;
  /** Loop-path labels for log entries. Defaults: 'talker' / 'reasoner'. */
  talkerLoopPath?: string;
  reasonerLoopPath?: string;
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
  askTimeoutMs: PERMISSION_BROKER_DEFAULTS.askTimeoutMs,
  escalationAskTimeoutMs: PERMISSION_BROKER_DEFAULTS.escalationAskTimeoutMs,
  settleVoiceDelayMs: PERMISSION_BROKER_DEFAULTS.settleVoiceDelayMs,
} as const;

type ResolvedOptions = typeof DUPLEX_ROUTER_DEFAULTS;

/**
 * Bound on dispatch_refused lifecycle entries per talker turn (N4). The
 * talker's hard maxTurns bounds turns, but one assistant message can carry
 * arbitrarily many malformed calls; without this each writes an entry.
 */
const MAX_REFUSAL_ENTRIES_PER_TURN = 3;

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

/** One tracked delegation (a spawn_task dispatch), keyed by alias. */
export interface DelegationSnapshot {
  alias: string;
  instructions: string;
  /** Log seq of the spawn directive. */
  seq: number;
  createdAt: number;
  cancelled: boolean;
  /**
   * When the work last reported a result, or null while it is outstanding.
   * A completed delegation stays resolvable (the reasoner is persistent and
   * a user routinely steers a task that already reported) but stops being
   * described as work in progress.
   */
  completedAt: number | null;
}

/** The registry's own record: a snapshot plus what identifies its results. */
interface TrackedDelegation extends DelegationSnapshot {
  /**
   * Every directive seq that belongs to this delegation: the spawn, plus
   * each steer aimed at it. A delivery whose cause set touches any of them
   * is a result for this delegation. Steers count because a run consuming a
   * redirect delivers under the redirect's causation, not the spawn's.
   */
  directiveSeqs: Set<number>;
  /** Last spawn, steer, or result. The age-out clock, so live work is safe. */
  lastActivityAt: number;
}

interface PendingDelivery {
  /** Raw delivered content (wrapped for the talker at delivery time). */
  content: string;
  enqueuedAt: number;
}

/** FNV-1a 32-bit; cheap content identity for dedup, not security. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// DuplexRouter
// ---------------------------------------------------------------------------

export class DuplexRouter implements ControlDispatchTarget, DeliveryTarget {
  private readonly ports: DuplexRouterPorts;
  private readonly options: ResolvedOptions;
  private readonly logger: CortexLogger;
  private readonly now: () => number;
  private readonly talkerLoopPath: string;
  private readonly reasonerLoopPath: string;

  // Delegation registry: human-friendly aliases so a fast-tier model never
  // reproduces UUIDs (communication.md).
  private readonly delegations = new Map<string, TrackedDelegation>();
  private nextAliasNumber = 1;

  // Conversation deltas (D18), flushed into the next dispatch message.
  private deltaBuffer: ConversationDelta[] = [];
  private deltaBufferChars = 0;
  private deltaOverflowed = false;

  // Dispatch backpressure (D19).
  private dispatchesThisTurn = 0;
  private dispatchesThisExchange = 0;
  /**
   * Talker turn index within the current exchange. Part of the dispatch
   * dedup key (D19): dedup absorbs retry-induced doubles within a turn,
   * while a deliberate repeat in a later turn (re-sending the same steer
   * after the reasoner visibly ignored it) dispatches again.
   */
  private dispatchTurnIndex = 0;
  /**
   * Highest utterance seq a talker run has been seen consuming; the
   * exchange rollover watermark (see {@link maybeRolloverExchange}).
   */
  private lastConsumedUtteranceSeq = 0;
  /** dedup key -> receipt of the original dispatch (retries replay it). */
  private dispatchDedup = new Map<string, string>();
  /** Refusal lifecycle entries written this turn (bounded, N4). */
  private refusalEntriesThisTurn = 0;
  /** Absorbed-duplicate lifecycle entries written this reasoner run (bounded). */
  private absorbedEntriesThisRun = 0;

  // Delivery backpressure (D19).
  private interruptTokens: number;
  private lastTokenRefillAt: number;
  private recentDeliveryHashes: Array<{ hash: number; at: number }> = [];
  private lastDeliveryAt = 0;

  // Delivery queues: interrupts ahead of held when_idle content.
  private interruptQueue: PendingDelivery[] = [];
  private whenIdleQueue: PendingDelivery[] = [];
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private pumpTimerAt = 0;
  private settleWaiters: Array<() => void> = [];

  // Liveness watchdog over reasoner runs (communication.md).
  private reasonerRunning = false;
  private reasonerRunStartAt = 0;
  private lastReasonerOutputAt = 0;
  private readonly watchdogTimer: ReturnType<typeof setInterval>;

  // Permission broker (D16): the consent boundary for every ask in duplex.
  private readonly broker: PermissionBroker;

  private destroyed = false;

  constructor(ports: DuplexRouterPorts, options?: DuplexRouterOptions) {
    this.ports = ports;
    this.options = { ...DUPLEX_ROUTER_DEFAULTS, ...pruneUndefined(options) };
    this.logger = ports.logger ?? NOOP_LOGGER;
    this.now = options?.now ?? Date.now;
    this.talkerLoopPath = ports.talkerLoopPath ?? 'talker';
    this.reasonerLoopPath = ports.reasonerLoopPath ?? 'reasoner';
    this.interruptTokens = this.options.interruptBucketCapacity;
    this.lastTokenRefillAt = this.now();

    this.broker = new PermissionBroker(
      {
        appendLog: (input) => this.ports.appendLog(input),
        voiceToTalker: (content, causeTag) => {
          // The reserved ask lane: no token bucket, no dedup, no queues.
          // Voicing stamps the spacing clock so queued normal deliveries
          // hold off for one spacing window behind a fresh ask instead of
          // talking over it.
          this.lastDeliveryAt = this.now();
          this.ports.voiceAskToTalker(content, causeTag);
        },
        currentTalkerCauseTags: () => this.ports.currentTalkerCauseTags(),
        ...(ports.markAskVoiced
          ? { markAskVoiced: (askId: string) => this.ports.markAskVoiced!(askId) }
          : {}),
        ...(ports.logger ? { logger: ports.logger } : {}),
      },
      {
        askTimeoutMs: this.options.askTimeoutMs,
        escalationAskTimeoutMs: this.options.escalationAskTimeoutMs,
        settleVoiceDelayMs: this.options.settleVoiceDelayMs,
        now: this.now,
      },
    );

    // The watchdog checks well inside its interval so a hung run is noticed
    // at most ~1.25 intervals after its last output.
    const checkEvery = Math.min(Math.max(50, Math.floor(this.options.watchdogIntervalMs / 4)), 15_000);
    this.watchdogTimer = setInterval(() => this.watchdogTick(), checkEvery);
    this.watchdogTimer.unref?.();
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
   * the latest, sees it ({@link maybeRolloverExchange}).
   *
   * Open question (review N1): the per-exchange cap refreshes only on a
   * consumed user utterance, so a long autonomous stretch (deliveries
   * waking the talker with no new user input) runs against one fixed
   * delegation budget until the user next speaks. Whether autonomous
   * turns should ever refresh the cap is a policy call deferred until
   * real usage data exists.
   */
  noteUserUtterance(text: string): void {
    this.pushDelta({ speaker: 'user', text });
  }

  /** A talker reply: the other half of the conversation delta (F4). */
  noteTalkerReply(text: string): void {
    this.pushDelta({ speaker: 'assistant', text });
  }

  /** Consumer-provided context for the work surface (no-wake work input). */
  noteWorkContext(text: string): void {
    this.pushDelta({ speaker: 'consumer', text });
  }

  /**
   * A silent conversation input (facade deliver, wake false): conversation
   * context without opening a new exchange.
   */
  noteUserContext(text: string): void {
    this.pushDelta({ speaker: 'user', text });
  }

  /**
   * Compose a consumer work-input dispatch: the pending conversation block
   * ahead of the directive, exactly like a control-tool dispatch. The
   * facade delivers the returned message to the reasoner itself (it owns
   * the causation binding for the run).
   */
  composeWorkDispatch(content: string): string {
    return composeDispatchMessage(this.consumeConversationBlock(), buildWorkInputDirective(content));
  }

  /**
   * A talker turn boundary: resets the per-turn dispatch cap. The turn_end
   * event fires while the run is still live and its cause tags readable
   * (the stop-reason audit relies on the same property), so this is also
   * where a consumed utterance rolls the exchange when the consuming run
   * dispatched nothing: without it the tag set is gone when the run's
   * cleanup clears it, and a later delivery-woken run that does dispatch
   * would be refused against a budget the user's utterance should have
   * refreshed. Ordering is idempotent: the rollover zeroes the turn state
   * and clears the dedup map, then the turn-boundary bump advances the
   * index off the fresh exchange's zero.
   */
  noteTalkerTurnEnd(): void {
    this.maybeRolloverExchange();
    this.dispatchesThisTurn = 0;
    this.dispatchTurnIndex += 1;
    this.refusalEntriesThisTurn = 0;
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

  /**
   * Open a fresh exchange (caps, dedup, turn index) when the talker's live
   * run has consumed a user utterance newer than the one that opened the
   * current exchange. Keyed on CONSUMPTION (the utterance's cause tag
   * arriving on the run), never on facade arrival; checked at each dispatch
   * and at each talker turn end, the last point the consuming run's tags
   * are still readable when it dispatched nothing. Only
   * utterance-kind tags advance the watermark: a delivery- or
   * directive-caused run is not the user speaking and must not refresh
   * delegation budgets. The cause set carries no ordering guarantee, so
   * the whole set is scanned.
   */
  private maybeRolloverExchange(): void {
    let newest = this.lastConsumedUtteranceSeq;
    for (const tag of this.ports.currentTalkerCauseTags()) {
      if (tag.kind === 'utterance' && tag.seq > newest) newest = tag.seq;
    }
    if (newest === this.lastConsumedUtteranceSeq) return;
    this.lastConsumedUtteranceSeq = newest;
    this.dispatchesThisExchange = 0;
    this.dispatchesThisTurn = 0;
    this.dispatchTurnIndex = 0;
    this.dispatchDedup.clear();
  }

  // -------------------------------------------------------------------------
  // Control-tool dispatch (D8/D17: every return is a voiceable receipt)
  // -------------------------------------------------------------------------

  dispatchSpawn(instructionsRaw: unknown): string {
    this.maybeRolloverExchange();
    const instructions = asTrimmedString(instructionsRaw);
    if (!instructions) {
      return this.refuseDispatch('spawn_task', 'missing instructions',
        'Could not start the task: no instructions given.');
    }
    const dedupKey = `${this.dispatchTurnIndex}:spawn_task:${fnv1a(instructions)}`;
    const replay = this.dispatchDedup.get(dedupKey);
    if (replay !== undefined) return replay;
    const capRefusal = this.applyDispatchCaps('spawn_task');
    if (capRefusal) return capRefusal;

    const alias = `task-${this.nextAliasNumber++}`;
    const seq = this.ports.appendLog({
      type: 'directive',
      loopPath: this.talkerLoopPath,
      content: `spawn_task ${alias}: ${instructions}`,
      data: { tool: 'spawn_task', alias, instructions },
      ...this.talkerCause(),
    });
    const createdAt = this.now();
    this.delegations.set(alias, {
      alias,
      instructions,
      seq,
      createdAt,
      cancelled: false,
      completedAt: null,
      directiveSeqs: new Set([seq]),
      lastActivityAt: createdAt,
    });
    if (!this.dispatch(buildSpawnDirective(alias, instructions), seq)) {
      // Never handed over: do not track it as live work (headlines and
      // steer/cancel must not target a task the reasoner never received),
      // and never memoize a success receipt for it.
      this.delegations.delete(alias);
      return 'Could not start that: the handoff failed. Tell the user and try again.';
    }
    const receipt = `Started ${alias}.`;
    this.dispatchDedup.set(dedupKey, receipt);
    return receipt;
  }

  dispatchSteer(taskAliasRaw: unknown, messageRaw: unknown): string {
    this.maybeRolloverExchange();
    const message = asTrimmedString(messageRaw);
    if (!message) {
      return this.refuseDispatch('steer_task', 'missing message',
        'Nothing to send: the redirect was empty.');
    }
    const aliasName = asTrimmedString(taskAliasRaw);
    let alias: string | null = null;
    let steered: TrackedDelegation | undefined;
    if (aliasName) {
      const delegation = this.resolveDelegation(aliasName);
      if (!delegation) {
        return this.refuseDispatch('steer_task', `unknown task "${aliasName}"`,
          `No task called "${aliasName}" is tracked right now.`);
      }
      if (delegation.cancelled) {
        return `Task ${delegation.alias} was already cancelled; start a new task if the work is wanted again.`;
      }
      alias = delegation.alias;
      steered = delegation;
    }
    const dedupKey = `${this.dispatchTurnIndex}:steer_task:${alias ?? ''}:${fnv1a(message)}`;
    const replay = this.dispatchDedup.get(dedupKey);
    if (replay !== undefined) return replay;
    const capRefusal = this.applyDispatchCaps('steer_task');
    if (capRefusal) return capRefusal;

    const seq = this.ports.appendLog({
      type: 'directive',
      loopPath: this.talkerLoopPath,
      content: `steer_task${alias ? ` ${alias}` : ''}: ${message}`,
      data: { tool: 'steer_task', ...(alias ? { alias } : {}), message },
      ...this.talkerCause(),
    });
    if (!this.dispatch(buildSteerDirective(alias, message), seq)) {
      return 'The redirect did not go through. Tell the user and try again.';
    }
    if (steered) {
      // The redirected run will deliver under the STEER's causation, not the
      // spawn's, so without this the result cannot be matched back to the
      // task it belongs to and the delegation never retires.
      steered.directiveSeqs.add(seq);
      // A steered task is outstanding again, whatever it reported before.
      steered.completedAt = null;
      steered.lastActivityAt = this.now();
    }
    const receipt = `Redirect sent${alias ? ` to ${alias}` : ''}.`;
    this.dispatchDedup.set(dedupKey, receipt);
    return receipt;
  }

  dispatchCancel(taskAliasRaw: unknown): string {
    this.maybeRolloverExchange();
    const aliasName = asTrimmedString(taskAliasRaw);
    if (!aliasName) {
      return this.refuseDispatch('cancel_task', 'missing task alias',
        'Could not cancel: no task named.');
    }
    const delegation = this.resolveDelegation(aliasName);
    if (!delegation) {
      return this.refuseDispatch('cancel_task', `unknown task "${aliasName}"`,
        `No task called "${aliasName}" is tracked right now.`);
    }
    if (delegation.cancelled) {
      return `Task ${delegation.alias} is already cancelled.`;
    }
    // No delegation caps: a cancel reduces work, and refusing a user's stop
    // request on a rate cap would be the worse failure.
    delegation.cancelled = true;
    const seq = this.ports.appendLog({
      type: 'directive',
      loopPath: this.talkerLoopPath,
      content: `cancel_task ${delegation.alias}`,
      data: { tool: 'cancel_task', alias: delegation.alias },
      ...this.talkerCause(),
    });
    this.dispatch(buildCancelDirective(delegation.alias, delegation.instructions), seq);
    return `Cancelling ${delegation.alias}.`;
  }

  dispatchLookup(questionRaw: unknown): string {
    this.maybeRolloverExchange();
    const question = asTrimmedString(questionRaw);
    if (!question) {
      return this.refuseDispatch('quick_lookup', 'missing question',
        'Could not look that up: the question was empty.');
    }
    const dedupKey = `${this.dispatchTurnIndex}:quick_lookup:${fnv1a(question)}`;
    const replay = this.dispatchDedup.get(dedupKey);
    if (replay !== undefined) return replay;
    const capRefusal = this.applyDispatchCaps('quick_lookup');
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
        error: err instanceof Error ? err.message : String(err),
      });
      spawn = { accepted: false, reason: 'spawn failed' };
    }
    if (!spawn.accepted) {
      // Visible, logged refusal; never memoized, so a retry after the pool
      // drains can succeed.
      return this.refuseDispatch('quick_lookup', spawn.reason,
        `Could not start that lookup (${spawn.reason}). Tell the user; they can ask again shortly or hand it to the background agent.`);
    }
    const receipt = 'Looking into that in the background.';
    this.dispatchDedup.set(dedupKey, receipt);
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
    const now = this.now();
    let wake: WakeClass = 'interrupt';
    let demoted = false;
    this.refillInterruptTokens(now);
    if (this.interruptTokens > 0) {
      this.interruptTokens -= 1;
    } else {
      wake = 'when_idle';
      demoted = true;
      this.logger.info('lookup result demoted to when_idle (token bucket empty)');
    }

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

    this.pushDelta({ speaker: 'lookup', text });

    const pending: PendingDelivery = { content: text, enqueuedAt: now };
    if (wake === 'interrupt') {
      this.interruptQueue.push(pending);
    } else {
      this.whenIdleQueue.push(pending);
    }
    this.pump();
  }

  dispatchAnswerAsk(askIdRaw: unknown, decisionRaw: unknown, reasonRaw: unknown): string {
    this.maybeRolloverExchange();
    // The D16 consent rules live in the broker; a refused answer is logged
    // through the bounded dispatch_refused path so the anomaly stays in the
    // log (D16) without one spraying turn growing it unboundedly (N4). No
    // delegation caps here: refusing a user's permission answer on a rate
    // cap would be the worse failure, same rule as cancel_task.
    const outcome = this.broker.answer(askIdRaw, decisionRaw, reasonRaw);
    if (outcome.refusal !== undefined) {
      return this.refuseDispatch('answer_ask', outcome.refusal, outcome.receipt);
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

    // Content-hash dedup over recent deliveries: a reasoner (or its retry
    // ladder) emitting the same content repeatedly costs one delivery. The
    // causing directive seq is part of the identity: a repeat the user
    // explicitly asked for ("run it again", new directive) whose result is
    // byte-identical to the previous run's must still be delivered, or the
    // second request looks unanswered.
    this.pruneRecentHashes(now);
    const cause = this.reasonerCause();
    const hash = fnv1a(`${cause.causedBy ?? 'uncaused'}:${content.trim()}`);
    if (this.recentDeliveryHashes.some((entry) => entry.hash === hash)) {
      this.logger.info('duplicate delivery absorbed', { hash });
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
    this.recentDeliveryHashes.push({ hash, at: now });
    if (this.recentDeliveryHashes.length > this.options.deliveryDedupMaxEntries) {
      this.recentDeliveryHashes.shift();
    }

    // Producer proposes, router disposes: interrupts draw from the token
    // bucket and demote to when_idle when it is empty.
    const proposed: WakeClass = wakeProposed ?? 'when_idle';
    let wake: WakeClass = proposed;
    let demoted = false;
    if (proposed === 'interrupt') {
      this.refillInterruptTokens(now);
      if (this.interruptTokens > 0) {
        this.interruptTokens -= 1;
      } else {
        wake = 'when_idle';
        demoted = true;
        this.logger.info('interrupt delivery demoted to when_idle (token bucket empty)');
      }
    }

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
      this.retireDelegationsFor(this.ports.currentReasonerCauseTags());
    }

    if (wake === 'silent') {
      // Silent never wakes and never waits: it lands in the talker's own
      // silent queue (never pi's steering queue) and surfaces with the next
      // real prompt.
      try {
        this.ports.deliverToTalker(wrapDeliveryForTalker(content), false);
      } catch (err) {
        this.logger.error('silent delivery to talker failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return { delivered: true, wake };
    }

    const pending: PendingDelivery = { content, enqueuedAt: now };
    if (wake === 'interrupt') {
      this.interruptQueue.push(pending);
    } else {
      this.whenIdleQueue.push(pending);
    }
    this.pump();
    return { delivered: true, wake };
  }

  // -------------------------------------------------------------------------
  // Delivery pump (spacing, lull detection, degradation)
  // -------------------------------------------------------------------------

  /** Talker-waking deliveries not yet handed to the talker. */
  get pendingDeliveryCount(): number {
    return this.interruptQueue.length + this.whenIdleQueue.length;
  }

  /** Resolves once no talker-waking delivery is held by the router. */
  waitForDeliveriesSettled(): Promise<void> {
    if (this.pendingDeliveryCount === 0) return Promise.resolve();
    return new Promise((resolve) => this.settleWaiters.push(resolve));
  }

  private pump(): void {
    if (this.destroyed) return;
    for (;;) {
      if (this.interruptQueue.length === 0 && this.whenIdleQueue.length === 0) {
        this.notifySettled();
        return;
      }
      const now = this.now();
      // Minimum inter-delivery spacing holds regardless of wake class or
      // idle signal (the anti-collapse rule in communication.md).
      const spacingReadyAt = this.lastDeliveryAt + this.options.minDeliverySpacingMs;
      if (this.lastDeliveryAt > 0 && now < spacingReadyAt) {
        // Re-checked at the poll cadence rather than in one long sleep, so
        // the wait stays responsive to queue drops and clock control.
        this.scheduleAt(Math.min(spacingReadyAt, now + this.options.idlePollMs));
        return;
      }
      if (this.interruptQueue.length > 0) {
        this.deliverNow(this.interruptQueue.shift()!);
        continue;
      }
      const head = this.whenIdleQueue[0]!;
      const degradeAt = head.enqueuedAt + this.options.whenIdleDegradeMs;
      if (this.channelIdle()) {
        this.whenIdleQueue.shift();
        this.deliverNow(head);
        continue;
      }
      if (now >= degradeAt) {
        // The lull never came (no signal, or a signal that never reports
        // idle): the delivery interrupts rather than starving.
        this.logger.info('when_idle delivery degraded to interrupt after delay', {
          heldMs: now - head.enqueuedAt,
        });
        this.whenIdleQueue.shift();
        this.deliverNow(head);
        continue;
      }
      this.scheduleAt(Math.min(now + this.options.idlePollMs, degradeAt));
      return;
    }
  }

  private deliverNow(item: PendingDelivery): void {
    this.lastDeliveryAt = this.now();
    try {
      this.ports.deliverToTalker(wrapDeliveryForTalker(item.content), true);
    } catch (err) {
      // The content stays in the log (the durable record); the talker-side
      // failure is loop-owned territory (its deliver() never throws while
      // healthy, so this is teardown or a bug).
      this.logger.error('delivery to talker failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private channelIdle(): boolean {
    const signal = this.ports.idleSignal;
    if (signal) {
      try {
        return signal() === true;
      } catch (err) {
        this.logger.warn('idle signal threw; treating as not idle', {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    }
    return this.ports.talkerIdle();
  }

  private scheduleAt(at: number): void {
    if (this.destroyed) return;
    if (this.pumpTimer !== null) {
      if (at >= this.pumpTimerAt) return;
      clearTimeout(this.pumpTimer);
    }
    this.pumpTimerAt = at;
    const timer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, Math.max(0, at - this.now()));
    timer.unref?.();
    this.pumpTimer = timer;
  }

  private notifySettled(): void {
    if (this.settleWaiters.length === 0) return;
    const waiters = this.settleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private refillInterruptTokens(now: number): void {
    const capacity = this.options.interruptBucketCapacity;
    if (this.interruptTokens >= capacity) {
      this.lastTokenRefillAt = now;
      return;
    }
    const earned = Math.floor((now - this.lastTokenRefillAt) / this.options.interruptRefillMs);
    if (earned > 0) {
      this.interruptTokens = Math.min(capacity, this.interruptTokens + earned);
      this.lastTokenRefillAt += earned * this.options.interruptRefillMs;
    }
  }

  private pruneRecentHashes(now: number): void {
    const cutoff = now - this.options.deliveryDedupWindowMs;
    this.recentDeliveryHashes = this.recentDeliveryHashes.filter((entry) => entry.at >= cutoff);
  }

  // -------------------------------------------------------------------------
  // Watchdog (a working reasoner must be distinguishable from a hung one)
  // -------------------------------------------------------------------------

  private watchdogTick(): void {
    if (this.destroyed || !this.reasonerRunning) return;
    const now = this.now();
    if (now - this.lastReasonerOutputAt < this.options.watchdogIntervalMs) return;
    const elapsedS = Math.max(1, Math.round((now - this.reasonerRunStartAt) / 1000));
    const aliases = this.activeAliases();
    const text = aliases.length > 0
      ? `Background work (${aliases.join(', ')}) is still running, about ${elapsedS}s so far; no update from it yet.`
      : `Background work is still running, about ${elapsedS}s so far; no update from it yet.`;
    // Rides the normal intake (log entry, dedup, spacing); marks itself
    // synthetic and resets the silence clock through lastReasonerOutputAt.
    this.deliverFromReasoner(text, 'when_idle', { synthetic: true });
  }

  // -------------------------------------------------------------------------
  // Registry and state surfaces
  // -------------------------------------------------------------------------

  /** Snapshot of tracked delegations (copies). */
  getDelegations(): DelegationSnapshot[] {
    this.pruneDelegations();
    return [...this.delegations.values()].map(
      ({ directiveSeqs: _seqs, lastActivityAt: _at, ...delegation }) => delegation,
    );
  }

  /** The consent boundary for every permission ask in duplex (D16). */
  get permissionBroker(): PermissionBroker {
    return this.broker;
  }

  private activeAliases(): string[] {
    this.pruneDelegations();
    return [...this.delegations.values()]
      .filter((delegation) => !delegation.cancelled && delegation.completedAt === null)
      .map((delegation) => delegation.alias);
  }

  /**
   * Retire the delegations a delivery just answered.
   *
   * Nothing else in the registry retires an entry: before this, a delegation
   * was added on spawn and removed only by a failed handover or a restore, so
   * a finished task stayed in the block beside `<work state="idle">` for the
   * rest of the session. That is not merely untidy. `activeAliases()` feeds
   * the watchdog text and the block, so the talker gets told hours-old work
   * is in progress, and the block grows per delegation against a hard token
   * cap it shares with everything else.
   *
   * Matching is on the FULL cause set (D16's rule about the collapsing
   * helper applies to every causation consumer, not only to consent): a run
   * that consumed a spawn and a steer parked behind it collapses to the
   * steer alone, and the spawn's delegation would never retire.
   *
   * Marked, not deleted. The reasoner is persistent and a user routinely
   * steers a task that already reported ("and make the eviction metric
   * observable"), so the alias has to stay resolvable; a steer takes it back
   * out of the completed state. What stops is describing it as live work.
   */
  private retireDelegationsFor(causeTags: readonly CauseTag[]): void {
    if (causeTags.length === 0) return;
    const now = this.now();
    for (const delegation of this.delegations.values()) {
      if (delegation.completedAt !== null) continue;
      const answered = causeTags.some(
        (tag) => tag.kind === 'directive' && delegation.directiveSeqs.has(tag.seq),
      );
      if (answered) {
        delegation.completedAt = now;
        delegation.lastActivityAt = now;
      }
    }
  }

  /**
   * Drop delegations past the age bound, measured from their last spawn,
   * steer, or result so live work is never dropped mid-flight. The backstop
   * behind result-driven retirement: work can end without any delivery the
   * router can attribute (a run that died, a reasoner that answered in a way
   * the cause set does not connect), and an entry with no retirement path at
   * all is what makes the registry grow without limit.
   */
  private pruneDelegations(): void {
    const cutoff = this.now() - this.options.delegationMaxAgeMs;
    for (const [alias, delegation] of this.delegations) {
      if (delegation.lastActivityAt < cutoff) this.delegations.delete(alias);
    }
  }

  private resolveDelegation(aliasName: string): TrackedDelegation | undefined {
    const exact = this.delegations.get(aliasName);
    if (exact) return exact;
    const lower = aliasName.toLowerCase();
    for (const delegation of this.delegations.values()) {
      if (delegation.alias.toLowerCase() === lower) return delegation;
    }
    return undefined;
  }

  /** Number of buffered conversation deltas awaiting a dispatch flush. */
  get deltaBufferSize(): number {
    return this.deltaBuffer.length;
  }

  /**
   * Drop held talker-waking deliveries (abort scope 'conversation'/'all').
   * The delivery entries stay in the log: retained, not delivered.
   */
  dropPendingDeliveries(): number {
    const dropped = this.pendingDeliveryCount;
    this.interruptQueue = [];
    this.whenIdleQueue = [];
    this.notifySettled();
    return dropped;
  }

  /** Drop buffered conversation deltas (abort scope 'work'/'all'). */
  dropWorkContext(): number {
    const dropped = this.deltaBuffer.length;
    this.deltaBuffer = [];
    this.deltaBufferChars = 0;
    this.deltaOverflowed = false;
    return dropped;
  }

  /** Reset the router wholesale (facade restore()). */
  resetForRestore(): void {
    // Pending asks belong to the replaced session; every resolver settles
    // as deny so no loop stays blocked on an ask nobody can answer anymore.
    this.broker.reset();
    this.dropPendingDeliveries();
    this.dropWorkContext();
    this.delegations.clear();
    this.dispatchDedup.clear();
    this.recentDeliveryHashes = [];
    this.dispatchesThisTurn = 0;
    this.dispatchesThisExchange = 0;
    this.dispatchTurnIndex = 0;
    this.lastConsumedUtteranceSeq = 0;
    this.refusalEntriesThisTurn = 0;
    this.absorbedEntriesThisRun = 0;
    this.reasonerRunning = false;
    this.lastDeliveryAt = 0;
    this.interruptTokens = this.options.interruptBucketCapacity;
    this.lastTokenRefillAt = this.now();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // Settle every pending ask first so no resolver promise outlives the
    // router: a hanging ask would block its loop into the force-kill path.
    this.broker.destroy();
    clearInterval(this.watchdogTimer);
    if (this.pumpTimer !== null) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    this.interruptQueue = [];
    this.whenIdleQueue = [];
    this.notifySettled();
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
  private dispatch(directive: string, causeSeq: number | null): boolean {
    const message = composeDispatchMessage(this.consumeConversationBlock(), directive);
    try {
      this.ports.dispatchToReasoner(message, causeSeq);
      return true;
    } catch (err) {
      this.logger.error('dispatch to reasoner failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.ports.appendLog({
        type: 'lifecycle',
        loopPath: this.reasonerLoopPath,
        content: 'Dispatch to the reasoner failed',
        data: {
          event: 'dispatch_failed',
          error: err instanceof Error ? err.message : String(err),
        },
        ...(causeSeq !== null ? { causedBy: causeSeq } : {}),
      });
      return false;
    }
  }

  /**
   * Enforce the per-turn and per-exchange delegation caps. Returns the
   * refusal receipt when a cap is hit, null when the dispatch may proceed
   * (and counts it).
   */
  private applyDispatchCaps(tool: string): string | null {
    if (this.dispatchesThisTurn >= this.options.maxDispatchesPerTurn) {
      return this.refuseDispatch(tool, 'per-turn delegation cap',
        'Delegation limit reached for this turn; summarize for the user instead of dispatching more.');
    }
    if (this.dispatchesThisExchange >= this.options.maxDispatchesPerExchange) {
      return this.refuseDispatch(tool, 'per-exchange delegation cap',
        'Delegation limit reached for this exchange; wait for the user before dispatching more.');
    }
    this.dispatchesThisTurn += 1;
    this.dispatchesThisExchange += 1;
    return null;
  }

  /**
   * Record a refused dispatch as a lifecycle entry (a user instruction
   * must never vanish silently, F11) and return the receipt. Entries are
   * bounded per turn (N4): refusals run before any cap counting, so one
   * assistant message spraying N malformed calls must not write N entries;
   * past the bound the receipt still goes back but the log stays quiet,
   * with the last written entry marking the suppression.
   */
  private refuseDispatch(tool: string, reason: string, receipt: string): string {
    if (this.refusalEntriesThisTurn < MAX_REFUSAL_ENTRIES_PER_TURN) {
      this.refusalEntriesThisTurn += 1;
      const atBound = this.refusalEntriesThisTurn === MAX_REFUSAL_ENTRIES_PER_TURN;
      this.ports.appendLog({
        type: 'lifecycle',
        loopPath: this.talkerLoopPath,
        content: `Dispatch refused: ${tool} (${reason})`,
        data: {
          event: 'dispatch_refused',
          tool,
          reason,
          ...(atBound ? { furtherRefusalsSuppressed: true } : {}),
        },
        ...this.talkerCause(),
      });
    }
    return receipt;
  }

  private consumeConversationBlock(): string | null {
    if (this.deltaBuffer.length === 0) return null;
    const deltas = this.deltaBuffer.splice(0);
    this.deltaBufferChars = 0;
    if (this.deltaOverflowed) {
      deltas.unshift({ speaker: 'consumer', text: DELTA_OVERFLOW_MARKER });
      this.deltaOverflowed = false;
    }
    return buildConversationBlock(deltas);
  }

  private pushDelta(delta: ConversationDelta): void {
    this.deltaBuffer.push(delta);
    this.deltaBufferChars += delta.text.length;
    while (
      this.deltaBufferChars > this.options.deltaBufferMaxChars &&
      this.deltaBuffer.length > 1
    ) {
      const removed = this.deltaBuffer.shift()!;
      this.deltaBufferChars -= removed.text.length;
      this.deltaOverflowed = true;
    }
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
