/**
 * The loop-owned delivery queues behind deliver() (docs/cortex/duplex/
 * log-and-context.md), plus the public steer/follow-up paths onto pi's own
 * queues.
 *
 * Two loop-owned queues, neither of them pi's steering queue. pi polls
 * steering at run start and after every tool batch (including terminated
 * ones), and the queue cannot be inspected or selectively drained, so
 * content parked there either surfaces as an unprompted response or can
 * only be reconciled after the fact by duplicating or destroying it:
 *
 * - Silent (no-wake) deliveries wait for the next real prompt, which
 *   flushes them into its message batch.
 * - Wake deliveries parked while the loop gate was held are spliced to the
 *   front of the next real prompt's batch, or delivered by a sweep task
 *   enqueued at park time with a run of its own. Splicing clears the queue
 *   at batch time, so a run that consumed the content leaves nothing for
 *   the sweep: exactly one run receives each parked delivery. abort()
 *   cancels parked deliveries (see the abort epoch in run-control.ts).
 *
 * Both are dropped on destroy(); a facade that needs them durable drains
 * them first (clearQueuedDeliveries / clearAllQueues).
 */

import type { AgentMessage } from '../context-manager.js';
import { classifyError, errorMessageOf, toError } from '../error-classifier.js';
import type { CortexEvent } from '../event-bridge.js';
import type { CortexLogger, RetryPolicy } from '../types.js';
import {
  boundedPolicyFor,
  partitionExhausted,
  WAKE_DELIVERY_LIMITS,
} from './delivery-failure.js';
import type { DeadLetterStore } from './delivery-failure.js';
import type { DirectCompletionOptions } from './direct-completion.js';
import type { PiAgent, QueueDrainMode } from './pi-agent.js';
import type { AbortState, LoopGate } from './run-control.js';
import { unwindFailedDelivery, unwindSplicedBatch } from './transcript-repair.js';

/** Options for {@link AgentLoop.deliver}. */
export interface DeliverOptions {
  /**
   * Whether the delivery may wake an idle loop by starting a turn. Default
   * true. When false and the loop is idle, the content is queued on the
   * AgentLoop itself and flushed into the next real prompt's message batch;
   * it never starts a run and never enters pi's steering queue (which would
   * drain into whatever run starts next and produce an unprompted response).
   */
  wake?: boolean;
  /**
   * Options for the turn this delivery starts when it lands on an idle loop
   * (the 'prompted' outcome only). Parked and queued content rides a later
   * run whose options belong to that run's initiator, so these are dropped
   * on those paths by design.
   */
  promptOptions?: DirectCompletionOptions;
  /**
   * Opaque causation tag that travels WITH the content: exposed through
   * {@link AgentLoop.activeRunCauseTags} for exactly the run that consumes
   * this delivery (the turn it starts, the prompt whose leading batch it
   * rides, or the sweep run that delivers it after parking). The facade
   * stamps log-entry causation from it; binding the tag to the content
   * rather than to a caller-side field means a parked delivery keeps its
   * causation across the sweep, and a later run can never inherit a
   * previous run's tag. Wake deliveries only; silent content is
   * context-only and carries no causation.
   */
  causeTag?: unknown;
  /**
   * Let a run already in flight take this wake delivery at its next turn
   * boundary, instead of the delivery waiting for the next run. For content
   * that redirects the work the live run is doing (a steer, a stop), where
   * waiting for the run to end defeats the point.
   *
   * Exact, like every other wake path: the content still parks on the
   * loop-owned queue, and is handed to pi's steering queue only in the
   * turn_end frame of a live, non-failed turn, and only while pi's queues
   * are empty, i.e. immediately before the steering poll that drains
   * exactly that one message. Anything else (no live run, retry backoff,
   * digestion, a failed or aborted turn, public steer() content already
   * queued, an ordinary parked delivery ahead of it) leaves it parked for
   * the next run, as without the flag. Wake deliveries only.
   */
  atTurnBoundary?: boolean;
}

/** Which branch of the deliver() state machine handled a delivery. */
export type DeliverOutcome = 'prompted' | 'parked' | 'queued';

/** Result of {@link AgentLoop.deliver}. */
export interface DeliverResult {
  outcome: DeliverOutcome;
  /**
   * Present only for 'prompted': the promise of the turn this delivery
   * started (the same promise prompt() would return). A 'parked' delivery
   * has no promise of its own: the content opens the NEXT run (as leading
   * batch messages of a prompt already queued ahead of it, or through the
   * sweep's own run), and failures of that run surface through onError. A
   * 'queued' delivery has no turn at all until the next real prompt
   * flushes it.
   */
  turn?: Promise<unknown>;
}

