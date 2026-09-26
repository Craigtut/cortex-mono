/**
 * AskVoicing: what the user has heard of the pending permission asks
 * (decisions.md D16, communication.md "Permission Brokering").
 *
 * Exactly one ask is voiced at a time; the rest queue behind it. For each
 * ask this owns the consent anchor (the `ask_voiced` entry a qualifying
 * utterance must follow) and the sticky "was ever voiced" flag. For the
 * conversation surface it owns the ledger of voicing deliveries handed to
 * the talker, by delivery id, which is how a destroyed delivery is
 * recognized as a lost voicing
 * and how a voicing parked behind a busy talker is found and retracted once
 * its ask is gone, and the hold a conversation abort puts on reading a
 * request out. The broker owns the asks and their settlement; it asks this
 * module who is voiced and whether they could have heard it.
 */

import type { CortexLogger } from '../types.js';
import { errorMessageOf } from '../error-classifier.js';
import type { CauseTag } from './cause-tags.js';
import { buildAskVoicing } from './prompts.js';
import type { BrokeredAskKind, BrokerLogInput } from './permission-broker.js';

/**
 * Minimum ms between re-voicings of the same ask. One assistant message can
 * carry many refused answer_ask calls (the N4 shape); without damping each
 * refusal would re-deliver the voicing and the ask would talk over itself.
 * The ask stays answerable the whole time; only the re-delivery is damped.
 *
 * Deliberately larger than the router's default inter-delivery spacing
 * (2s): every voicing stamps that spacing clock, so at equal values the
 * re-voice becomes eligible exactly as the queued ordinary deliveries do,
 * and the margin the damping is supposed to provide is zero by
 * construction.
 */
const REVOICE_MIN_INTERVAL_MS = 3_000;

/**
 * Re-reads per ask that a refused answer may trigger. Damping alone does not
 * bound them: a talker still holding an earlier "yes" in its context answers
 * allow from every run that reads the request out, each of those runs carries
 * the voicing's own tag so the allow is refused, and each refusal re-reads
 * the request into the next such run. That repeats until the ask times out
 * (minutes for tool asks, far longer for escalations). Past the cap the
 * request stays pending and answerable; only the re-reading stops.
 */
const MAX_REVOICES_PER_ASK = 2;

/**
 * Cap on the voicing ledger. It exists only to recognize the session's own
 * voicings among the talker's PARKED deliveries, which a run drains at the
 * next turn, so the live window is a handful at most. An evicted entry
 * degrades to "not recognized as a voicing", which leaves a moot request
 * readable rather than dropping something else: the safe direction for a
 * bounded cache to fail in.
 */
const MAX_LEDGER_ENTRIES = 32;

/** What voicing needs of one pending ask. */
export interface VoiceableAsk {
  readonly askId: string;
  readonly loopPath: string;
  readonly renderedRequest: string;
  readonly kind: BrokeredAskKind;
  /** Seq of the 'ask' log entry; the voicing's cause tag carries it. */
  readonly entrySeq: number;
}

/** One ask's voicing state, as status surfaces read it. */
export interface AskVoicingState {
  /** Sticky: set when a voicing is first handed over, never cleared. */
  voiced: boolean;
  /**
   * Seq anchor for consent: the ask_voiced entry appended at the moment of
   * (re-)voicing. A qualifying utterance must be strictly newer. Null until
   * a voicing is accepted by the talker, and withdrawn when a voicing is
   * lost, so an ask nobody could have heard can never be allowed.
   */
  voicedAtSeq: number | null;
}

interface VoicingRecord extends AskVoicingState {
  ask: VoiceableAsk;
  /** Clock stamp of the last voicing delivery, for revoice damping. */
  lastVoicedAtMs: number;
  /** Refusal re-reads delivered since the user could last have heard it fresh. */
  revoices: number;
}

/** What a refusal's re-read did (see {@link AskVoicing.revoiceCurrent}). */
export type RevoiceOutcome = 'revoiced' | 'damped' | 'exhausted' | 'none';

export interface AskVoicingPorts {
  appendLog(input: BrokerLogInput): number;
  /**
   * Wake-deliver a voicing to the talker through the reserved ask lane,
   * carrying its ask-kind cause tag; returns the talker's delivery id. A
   * throw means nothing reached the user.
   */
  voiceToTalker(content: string, causeTag: CauseTag): string;
  /** Loop path the voicing's own lifecycle entries are filed under. */
  talkerLoopPath: string;
  /**
   * Remove the talker's parked wake deliveries whose delivery id matches;
   * returns the removed content.
   */
  dropParked(matches: (deliveryId: string) => boolean): string[];
}

