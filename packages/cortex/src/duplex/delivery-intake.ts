/**
 * The router's delivery intake (wake policy, decisions.md D10/D13/D19): how
 * reasoner results and quick-lookup answers become talker-bound deliveries.
 * Producer proposes, intake disposes: a proposed interrupt draws from the
 * token bucket and demotes when it is empty, and every delivery is logged
 * before it is handed on, so the log stays the durable record of content a
 * later abort or restore drops.
 */

import type { CortexLogger } from '../types.js';
import type { WakeClass } from '../session-log.js';
import { errorMessageOf } from '../error-classifier.js';
import { buildLookupResultText, wrapDeliveryForTalker } from './prompts.js';
import { latestCauseSeq } from './cause-tags.js';
import type { CauseTag } from './cause-tags.js';
import type { ConversationDeltas } from './conversation-deltas.js';
import type { DelegationRegistry } from './delegations.js';
import type { DeliveryScheduler } from './delivery-scheduler.js';
import type { QuickLookupOutcome } from './quick-lookups.js';
import type { DeliveryIntakeResult } from './reasoner-tools.js';
import { deliveryConcludes } from './reasoner-outcomes.js';
import type { RouterLogInput } from './router-contract.js';

/**
 * Bound on delivery_absorbed lifecycle entries per reasoner attempt (the N4
 * rule applied to the intake side): a reasoner (or its retry ladder)
 * re-emitting the same content arbitrarily many times in one attempt must
 * not write an entry per repeat. The dedup itself still absorbs every repeat;
 * past the bound only the log stays quiet, with the last written entry
 * marking the suppression.
 */
const MAX_ABSORBED_ENTRIES_PER_ATTEMPT = 3;

export interface DeliveryIntakePorts {
  appendLog(input: RouterLogInput): number;
  deliverToTalker(content: string, wake: boolean): void;
  currentReasonerCauseTags(): readonly CauseTag[];
  reasonerAttemptId(): number;
}

export class DeliveryIntake {
  private readonly ports: DeliveryIntakePorts;
  private readonly delegations: DelegationRegistry;
  private readonly deltas: ConversationDeltas;
  private readonly scheduler: DeliveryScheduler;
  private readonly options: { reasonerLoopPath: string; logger: CortexLogger };
  /** Absorbed-duplicate lifecycle entries written this reasoner attempt (bounded). */
  private absorbed = { attemptId: -1, entries: 0 };

  constructor(
    ports: DeliveryIntakePorts,
    parts: { delegations: DelegationRegistry; deltas: ConversationDeltas; scheduler: DeliveryScheduler },
    options: { reasonerLoopPath: string; logger: CortexLogger },
  ) {
    this.ports = ports;
    this.delegations = parts.delegations;
    this.deltas = parts.deltas;
    this.scheduler = parts.scheduler;
    this.options = options;
  }

  /**
   * A quick lookup settled: append the durable lookup_result entry, join
   * the outcome into the reasoner's conversation deltas (shared context,
   * D13: the reasoner sees everything the talker learned, at its next
   * dispatch), and wake the talker. Cancelled lookups are logged by the
   * facade and never reach here.
   */
  lookupResult(outcome: QuickLookupOutcome): void {
    if (outcome.status === 'cancelled') return;
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
    if (demoted) this.options.logger.info('lookup result demoted to when_idle (token bucket empty)');

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

  /**
   * A reasoner delivery: dropped if it answers only cancelled work,
   * absorbed if it repeats a recent one, otherwise logged (the durable
   * record), retiring the work it concludes, and handed to the talker by
   * wake class.
   */
  fromReasoner(
    content: string,
    wakeProposed: WakeClass | undefined,
    meta?: { implicit?: boolean; synthetic?: boolean; terminal?: boolean },
  ): DeliveryIntakeResult {
    // cancel_task is the one discard path (communication.md): a result
    // whose causation is entirely cancelled work never reaches the user.
    // It is still recorded, so the audit trail shows what was withheld.
    const causeTags = this.ports.currentReasonerCauseTags();
    if (this.delegations.servesOnlyCancelled(causeTags)) {
      this.ports.appendLog({
        type: 'lifecycle',
        loopPath: this.options.reasonerLoopPath,
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
      // are bounded per reasoner attempt (same rule as dispatch_refused,
      // N4) so an attempt re-emitting the same content in a loop cannot
      // grow the log unboundedly.
      const attemptId = this.ports.reasonerAttemptId();
      if (this.absorbed.attemptId !== attemptId) this.absorbed = { attemptId, entries: 0 };
      if (this.absorbed.entries < MAX_ABSORBED_ENTRIES_PER_ATTEMPT) {
        this.absorbed.entries += 1;
        const atBound = this.absorbed.entries === MAX_ABSORBED_ENTRIES_PER_ATTEMPT;
        this.ports.appendLog({
          type: 'lifecycle',
          loopPath: this.options.reasonerLoopPath,
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
    if (demoted) this.options.logger.info('interrupt delivery demoted to when_idle (token bucket empty)');

    // The log is the durable record of the delivery; a delivery dropped
    // later (abort, restore) stays retained here (facade-api.md abort
    // table).
    this.ports.appendLog({
      type: 'delivery',
      loopPath: this.options.reasonerLoopPath,
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
        this.options.logger.error('silent delivery to talker failed', {
          error: errorMessageOf(err),
        });
      }
      return { delivered: true, wake };
    }

    this.scheduler.enqueue(content, wake);
    return { delivered: true, wake };
  }

  reset(): void {
    this.absorbed = { attemptId: -1, entries: 0 };
  }

  private reasonerCause(): { causedBy?: number } {
    const seq = latestCauseSeq(this.ports.currentReasonerCauseTags());
    return seq !== null ? { causedBy: seq } : {};
  }
}
