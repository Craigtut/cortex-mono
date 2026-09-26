/**
 * PermissionBroker: the duplex facade's consent boundary (decisions.md D16,
 * communication.md "Permission Brokering").
 *
 * Every blocking permission ask in duplex mode flows through here: tool asks
 * from the reasoner and its sub-agents (via the brokered resolvePermission),
 * sandbox escalation asks (same path, under the synthetic Bash(escalate)
 * name), and network egress asks from WebFetch and the sandbox ask callback
 * (via the brokered resolveNetworkAccess). An ask becomes a log entry, is
 * voiced to the user through the talker (exactly one at a time), and settles
 * when the talker relays the user's answer through answer_ask, when it times
 * out, or when the asking run aborts.
 *
 * Several asks pending at once is inherently a MULTI-LOOP situation. Tool
 * execution is sequential, so a loop that reaches an ask-gated call blocks
 * its whole batch on that one decision and cannot raise a second: a queue
 * behind the voiced ask means the reasoner and one of its sub-agents, or two
 * sub-agents, each blocked on its own. That is why the queue exists at all,
 * and why every ask carries loopPath.
 *
 * D16 is enforced HERE, router-side, never prompt-side: the talker's
 * judgment is precisely what an injected-content attacker targets, so no
 * consent rule may depend on the talker behaving. The rules:
 *
 * - exactly one ask is voiced at a time;
 * - `allow` binds only to the most recently voiced ask, takes effect at most
 *   once, and is accepted only from a talker turn whose cause set contains a
 *   user utterance newer than the voicing (details on {@link answer});
 * - `deny` is unrestricted;
 * - anything else returns a voiceable refusal and re-voices the pending ask.
 *
 * The consent check reads the FULL discriminated cause set
 * (currentTalkerCauseTags) and filters by kind before aggregating. It must
 * never use the collapsing latest-seq helper: collapse-then-filter denies a
 * real "yes" whenever a later non-utterance rode the same run, and
 * collapse-without-filter grants consent off a delivery the user never
 * spoke (decisions.md D16 worked examples).
 *
 * The tag set is NOT a complete record of what the user said: steer()
 * bypasses causation entirely, so a user steering "yes, go ahead" reaches
 * neither the log nor this check. That failure direction is safe by design:
 * an unheard yes leaves the ask pending and it gets re-voiced. There is
 * deliberately NO recovery path that tries to infer such consent; any
 * recovery heuristic would itself be an attack surface.
 */

import type {
  CortexLogger,
  PendingAsk,
  ToolPermissionRequestContext,
} from '../types.js';
import type { WakeClass } from '../session-log.js';
import { NOOP_LOGGER } from '../noop-logger.js';
import type { CauseTag } from './cause-tags.js';
import { stripAskFence } from './ask-fence.js';
import { asTrimmedString } from './control-tools.js';
import { AskVoicing } from './ask-voicing.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Ask classes the broker distinguishes. `escalation` is a Bash call asking
 * to run outside the sandbox (it reaches the resolver under the synthetic
 * Bash(escalate) name, never plain Bash); `network` is an egress ask from
 * WebFetch or the sandbox ask callback. The class picks the voicing
 * template and the timeout policy.
 */
export type BrokeredAskKind = 'tool' | 'escalation' | 'network';

