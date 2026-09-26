/**
 * Delivering finished background work (background sub-agents, backgrounded
 * Bash commands) back to the loop: each completion is queued and a gated
 * drain cycle delivers the queue with a run of its own. A completion that
 * lands while a run holds the gate is delivered by that cycle's own
 * end-of-cycle drain, and the scheduled drain becomes a no-op; scheduling
 * unconditionally closes the race where a completion lands between the
 * running cycle's final drain check and the gate release.
 *
 * Failed delivery runs are unwound from the transcript and re-attempted
 * within the delivery budget (delivery-failure.ts); content the loop gives
 * up on, or that arrives during teardown, is dead-lettered. Background
 * completions are not cancelled by a user abort: a drain replaces an
 * aborted controller and delivers anyway.
 */

import type { AgentMessage } from '../context-manager.js';
import { classifyError, toError } from '../error-classifier.js';
import type { BackgroundTaskStore } from '../tools/runtime.js';
import type { CortexLogger, RetryPolicy, SubAgentResult } from '../types.js';
import { formatBashCompletion, formatSubAgentCompletion } from './background-task-text.js';
import {
  BACKGROUND_DELIVERY_LIMITS,
  boundedPolicyFor,
  partitionExhausted,
} from './delivery-failure.js';
import type { DeadLetterStore } from './delivery-failure.js';
import { HandlerList } from './handler-list.js';
import type { AbortState, LoopGate } from './run-control.js';

/**
 * A background task that finished while the agent was busy and must be
 * delivered to the loop once it goes idle. Either a sub-agent (carries its
 * result) or a backgrounded Bash command (read live from the task store at
 * delivery time, so dedup against polling/kill stays correct).
 */
export type PendingBackgroundCompletion = (
  | { kind: 'subagent'; taskId: string; result: SubAgentResult }
  | { kind: 'bash'; taskId: string }
) & {
  /** Failed delivery attempts so far. Set by the drain's re-queue path. */
  deliveryAttempts?: number;
  /**
   * Set when the item was given up on. Read by the drain to tell a recovered
   * batch from a terminal one; an exact marker rather than a lookup in the
   * capped dead-letter list, which can evict the entry being looked for.
   */
  deadLettered?: boolean;
  /**
   * When the first delivery attempt for this completion started. Bounds the
   * TOTAL time spent delivering it (in-run retry backoff included), so
   * re-queued attempts cannot re-enter the full retry ladder back-to-back.
   */
  firstDeliveryAttemptAt?: number;
  /**
   * Message formatted on the first delivery attempt. Re-queued items reuse
   * it because formatting marks Bash tasks notified, so re-formatting would
   * return null and silently drop the completion.
   */
  formattedMessage?: string;
};

export interface BackgroundDeliveryPorts {
  gate: LoopGate;
  abort: AbortState;
  isAborted(): boolean;
  isShuttingDown(): boolean;
  /** Whether a sub-agent was cancelled (its result is discarded, not delivered). */
  isCancelled(taskId: string): boolean;
  /** A drain run: delivers `message` even after an abort, flushing no silent content. */
  runDeliveryTurn(message: string, retryPolicy: RetryPolicy): Promise<unknown>;
  /** Unwind a failed delivery run (true: the content must be re-queued). */
  unwindFailedDelivery(preDeliveryCount: number, runAbortEpoch: number): boolean;
  messages(): AgentMessage[];
  backgroundTasks: Pick<BackgroundTaskStore, 'get'>;
  deadLetters: DeadLetterStore;
  retryPolicy: RetryPolicy;
  emitError(error: Error): void;
  logger: CortexLogger;
}

export class BackgroundDelivery {
  readonly deliveryHandlers: HandlerList<[taskIds: string[]]>;
  /** Completions awaiting delivery (mutated in place; tests hold the array). */
  readonly pending: PendingBackgroundCompletion[] = [];

  constructor(private readonly ports: BackgroundDeliveryPorts) {
    this.deliveryHandlers = new HandlerList('onBackgroundResultDelivery', ports.logger);
  }