/**
 * A delivery held by the loop until a run consumes it. Loop-owned queue
 * semantics from docs/cortex/duplex/log-and-context.md: the content must
 * never sit in pi's steering queue, which cannot be inspected or
 * selectively drained. Silent (no-wake) deliveries wait for the next real
 * prompt; wake deliveries parked while the gate was held are spliced into
 * the next real prompt's batch or delivered by a sweep run.
 */
export interface QueuedDelivery {
  content: string;
  timestamp: number;
  /** Failed delivery-run attempts so far (wake parking only). */
  deliveryAttempts?: number;
  /**
   * When the first delivery run for this item started (wake parking only).
   * Bounds total time spent in failed attempts via the elapsed budget.
   */
  firstDeliveryAttemptAt?: number;
  /**
   * The loop's abort epoch when this item parked (wake parking only).
   * abort() cancels parked deliveries; an item stamped before the most
   * recent abort completed is dropped instead of delivered to a run that
   * starts after the user stopped the agent.
   */
  abortEpoch?: number;
  /** Causation tag riding with the content (see DeliverOptions.causeTag). */
  causeTag?: unknown;
  /** A live run may take it at its next turn boundary (see DeliverOptions). */
  atTurnBoundary?: boolean;
}

export interface DeliveryQueuePorts {
  gate: LoopGate;
  abort: AbortState;
  isAborted(): boolean;
  isShuttingDown(): boolean;
  assertNotShuttingDown(): void;
  hasSystemPrompt(): boolean;
  /** Whether a logical turn is in flight. */
  isPrompting(): boolean;
  budgetBreached(): boolean;
  /** The loop's prompt(), with the delivery's cause tag staged for its run. */
  startPrompt(content: string, options: DirectCompletionOptions | undefined, causeTag: unknown): Promise<unknown>;
  /** A drain-style run (no silent flush) carrying `causeTags`. */
  runDeliveryTurn(message: string, retryPolicy: RetryPolicy, causeTags: unknown[]): Promise<unknown>;
  /** Add causation to the run in flight (content steered into it). */
  appendActiveCauseTags(tags: unknown[]): void;
  transcript: {
    messages(): AgentMessage[];
    /** Where this run's leading batch starts (live: compaction moves it). */
    boundary(): number;
    notifyTailTrimmed(): void;
  };
  piQueues: Pick<
    PiAgent,
    'steer' | 'followUp' | 'steeringMode' | 'followUpMode' | 'clearSteeringQueue' | 'clearFollowUpQueue' | 'hasQueuedMessages'
  >;
  deadLetters: DeadLetterStore;
  retryPolicy: RetryPolicy;
  emitError(error: Error): void;
  logger: CortexLogger;
}

export class DeliveryQueues {
  private readonly silent: QueuedDelivery[] = [];
  /** Parked wake deliveries (mutated in place; tests hold the array). */
  readonly wake: QueuedDelivery[] = [];

  constructor(private readonly ports: DeliveryQueuePorts) {}

  /** See AgentLoop.steer: pi's steering queue, reached only while a run can poll it. */
  steer(message: string): void {
    // A turn started via prompt() is deferred one microtask (it dequeues
    // from the loop gate), so _isPrompting is still false in the same frame.
    // Treat a non-empty gate as prompting too, so a
    // same-frame prompt()+steer() reaches pi's steering queue (drained at
    // loop start) instead of being silently dropped.
    if (!this.ports.isPrompting() && !this.ports.gate.isActive) return;
    this.ports.piQueues.steer({ role: 'user', content: message });
  }

