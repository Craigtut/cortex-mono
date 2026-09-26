/**
 * AgentLoop's public surface, delivering input (deliver, steer, follow-
 * ups, the loop-owned queues) and the permission asks the loop is blocked
 * on. AgentLoop implements this interface; the member docs here are
 * AgentLoop's documentation.
 */

import type { PendingAsk } from '../../types.js';
import type { DeliverOptions, DeliverResult } from '../delivery-queues.js';
import type { QueueDrainMode } from '../pi-agent.js';

export interface LoopDeliveryApi {
  /**
   * Inject a steering message into the running agentic loop.
   * Queues the message for pi-agent-core to inject after the current
   * assistant turn and any current tool batch finish.
   * Only effective while a prompt() call is in progress or queued.
   *
   * No-op if the agent is not currently prompting.
   *
   * @param message - The message content to inject
   */
  steer(message: string): void;

  /**
   * Deliver a message to this loop regardless of its run state. The delivery
   * primitive behind facade routing (docs/cortex/duplex/log-and-context.md):
   * a state machine over (loop-gate depth, pi run state, abort state) with
   * three actions:
   *
   * - `wake: false` (silent class), in EVERY run state: queue on the
   *   AgentLoop itself, flushed into the next real prompt's message batch.
   *   Never pi's steering queue: during a live run pi polls steering after
   *   every tool batch (including terminated ones) and continues the loop if
   *   anything is queued, and while idle a queued steer drains into whatever
   *   run starts next (including a background-completion delivery). Either
   *   way silent content would surface as an unprompted response.
   * - Wake wanted, gate held (a turn is running, queued, in retry backoff,
   *   or in the end-of-cycle drain window): park on the loop-owned wake
   *   queue and enqueue a sweep task behind every gate task present now.
   *   The content opens the NEXT run, not the one in flight: either as
   *   leading batch messages of a prompt that dequeues ahead of the sweep,
   *   or through the sweep's own run once the tasks ahead of it finish.
   *   Cortex owns wake parking end to end; the content never enters pi's
   *   steering queue (that queue belongs to the public steer() API alone,
   *   and it cannot be inspected or selectively drained, so reconciling a
   *   steered delivery after the fact either duplicated content a run had
   *   already drained or destroyed steer() content). The cost is a bounded
   *   one-run delay for a delivery that lands during a live run; the gain
   *   is that delivery is exact rather than probabilistic.
   * - Wake wanted, idle: start a turn with this content as the prompt; the
   *   returned `turn` promise settles with it.
   *
   * The branch decision and its action happen in one synchronous frame, so
   * there is no time-of-check race against prompt() (which throws whenever
   * the gate is held): nothing can acquire the gate between the depth check
   * and the action taken here.
   *
   * Queued silent deliveries are dropped on destroy(); a facade that needs
   * them durable should drain them into its own state before teardown (see
   * {@link clearQueuedDeliveries}). Parked wake deliveries share that
   * contract (see {@link clearAllQueues}) and are additionally dropped by
   * abort(): a parked delivery is cancelled like the turn it was waiting
   * behind, never delivered by a run that starts after the user stopped
   * the agent. That includes a delivery that parks while an abort is
   * completing (the parked queue is gated on an abort epoch, so neither a
   * mid-abort drain replacing the controller nor the skipped gate wait
   * lets it through to a post-abort run).
   *
   * @param content - Non-whitespace message content (user role)
   * @param options - Wake behavior; default wakes an idle loop
   */
  deliver(content: string, options?: DeliverOptions): DeliverResult;

  /**
   * Queue a follow-up message on pi's follow-up queue. Unlike steer(), which
   * lands at the next turn boundary inside the current run, a follow-up
   * drains only at a would-stop point: after the model has produced what
   * would otherwise be the run's final answer, the loop continues with the
   * queued message instead of stopping. Queued while idle, it drains at the
   * end of the next run.
   */
  followUp(message: string): void;

  /** Set how pi drains queued steering messages. */
  setSteeringQueueMode(mode: QueueDrainMode): void;

  /** Set how pi drains queued follow-up messages. */
  setFollowUpQueueMode(mode: QueueDrainMode): void;

  /**
   * Remove all queued steering messages from pi's steering queue (public
   * steer() content). Parked wake deliveries are loop-owned and are not
   * affected; drop those via {@link clearAllQueues}.
   */
  clearSteeringQueue(): void;

  /** Remove all queued follow-up messages from pi's follow-up queue. */
  clearFollowUpQueue(): void;

  /**
   * Remove every queued message: pi's steering and follow-up queues plus
   * this loop's silent delivery queue and parked wake deliveries. Returns
   * the dropped loop-owned content (silent first, then parked wake, each
   * in queue order) so a caller can re-route or persist it. A pending
   * sweep task finds nothing and no-ops.
   */
  clearAllQueues(): string[];

  /** Number of silent deliveries waiting for the next real prompt. */
  readonly queuedDeliveryCount: number;

  /** Number of parked wake deliveries waiting for the next run. */
  readonly pendingWakeDeliveryCount: number;

  /**
   * Drop all queued silent deliveries, returning their content in queue
   * order so the caller can re-route or persist them.
   */
  clearQueuedDeliveries(): string[];

  /**
   * Retract parked wake deliveries whose content matches `predicate`,
   * returning the dropped content in queue order. Silent deliveries and pi's
   * queues are untouched.
   *
   * The narrow form exists because the broad one destroys information. An
   * owner that needs to retract ONE class of parked content (a facade
   * dropping permission voicings whose ask has already been settled, so a
   * dead request is never read out) would otherwise have to call
   * {@link clearAllQueues} and re-deliver the survivors, which loses their
   * cause tags: a parked user utterance re-delivered without its tag can no
   * longer satisfy a permission ask, so retracting one delivery would
   * silently revoke the consent value of another.
   *
   * Nothing is dead-lettered here. The drop is the caller's deliberate
   * decision about content it produced, not a delivery failure, and the
   * caller is the one holding the context to record it.
   */
  dropPendingWakeDeliveries(predicate: (content: string) => boolean): string[];

  /**
   * Snapshot of permission asks currently blocked on a resolver decision,
   * for this loop and (mirrored) its spawned children, oldest first. Each
   * entry's askId matches the ToolPermissionRequestContext.askId the
   * resolver received, so a broker can correlate what it queries here with
   * the resolver call it is answering. Entries vanish when an ask settles,
   * however it settles (answered, blocked, or aborted).
   */
  getPendingAsks(): PendingAsk[];

  /**
   * Mark a pending ask as voiced (presented to the human). Consent binding
   * accepts an allow only for the most recently voiced ask, so a broker
   * calls this at the moment it actually surfaces the request. Returns
   * false for an unknown or already-settled askId.
   */
  markAskVoiced(askId: string): boolean;

  /**
   * Resolve once the pending-ask set next shrinks: an ask settled (however
   * it settled: answered, blocked, or aborted) or teardown cleared the
   * registry. Resolves immediately when no ask is pending. This is the
   * event-driven form settlement predicates wait on instead of polling
   * getPendingAsks(), which can otherwise spin for as long as an ask
   * outlives the work that raised it.
   */
  waitForAskSettlement(): Promise<void>;
}