/** One ask handed to the broker for a user decision. */
export interface BrokeredAskRequest {
  /**
   * Per-ask nonce. For tool asks this is the id the loop minted for the
   * resolver call (so the broker, the loop's pending-ask registry, and the
   * consumer all correlate on one id); network asks mint their own.
   * Security-relevant: consent binding keys on it.
   */
  askId: string;
  /** Path identity of the asking loop. */
  loopPath: string;
  /**
   * Set when {@link loopPath} is a best guess rather than the asking loop's
   * own identity (network asks: NetworkAccessRequest carries no loop
   * identity, so a sub-agent's egress ask is filed under the reasoner).
   * Recorded on the log entry so an audit reads the attribution as
   * approximate instead of trusting a path the broker cannot know.
   */
  loopPathApproximate?: boolean;
  /** Permission name (tool name, Bash(escalate), or NetworkAccess). */
  toolName: string;
  /**
   * Verbatim head-and-tail rendering of what is being asked. Carried
   * through to the log and the voicing UNCHANGED; the broker never
   * summarizes it (review-findings F14).
   */
  renderedRequest: string;
  kind: BrokeredAskKind;
  /**
   * The asking run's abort signal, when the caller has one (tool asks do;
   * network asks do not). An abort settles the ask as deny so the broker's
   * registry can never outlive the run it blocks.
   */
  signal?: AbortSignal | undefined;
}

/** The user's decision as the asking resolver receives it. */
export interface BrokeredAskDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}

/** Outcome of {@link PermissionBroker.answer}, consumed by the router. */
export interface AskAnswerOutcome {
  /** Voiceable receipt for the answer_ask control-tool result (D17). */
  receipt: string;
  /**
   * Set when the answer was refused (consent rules, unreadable decision).
   * The router records it as a bounded dispatch_refused lifecycle entry so
   * the anomaly stays in the log without letting one spraying turn grow the
   * log unboundedly.
   */
  refusal?: string;
}

/** Log entry input the broker produces (a subset of the router's schema). */
export interface BrokerLogInput {
  type: 'ask' | 'ask_answer' | 'lifecycle';
  loopPath: string;
  content: string;
  wake?: WakeClass;
  causedBy?: number;
  data?: Record<string, unknown>;
}

/** What the broker needs from the router/facade. */
export interface PermissionBrokerPorts {
  /** Append a session log entry; returns its seq. */
  appendLog(input: BrokerLogInput): number;
  /**
   * Wake-deliver an ask voicing to the talker, carrying its ask-kind cause
   * tag. This is the reserved ask lane (communication.md): it must bypass
   * the delivery token bucket, dedup, and queues, because the loop that
   * raised the ask blocks for as long as the voicing is delayed.
   */
  voiceToTalker(content: string, causeTag: CauseTag): void;
  /**
   * The FULL discriminated cause set of the talker's live run. The set
   * carries no ordering guarantee; the consent check scans all of it.
   */
  currentTalkerCauseTags(): readonly CauseTag[];
  /** Loop path the voicing's own lifecycle entries are filed under. */
  talkerLoopPath: string;
  /**
   * Remove the talker's parked wake deliveries whose content matches;
   * returns what was removed (moot voicings, see AskVoicing.retractParked).
   */
  dropParkedDeliveries(matches: (content: string) => boolean): string[];
  logger?: CortexLogger;
}

export interface PermissionBrokerOptions {
  /**
   * Timeout for tool and network asks, after which the ask settles as deny
   * with a reason. Null disables the timeout.
   */
  askTimeoutMs?: number | null;
  /**
   * Timeout for sandbox escalation asks. Long rather than absent (see
   * {@link PERMISSION_BROKER_DEFAULTS}). Null disables it.
   */
  escalationAskTimeoutMs?: number | null;
  /**
   * Coalescing window before a settlement voices the next queued ask (see
   * {@link PERMISSION_BROKER_DEFAULTS}).
   */
  settleVoiceDelayMs?: number;
  /** Clock override for tests (stamps and revoice damping, not timers). */
  now?: () => number;
}