  /** See AgentLoop.deliver: the silent / parked / prompted state machine. */
  deliver(content: string, options?: DeliverOptions): DeliverResult {
    this.ports.assertNotShuttingDown();
    if (typeof content !== 'string' || content.trim().length === 0) {
      // Whitespace-only content is silently dropped at provider conversion,
      // which would turn a "delivered" message into nothing. Fail loudly.
      throw new Error('deliver() requires non-whitespace string content');
    }
    if (!this.ports.hasSystemPrompt()) {
      // prompt() rejects for the same reason, but only asynchronously and
      // without emitting onError, so a fire-and-forget deliver() would
      // report an outcome for a turn that can never run (and steered or
      // queued content would wait on a prompt that must fail). Fail at the
      // point of misuse instead.
      throw new Error(
        'AgentLoop prompt is not configured. Call setBasePrompt() before deliver(), ' +
        'or provide initialBasePrompt during creation.',
      );
    }
    const wake = options?.wake ?? true;

    if (!wake) {
      // Silent class queues in EVERY run state. Steering it into a live run
      // would surface it at the next tool-batch boundary (pi continues the
      // inner loop whenever steering is non-empty, even after a terminated
      // batch), which is exactly the unprompted response silent forbids.
      this.silent.push({ content, timestamp: Date.now() });
      this.ports.logger.debug('silent delivery queued', {
        queued: this.silent.length,
      });
      return { outcome: 'queued' };
    }

    if (this.ports.gate.isActive) {
      // Covers both "pi running" and "gate held but pi idle" (retry backoff,
      // drain window, idle digestion, a cycle cancelled at dequeue). The
      // content is parked for the next run; the sweep task guarantees that
      // run happens even when every gate task ahead of it is a non-run task.
      this.wake.push({
        content,
        timestamp: Date.now(),
        abortEpoch: this.ports.abort.epoch,
        ...(options?.causeTag !== undefined ? { causeTag: options.causeTag } : {}),
        ...(options?.atTurnBoundary ? { atTurnBoundary: true } : {}),
      });
      this.scheduleSweep();
      this.ports.logger.debug('wake delivery parked for the next run', {
        parked: this.wake.length,
      });
      return { outcome: 'parked' };
    }

    // Idle + wake: the gate is empty in this same synchronous frame, so
    // prompt() cannot fail fast on a held gate. Attach a rejection handler so
    // a fire-and-forget caller never produces an unhandled rejection and the
    // failure is at least logged; callers that await result.turn still
    // observe the rejection, and run failures surface through onError.
    // The cause tag is staged for the run prompt() enqueues: the gate is
    // empty here, so that cycle is the next run task and no other run can
    // dequeue between this frame and it.
    const turn = this.ports.startPrompt(content, options?.promptOptions, options?.causeTag);
    turn.catch((err) => {
      this.ports.logger.warn('deliver-started turn failed', {
        error: errorMessageOf(err),
      });
    });
    return { outcome: 'prompted', turn };
  }

  /**
   * Dequeue the parked wake deliveries that are still deliverable. An
   * abort cancels parked deliveries, so two classes are dropped here
   * instead of riding a post-abort run: everything, while an abort is
   * still completing (abort() drops the queue synchronously at entry, but
   * a delivery can park during its await windows, and a drain that starts
   * mid-abort replaces the aborted controller, so neither the entry drop
   * nor the live controller covers that window); and items stamped with a
   * previous abort epoch, which parked before the most recent abort()
   * finished and were cancelled by it.
   */
  takeDeliverableWake(): QueuedDelivery[] {
    const taken = this.wake.splice(0);
    if (taken.length === 0) return taken;
    const epoch = this.ports.abort.epoch;
    const deliverable = this.ports.abort.inFlight
      ? []
      : taken.filter((item) => (item.abortEpoch ?? epoch) === epoch);
    const dropped = taken.filter((item) => !deliverable.includes(item));
    if (dropped.length > 0) {
      this.ports.logger.info('dropped wake deliveries parked during abort', {
        count: dropped.length,
      });
      // Content destroyed here (parked during an abort window, or stamped
      // with a previous abort epoch) is durably recorded, not just counted:
      // the dead-letter surface is what turns the drop into a session-log
      // lifecycle entry.
      this.ports.deadLetters.recordWake(dropped, 'cancelled by abort (parked during the abort window)');
    }
    return deliverable;
  }

