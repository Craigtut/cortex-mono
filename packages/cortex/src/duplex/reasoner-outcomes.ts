/**
 * ReasonerOutcomeReporter: how the end of a reasoner run reaches the
 * conversation. Its final result (explicit through Deliver, or implicit
 * from its final text), its failure, or its being stopped, each surfaced at
 * most once, so a failed or stopped reasoner is never indistinguishable
 * from a working one and a finished one is never announced twice.
 */

import type { AgentLoop } from '../agent-loop.js';
import type {
  ClassifiedError,
  RetryExhaustedInfo,
  RetryScheduledInfo,
} from '../types.js';
import type { CortexEvent } from '../event-bridge.js';
import type { WakeClass } from '../session-log.js';
import { spokenText } from '../working-tags.js';
import type { DuplexHeadlines } from './headlines.js';
import type { DuplexRouter } from './router.js';
import { deliveryConcludes } from './router.js';
import type { DeliveryIntakeResult, DeliveryTarget } from './reasoner-tools.js';

/** Chars of a provider error message carried into a failure delivery. */
const MAX_FAILURE_DETAIL_CHARS = 300;

/**
 * Bound a provider error message before it rides a failure delivery into the
 * talker's transcript. Provider text is arbitrary length and not ours; the
 * delivery wrapper already fences it as information rather than instruction,
 * so all that is left to do is stop a multi-kilobyte body from crowding out
 * the conversation.
 */
function clipFailureDetail(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) return 'no detail reported';
  return trimmed.length > MAX_FAILURE_DETAIL_CHARS
    ? `${trimmed.slice(0, MAX_FAILURE_DETAIL_CHARS)}…`
    : trimmed;
}

/** Why the session itself is aborting the reasoner. */
export type RequestedAbort = 'user' | 'cancel';

export interface ReasonerOutcomePorts {
  reasoner: AgentLoop;
  router: DuplexRouter;
  headlines: DuplexHeadlines;
  /** Whether the session's aggregate spending limit has tripped. */
  aggregateBreached(): boolean;
  destroyed(): boolean;
}

export class ReasonerOutcomeReporter implements DeliveryTarget {
  private readonly ports: ReasonerOutcomePorts;
  /**
   * Whether the current reasoner run delivered a result through Deliver
   * (implicit-delivery guard). Progress notes (`silent`) do not count.
   */
  private deliveredResultThisRun = false;
  /**
   * Whether the reasoner's current terminal failure already produced a
   * delivery. See deliverFailure for why a per-run reset is the right unit
   * for this and would not be for anything announced mid-ladder.
   */
  private failureAnnounced = false;
  /**
   * Set while the session itself is aborting the reasoner (a user abort, a
   * cancel), so the run end that abort produces is not mistaken for a stop
   * nobody asked for. Budget stops are read off the guards instead.
   */
  private abortCause: RequestedAbort | null = null;

  constructor(ports: ReasonerOutcomePorts) {
    this.ports = ports;
  }

  /**
   * The Deliver tool's target. An explicit Deliver that concludes the work
   * suppresses the implicit final-text delivery for the same run. A silent
   * progress note does not: the role prompt encourages those mid-work, and
   * letting one swallow the final answer would leave the user with
   * "halfway there" as the last thing they heard.
   */
  deliverFromReasoner(
    content: string,
    wake: WakeClass | undefined,
    meta?: { implicit?: boolean; synthetic?: boolean; terminal?: boolean },
  ): DeliveryIntakeResult {
    if (deliveryConcludes(wake, meta)) this.deliveredResultThisRun = true;
    return this.ports.router.deliverFromReasoner(content, wake, meta);
  }

  /** The session is about to abort the reasoner itself, for `cause`. */
  expectAbort(cause: RequestedAbort): void {
    this.abortCause = cause;
  }

  /** That abort has unwound; later stops are nobody's request. */
  abortUnwound(cause: RequestedAbort): void {
    if (this.abortCause === cause) this.abortCause = null;
  }

