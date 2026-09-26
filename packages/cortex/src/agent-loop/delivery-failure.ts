/**
 * The redelivery budgets for parked wake deliveries and background
 * completions, and the dead-letter store for what the loop gives up on.
 * See "Background delivery budgets and dead letters" in
 * docs/cortex/cortex-architecture.md.
 *
 * Each delivery attempt runs an in-run retry ladder, so an attempt cap
 * alone would let re-attempts re-enter the full ladder (~3h by default)
 * back-to-back while holding the gate through an outage. The elapsed
 * budget also caps each attempt's ladder (boundedPolicyFor). Nothing given
 * up on is dropped silently: it is dead-lettered and handlers fire.
 */

import { withElapsedCeiling } from '../retry-policy.js';
import type { CortexLogger, DeadLetteredBackgroundResult, RetryPolicy } from '../types.js';
import { HandlerList } from './handler-list.js';

export interface DeliveryLimits {
  /** Failed delivery runs before the content is given up on. */
  maxAttempts: number;
  /** Total time across failed runs (in-run retry backoff included). */
  maxElapsedMs: number;
}

/** Parked wake deliveries: dropped (dead-lettered) after these. */
export const WAKE_DELIVERY_LIMITS: DeliveryLimits = {
  maxAttempts: 3,
  maxElapsedMs: 4 * 60 * 60 * 1000,
};

/** Background completions: dead-lettered after these. */
export const BACKGROUND_DELIVERY_LIMITS: DeliveryLimits = {
  maxAttempts: 3,
  maxElapsedMs: 4 * 60 * 60 * 1000,
};

/** Delivery bookkeeping both queues stamp on their items. */
export interface DeliveryAttempts {
  /** Failed delivery runs so far. */
  deliveryAttempts?: number;
  /** When the first delivery run for this item started. */
  firstDeliveryAttemptAt?: number;
}

/**
 * The retry policy for one delivery run: `base` with its elapsed ceiling
 * lowered to what remains of the oldest item's delivery budget.
 */
export function boundedPolicyFor(
  base: RetryPolicy,
  items: readonly DeliveryAttempts[],
  limits: DeliveryLimits,
  now: number,
): RetryPolicy {
  const oldestFirstAttemptAt = items.reduce(
    (oldest, item) => Math.min(oldest, item.firstDeliveryAttemptAt ?? oldest),
    now,
  );
  return withElapsedCeiling(base, Math.max(0, limits.maxElapsedMs - (now - oldestFirstAttemptAt)));
}

/**
 * After a failed delivery run, charge each item the attempt (unless
 * `countAttempt` is false) and split off the exhausted ones. `fatal`
 * exhausts everything.
 */
export function partitionExhausted<T extends DeliveryAttempts>(
  items: readonly T[],
  limits: DeliveryLimits,
  now: number,
  options?: { countAttempt?: boolean; fatal?: boolean },
): { retry: T[]; exhausted: T[] } {
  const countAttempt = options?.countAttempt ?? true;
  const retry: T[] = [];
  const exhausted: T[] = [];
  for (const item of items) {
    item.deliveryAttempts = (item.deliveryAttempts ?? 0) + (countAttempt ? 1 : 0);
    item.firstDeliveryAttemptAt ??= now;
    const spent =
      options?.fatal === true ||
      item.deliveryAttempts >= limits.maxAttempts ||
      now - item.firstDeliveryAttemptAt >= limits.maxElapsedMs;
    (spent ? exhausted : retry).push(item);
  }
  return { retry, exhausted };
}

/** Dead-lettered completions retained for consumer inspection. */
const DEFAULT_DEAD_LETTER_CAP = 50;

/** Synthetic taskIds for dead-lettered loop-owned deliveries, which have no task. */
const WAKE_DELIVERY_DEAD_LETTER_ID = 'wake-delivery';
const SILENT_DELIVERY_DEAD_LETTER_ID = 'silent-delivery';

/**
 * The bounded record of content the loop gave up on. Not cleared on
 * destroy: it is the consumer's post-mortem record, and teardown itself
 * dead-letters anything pending.
 */
export class DeadLetterStore {
  readonly handlers: HandlerList<[result: DeadLetteredBackgroundResult]>;
  private readonly entries: DeadLetteredBackgroundResult[] = [];

  constructor(
    private readonly logger: CortexLogger,
    private readonly cap = DEFAULT_DEAD_LETTER_CAP,
  ) {
    this.handlers = new HandlerList('onBackgroundResultDeadLettered', logger);
  }

  /** Append to the bounded store and notify handlers. */
  record(entry: DeadLetteredBackgroundResult): void {
    this.entries.push(entry);
    const excess = this.entries.length - this.cap;
    if (excess > 0) {
      // An evicted entry is completed work vanishing for good.
      const evicted = this.entries.splice(0, excess);
      this.logger.warn('dead-letter cap reached; evicting oldest entries', {
        cap: this.cap,
        evicted: evicted.map((e) => ({ kind: e.kind, taskId: e.taskId })),
      });
    }
    this.handlers.emit(entry);
  }

  /** One entry per dropped wake delivery, so a reply-less utterance has an explanation. */
  recordWake(dropped: ReadonlyArray<{ content: string } & DeliveryAttempts>, lastError: string): void {
    for (const item of dropped) {
      this.record({
        kind: 'wake_delivery',
        taskId: WAKE_DELIVERY_DEAD_LETTER_ID,
        attempts: item.deliveryAttempts ?? 0,
        lastError,
        deadLetteredAt: Date.now(),
        message: item.content,
      });
    }
  }

  /** One entry per silent delivery a teardown dropped before any prompt took it. */
  recordSilent(dropped: ReadonlyArray<{ content: string }>, lastError: string): void {
    for (const item of dropped) {
      this.record({
        kind: 'silent_delivery',
        taskId: SILENT_DELIVERY_DEAD_LETTER_ID,
        attempts: 0,
        lastError,
        deadLetteredAt: Date.now(),
        message: item.content,
      });
    }
  }

  /** Newest last. */
  list(): DeadLetteredBackgroundResult[] {
    return [...this.entries];
  }
}