  /**
   * Hand the parked turn-boundary deliveries (DeliverOptions.atTurnBoundary)
   * to the live run, in the turn_end frame, right before pi's steering poll.
   *
   * pi emits turn_end, awaits its listeners, and then polls the steering
   * queue (unless the turn failed or was aborted, where it ends the run
   * without polling). So content steered here, while pi's queues are empty,
   * is exactly the message that poll drains, in either drain mode, and the
   * run continues into a turn that sees it. Every condition that would break
   * that guarantee leaves the content parked for the next run instead.
   *
   * Only the leading flagged items are taken: an ordinary delivery parked
   * ahead of them (a new task, say) opens the next run, and letting a later
   * redirect overtake it would hand the live run an instruction about work
   * it has not been given yet.
   */
  steerTurnBoundary(event: CortexEvent): void {
    if (this.wake.length === 0) return;
    if (!this.wake[0]!.atTurnBoundary) return;
    if (!this.ports.isPrompting() || this.ports.isShuttingDown()) return;
    if (this.ports.abort.inFlight) return;
    if (this.ports.budgetBreached()) return;
    const message = (event.data as { message?: { stopReason?: unknown; errorMessage?: unknown } } | undefined)
      ?.message;
    if (!message) return;
    if (message.stopReason === 'error' || message.stopReason === 'aborted' || message.errorMessage != null) {
      return;
    }
    // Unknown queue state (a pi double without the probe) is not provably
    // empty, so the content waits for the next run.
    if (this.ports.piQueues.hasQueuedMessages?.() !== false) return;

    let count = 0;
    while (
      count < this.wake.length &&
      this.wake[count]!.atTurnBoundary &&
      (this.wake[count]!.abortEpoch ?? this.ports.abort.epoch) === this.ports.abort.epoch
    ) {
      count += 1;
    }
    if (count === 0) return;
    const taken = this.wake.splice(0, count);
    this.ports.piQueues.steer({ role: 'user', content: taken.map((item) => item.content).join('\n\n') });
    // The run now answers this content, so it carries its causation too.
    const tags = taken.map((item) => item.causeTag).filter((tag) => tag !== undefined);
    if (tags.length > 0) this.ports.appendActiveCauseTags(tags);
    this.ports.logger.debug('parked deliveries steered into the live run', { count });
  }

  /**
   * Guarantee a run for parked wake deliveries: enqueue a sweep task behind
   * every gate task present now. A real prompt that dequeues ahead of the
   * sweep splices the parked list into its own batch and leaves nothing to
   * find; the sweep delivers whatever is still parked when it fires with a
   * run of its own. Sweep runs have no consumer-level caller, so terminal
   * failures are routed to onError like the scheduled background drain's.
   */
  private scheduleSweep(): void {
    void this.ports.gate.enqueue(async () => {
      if (this.ports.isShuttingDown()) return;
      try {
        await this.sweep();
      } catch (err) {
        this.ports.emitError(toError(err));
      }
    });
  }