export const PERMISSION_BROKER_DEFAULTS = {
  askTimeoutMs: 120_000 as number | null,
  /**
   * Escalations get a long bound, not none. The reason for the leniency
   * holds (auto-denying an escalation leaves the command running contained
   * and failing, which invites a retry loop, communication.md), and a long
   * bound satisfies it just as well as no bound does. No bound has a
   * failure mode of its own: with no answer, no abort and no destroy, the
   * asking run blocks forever while the watchdog truthfully reports it as
   * still working, which is exactly what a talker that never relays the
   * request produces.
   */
  escalationAskTimeoutMs: 900_000 as number | null,
  /**
   * A settlement does not voice the next ask synchronously; it coalesces
   * over this window and voices whatever is at the head afterwards. One
   * assistant message can settle several asks (deny is unrestricted and
   * takes an id, so unvoiced asks settle too), and voicing each successor
   * as its predecessor settles puts several voicings in the same next
   * talker batch: the user hears two requests read out, one of which is
   * already denied, and a bare "yes" meant for the first binds to whichever
   * one ended up voiced. The window only has to outlast a tool batch, which
   * is a few dispatches of well under a millisecond each.
   */
  settleVoiceDelayMs: 250,
} as const;

/** Cap on {@link PermissionBroker.settledAskIds}. */
const MAX_SETTLED_ASK_IDS = 64;

// ---------------------------------------------------------------------------
// Receipts and reasons (bare and uniform, D16/D17: as little imitable
// decision text in the talker's transcript as possible)
// ---------------------------------------------------------------------------

const NO_PENDING_RECEIPT = 'There are no pending permission requests to answer.';
const NOT_PENDING_RECEIPT = 'That permission request is no longer pending; nothing was changed.';
const UNKNOWN_ASK_RECEIPT =
  'No permission request has that id. The pending one will be read to the user again; ' +
  'answer that one.';
const ALLOW_RECEIPT = 'Approval passed along.';
const DENY_RECEIPT = 'Denial passed along.';
const CONSENT_REFUSED_RECEIPT =
  'Not accepted: approval needs the user\'s own answer, given after hearing the request. ' +
  'It will be read to the user again.';
const NOT_VOICED_RECEIPT =
  'Not accepted: only the request most recently read to the user can be approved. ' +
  'It will be read again.';
const INVALID_DECISION_RECEIPT =
  'Could not read that decision. Ask the user to allow or deny, then call answer_ask again.';
const UNBOUND_RECEIPT =
  'Could not tell which pending request that answers; it will be read to the user again.';

const TIMEOUT_DENY_REASON =
  'No answer from the user before the permission request timed out; denied by default. ' +
  'Ask again if the work still needs it.';
/**
 * Escalations time out on a much longer bound, so the reason says what
 * actually happened: nobody ever came back with a decision. The asking run
 * is unblocked either way, and the distinct wording keeps a silent relay
 * failure from reading like an ordinary short-timeout deny.
 */
const ESCALATION_TIMEOUT_DENY_REASON =
  'Nobody answered the request to run outside the sandbox before it timed out; ' +
  'denied by default. Continue contained if that is possible, or ask again.';
const ABORT_DENY_REASON = 'The run that raised this permission request was aborted.';

const DROP_REASONS: Record<'abort' | 'restore' | 'destroy', string> = {
  abort: 'Aborted before the user answered the permission request.',
  restore: 'The session was restored before the user answered the permission request.',
  destroy: 'The agent was shut down before the user answered the permission request.',
};

/** Cap on the relayed reason so a runaway argument cannot bloat the log. */
const MAX_REASON_CHARS = 400;

/** Fence-strip an unvalidated tool argument, leaving non-strings alone. */
function stripAskFenceFromReason(value: unknown): unknown {
  return typeof value === 'string' ? stripAskFence(value) : value;
}

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------

interface BrokeredAsk {
  request: BrokeredAskRequest;
  /** Seq of the 'ask' log entry; also the seq the voicing cause tag carries. */
  entrySeq: number;
  requestedAt: number;
  settled: boolean;
  resolve: (decision: BrokeredAskDecision) => void;
  timer: ReturnType<typeof setTimeout> | null;
  abortListener: (() => void) | null;
}

export class PermissionBroker {
  private readonly ports: PermissionBrokerPorts;
  private readonly logger: CortexLogger;
  private readonly now: () => number;
  private readonly askTimeoutMs: number | null;
  private readonly escalationAskTimeoutMs: number | null;
  /** What the user has heard: queue, voiced ask, consent anchors. */
  readonly voicing: AskVoicing;

