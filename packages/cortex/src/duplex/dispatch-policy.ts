/**
 * DispatchPolicy: backpressure on the talker's control-tool dispatches
 * (decisions.md D19): per-turn and per-exchange delegation caps, dispatch
 * dedup that absorbs retry-induced doubles, the exchange rollover that
 * refreshes both, and the bounded refusal entries that keep every refused
 * instruction in the log without letting one turn flood it (N4).
 */

import type { CauseTag } from './cause-tags.js';
import type { RouterLogInput } from './router-contract.js';

/**
 * Bound on dispatch_refused lifecycle entries per talker turn (N4). The
 * talker's hard maxTurns bounds turns, but one assistant message can carry
 * arbitrarily many malformed calls; without this each writes an entry.
 */
const MAX_REFUSAL_ENTRIES_PER_TURN = 3;

export interface DispatchPolicyPorts {
  appendLog(input: RouterLogInput): number;
  /** The FULL cause set of the talker's live run (no ordering guarantee). */
  currentTalkerCauseTags(): readonly CauseTag[];
  /** The causation stamp for an entry the talker's live run produced. */
  talkerCause(): { causedBy?: number };
  talkerLoopPath: string;
}

export class DispatchPolicy {
  private readonly ports: DispatchPolicyPorts;
  private readonly maxPerTurn: number;
  private readonly maxPerExchange: number;

  private dispatchesThisTurn = 0;
  private dispatchesThisExchange = 0;
  /**
   * Talker turn index within the current exchange. Part of the dedup key:
   * dedup absorbs retry-induced doubles within a turn, while a deliberate
   * repeat in a later turn (re-sending the same steer after the reasoner
   * visibly ignored it) dispatches again.
   */
  private turnIndex = 0;
  /**
   * Highest utterance seq a talker run has been seen consuming; the
   * exchange rollover watermark (see {@link beginDispatch}).
   */
  private lastConsumedUtteranceSeq = 0;
  /**
   * Dedup key to the receipt of the original dispatch (retries replay it).
   * Raw-string keys: the map holds at most one exchange's admitted
   * dispatches, and a rollover clears it.
   */
  private readonly dedup = new Map<string, string>();
  /** Refusal lifecycle entries written this turn (bounded, N4). */
  private refusalEntriesThisTurn = 0;

  constructor(ports: DispatchPolicyPorts, options: { maxPerTurn: number; maxPerExchange: number }) {
    this.ports = ports;
    this.maxPerTurn = options.maxPerTurn;
    this.maxPerExchange = options.maxPerExchange;
  }

  /**
   * Open a fresh exchange (caps, dedup, turn index) when the talker's live
   * run has consumed a user utterance newer than the one that opened the
   * current exchange. Keyed on CONSUMPTION (the utterance's cause tag
   * arriving on the run), never on facade arrival; checked at each dispatch
   * and at each talker turn end, the last point the consuming run's tags
   * are still readable when it dispatched nothing. Only utterance-kind tags
   * advance the watermark: a delivery- or directive-caused run is not the
   * user speaking and must not refresh delegation budgets. The cause set
   * carries no ordering guarantee, so the whole set is scanned.
   *
   * Resetting at ARRIVAL instead would clear the dedup map under a batch
   * still running, so its retry-induced duplicate spawn would dispatch
   * identical work twice, and a talker that had exhausted its caps would
   * earn a fresh budget inside the very turn that was capped.
   *
   * Open question (review N1): the per-exchange cap refreshes only on a
   * consumed user utterance, so a long autonomous stretch (deliveries
   * waking the talker with no new user input) runs against one fixed
   * delegation budget until the user next speaks. Whether autonomous turns
   * should ever refresh the cap is a policy call deferred until real usage
   * data exists.
   */
  beginDispatch(): void {
    let newest = this.lastConsumedUtteranceSeq;
    for (const tag of this.ports.currentTalkerCauseTags()) {
      if (tag.kind === 'utterance' && tag.seq > newest) newest = tag.seq;
    }
    if (newest === this.lastConsumedUtteranceSeq) return;
    this.lastConsumedUtteranceSeq = newest;
    this.dispatchesThisExchange = 0;
    this.dispatchesThisTurn = 0;
    this.turnIndex = 0;
    this.dedup.clear();
  }

