/**
 * The DuplexRouter's contract: the ports it needs from the session, the
 * tunables consumers set through `duplex` tuning, their defaults, and the
 * router state the persisted artifact carries.
 */

import type { CortexLogger } from '../types.js';
import type { WakeClass } from '../session-log.js';
import type { CauseTag } from './cause-tags.js';
import type { DelegationRegistryState } from './delegations.js';
import type { ConversationDeltasState } from './conversation-deltas.js';
import { PERMISSION_BROKER_DEFAULTS } from './permission-broker.js';
import type { AskAnswerOutcome } from './permission-broker.js';
import type { QuickLookupRequestResult } from './quick-lookups.js';

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
   * The FULL discriminated cause set of the talker's live run (empty when
   * no run is live or its content carried no tags). The set carries NO
   * ordering guarantee: readers must scan it, never assume ascending seq
   * order or read only the last element. This is the surface the D16
   * consent check reads (does the chain include a user utterance newer than
   * the voiced ask), where the collapsing helper above would misread a
   * mixed-kind set in both directions. Log stamps collapse it with
   * latestCauseSeq; nothing deciding behavior may.
   */
  currentTalkerCauseTags(): readonly CauseTag[];
  /**
   * The FULL discriminated cause set of the reasoner's live run, with the
   * same no-ordering contract as {@link currentTalkerCauseTags}. Delegation
   * retirement reads it: a run routinely consumes several directives (a spawn
   * with a steer parked behind it), and a collapse to the newest would leave
   * the delegation the result actually answers listed as live forever.
   *
   * There is deliberately no separate stamping port beside either set: the
   * log stamp is latestCauseSeq over the same set, so the two cannot
   * disagree.
   */
  currentReasonerCauseTags(): readonly CauseTag[];
  /**
   * Settle a permission ask from the talker's answer_ask (the broker's
   * answer, where the D16 consent rules live).
   */
  answerAsk(askId: unknown, decision: unknown, reason: unknown): AskAnswerOutcome;
  /**
   * A key naming the reasoner's current attempt (ReasonerRunTracker).
   * Bounds on per-attempt log noise reset when it changes.
   */
  reasonerAttemptKey(): string;
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

/** What the outcome reporter tells the router about one reasoner delivery. */
export interface ReasonerDeliveryMeta {
  implicit?: boolean;
  synthetic?: boolean;
  terminal?: boolean;
  /**
   * Whether the delivery reports the work reaching a conclusion, decided
   * once by the outcome reporter (deliveryConcludes): a concluding delivery
   * retires the delegation it answers.
   */
  concludes: boolean;
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

export type ResolvedRouterOptions = typeof DUPLEX_ROUTER_DEFAULTS;

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