  private readonly asks = new Map<string, BrokeredAsk>();
  /**
   * Recently settled ask ids, bounded and FIFO-evicted. Only used to tell
   * "you already answered that" from "no such request" in the answer_ask
   * receipt. An evicted id degrades to the unknown-id path, which refuses
   * and re-reads: never a grant, so the cap is safe to be small.
   */
  private readonly settledAskIds = new Set<string>();
  /** Released whenever an ask settles (see waitForSettlement). */
  private settlementWaiters: Array<() => void> = [];
  private destroyed = false;

  constructor(ports: PermissionBrokerPorts, options?: PermissionBrokerOptions) {
    this.ports = ports;
    this.logger = ports.logger ?? NOOP_LOGGER;
    this.now = options?.now ?? Date.now;
    this.askTimeoutMs = options?.askTimeoutMs !== undefined
      ? options.askTimeoutMs
      : PERMISSION_BROKER_DEFAULTS.askTimeoutMs;
    this.escalationAskTimeoutMs = options?.escalationAskTimeoutMs !== undefined
      ? options.escalationAskTimeoutMs
      : PERMISSION_BROKER_DEFAULTS.escalationAskTimeoutMs;
    this.voicing = new AskVoicing(
      {
        appendLog: (input) => this.ports.appendLog(input),
        voiceToTalker: (content, causeTag) => this.ports.voiceToTalker(content, causeTag),
        talkerLoopPath: ports.talkerLoopPath,
        dropParked: (matches) => this.ports.dropParkedDeliveries(matches),
      },
      {
        settleVoiceDelayMs: options?.settleVoiceDelayMs
          ?? PERMISSION_BROKER_DEFAULTS.settleVoiceDelayMs,
        now: this.now,
        logger: this.logger,
      },
    );
  }

  // -------------------------------------------------------------------------
  // Intake
  // -------------------------------------------------------------------------

  /**
   * Route one ask through the conversation. Appends the 'ask' log entry,
   * queues the voicing (one at a time), arms the timeout for its kind, and
   * resolves with the user's decision, the timeout deny, or the abort deny.
   * Never rejects: the asking resolver maps the decision to allow/block.
   */
  requestDecision(request: BrokeredAskRequest): Promise<BrokeredAskDecision> {
    if (this.destroyed) {
      return Promise.resolve({ decision: 'deny', reason: DROP_REASONS.destroy });
    }
    if (this.asks.has(request.askId)) {
      // Nonce reuse is a caller bug; refuse rather than corrupt the
      // registry an allow-once guarantee depends on.
      return Promise.resolve({ decision: 'deny', reason: 'Duplicate ask id.' });
    }
    if (request.signal?.aborted) {
      return Promise.resolve({ decision: 'deny', reason: ABORT_DENY_REASON });
    }
    return new Promise<BrokeredAskDecision>((resolve) => {
      const entrySeq = this.ports.appendLog({
        type: 'ask',
        loopPath: request.loopPath,
        // The verbatim rendering IS the durable payload; never a summary.
        content: request.renderedRequest,
        wake: 'interrupt',
        data: {
          askId: request.askId,
          toolName: request.toolName,
          kind: request.kind,
          ...(request.loopPathApproximate ? { loopPathApproximate: true } : {}),
        },
      });
      const ask: BrokeredAsk = {
        request,
        entrySeq,
        requestedAt: this.now(),
        settled: false,
        resolve,
        timer: null,
        abortListener: null,
      };
      this.asks.set(request.askId, ask);

      const timeoutMs = request.kind === 'escalation'
        ? this.escalationAskTimeoutMs
        : this.askTimeoutMs;
      if (timeoutMs !== null && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        const timer = setTimeout(() => this.handleTimeout(request.askId), timeoutMs);
        timer.unref?.();
        ask.timer = timer;
      }
      if (request.signal) {
        ask.abortListener = () => this.handleAbort(request.askId);
        request.signal.addEventListener('abort', ask.abortListener, { once: true });
      }
      this.voicing.enqueue({
        askId: request.askId,
        loopPath: request.loopPath,
        renderedRequest: request.renderedRequest,
        kind: request.kind,
        entrySeq,
      });
    });
  }