  /**
   * Deliver whatever is still parked on the wake queue with a run of its
   * own. Exact by construction: the parked list is the single source of
   * truth for undelivered wake content (batch splicing clears it at every
   * real prompt's run start), so an empty list means every parked delivery
   * already reached a run and there is nothing to do; a non-empty list is
   * content NO run has consumed. No queue-state guessing is involved.
   *
   * Failure recovery mirrors the background drain's: the transcript is
   * unwound from the pre-delivery boundary (so a run that failed after an
   * assistant tool-call turn cannot leave an unpaired tool call), and
   * unwound content returns to the parked list for a bounded number of
   * further sweep attempts rather than being dropped. Both bounds the
   * drain applies hold here too: an attempt cap, and an elapsed delivery
   * budget that also caps each attempt's in-run retry ladder (via
   * maxElapsedMs), so a sustained outage cannot hold the gate for full
   * ladders back-to-back. Content the failed run progressed past stays in
   * the transcript as durable history, where the next successful run sees
   * it; re-parking it would duplicate it.
   */
  private async sweep(): Promise<void> {
    if (this.wake.length === 0) return;
    const pending = this.takeDeliverableWake();
    if (pending.length === 0) return;
    const message = pending.map((item) => item.content).join('\n\n');
    this.ports.logger.info('delivering parked wake deliveries with a run', {
      count: pending.length,
    });
    // Each attempt's in-run retry ladder is capped to the batch's remaining
    // delivery budget (see delivery-failure.ts).
    const now = Date.now();
    for (const item of pending) item.firstDeliveryAttemptAt ??= now;
    const boundedRetryPolicy = boundedPolicyFor(this.ports.retryPolicy, pending, WAKE_DELIVERY_LIMITS, now);
    // Boundary for the failure unwind, captured like the drain captures it:
    // pi pushes the delivery message at run start, before any model call.
    // The abort epoch is captured beside it so unwind recovery stamps
    // re-parked content deterministically with the run's own epoch.
    const preDeliveryCount = this.ports.transcript.messages().length;
    const runAbortEpoch = this.ports.abort.epoch;
    try {
      // Drain semantics: replace an aborted controller (parked deliveries
      // survive a prior abort, like background completions) and never flush
      // the silent queue (its contract is "next real prompt", and the
      // unwind below counts messages from the pre-delivery boundary, which
      // flushed extras would corrupt). The batch's cause tags ride along so
      // the sweep run carries the same causation the parked content did.
      await this.ports.runDeliveryTurn(
        message,
        boundedRetryPolicy,
        pending.map((item) => item.causeTag).filter((tag) => tag !== undefined),
      );
    } catch (err) {
      const error = toError(err);
      if (!this.unwindFailedDelivery(preDeliveryCount, runAbortEpoch)) {
        // The run progressed past the parked content: it is durable
        // history now. The run's failure still surfaces, but the delivery
        // itself was made; re-parking would duplicate it.
        throw error;
      }
      // Content is back out of the transcript. An abort cancels parked
      // deliveries exactly like it cancels the turn that carried them;
      // re-parking would resurrect a run the user just stopped. The
      // cancellation is dead-lettered like every other destruction of
      // parked content, so the drop reaches the session log.
      if (classifyError(error, { wasAborted: this.ports.isAborted() }).category === 'cancelled') {
        this.ports.logger.info('wake delivery run aborted; parked content cancelled', {
          count: pending.length,
        });
        this.ports.deadLetters.recordWake(pending, 'cancelled by abort (carrying run aborted)');
        return;
      }
      // Otherwise re-park for another sweep attempt, dropping items whose
      // attempt cap or total delivery budget is exhausted so a terminal
      // error cannot loop the gate forever. Dropped items dead-letter so
      // the drop is observable (a bare count in a log line leaves the
      // session log showing content that simply never got a run).
      const { retry: requeue, exhausted: droppedItems } =
        partitionExhausted(pending, WAKE_DELIVERY_LIMITS, Date.now());
      if (droppedItems.length > 0) {
        this.ports.logger.error('dropping parked wake deliveries after repeated failed runs', {
          dropped: droppedItems.length,
          attempts: WAKE_DELIVERY_LIMITS.maxAttempts,
        });
        this.ports.deadLetters.recordWake(droppedItems, error.message);
      }
      if (requeue.length > 0) {
        // Ahead of anything that parked meanwhile, preserving arrival order.
        this.wake.unshift(...requeue);
        this.scheduleSweep();
      }
      if (requeue.length === pending.length) {
        // Every item gets another attempt: this failure is not terminal
        // yet, so it must not surface (mirroring the drain chain, which
        // stays silent for a re-queued batch a later attempt delivers).
        this.ports.logger.warn('wake delivery run failed; re-parked for another sweep', {
          error: error.message,
          count: requeue.length,
        });
        return;
      }
      throw error;
    }
  }

  /**
   * After a terminal consumer-prompt failure, recover wake deliveries that
   * were spliced into the failed run's leading batch. pi pushed them into
   * the transcript at run start, but no run ever answered them: left
   * there, content whose caller was told 'parked' silently demotes to
   * inert context. Mirrors the sweep's failure recovery: when the run
   * produced nothing beyond the batch (and failure stubs), the wake
   * messages are spliced back out and re-parked for a sweep run of their
   * own; when the run progressed past the batch, the content is durable
   * history the next successful run sees, and re-parking would duplicate
   * it. Consumer failure semantics for the prompt's own input and any
   * flushed silent deliveries are unchanged: those stay in the transcript
   * exactly as before.
   */
  reparkAfterFailedPrompt(
    wakeBatch: QueuedDelivery[],
    trailingBatchCount: number,
    lastError: string,
  ): void {
    if (wakeBatch.length === 0) return;
    const messages = this.ports.transcript.messages();

    // Walk from the LIVE boundary, not the one captured at run start: a
    // mid-run front trim (observational activation through
    // setSourceHistory, the only in-run writer of _prePromptMessageCount)
    // shifts every message down, and the recalculated boundary tracks
    // exactly that shift (new length minus current-tick messages). From
    // the stale offset, "rewritten down" reads as "never pushed" and the
    // sweep would deliver content the transcript already carries twice.
    const boundary = this.ports.transcript.boundary();

    const unwind = unwindSplicedBatch(messages, wakeBatch, boundary, trailingBatchCount);
    if (unwind.trimmed) this.ports.transcript.notifyTailTrimmed();
    if (unwind.outcome !== 'repark') return;

    const { retry: requeue, exhausted: droppedItems } =
      partitionExhausted(wakeBatch, WAKE_DELIVERY_LIMITS, Date.now());
    if (droppedItems.length > 0) {
      this.ports.logger.error('dropping wake deliveries after repeated failed carrying runs', {
        dropped: droppedItems.length,
        attempts: WAKE_DELIVERY_LIMITS.maxAttempts,
      });
      this.ports.deadLetters.recordWake(droppedItems, lastError);
    }
    if (requeue.length > 0) {
      // Ahead of anything that parked meanwhile, preserving arrival order.
      this.wake.unshift(...requeue);
      this.scheduleSweep();
    }
  }

