/**
 * AgentLoop's public surface, delivering input (deliver, steer, follow-
 * ups, the loop-owned queues) and the permission asks the loop is blocked
 * on. AgentLoop implements this interface; the member docs here are
 * AgentLoop's documentation.
 */

import type { PendingAsk } from '../../types.js';
import type { DirectCompletionOptions } from '../direct-completion.js';
import type { QueueDrainMode } from '../pi-agent.js';

/** Options for {@link AgentLoop.deliver}. */
export interface DeliverOptions {
  /**
   * Whether the delivery may wake an idle loop by starting a turn. Default
   * true. When false, the content is queued on the AgentLoop and flushed
   * into the next real prompt's message batch; it never starts a run.
   */
  wake?: boolean;
  /**
   * Options for the turn this delivery starts on an idle loop ('prompted'
   * only). Parked and queued content rides a later run whose options belong
   * to that run's initiator, so these are ignored there.
   */
  promptOptions?: DirectCompletionOptions;
  /**
   * Opaque causation tag that travels with the content: exposed through
   * {@link AgentLoop.activeRunCauseTags} for exactly the run that consumes
   * this delivery (the turn it starts, the prompt batch it rides, or the
   * sweep run). Bound to the content, so a parked delivery keeps its
   * causation and a later run never inherits a previous run's tag. Wake
   * deliveries only.
   */
  causeTag?: unknown;
  /**
   * Let a run already in flight take this wake delivery at its next turn
   * boundary instead of waiting for the next run. For content that
   * redirects the live run's work (a steer, a stop).
   *
   * The content is handed over only at the turn_end of a live, non-failed
   * turn while pi's queues are empty. Otherwise (no live run, backoff,
   * digestion, a failed turn, steer() content queued, an ordinary delivery
   * parked ahead) it stays parked for the next run. Wake deliveries only.
   */
  atTurnBoundary?: boolean;
  /**
   * The handle this delivery is known by (DeliverResult.deliveryId, and the
   * `id` a dead-letter entry or a dropPendingWakeDeliveries predicate sees).
   * Supply one to correlate before the call returns; otherwise the loop
   * mints a unique one. Uniqueness of a supplied id is the caller's.
   */
  deliveryId?: string;
}

/** Which branch of the deliver() state machine handled a delivery. */
export type DeliverOutcome = 'prompted' | 'parked' | 'queued';

/** Result of {@link AgentLoop.deliver}. */
export interface DeliverResult {
  outcome: DeliverOutcome;
  /**
   * Present only for 'prompted': the promise prompt() would return. A
   * 'parked' delivery opens the next run (a queued prompt's batch or the
   * sweep run), whose failures surface through onError. A 'queued' delivery
   * has no turn until the next real prompt flushes it.
   */
  turn?: Promise<unknown>;
  /**
   * The delivery's stable handle (see DeliverOptions.deliveryId): a
   * dead-letter entry for this content, and the parked delivery a
   * dropPendingWakeDeliveries predicate is shown, carry the same id, so a
   * producer recognizes its own content by identity rather than by text.
   * Always set by AgentLoop.deliver; absent only where a facade absorbed the
   * content without handing it to a loop.
   */
  deliveryId?: string;
}

/** A parked wake delivery, as dropPendingWakeDeliveries shows it. */
export interface PendingWakeDelivery {
  readonly id: string;
  readonly content: string;
  /** Its DeliverOptions.causeTag, when it has one. */
  readonly causeTag?: unknown;
}


export interface LoopDeliveryApi {
  /**
   * Inject a steering message into the running agentic loop, after the
   * current assistant turn and any current tool batch finish. Only effective
   * while a prompt() call is in progress or queued; a no-op otherwise.
   *
   * @param message - The message content to inject
   */
  steer(message: string): void;

  /**
   * Deliver a message to this loop regardless of its run state. Three
   * outcomes (design: "Delivery and Steering" in
   * docs/cortex/cortex-architecture.md):
   *
   * - `wake: false` (silent), in every run state: queued on the AgentLoop
   *   and flushed into the next real prompt's message batch. It never
   *   starts a run or surfaces as an unprompted response.
   * - Wake wanted, gate held (a turn running, queued, in retry backoff, or
   *   in the drain window): parked. The content opens the next run, not the
   *   one in flight, either in the batch of a prompt queued ahead or through
   *   a sweep run of its own. It never enters pi's steering queue, so
   *   delivery is exact: nothing duplicated, nothing destroyed.
   * - Wake wanted, idle: a turn starts with this content as the prompt; the
   *   returned `turn` promise settles with it.
   *
   * The decision and its action happen in one synchronous frame, so there
   * is no time-of-check race against prompt().
   *
   * Silent and parked content still held at destroy() is dead-lettered
   * (kinds 'silent_delivery' and 'wake_delivery'); a facade that needs it
   * delivered elsewhere drains it first ({@link clearQueuedDeliveries},
   * {@link clearAllQueues}). abort() also cancels parked content, including
   * content that parks while the abort is completing, so it never rides a
   * run that starts after the user stopped the agent.
   *
   * @param content - Non-whitespace message content (user role)
   * @param options - Wake behavior; default wakes an idle loop
   */
  deliver(content: string, options?: DeliverOptions): DeliverResult & { readonly deliveryId: string };

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
   * The queued silent deliveries' content in queue order, without removing
   * it: what a persistence snapshot records so a restore can queue it again.
   */
  getQueuedDeliveries(): string[];

  /**
   * Retract parked wake deliveries `predicate` matches, returning the
   * dropped content in queue order. The predicate sees each delivery's
   * content and its handle ({@link PendingWakeDelivery}: id and cause tag),
   * so a producer can match its own deliveries by the id deliver()
   * returned. Silent deliveries and pi's queues are untouched.
   *
   * Use this instead of {@link clearAllQueues} plus re-delivery to retract
   * one class of parked content (say, voicings of an already-settled ask):
   * re-delivered survivors lose their cause tags, and a user utterance
   * without its tag can no longer satisfy a permission ask.
   *
   * Nothing is dead-lettered: the drop is the caller's deliberate decision,
   * not a delivery failure.
   */
  dropPendingWakeDeliveries(
    predicate: (content: string, delivery: PendingWakeDelivery) => boolean,
  ): string[];

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
   * Resolve once the pending-ask set next shrinks: an ask settled
   * (answered, blocked, or aborted) or teardown cleared the registry.
   * Resolves immediately when no ask is pending. Wait on this instead of
   * polling getPendingAsks().
   */
  waitForAskSettlement(): Promise<void>;
}