  /**
   * Handle a background task (sub-agent or Bash command) completing. The
   * completion is queued and a gated drain cycle is scheduled: if a loop is
   * currently running, its own end-of-cycle drain delivers the item first
   * and the scheduled drain becomes a no-op; if the agent is idle, the
   * scheduled drain delivers it by starting a new loop.
   *
   * Scheduling unconditionally (instead of branching on _isPrompting)
   * closes the race where a completion lands between the running cycle's
   * final drain check and the gate release, which would strand it.
   *
   * Shared by background sub-agents (resolved promise) and backgrounded Bash
   * commands (process `close` callback), so both wake the loop the same way.
   */
  async enqueue(
    item: PendingBackgroundCompletion,
  ): Promise<void> {
    // A cancelled sub-agent can settle after its cancel (its completion path
    // survives the abort); its result must never wake the loop. Checked
    // before the shutdown gate: work discarded on purpose is not
    // dead-letter material, even when the discard happens mid-teardown.
    if (item.kind === 'subagent' && this.ports.isCancelled(item.taskId)) {
      this.ports.logger.info('dropping result of cancelled subagent', {
        taskId: item.taskId,
      });
      return;
    }
    // Completed work arriving during teardown will never be delivered:
    // record it as dead-lettered instead of dropping it silently.
    if (this.ports.isShuttingDown()) {
      this.deadLetter(item, 'agent shut down before delivery');
      return;
    }

    this.pending.push(item);
    await this.schedule();
  }

  /**
   * Enqueue a gated drain cycle. Delivery failures have no consumer-level
   * caller to catch them, so a terminal failure is routed to onError (once,
   * at this chain root) and never rejected out of the returned promise.
   */
  schedule(): Promise<void> {
    return this.ports.gate.enqueue(async () => {
      if (this.ports.isShuttingDown()) return;
      try {
        await this.drain();
      } catch (err) {
        this.ports.emitError(toError(err));
      }
    });
  }

  /**
   * Drain all pending background completions by restarting the agentic loop
   * with a combined message. Must be called while holding the loop gate
   * (from a cycle's finally or a scheduled drain task). Completions that
   * were already observed in the meantime (Bash poll/kill) are skipped, and
   * if nothing remains to deliver the loop is not restarted.
   */
  async drain(): Promise<void> {
    if (this.ports.isShuttingDown()) return;
    if (this.pending.length === 0) return;

    const pending = this.pending.splice(0);
    const batch: PendingBackgroundCompletion[] = [];
    const parts: string[] = [];
    const firstAttemptTaskIds: string[] = [];
    for (const item of pending) {
      // Cancelled sub-agent work is discarded, including re-queued items
      // whose cancel landed between delivery attempts.
      if (item.kind === 'subagent' && this.ports.isCancelled(item.taskId)) {
        continue;
      }
      // Re-queued items reuse the message formatted on their first attempt
      // (formatting marks Bash tasks notified, so it must not re-run).
      const message = item.formattedMessage ?? this.format(item);
      if (message === null) continue;
      item.formattedMessage = message;
      item.firstDeliveryAttemptAt ??= Date.now();
      batch.push(item);
      parts.push(message);
      if (!item.deliveryAttempts) firstAttemptTaskIds.push(item.taskId);
    }
    if (batch.length === 0) return;

    // Each attempt's in-run retry ladder is capped to the batch's remaining
    // delivery budget (see delivery-failure.ts).
    const boundedRetryPolicy = boundedPolicyFor(
      this.ports.retryPolicy, batch, BACKGROUND_DELIVERY_LIMITS, Date.now(),
    );

    const message = parts.join('\n\n---\n\n');
    // Notify consumers once per completion (not again on re-attempts).
    if (firstAttemptTaskIds.length > 0) {
      this.deliveryHandlers.emit(firstAttemptTaskIds);
    }
    // pi pushes the delivery's user message into state.messages at run
    // start, before any model call, so a failed delivery leaves that
    // message (plus a synthetic failure stub) in the transcript. Captured
    // here so the catch can unwind exactly what this attempt appended. The
    // abort epoch rides along for deterministic re-park stamping.
    const preDeliveryCount = this.ports.messages().length;
    const runAbortEpoch = this.ports.abort.epoch;
    let attemptError: Error | null = null;
    let requeuedForRetry = false;
    try {
      // fromDrain: deliver via a fresh loop even if a prior turn was
      // aborted; background completions are not cancelled by user abort.
      await this.ports.runDeliveryTurn(message, boundedRetryPolicy);
    } catch (err) {
      // The delivery loop failed. Re-queue only when the delivery message
      // could be unwound from the transcript (or never landed); if the run
      // progressed past it, the body already lives in history where the
      // next successful run will see it, and re-queueing would append the
      // same completion a second time.
      attemptError = toError(err);
      if (this.ports.unwindFailedDelivery(preDeliveryCount, runAbortEpoch)) {
        this.requeueOrDeadLetter(batch, err);
        requeuedForRetry = true;
      }
    }

    // Deliver anything that arrived during this delivery (including items
    // the catch above re-queued), even when the attempt failed, matching
    // the pre-gate recursive prompt() behavior. Bounded: each re-queued
    // item carries an attempt count and dead-letters at the cap. A failure
    // here propagates in place of this attempt's own error (as the old
    // finally-based flow did).
    await this.drain();

    if (attemptError !== null) {
      // A later attempt in this same drain chain delivered the whole
      // re-queued batch: the failure was recovered from, so it must not
      // reach onError or reject a consumer turn (mirroring how an in-run
      // retry that recovers reports onRetrySucceeded rather than onError).
      if (requeuedForRetry && this.batchRecoveredAfterRequeue(batch)) {
        this.ports.logger.info('background delivery recovered after re-queue', {
          taskIds: batch.map((item) => item.taskId),
          error: attemptError.message,
        });
        return;
      }
      throw attemptError;
    }
  }