  /**
   * After a failed delivery attempt, restore the transcript to its
   * pre-delivery state when possible. pi pushes the delivery's user message
   * at run start (before any model call) and appends a synthetic assistant
   * failure stub when the run fails; both must be removed before a
   * re-attempt, or the re-queued delivery appends the same body again.
   *
   * Returns true when the delivery message is no longer in the transcript
   * (unwound here, or it never landed), meaning the batch must be re-queued
   * to survive. Returns false when the run progressed past the delivery
   * message (a model response, tool results, or a steer landed after it):
   * its content stays in history, so the completion counts as delivered and
   * re-queueing would duplicate it.
   */
  unwindFailedDelivery(preDeliveryCount: number, runAbortEpoch: number): boolean {
    const unwind = unwindFailedDelivery(this.ports.transcript.messages(), preDeliveryCount);
    if (unwind.trimmed) this.ports.transcript.notifyTailTrimmed();
    if (unwind.injectedUserTexts.length > 0) {
      // Content pi injected inside the failed run opens the next run
      // through wake parking.
      for (const content of unwind.injectedUserTexts) {
        this.wake.push({
          content,
          timestamp: Date.now(),
          // Stamped with the epoch the failed run STARTED under. Read at
          // push time it would race the abort's epoch advance: a catch
          // running after the abort's finally would stamp the new epoch
          // and resurrect content the abort should cancel with its run.
          abortEpoch: runAbortEpoch,
        });
      }
      this.scheduleSweep();
    }
    return unwind.outcome === 'requeue';
  }

  /**
   * abort() entry: cancel everything parked. Left parked, a queued sweep
   * would start a full model run for them AFTER the user stopped the
   * agent. The cancellation dead-letters so the destroyed content is
   * durably recorded, not just counted in a log line.
   */
  dropAllWakeForAbort(): void {
    const droppedWake = this.wake.splice(0);
    if (droppedWake.length > 0) {
      this.ports.logger.info('abort dropped parked wake deliveries', {
        count: droppedWake.length,
      });
      this.ports.deadLetters.recordWake(droppedWake, 'cancelled by abort');
    }
  }

  /** Queue a follow-up on pi's follow-up queue (drains at a would-stop point). */
  followUp(message: string): void {
    if (!this.ports.piQueues.followUp) {
      throw new Error('The underlying agent does not expose followUp()');
    }
    this.ports.piQueues.followUp({ role: 'user', content: message });
  }

  setSteeringQueueMode(mode: QueueDrainMode): void {
    this.ports.piQueues.steeringMode = mode;
  }

  setFollowUpQueueMode(mode: QueueDrainMode): void {
    this.ports.piQueues.followUpMode = mode;
  }

  clearSteeringQueue(): void {
    this.ports.piQueues.clearSteeringQueue?.();
  }

  clearFollowUpQueue(): void {
    this.ports.piQueues.clearFollowUpQueue?.();
  }

  /** Clear pi's queues and both loop queues; returns the loop-owned content (silent, then wake). */
  clearAll(): string[] {
    this.clearSteeringQueue();
    this.clearFollowUpQueue();
    const wake = this.wake.splice(0).map((item) => item.content);
    return [...this.clearSilent(), ...wake];
  }

  get silentCount(): number {
    return this.silent.length;
  }

  get wakeCount(): number {
    return this.wake.length;
  }

  /** Take the silent queue for a real prompt's batch. */
  takeSilent(): QueuedDelivery[] {
    return this.silent.splice(0);
  }

  clearSilent(): string[] {
    return this.silent.splice(0).map((item) => item.content);
  }

  /** Retract parked wake deliveries matching `predicate` (see AgentLoop.dropPendingWakeDeliveries). */
  dropWake(predicate: (content: string) => boolean): string[] {
    const dropped: string[] = [];
    for (let i = this.wake.length - 1; i >= 0; i--) {
      if (predicate(this.wake[i]!.content)) dropped.unshift(this.wake.splice(i, 1)[0]!.content);
    }
    return dropped;
  }

  /** Teardown: both queues are dropped by contract (the sweep no-ops then). */
  clearForTeardown(): void {
    this.silent.splice(0);
    this.wake.splice(0);
  }
}
