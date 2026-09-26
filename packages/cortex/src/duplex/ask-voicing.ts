/**
 * AskVoicing: what the user has heard of the pending permission asks
 * (decisions.md D16, communication.md "Permission Brokering").
 *
 * Exactly one ask is voiced at a time; the rest queue behind it. For each
 * ask this owns the consent anchor (the `ask_voiced` entry a qualifying
 * utterance must follow), the sticky "was ever voiced" flag, and the text of
 * the last voicing handed over, which is how a destroyed delivery is
 * recognized as a lost voicing. The broker owns the asks and their
 * settlement; it asks this module who is voiced and whether they could have
 * heard it.
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
  /** The exact text of the last voicing handed over; null while unheard. */
  lastVoicingText: string | null;
  /** Clock stamp of the last voicing delivery, for revoice damping. */
  lastVoicedAtMs: number;
}

export interface AskVoicingPorts {
  appendLog(input: BrokerLogInput): number;
  /**
   * Wake-deliver a voicing to the talker through the reserved ask lane,
   * carrying its ask-kind cause tag. A throw means nothing reached the user.
   */
  voiceToTalker(content: string, causeTag: CauseTag): void;
  /** Mark the loop-registry pending ask as voiced (tool asks only). */
  markAskVoiced?(askId: string): void;
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
      lastVoicingText: null,
      lastVoicedAtMs: 0,
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
   * cannot flood the voice channel. Use {@link noteLost} instead when the
   * previous voicing never reached the user: that case is not damped and
   * does take a fresh anchor.
   */
  revoiceCurrent(): void {
    if (this.destroyed || this.voicedAskId === null) return;
    const record = this.records.get(this.voicedAskId);
    if (!record) return;
    if (this.options.now() - record.lastVoicedAtMs < REVOICE_MIN_INTERVAL_MS) return;
    this.voice(record);
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
    record.lastVoicingText = null;
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
   * Destroyed delivery content reported by the loop's dead-letter surface.
   * The surface carries no delivery id, so correlation is by exact content:
   * a dropped wake delivery whose text is the voicing we handed over IS
   * that voicing. Anything else is another producer's content and is
   * ignored. Returns whether it matched the current voicing.
   */
  noteDestroyed(content: string): boolean {
    if (this.voicedAskId === null) return false;
    const record = this.records.get(this.voicedAskId);
    if (!record || record.lastVoicingText === null || record.lastVoicingText !== content) return false;
    return this.noteLost();
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
   * talker has accepted the hand-off. `voiced`, the loop-registry sync, and
   * the consent anchor all assert "the user could have heard this", so a
   * delivery that threw must set none of them.
   */
  private voice(record: VoicingRecord): boolean {
    const firstVoicing = !record.voiced;
    if (!this.deliverVoicing(record, !firstVoicing)) return false;
    if (firstVoicing) {
      record.voiced = true;
      try {
        this.ports.markAskVoiced?.(record.ask.askId);
      } catch (err) {
        this.options.logger.warn('markAskVoiced port threw', {
          error: errorMessageOf(err),
        });
      }
    }
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
    try {
      this.ports.voiceToTalker(text, { kind: 'ask', seq: ask.entrySeq });
    } catch (err) {
      // Nothing reached the user, so nothing about this voicing may stand.
      // Withdrawing the anchor is what keeps an unheard request out of
      // allow range: left anchored, a later utterance plus a persuaded
      // talker would grant a request nobody ever read out. The ask itself
      // stays pending and answerable, and timeout/abort still bound it.
      record.voicedAtSeq = null;
      record.lastVoicingText = null;
      this.options.logger.error('ask voicing delivery failed', {
        askId: ask.askId,
        error: errorMessageOf(err),
      });
      return false;
    }
    if (anchoring) record.voicedAtSeq = anchorSeq;
    record.lastVoicingText = text;
    return true;
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