  /**
   * Record an ask the consumer's isAutoApprove bypassed: it never blocks and
   * is never voiced, but the audit trail must still show it was granted
   * without the user hearing it.
   */
  noteAutoApproved(toolName: string, context?: ToolPermissionRequestContext): void {
    if (this.destroyed) return;
    this.ports.appendLog({
      type: 'lifecycle',
      loopPath: context?.loopPath ?? 'reasoner',
      content: `Permission auto-approved: ${context?.renderedRequest ?? toolName}`,
      data: {
        event: 'ask_auto_approved',
        toolName,
        ...(context?.askId !== undefined ? { askId: context.askId } : {}),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Answering (the D16 rules)
  // -------------------------------------------------------------------------

  /**
   * Settle an ask from the talker's answer_ask dispatch. Enforced here, not
   * in any prompt:
   *
   * - `deny` is unrestricted: any pending ask (named by id, or the voiced
   *   one when no id is given) settles as deny with no causation check.
   * - `allow` binds only to the most recently voiced ask, at most once, and
   *   only when the talker's live cause set contains an utterance-kind tag
   *   with seq strictly greater than the ask's voicing anchor. The set is
   *   scanned whole and filtered by kind first (never collapsed, D16).
   *   Additionally, a run whose cause set carries THIS ask's voicing tag
   *   cannot grant it: content consumed alongside the voicing was authored
   *   before the user could have heard the request, so a stale "yes" that
   *   parked with the voicing must not bind to it.
   * - anything else returns a voiceable refusal and re-voices the pending
   *   ask (damped, so a spraying turn cannot flood the voice channel).
   */
  answer(askIdRaw: unknown, decisionRaw: unknown, reasonRaw: unknown): AskAnswerOutcome {
    if (this.asks.size === 0) {
      return { receipt: NO_PENDING_RECEIPT };
    }
    const askId = asTrimmedString(askIdRaw);
    const decisionText = asTrimmedString(decisionRaw)?.toLowerCase() ?? null;
    // The reason is talker-authored and reaches the reasoner verbatim as the
    // resolver's block reason, so it is a fence leak path. Sanitized once
    // here at intake rather than at each use: the same string goes to the
    // log and to the resolver, and a second copy of this rule is a second
    // place for it to be forgotten. Strip before the cap, so the cap
    // measures what is actually relayed.
    const rawReason = asTrimmedString(stripAskFenceFromReason(reasonRaw));
    const reason = rawReason !== null && rawReason.length > MAX_REASON_CHARS
      ? rawReason.slice(0, MAX_REASON_CHARS)
      : rawReason;

    if (decisionText !== 'allow' && decisionText !== 'deny') {
      this.voicing.revoiceCurrent();
      return { receipt: INVALID_DECISION_RECEIPT, refusal: 'unreadable decision' };
    }

    let ask: BrokeredAsk | undefined;
    if (askId !== null) {
      ask = this.asks.get(askId);
      if (!ask) {
        // An already-settled ask is the replay path: a second allow for the
        // same ask finds nothing here, which is what makes allow take
        // effect exactly once, and the receipt says so.
        if (this.settledAskIds.has(askId)) return { receipt: NOT_PENDING_RECEIPT };
        // An id that never existed is something else: a typo or a
        // fabrication, with the real request still pending. Reported as
        // "no longer pending" it tells the user the request went away while
        // it sits there waiting, so it refuses and re-reads instead.
        this.voicing.revoiceCurrent();
        return { receipt: UNKNOWN_ASK_RECEIPT, refusal: 'unknown ask id' };
      }
    } else {
      // A bare answer binds to the one voiced ask; with exactly one voiced
      // at a time there is nothing else it could honestly mean.
      const voicedAskId = this.voicing.voiced()?.askId;
      if (voicedAskId !== undefined) ask = this.asks.get(voicedAskId);
    }
    if (!ask) {
      this.voicing.revoiceCurrent();
      return { receipt: UNBOUND_RECEIPT, refusal: 'no ask bindable without an id' };
    }

    if (decisionText === 'deny') {
      this.ports.appendLog({
        type: 'ask_answer',
        loopPath: ask.request.loopPath,
        content: `deny: ${ask.request.renderedRequest}`,
        causedBy: ask.entrySeq,
        data: {
          askId: ask.request.askId,
          decision: 'deny',
          ...(reason !== null ? { reason } : {}),
        },
      });
      this.settle(ask, { decision: 'deny', ...(reason !== null ? { reason } : {}) });
      return { receipt: DENY_RECEIPT };
    }

    // allow
    const voiced = this.voicing.voiced();
    if (voiced?.askId !== ask.request.askId || voiced.voicedAtSeq === null) {
      this.voicing.revoiceCurrent();
      return {
        receipt: NOT_VOICED_RECEIPT,
        refusal: 'allow for an ask that is not the most recently voiced',
      };
    }
    let qualifyingSeq: number | null = null;
    let voicingInThisRun = false;
    for (const tag of this.ports.currentTalkerCauseTags()) {
      if (tag.kind === 'utterance' && tag.seq > voiced.voicedAtSeq) {
        if (qualifyingSeq === null || tag.seq > qualifyingSeq) qualifyingSeq = tag.seq;
      }
      if (tag.kind === 'ask' && tag.seq === ask.entrySeq) {
        voicingInThisRun = true;
      }
    }
    if (qualifyingSeq === null || voicingInThisRun) {
      this.voicing.revoiceCurrent();
      return {
        receipt: CONSENT_REFUSED_RECEIPT,
        refusal: voicingInThisRun
          ? 'allow from the run that carried the voicing'
          : 'no user utterance after the ask was voiced',
      };
    }

    this.ports.appendLog({
      type: 'ask_answer',
      loopPath: ask.request.loopPath,
      content: `allow: ${ask.request.renderedRequest}`,
      // The consent-carrying cause: the qualifying utterance, so an audit
      // can trace every allow to the user words that granted it.
      causedBy: qualifyingSeq,
      data: {
        askId: ask.request.askId,
        decision: 'allow',
        qualifyingUtteranceSeq: qualifyingSeq,
        ...(reason !== null ? { reason } : {}),
      },
    });
    this.settle(ask, { decision: 'allow', ...(reason !== null ? { reason } : {}) });
    return { receipt: ALLOW_RECEIPT };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Settle every pending ask as deny (facade abort, restore, or teardown).
   * Tool asks also settle through their own abort signals; double settlement
   * is guarded. Never leaves a resolver hanging.
   */
  settleAll(cause: 'abort' | 'restore' | 'destroy'): void {
    // Guarded like every other lifecycle method: after destroy there are no
    // asks to settle, and a late abort or restore must not re-enter the
    // drain.
    if (this.destroyed) return;
    this.voicing.drain(() => {
      for (const ask of [...this.asks.values()]) {
        this.ports.appendLog({
          type: 'lifecycle',
          loopPath: ask.request.loopPath,
          content: `Permission request dropped (${cause})`,
          causedBy: ask.entrySeq,
          data: { event: 'ask_dropped', askId: ask.request.askId, cause },
        });
        this.settle(ask, { decision: 'deny', reason: DROP_REASONS[cause] });
      }
    });
  }

  /** Facade restore(): the pending asks belong to the replaced session. */
  reset(): void {
    this.settleAll('restore');
    this.voicing.resetForRestore();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.settleAll('destroy');
    this.destroyed = true;
    this.voicing.destroy();
  }

  /**
   * Snapshot of asks the broker is holding, in the loop registry's shape
   * plus the broker's kind and its live consent anchor. Tool and escalation
   * asks also appear in the asking loop's own registry (same askId); network
   * asks exist only here.
   *
   * `voicedAtSeq` is the field a status surface should key on, not `voiced`.
   * `voiced` is sticky: it is set once when a voicing is handed over and
   * never cleared, so an ask whose voicing was lost (a destroyed delivery, a
   * hand-off that threw) still reports true while the broker has decided the
   * user never heard it. The anchor is the broker's own answer to "could the
   * user have heard this", it is what the D16 consent check reads, and
   * AskVoicing.noteLost withdraws it.
   */
  getPendingAsks(): Array<PendingAsk & { kind: BrokeredAskKind; voicedAtSeq: number | null }> {
    return [...this.asks.values()].map((ask) => ({
      askId: ask.request.askId,
      loopPath: ask.request.loopPath,
      toolName: ask.request.toolName,
      renderedRequest: ask.request.renderedRequest,
      requestedAt: ask.requestedAt,
      ...this.voicing.stateOf(ask.request.askId),
      kind: ask.request.kind,
    }));
  }

  /** Number of asks awaiting a decision. */
  get pendingAskCount(): number {
    return this.asks.size;
  }

  /**
   * Resolves when the next pending ask settles, at once when none is
   * pending. The settlement signal for asks only the broker holds (network
   * asks, quick-lookup asks), which no loop registry can wake.
   */
  waitForSettlement(): Promise<void> {
    if (this.asks.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.settlementWaiters.push(resolve));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private handleTimeout(askId: string): void {
    const ask = this.asks.get(askId);
    if (!ask || ask.settled) return;
    this.ports.appendLog({
      type: 'ask_answer',
      loopPath: ask.request.loopPath,
      content: `deny (timeout): ${ask.request.renderedRequest}`,
      causedBy: ask.entrySeq,
      data: { askId, decision: 'deny', timedOut: true },
    });
    this.settle(ask, {
      decision: 'deny',
      reason: ask.request.kind === 'escalation'
        ? ESCALATION_TIMEOUT_DENY_REASON
        : TIMEOUT_DENY_REASON,
    });
  }

  private handleAbort(askId: string): void {
    const ask = this.asks.get(askId);
    if (!ask || ask.settled) return;
    // No ask_answer entry: nobody answered. The lifecycle entry records why
    // the ask vanished; the loop's own abort race already unblocked the run.
    this.ports.appendLog({
      type: 'lifecycle',
      loopPath: ask.request.loopPath,
      content: 'Permission request aborted with its run',
      causedBy: ask.entrySeq,
      data: { event: 'ask_aborted', askId },
    });
    this.settle(ask, { decision: 'deny', reason: ABORT_DENY_REASON });
  }

  /** Settle exactly once: remove first, then resolve, then voice the next. */
  private settle(ask: BrokeredAsk, decision: BrokeredAskDecision): void {
    if (ask.settled) return;
    ask.settled = true;
    if (ask.timer !== null) {
      clearTimeout(ask.timer);
      ask.timer = null;
    }
    if (ask.abortListener !== null && ask.request.signal) {
      ask.request.signal.removeEventListener('abort', ask.abortListener);
      ask.abortListener = null;
    }
    this.asks.delete(ask.request.askId);
    this.rememberSettled(ask.request.askId);
    ask.resolve(decision);
    for (const release of this.settlementWaiters.splice(0)) release();
    this.voicing.forget(ask.request.askId);
  }

  private rememberSettled(askId: string): void {
    this.settledAskIds.add(askId);
    while (this.settledAskIds.size > MAX_SETTLED_ASK_IDS) {
      // Sets iterate in insertion order, so the first entry is the oldest.
      const oldest = this.settledAskIds.values().next().value;
      if (oldest === undefined) break;
      this.settledAskIds.delete(oldest);
    }
  }
}