  /**
   * Whether every item of a failed-then-re-queued delivery batch has since
   * left the system without being dead-lettered: no longer waiting in the
   * pending queue and not marked given-up. True means the recursive drain
   * that ran after the re-queue delivered the batch (or a cancel discarded
   * it), so the failure that re-queued it was transient.
   */
  batchRecoveredAfterRequeue(batch: PendingBackgroundCompletion[]): boolean {
    return batch.every(
      (item) => !this.pending.includes(item) && !item.deadLettered,
    );
  }

  /**
   * After a failed delivery, put the batch back at the front of the queue
   * (preserving order relative to completions that arrived meanwhile), or
   * dead-letter items that cannot productively re-attempt: attempts
   * exhausted, total delivery time over budget, or a fatal error category
   * (an immediate identical re-attempt of an authentication failure is
   * futile; the consumer must act first). Bounds both deterministic
   * redelivery loops and gate-holding during a sustained outage.
   */
  requeueOrDeadLetter(batch: PendingBackgroundCompletion[], err: unknown): void {
    const error = toError(err);
    const lastError = error.message;
    const classified = classifyError(error, { wasAborted: this.ports.isAborted() });
    const fatal = classified.severity === 'fatal';
    // An abort is the user stopping the agent, not this delivery failing on
    // its own terms, so it must not consume an attempt: a few quick aborts
    // would otherwise dead-letter completed work that never truly failed.
    const { retry: requeue, exhausted } = partitionExhausted(
      batch,
      BACKGROUND_DELIVERY_LIMITS,
      Date.now(),
      { countAttempt: classified.category !== 'cancelled', fatal },
    );
    for (const item of exhausted) this.deadLetter(item, lastError);
    this.pending.unshift(...requeue);
  }

  /** Drop a cancelled sub-agent's queued result. */
  purgeSubAgent(taskId: string): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const item = this.pending[i]!;
      if (item.kind === 'subagent' && item.taskId === taskId) this.pending.splice(i, 1);
    }
  }

  /**
   * Teardown: completions still awaiting delivery will never be delivered
   * (queued drains no-op once teardown began), so record them rather than
   * let completed work vanish with the shutdown.
   */
  deadLetterAllPending(reason: string): void {
    for (const item of this.pending.splice(0)) {
      this.deadLetter(item, reason);
    }
  }

  /**
   * Record a completion the agent gives up on delivering: log it, append it
   * to the bounded dead-letter list, and notify
   * onBackgroundResultDeadLettered handlers. Cap evictions are logged,
   * since an evicted entry is completed work vanishing for good.
   */
  private deadLetter(
    item: PendingBackgroundCompletion,
    lastError: string,
  ): void {
    const attempts = item.deliveryAttempts ?? 0;
    item.deadLettered = true;
    this.ports.logger.error('background result dead-lettered', {
      kind: item.kind,
      taskId: item.taskId,
      attempts,
      lastError,
    });
    // Items dead-lettered without ever entering a drain (teardown, a
    // completion arriving mid-shutdown) have no formattedMessage yet, so
    // format here to preserve the payload. Empty only when the source is
    // already gone (a Bash completion landing after runtime teardown).
    const message = item.formattedMessage ?? this.format(item) ?? '';
    this.ports.deadLetters.record({
      kind: item.kind,
      taskId: item.taskId,
      attempts,
      lastError,
      deadLetteredAt: Date.now(),
      message,
    });
  }

  /**
   * Format a pending completion into the message delivered to the loop, or
   * null if there is nothing to deliver. Marks Bash tasks as notified so the
   * same completion is never delivered twice.
   */
  private format(item: PendingBackgroundCompletion): string | null {
    if (item.kind === 'subagent') {
      return formatSubAgentCompletion(item.taskId, item.result);
    }
    const task = this.ports.backgroundTasks.get(item.taskId);
    if (!task || !task.completed || task.notified) return null;
    task.notified = true;
    return formatBashCompletion(task);
  }
}
