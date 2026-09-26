/**
 * ReasonerDispatcher: how a router dispatch reaches the reasoner, including
 * the one case that is not a plain wake delivery. A cancel whose live run
 * serves only the cancelled work stops that run outright, and every
 * dispatch that arrives while that abort unwinds waits behind it, in order,
 * rather than parking inside the abort window and being cancelled with the
 * run.
 */

import type { AgentLoop, DeliverOptions } from '../agent-loop.js';
import type { CortexLogger } from '../types.js';
import { errorMessageOf } from '../error-classifier.js';
import type { LogEntryInput } from '../facade/log-recorder.js';
import type { CauseTag } from './cause-tags.js';
import type { ReasonerDispatchOptions } from './router-contract.js';

export interface ReasonerDispatchPorts {
  reasoner: AgentLoop;
  append(input: LogEntryInput): void;
  /** Input is about to reach a loop (idle digestion yields to it). */
  beforeInput(): void;
  /** The session itself is aborting the reasoner run to honor a cancel. */
  cancelAbortStarting(): void;
  /** That abort has unwound; the next run is the cancel's own. */
  cancelAbortFinished(): void;
  destroyed(): boolean;
  logger: CortexLogger;
}

export class ReasonerDispatcher {
  private readonly ports: ReasonerDispatchPorts;
  /**
   * Set while a cancel_task is aborting a reasoner run that served only the
   * cancelled work; later dispatches chain behind it.
   */
  private cancelAbort: Promise<void> | null = null;

  constructor(ports: ReasonerDispatchPorts) {
    this.ports = ports;
  }

  /**
   * Wake-deliver a dispatch to the reasoner. The directive seq rides the
   * delivery as its cause tag (stamped kind 'directive': the router only
   * ever dispatches on behalf of a directive entry it just appended), so
   * the run that consumes it (the turn it starts, or the sweep run when the
   * reasoner is busy) carries the causation regardless of which path
   * delivers it.
   */
  dispatch(message: string, causeSeq: number | null, options?: ReasonerDispatchOptions): void {
    const { reasoner } = this.ports;
    this.ports.beforeInput();
    const deliverOptions: DeliverOptions = {
      ...(causeSeq !== null
        ? { causeTag: { kind: 'directive', seq: causeSeq } satisfies CauseTag }
        : {}),
      ...(options?.atTurnBoundary ? { atTurnBoundary: true } : {}),
    };
    if (this.cancelAbort) {
      // A cancel is stopping the reasoner's run. Anything handed over now
      // would park inside the abort window and be cancelled with the run,
      // so it waits for the abort to finish, in order.
      this.cancelAbort = this.cancelAbort.then(() => {
        this.deliverAfterCancel(message, deliverOptions, causeSeq);
      });
      return;
    }
    if (
      options?.abortLiveRun &&
      reasoner.isPrompting &&
      // Aborting drops everything parked behind the run (other tasks'
      // dispatches among it); stopping one task must not cost another.
      reasoner.pendingWakeDeliveryCount === 0
    ) {
      this.ports.append({
        type: 'lifecycle',
        loopPath: reasoner.loopPath,
        content: 'Stopping the reasoner run: it served only cancelled work',
        data: { event: 'cancelled_run_stopped' },
        causedBy: causeSeq,
      });
      this.ports.cancelAbortStarting();
      this.cancelAbort = reasoner.abort()
        .catch((err: unknown) => {
          this.ports.logger.warn('cancel abort of the reasoner run failed', {
            error: errorMessageOf(err),
          });
        })
        .then(() => {
          this.ports.cancelAbortFinished();
          this.deliverAfterCancel(message, deliverOptions, causeSeq);
        })
        .finally(() => {
          this.cancelAbort = null;
        });
      return;
    }
    reasoner.deliver(message, deliverOptions);
  }

  /**
   * A dispatch deferred behind a cancel abort. It can no longer fail the
   * control-tool call that produced it, so a failure is recorded the way
   * the router records a synchronous one.
   */
  private deliverAfterCancel(
    message: string,
    deliverOptions: DeliverOptions,
    causeSeq: number | null,
  ): void {
    if (this.ports.destroyed()) return;
    const { reasoner } = this.ports;
    try {
      reasoner.deliver(message, deliverOptions);
    } catch (err) {
      this.ports.logger.error('dispatch to reasoner failed after a cancel abort', {
        error: errorMessageOf(err),
      });
      this.ports.append({
        type: 'lifecycle',
        loopPath: reasoner.loopPath,
        content: 'Dispatch to the reasoner failed',
        data: {
          event: 'dispatch_failed',
          error: errorMessageOf(err),
        },
        causedBy: causeSeq,
      });
    }
  }
}