  /** A reasoner run started: its outcome is open again. */
  noteRunStart(): void {
    this.deliveredResultThisRun = false;
    this.failureAnnounced = false;
  }

  /**
   * A reasoner run ended: if it never delivered a result through Deliver
   * (silent progress notes do not count) and its final assistant text is
   * user-facing, deliver that text as an implicit when_idle delivery so
   * results always surface (review-findings F1).
   */
  noteRunEnd(event: CortexEvent): void {
    this.ports.router.noteReasonerRunEnd();
    const messages = (event.data as { messages?: unknown[] } | undefined)?.messages;
    if (!Array.isArray(messages)) return;
    let last: { stopReason?: unknown; content?: unknown; errorMessage?: unknown } | null = null;
    for (const message of messages) {
      if ((message as { role?: string } | null)?.role === 'assistant') {
        last = message as { stopReason?: unknown; content?: unknown; errorMessage?: unknown };
      }
    }
    if (!last) return;
    // Ahead of the delivered-result check: a run that reported one result
    // and was then stopped mid-way through more work was still stopped.
    if (last.stopReason === 'aborted') {
      this.handleStopped();
      return;
    }
    if (this.deliveredResultThisRun) return;
    if (last.stopReason === 'error') {
      // Only when nothing else in the system is going to speak.
      //
      // pi emits agent_end for a FAILED run too, and on a retryable failure
      // that is attempt 1 of N. Announcing "it stopped with an error" here
      // contradicts the headline block, which correctly says "Retrying after
      // a network failure: attempt 1 of 3" at the same moment, and the
      // delivery is the louder of the two.
      //
      // The discriminator is the stub's own errorMessage. pi mirrors an
      // assistant message's errorMessage into state.errorMessage
      // (pi-agent-core agent.js:394), and the loop turns a recorded
      // state.errorMessage into a throw (agent-loop.ts runTurnWithRetry), so
      // a stub carrying one is guaranteed to reach the retry ladder and then
      // either onRetryExhausted or onError. Those own it, and they fire when
      // the ladder is DONE rather than per attempt.
      //
      // A stub with an error stop reason and NO errorMessage is the other
      // case: prompt() resolved, no throw, no ladder, no onError. This branch
      // is the only thing that can speak for it.
      if (last.errorMessage != null) return;
      this.deliverFailure(
        'The background work stopped with an error before producing a result. ' +
        'Tell the user plainly and offer to try again.',
      );
      return;
    }
    const spoken = spokenText(last);
    if (spoken.length === 0) return;
    this.ports.router.deliverFromReasoner(spoken, 'when_idle', { implicit: true });
  }

  /**
   * Wire the reasoner's failure and retry signals into the talker's two
   * surfaces: the headline block (retrying is a different fact from working,
   * and the block could only say "working") and an interrupt delivery when
   * the ladder gives up or a fatal error lands.
   *
   * Reasoner-only. The talker's own failures are the consumer's to see
   * through onError; delivering them to the talker would ask a loop that
   * just failed to perform an update about itself.
   */
  wireFailureSurfacing(): void {
    const { reasoner, headlines } = this.ports;
    reasoner.onRetryScheduled((info: RetryScheduledInfo) => {
      headlines.noteRetry({
        category: info.category,
        attempt: info.attempt,
        maxAttempts: info.maxAttempts,
      });
    });
    reasoner.onRetrySucceeded(() => {
      headlines.clearRetry();
    });
    reasoner.onRetryExhausted((info: RetryExhaustedInfo) => {
      headlines.clearRetry();
      this.deliverFailure(
        `The background work failed and has given up retrying (${info.category}, ` +
        `${info.attempts} attempts). It produced no result. Tell the user plainly ` +
        'and offer to try again.',
      );
    });
    reasoner.onError((error: ClassifiedError) => {
      // Only a failure that ended a reasoner TURN. emitError also serves the
      // direct and utility completion paths (an observation call failing,
      // say), which are not the user's work dying and must not be announced
      // as such. Inside a run the loop is still prompting here: the flag is
      // cleared in runPromptOnce's finally, well after this fires.
      if (!reasoner.isPrompting) return;

      // An abort has to clear the retry line: an abort during a backoff
      // window produces neither a run start nor a run end, and neither
      // onRetrySucceeded nor onRetryExhausted, so nothing else would ever
      // take "Retrying, attempt 2 of 3" back down. A breached budget guard
      // is the reason the run died, whatever the abort surfaced as (the
      // abort comes from the guard, not the loop's own controller, so it is
      // not always classified as a cancellation).
      if (error.category === 'cancelled' || this.budgetBreached()) {
        headlines.clearRetry();
        this.handleStopped();
        return;
      }

      // Everything else here is terminal by construction: the loop emits
      // onError from runTurnWithRetry only on the path where it has decided
      // NOT to retry, so reaching this point means the ladder is over (or
      // never ran). Severity picks the wording, not whether to speak: a
      // 'recoverable' classification that still ended the turn with no
      // result is exactly as silent to the user as a fatal one.
      const detail = clipFailureDetail(error.originalMessage);
      this.deliverFailure(
        error.severity === 'fatal'
          ? `The background work stopped with an error it cannot recover from: ${detail}. ` +
            'Tell the user plainly; it will not retry on its own.'
          : `The background work stopped and produced no result: ${detail}. ` +
            'Tell the user plainly and offer to try again.',
      );
    });
  }