export interface AskVoicingOptions {
  /** Coalescing window before a settlement voices the next queued ask. */
  settleVoiceDelayMs: number;
  now: () => number;
  logger: CortexLogger;
}

export class AskVoicing {
  private readonly ports: AskVoicingPorts;
  private readonly options: AskVoicingOptions;
  private readonly records = new Map<string, VoicingRecord>();
  /** Ask ids awaiting their first voicing, FIFO. */
  private queue: string[] = [];
  /** The most recently voiced, still-pending ask (exactly one at a time). */
  private voicedAskId: string | null = null;
  /** Pending coalesced voice-the-next-ask timer (see {@link forget}). */
  private settleVoiceTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the broker drains, so settlement never voices a doomed ask. */
  private draining = false;
  /** Re-entrancy guard for lost-voicing recovery (see noteLost). */
  private revoicingLostVoicing = false;
  /**
   * Voicing deliveries handed to the talker, by delivery id, and the ask
   * each voices; FIFO and bounded (Maps iterate in insertion order).
   */
  private readonly ledger = new Map<string, string>();
  /**
   * A conversation abort silenced the voiced request: it is pending, silent
   * and un-anchored, and is read out again the next time the conversation
   * surface receives input (see hold).
   */
  private held = false;
  private destroyed = false;

  constructor(ports: AskVoicingPorts, options: AskVoicingOptions) {
    this.ports = ports;
    this.options = options;
  }

  /** Queue a new ask for voicing, voicing it now if nothing else is voiced. */
  enqueue(ask: VoiceableAsk): void {
    this.records.set(ask.askId, {
      ask,
      voiced: false,
      voicedAtSeq: null,
      lastVoicedAtMs: 0,
      revoices: 0,
    });
    this.queue.push(ask.askId);
    this.voiceNext();
  }

  /** The currently voiced ask and its consent anchor, or null. */
  voiced(): { askId: string; voicedAtSeq: number | null } | null {
    if (this.voicedAskId === null) return null;
    const record = this.records.get(this.voicedAskId);
    return record ? { askId: this.voicedAskId, voicedAtSeq: record.voicedAtSeq } : null;
  }

  /** One ask's voicing state (unvoiced defaults for an unknown id). */
  stateOf(askId: string): AskVoicingState {
    const record = this.records.get(askId);
    return { voiced: record?.voiced ?? false, voicedAtSeq: record?.voicedAtSeq ?? null };
  }

  /**
   * The ask settled: stop voicing it, and voice the next queued one after a
   * coalescing window rather than inline with this settlement. Settling
   * several asks in one talker turn must leave exactly one voicing in
   * flight, not one per settlement.
   */
  forget(askId: string): void {
    this.records.delete(askId);
    this.queue = this.queue.filter((id) => id !== askId);
    if (this.voicedAskId === askId) {
      this.voicedAskId = null;
    }
    this.scheduleVoiceNext();
  }

  /**
   * Re-read the currently voiced ask to the user (refusal recovery). The
   * consent anchor does NOT move: the user already heard this request, and
   * a re-read must not invalidate an answer they have already given. Damped
   * to one re-delivery per interval, so a turn spraying refused answers
   * cannot flood the voice channel, and capped per ask
   * (MAX_REVOICES_PER_ASK), so a talker that keeps answering from the run
   * reading the request out cannot keep it talking until the timeout. At
   * the cap nothing is re-read, the log records it once, and the caller
   * tells the talker the request needs the user's fresh answer. Use
   * {@link noteLost} instead when the previous voicing never reached the
   * user: that case is neither damped nor capped, takes a fresh anchor, and
   * restarts the count.
   */
  revoiceCurrent(): RevoiceOutcome {
    if (this.destroyed || this.voicedAskId === null) return 'none';
    const record = this.records.get(this.voicedAskId);
    if (!record) return 'none';
    if (record.revoices >= MAX_REVOICES_PER_ASK) {
      if (record.revoices === MAX_REVOICES_PER_ASK) {
        // Counted past the cap so the entry is written once per ask.
        record.revoices += 1;
        this.ports.appendLog({
          type: 'lifecycle',
          loopPath: this.ports.talkerLoopPath,
          content: 'Permission request not re-read again: it needs a fresh answer from the user',
          causedBy: record.ask.entrySeq,
          data: { event: 'ask_revoice_exhausted', askId: record.ask.askId, revoices: MAX_REVOICES_PER_ASK },
        });
      }
      return 'exhausted';
    }
    if (this.options.now() - record.lastVoicedAtMs < REVOICE_MIN_INTERVAL_MS) return 'damped';
    if (!this.voice(record)) return 'none';
    record.revoices += 1;
    return 'revoiced';
  }

