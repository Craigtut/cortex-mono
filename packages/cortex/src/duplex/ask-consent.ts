/**
 * The D16 consent rules for an answer_ask (decisions.md D16): what an
 * answer relayed by the talker is allowed to settle. Enforced here, never
 * prompt-side: the talker's judgment is precisely what an injected-content
 * attacker targets, so no consent rule may depend on the talker behaving.
 *
 * - `deny` is unrestricted: any pending ask (named by id, or the voiced one
 *   when no id is given) settles as deny with no causation check.
 * - `allow` binds only to the most recently voiced ask, at most once, and
 *   only when the talker's live cause set contains an utterance-kind tag
 *   with seq strictly greater than the ask's voicing anchor. The set is
 *   scanned whole and filtered by kind first (never collapsed:
 *   collapse-then-filter denies a real "yes" whenever a later non-utterance
 *   rode the same run, and collapse-without-filter grants consent off a
 *   delivery the user never spoke). A run whose cause set carries THIS
 *   ask's voicing tag cannot grant it either: content consumed alongside
 *   the voicing was authored before the user could have heard the request.
 * - anything else is a voiceable refusal, and the pending ask is re-read.
 *
 * Every user input reaches this check the same way: prompt(), a deliver()
 * with `speaker: 'user'`, and a steer() into a live talker turn are each
 * logged as an utterance and carry its tag into the run that consumes the
 * words (a steer joins the live run at a turn boundary, and only from that
 * moment). Words that never reached a run carry no tag, and that failure
 * direction is safe by design: an unheard yes leaves the ask pending. There
 * is deliberately NO recovery path that tries to infer consent from
 * anything else; any recovery heuristic would itself be an attack surface.
 */

import type { CauseTag } from './cause-tags.js';
import { stripAskFence } from './ask-fence.js';
import { asTrimmedString } from './control-tools.js';

// Receipts are bare and uniform (D16/D17): as little imitable decision text
// in the talker's transcript as possible.
export const ALLOW_RECEIPT = 'Approval passed along.';
export const DENY_RECEIPT = 'Denial passed along.';
const NO_PENDING_RECEIPT = 'There are no pending permission requests to answer.';
const NOT_PENDING_RECEIPT = 'That permission request is no longer pending; nothing was changed.';
const UNKNOWN_ASK_RECEIPT =
  'No permission request has that id. The pending one will be read to the user again; ' +
  'answer that one.';
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

/** Cap on the relayed reason so a runaway argument cannot bloat the log. */
const MAX_REASON_CHARS = 400;

/** What the rules read of the broker's state. */
export interface ConsentView {
  readonly pendingCount: number;
  isPending(askId: string): boolean;
  /** Recently settled (the replay path), as opposed to never existing. */
  wasSettled(askId: string): boolean;
  /** The one voiced ask and its consent anchor, or null. */
  voiced(): { askId: string; voicedAtSeq: number | null } | null;
  /** Seq of the ask's 'ask' log entry (its voicing cause tag carries it). */
  entrySeqOf(askId: string): number;
  /** The FULL discriminated cause set of the talker's live run. */
  talkerCauseTags(): readonly CauseTag[];
}

export type AnswerVerdict =
  /** Nothing to settle and nothing to re-read. */
  | { kind: 'receipt'; receipt: string }
  /** Refused: the receipt goes back, the refusal is logged, the ask re-read. */
  | { kind: 'refused'; receipt: string; refusal: string }
  | { kind: 'deny'; askId: string; reason: string | null }
  /** `qualifyingSeq`: the user utterance that granted it, for the audit trail. */
  | { kind: 'allow'; askId: string; reason: string | null; qualifyingSeq: number };

/** Judge one answer_ask against the rules above. Pure: settles nothing. */
export function judgeAnswer(
  view: ConsentView,
  askIdRaw: unknown,
  decisionRaw: unknown,
  reasonRaw: unknown,
): AnswerVerdict {
  if (view.pendingCount === 0) {
    return { kind: 'receipt', receipt: NO_PENDING_RECEIPT };
  }
  const askIdArg = asTrimmedString(askIdRaw);
  const decisionText = asTrimmedString(decisionRaw)?.toLowerCase() ?? null;
  // The reason is talker-authored and reaches the reasoner verbatim as the
  // resolver's block reason, so it is a fence leak path. Sanitized once here
  // at intake rather than at each use: the same string goes to the log and
  // to the resolver. Strip before the cap, so the cap measures what is
  // actually relayed.
  const rawReason = asTrimmedString(typeof reasonRaw === 'string' ? stripAskFence(reasonRaw) : reasonRaw);
  const reason = rawReason !== null && rawReason.length > MAX_REASON_CHARS
    ? rawReason.slice(0, MAX_REASON_CHARS)
    : rawReason;

  if (decisionText !== 'allow' && decisionText !== 'deny') {
    return { kind: 'refused', receipt: INVALID_DECISION_RECEIPT, refusal: 'unreadable decision' };
  }

  let askId: string | null = null;
  if (askIdArg !== null) {
    if (!view.isPending(askIdArg)) {
      // An already-settled ask is the replay path: a second allow for the
      // same ask finds nothing, which is what makes allow take effect
      // exactly once, and the receipt says so.
      if (view.wasSettled(askIdArg)) return { kind: 'receipt', receipt: NOT_PENDING_RECEIPT };
      // An id that never existed is a typo or a fabrication, with the real
      // request still pending: "no longer pending" would tell the user the
      // request went away while it sits there waiting.
      return { kind: 'refused', receipt: UNKNOWN_ASK_RECEIPT, refusal: 'unknown ask id' };
    }
    askId = askIdArg;
  } else {
    // A bare answer binds to the one voiced ask; with exactly one voiced at
    // a time there is nothing else it could honestly mean.
    const voicedAskId = view.voiced()?.askId;
    if (voicedAskId !== undefined && view.isPending(voicedAskId)) askId = voicedAskId;
  }
  if (askId === null) {
    return { kind: 'refused', receipt: UNBOUND_RECEIPT, refusal: 'no ask bindable without an id' };
  }

  if (decisionText === 'deny') return { kind: 'deny', askId, reason };

  const voiced = view.voiced();
  if (voiced?.askId !== askId || voiced.voicedAtSeq === null) {
    return {
      kind: 'refused',
      receipt: NOT_VOICED_RECEIPT,
      refusal: 'allow for an ask that is not the most recently voiced',
    };
  }
  const entrySeq = view.entrySeqOf(askId);
  let qualifyingSeq: number | null = null;
  let voicingInThisRun = false;
  for (const tag of view.talkerCauseTags()) {
    if (tag.kind === 'utterance' && tag.seq > voiced.voicedAtSeq) {
      if (qualifyingSeq === null || tag.seq > qualifyingSeq) qualifyingSeq = tag.seq;
    }
    if (tag.kind === 'ask' && tag.seq === entrySeq) {
      voicingInThisRun = true;
    }
  }
  if (qualifyingSeq === null || voicingInThisRun) {
    return {
      kind: 'refused',
      receipt: CONSENT_REFUSED_RECEIPT,
      refusal: voicingInThisRun
        ? 'allow from the run that carried the voicing'
        : 'no user utterance after the ask was voiced',
    };
  }
  return { kind: 'allow', askId, reason, qualifyingSeq };
}