  /**
   * The reasoner's run was aborted. Reached from the run end (a run pi ended
   * as aborted) and from onError (an abort that surfaced as a cancelled
   * failure, including one landing in retry backoff, which produces no run
   * end at all), so everything here is idempotent per run.
   *
   * The work the run served is no longer in progress whoever stopped it, so
   * its delegations retire. Only a stop the user did not ask for is
   * announced: a user abort or a cancel was acknowledged when it was asked
   * for, a budget stop was not.
   */
  private handleStopped(): void {
    if (this.ports.destroyed()) return;
    this.ports.router.retireRunDelegations();
    if (this.abortCause !== null) return;
    // The aggregate breach announces itself once for the whole session
    // (AggregateBudget); a run it stops needs no second notice.
    if (this.ports.aggregateBreached()) return;
    if (this.budgetBreached()) {
      this.deliverFailure(
        'The background work was stopped because it reached its spending limit for this ' +
        'request. It produced no result. Tell the user plainly; it will not continue on its own.',
      );
    }
  }

  /** Whether a spending guard over the reasoner has tripped. */
  private budgetBreached(): boolean {
    return this.ports.reasoner.getBudgetGuard().isBreached() || this.ports.aggregateBreached();
  }

  /**
   * Surface a reasoner failure to the user, as an interrupt delivery: the
   * producer beside Deliver, the implicit final text, and the watchdog that
   * speaks on the path where a run dies.
   *
   * Once per terminal failure. An exhausted ladder reaches here twice:
   * onRetryExhausted fires first, then emitError for the same failure, a few
   * statements later in the same synchronous unwind. The first wins because
   * its message is the better one ("gave up after N attempts").
   *
   * The guard is reset on `loop_start`, which is the correct unit ONLY
   * because nothing announces a failure mid-ladder: the run-end branch
   * defers a recorded stub to the error path, so the two calls above are
   * the only ones, and no run start falls between them. It is emphatically
   * not "once per logical turn" (pi emits agent_start per retry attempt, so
   * a turn spanning a ladder crosses several resets).
   */
  private deliverFailure(text: string): void {
    if (this.ports.destroyed()) return;
    if (this.failureAnnounced) return;
    this.failureAnnounced = true;
    // interrupt: a user waiting on work that is never coming is exactly the
    // case the class exists for. The router may still demote it under
    // backpressure, which is the intended tradeoff. `terminal` marks it as a
    // conclusion despite being synthetic, so the delegation it answers stops
    // being listed as live work.
    this.ports.router.deliverFromReasoner(text, 'interrupt', {
      synthetic: true,
      terminal: true,
    });
  }
}