  /**
   * The current voicing never reached the user: the delivery was destroyed
   * (a facade abort clearing the talker's queues, a parked item dropped on
   * a stale abort epoch, a sweep giving up past the re-park cap) or the
   * hand-off threw. Withdraw the anchor, because it records only that
   * voicing began, and read the request out again with a fresh one.
   * Returns whether an ask was affected.
   */
  noteLost(): boolean {
    if (this.destroyed || this.draining || this.voicedAskId === null) return false;
    const record = this.records.get(this.voicedAskId);
    if (!record) return false;
    record.voicedAtSeq = null;
    record.revoices = 0;
    // Re-entrancy guard: the re-delivery below can itself be destroyed
    // synchronously (a re-voice landing inside an abort that is still
    // draining), and an un-anchored ask is already safe, so the recovery
    // must never recurse.
    if (this.revoicingLostVoicing) return true;
    this.revoicingLostVoicing = true;
    try {
      this.voice(record);
    } finally {
      this.revoicingLostVoicing = false;
    }
    return true;
  }

  /**
   * A talker delivery was destroyed (the loop's dead-letter surface reports
   * its id). If it is the current voicing, the user never heard it; any
   * other delivery is another producer's content and is ignored. Returns
   * whether it matched the current voicing.
   */
  noteDestroyed(deliveryId: string | undefined): boolean {
    if (deliveryId === undefined) return false;
    if (this.voicedAskId === null || this.ledger.get(deliveryId) !== this.voicedAskId) return false;
    this.ledger.delete(deliveryId);
    return this.noteLost();
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
   * So the anchor is withdrawn and the read-out is not performed: the ask
   * stays pending, silent and answerable with no anchor, visible in the
   * headline block and bounded by its own timeout, until {@link reopen}.
   */
  hold(): void {
    if (this.destroyed || this.draining || this.voicedAskId === null) return;
    const record = this.records.get(this.voicedAskId);
    if (!record) return;
    record.voicedAtSeq = null;
    this.held = true;
    this.ports.appendLog({
      type: 'lifecycle',
      loopPath: this.ports.talkerLoopPath,
      content: 'Permission request held silent after a conversation abort; ' +
        'it will be read out again when the conversation reopens',
      data: { event: 'ask_voicing_deferred', reason: 'conversation_abort' },
    });
  }

  /**
   * The conversation surface just received input, so the channel is open
   * again: read out any request {@link hold} silenced. Called after the
   * input is handed to the talker, so the voicing parks behind that run and
   * arrives carrying its ask cause tag, which is what stops the same run
   * from granting the request it is about to read. A lost-voicing re-read
   * rather than {@link revoiceCurrent}: the anchor is already withdrawn and
   * this re-read must take a fresh one, and it must not be swallowed by the
   * re-voice damping window.
   */
  reopen(): void {
    if (!this.held) return;
    this.held = false;
    this.noteLost();
  }

  /**
   * Retract voicings still parked on the talker after their asks were
   * settled wholesale. Only the session's own voicing deliveries are
   * matched, by id, so a parked user utterance (and the cause tag that makes
   * it able to grant consent) is left exactly where it is, whatever it says.
   */
  retractParked(reason: 'abort' | 'restore'): void {
    if (this.ledger.size === 0) return;
    const dropped = this.ports.dropParked((deliveryId) => this.ledger.has(deliveryId));
    // Every ask is gone, so every remembered voicing is moot whether or not
    // it was still parked.
    this.ledger.clear();
    if (dropped.length === 0) return;
    this.ports.appendLog({
      type: 'lifecycle',
      loopPath: this.ports.talkerLoopPath,
      content: `${dropped.length} permission voicing(s) dropped by ${reason}: their requests are settled`,
      data: { event: 'ask_voicing_dropped', reason, count: dropped.length },
    });
  }

  /** The talker's queues were cleared: nothing of ours is parked any more. */
  noteParkedCleared(): void {
    this.ledger.clear();
  }

  /** A restore: nothing is held and nothing parked is ours any more. */
  resetForRestore(): void {
    this.ledger.clear();
    this.held = false;
  }

  /**
   * Settle a batch of asks without voicing any successor mid-way, then
   * start from an empty queue.
   */
  drain(settleEach: () => void): void {
    this.clearSettleVoiceTimer();
    this.draining = true;
    try {
      settleEach();
    } finally {
      this.draining = false;
    }
    this.queue = [];
    this.voicedAskId = null;
  }

  destroy(): void {
    this.destroyed = true;
    this.clearSettleVoiceTimer();
  }

  private voiceNext(): void {
    if (this.destroyed || this.draining || this.voicedAskId !== null) return;
    for (;;) {
      const nextId = this.queue.shift();
      if (nextId === undefined) return;
      const record = this.records.get(nextId);
      if (!record) continue;
      this.voicedAskId = nextId;
      this.voice(record);
      return;
    }
  }

  /**
   * Voice (or re-voice) one ask and commit the voiced state only once the
   * talker has accepted the hand-off. `voiced` and the consent anchor both
   * assert "the user could have heard this", so a delivery that threw must
   * set neither.
   */
  private voice(record: VoicingRecord): boolean {
    const firstVoicing = !record.voiced;
    if (!this.deliverVoicing(record, !firstVoicing)) return false;
    record.voiced = true;
    return true;
  }

  /**
   * Append the ask_voiced anchor entry and hand the voicing to the talker.
   * The anchor entry is appended BEFORE the delivery, so any utterance that
   * qualifies is provably newer than the moment voicing began; the voicing
   * delivery carries the ask-kind cause tag that lets the consent check
   * refuse answers from the very run that introduced the request.
   *
   * The anchor is PROVISIONAL until the hand-off returns. An entry says
   * only that voicing was attempted, and every consent rule downstream
   * reads it as "the user could have heard the request", so a throw
   * withdraws it. Returns whether the talker took the voicing.
   *
   * An ask that is ALREADY anchored keeps its anchor across a re-read. The
   * anchor means "after the user could have heard this request", and a
   * re-read does not un-hear it, so moving it would silently discard
   * consent already given: the user says yes, the talker fumbles the
   * decision field, the refusal re-reads the request, and the yes is now
   * permanently stale. Only an unheard voicing (never delivered, or
   * destroyed, both of which null the anchor) takes a fresh one.
   */
  private deliverVoicing(record: VoicingRecord, revoiced: boolean): boolean {
    const { ask } = record;
    const anchoring = record.voicedAtSeq === null;
    const anchorSeq = this.ports.appendLog({
      type: 'lifecycle',
      loopPath: ask.loopPath,
      content: revoiced ? 'Permission request re-voiced' : 'Permission request voiced',
      causedBy: ask.entrySeq,
      data: {
        event: 'ask_voiced',
        askId: ask.askId,
        ...(revoiced ? { revoiced: true } : {}),
        ...(anchoring ? {} : { anchorUnchanged: true }),
      },
    });
    record.lastVoicedAtMs = this.options.now();
    const text = buildAskVoicing({
      askId: ask.askId,
      renderedRequest: ask.renderedRequest,
      kind: ask.kind,
      revoiced,
    });
    let deliveryId: string;
    try {
      deliveryId = this.ports.voiceToTalker(text, { kind: 'ask', seq: ask.entrySeq });
    } catch (err) {
      // Nothing reached the user, so nothing about this voicing may stand.
      // Withdrawing the anchor is what keeps an unheard request out of
      // allow range: left anchored, a later utterance plus a persuaded
      // talker would grant a request nobody ever read out. The ask itself
      // stays pending and answerable, and timeout/abort still bound it.
      record.voicedAtSeq = null;
      this.options.logger.error('ask voicing delivery failed', {
        askId: ask.askId,
        error: errorMessageOf(err),
      });
      return false;
    }
    if (anchoring) record.voicedAtSeq = anchorSeq;
    this.remember(deliveryId, ask.askId);
    // A voicing reached the talker, so nothing is being held any more.
    this.held = false;
    return true;
  }

  private remember(deliveryId: string, askId: string): void {
    this.ledger.set(deliveryId, askId);
    while (this.ledger.size > MAX_LEDGER_ENTRIES) {
      const oldest = this.ledger.keys().next().value;
      if (oldest === undefined) break;
      this.ledger.delete(oldest);
    }
  }

  private scheduleVoiceNext(): void {
    if (this.destroyed || this.draining) return;
    if (this.settleVoiceTimer !== null) return;
    if (this.options.settleVoiceDelayMs <= 0) {
      this.voiceNext();
      return;
    }
    const timer = setTimeout(() => {
      this.settleVoiceTimer = null;
      this.voiceNext();
    }, this.options.settleVoiceDelayMs);
    timer.unref?.();
    this.settleVoiceTimer = timer;
  }

  private clearSettleVoiceTimer(): void {
    if (this.settleVoiceTimer === null) return;
    clearTimeout(this.settleVoiceTimer);
    this.settleVoiceTimer = null;
  }
}