  /** The dedup identity of a dispatch within the current turn. */
  key(tool: string, ...parts: string[]): string {
    return JSON.stringify([this.turnIndex, tool, ...parts]);
  }

  /** The receipt of an identical dispatch earlier this turn, if any. */
  replay(key: string): string | undefined {
    return this.dedup.get(key);
  }

  /**
   * Enforce the per-turn and per-exchange delegation caps. Returns the
   * refusal receipt when a cap is hit, null when the dispatch may proceed
   * (and counts it).
   */
  admit(tool: string): string | null {
    if (this.dispatchesThisTurn >= this.maxPerTurn) {
      return this.refuse(tool, 'per-turn delegation cap',
        'Delegation limit reached for this turn; summarize for the user instead of dispatching more.');
    }
    if (this.dispatchesThisExchange >= this.maxPerExchange) {
      return this.refuse(tool, 'per-exchange delegation cap',
        'Delegation limit reached for this exchange; wait for the user before dispatching more.');
    }
    this.dispatchesThisTurn += 1;
    this.dispatchesThisExchange += 1;
    return null;
  }

  /**
   * Remember a successful dispatch's receipt for retries to replay. Only a
   * handed-over dispatch is remembered: a memoized "Started" for work that
   * never reached the reasoner would replay on the retry that could have
   * succeeded (S2).
   */
  remember(key: string, receipt: string): void {
    this.dedup.set(key, receipt);
  }

  /**
   * Record a refused dispatch as a lifecycle entry (a user instruction
   * must never vanish silently, F11) and return the receipt. Entries are
   * bounded per turn (N4): refusals run before any cap counting, so one
   * assistant message spraying N malformed calls must not write N entries;
   * past the bound the receipt still goes back but the log stays quiet,
   * with the last written entry marking the suppression.
   */
  refuse(tool: string, reason: string, receipt: string): string {
    if (this.refusalEntriesThisTurn < MAX_REFUSAL_ENTRIES_PER_TURN) {
      this.refusalEntriesThisTurn += 1;
      const atBound = this.refusalEntriesThisTurn === MAX_REFUSAL_ENTRIES_PER_TURN;
      this.ports.appendLog({
        type: 'lifecycle',
        loopPath: this.ports.talkerLoopPath,
        content: `Dispatch refused: ${tool} (${reason})`,
        data: {
          event: 'dispatch_refused',
          tool,
          reason,
          ...(atBound ? { furtherRefusalsSuppressed: true } : {}),
        },
        ...this.ports.talkerCause(),
      });
    }
    return receipt;
  }

  /**
   * A talker turn boundary: resets the per-turn cap. The turn_end event
   * fires while the run is still live and its cause tags readable, so this
   * is also where a consumed utterance rolls the exchange when the
   * consuming run dispatched nothing: without it the tag set is gone when
   * the run's cleanup clears it, and a later delivery-woken run that does
   * dispatch would be refused against a budget the user's utterance should
   * have refreshed. Ordering is idempotent: the rollover zeroes the turn
   * state and clears the dedup map, then the turn-boundary bump advances
   * the index off the fresh exchange's zero.
   */
  noteTurnEnd(): void {
    this.beginDispatch();
    this.dispatchesThisTurn = 0;
    this.turnIndex += 1;
    this.refusalEntriesThisTurn = 0;
  }

  reset(): void {
    this.dedup.clear();
    this.dispatchesThisTurn = 0;
    this.dispatchesThisExchange = 0;
    this.turnIndex = 0;
    this.lastConsumedUtteranceSeq = 0;
    this.refusalEntriesThisTurn = 0;
  }
}
