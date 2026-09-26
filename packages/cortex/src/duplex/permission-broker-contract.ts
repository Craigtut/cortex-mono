/**
 * The PermissionBroker's contract (permission-broker.ts): the asks it takes,
 * the decisions and receipts it returns, the ports it needs from the
 * session, and its tunables with their defaults.
 */

import type { CortexLogger } from '../types.js';
import type { WakeClass } from '../session-log.js';
import type { CauseTag } from './cause-tags.js';

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
   * raised the ask blocks for as long as the voicing is delayed. Returns the
   * talker's delivery id for it.
   */
  voiceToTalker(content: string, causeTag: CauseTag): string;
  /**
   * The FULL discriminated cause set of the talker's live run. The set
   * carries no ordering guarantee; the consent check scans all of it.
   */
  currentTalkerCauseTags(): readonly CauseTag[];
  /** Loop path the voicing's own lifecycle entries are filed under. */
  talkerLoopPath: string;
  /**
   * Remove the talker's parked wake deliveries whose delivery id matches;
   * returns the removed content (moot voicings, see AskVoicing.retractParked).
   */
  dropParkedDeliveries(matches: (deliveryId: string) => boolean): string[];
  logger?: CortexLogger;
}

export interface PermissionBrokerOptions {
  /**
   * Timeout for tool and network asks, after which the ask settles as deny
   * with a reason. Null disables the timeout.
   */
  askTimeoutMs?: number | null | undefined;
  /**
   * Timeout for sandbox escalation asks. Long rather than absent (see
   * {@link PERMISSION_BROKER_DEFAULTS}). Null disables it.
   */
  escalationAskTimeoutMs?: number | null | undefined;
  /**
   * Coalescing window before a settlement voices the next queued ask (see
   * {@link PERMISSION_BROKER_DEFAULTS}).
   */
  settleVoiceDelayMs?: number | undefined;
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
