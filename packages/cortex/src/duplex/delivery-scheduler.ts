/**
 * DeliveryScheduler: when talker-waking content actually reaches the talker
 * (communication.md wake policy; decisions.md D10, D19).
 *
 * Wake classes describe intent, not rate. The scheduler bounds rate with an
 * interrupt token bucket and content-hash dedup over recent deliveries, and
 * paces what it admits: interrupts ahead of held when_idle content, a
 * facade-enforced minimum spacing between talker-waking deliveries that an
 * always-idle or never-idle consumer signal cannot collapse, when_idle
 * content waiting for a lull, and degradation to interrupt when the lull
 * never comes. It is the sole owner of the spacing clock; the reserved ask
 * lane stamps it through {@link stampReservedLane} instead of keeping a
 * second one.
 */

import type { CortexLogger } from '../types.js';
import type { WakeClass } from '../session-log.js';
import { errorMessageOf } from '../error-classifier.js';

export interface DeliverySchedulerPorts {
  /** Hand one admitted delivery to the talker as a waking delivery. */
  deliver(content: string): void;
  /** Whether the conversation surface is idle (the default lull signal). */
  talkerIdle(): boolean;
  /**
   * The consumer's advisory idle signal, read at every check so a consumer
   * (or a test) can swap it mid-session. Overrides talkerIdle when set.
   */
  readonly idleSignal?: (() => boolean) | undefined;
}

export interface DeliverySchedulerOptions {
  minDeliverySpacingMs: number;
  whenIdleDegradeMs: number;
  idlePollMs: number;
  interruptBucketCapacity: number;
  interruptRefillMs: number;
  deliveryDedupWindowMs: number;
  deliveryDedupMaxEntries: number;
  now: () => number;
  logger: CortexLogger;
}

/** What {@link DeliveryScheduler.admit} decided for one delivery. */
export type DeliveryAdmission =
  | { duplicate: true }
  | { duplicate: false; wake: WakeClass; demoted: boolean };

interface PendingDelivery {
  /** Raw delivered content (the port wraps it for the talker). */
  content: string;
  enqueuedAt: number;
}

/** FNV-1a 32-bit; cheap content identity for dedup, not security. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class DeliveryScheduler {
  private readonly ports: DeliverySchedulerPorts;
  private readonly options: DeliverySchedulerOptions;
  private readonly now: () => number;
  private readonly logger: CortexLogger;

  private interruptTokens: number;
  private lastTokenRefillAt: number;
  private recentDeliveryHashes: Array<{ hash: number; at: number }> = [];
  private lastDeliveryAt = 0;

  // Interrupts ahead of held when_idle content.
  private interruptQueue: PendingDelivery[] = [];
  private whenIdleQueue: PendingDelivery[] = [];
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private pumpTimerAt = 0;
  private settleWaiters: Array<() => void> = [];
  private destroyed = false;

  constructor(ports: DeliverySchedulerPorts, options: DeliverySchedulerOptions) {
    this.ports = ports;
    this.options = options;
    this.now = options.now;
    this.logger = options.logger;
    this.interruptTokens = options.interruptBucketCapacity;
    this.lastTokenRefillAt = this.now();
  }

  /**
   * Admit one reasoner delivery. `identity` is its dedup identity: content
   * repeated within the dedup window is absorbed, so a reasoner (or its
   * retry ladder) emitting the same content repeatedly costs one delivery.
   * A proposed interrupt draws from the token bucket and demotes to
   * when_idle when it is empty (producer proposes, scheduler disposes).
   */
  admit(identity: string, proposed: WakeClass): DeliveryAdmission {
    const now = this.now();
    this.pruneRecentHashes(now);
    const hash = fnv1a(identity);
    if (this.recentDeliveryHashes.some((entry) => entry.hash === hash)) {
      this.logger.info('duplicate delivery absorbed', { hash });
      return { duplicate: true };
    }
    this.recentDeliveryHashes.push({ hash, at: now });
    if (this.recentDeliveryHashes.length > this.options.deliveryDedupMaxEntries) {
      this.recentDeliveryHashes.shift();
    }
    if (proposed === 'interrupt' && !this.drawInterrupt()) {
      return { duplicate: false, wake: 'when_idle', demoted: true };
    }
    return { duplicate: false, wake: proposed, demoted: false };
  }

  /** Take one interrupt token; false when the bucket is empty. */
  drawInterrupt(): boolean {
    this.refillInterruptTokens(this.now());
    if (this.interruptTokens <= 0) return false;
    this.interruptTokens -= 1;
    return true;
  }

  /** Queue a talker-waking delivery and let the pump decide when it lands. */
  enqueue(content: string, wake: 'interrupt' | 'when_idle'): void {
    const pending: PendingDelivery = { content, enqueuedAt: this.now() };
    if (wake === 'interrupt') {
      this.interruptQueue.push(pending);
    } else {
      this.whenIdleQueue.push(pending);
    }
    this.pump();
  }

  /**
   * Content just went to the talker through the reserved ask lane, which
   * bypasses the bucket, dedup and queues: queued deliveries hold off for
   * one spacing window behind it instead of talking over it.
   */
  stampReservedLane(): void {
    this.lastDeliveryAt = this.now();
  }

  /** Talker-waking deliveries not yet handed to the talker. */
  get pendingCount(): number {
    return this.interruptQueue.length + this.whenIdleQueue.length;
  }

  /** The held deliveries' content, interrupts first (the persisted artifact). */
  pendingContents(): string[] {
    return [...this.interruptQueue, ...this.whenIdleQueue].map((item) => item.content);
  }

  /** Resolves once no talker-waking delivery is held. */
  waitSettled(): Promise<void> {
    if (this.pendingCount === 0) return Promise.resolve();
    return new Promise((resolve) => this.settleWaiters.push(resolve));
  }

  /** Drop held deliveries; returns how many went. */
  dropPending(): number {
    const dropped = this.pendingCount;
    this.interruptQueue = [];
    this.whenIdleQueue = [];
    this.notifySettled();
    return dropped;
  }

  /** Everything back to a fresh session (facade restore()). */
  reset(): void {
    this.dropPending();
    this.recentDeliveryHashes = [];
    this.lastDeliveryAt = 0;
    this.interruptTokens = this.options.interruptBucketCapacity;
    this.lastTokenRefillAt = this.now();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.pumpTimer !== null) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    this.interruptQueue = [];
    this.whenIdleQueue = [];
    this.notifySettled();
  }

  private pump(): void {
    if (this.destroyed) return;
    for (;;) {
      if (this.interruptQueue.length === 0 && this.whenIdleQueue.length === 0) {
        this.notifySettled();
        return;
      }
      const now = this.now();
      // Minimum inter-delivery spacing holds regardless of wake class or
      // idle signal (the anti-collapse rule in communication.md).
      const spacingReadyAt = this.lastDeliveryAt + this.options.minDeliverySpacingMs;
      if (this.lastDeliveryAt > 0 && now < spacingReadyAt) {
        // Re-checked at the poll cadence rather than in one long sleep, so
        // the wait stays responsive to queue drops and clock control.
        this.scheduleAt(Math.min(spacingReadyAt, now + this.options.idlePollMs));
        return;
      }
      if (this.interruptQueue.length > 0) {
        this.deliverNow(this.interruptQueue.shift()!);
        continue;
      }
      const head = this.whenIdleQueue[0]!;
      const degradeAt = head.enqueuedAt + this.options.whenIdleDegradeMs;
      if (this.channelIdle()) {
        this.whenIdleQueue.shift();
        this.deliverNow(head);
        continue;
      }
      if (now >= degradeAt) {
        // The lull never came (no signal, or a signal that never reports
        // idle): the delivery interrupts rather than starving.
        this.logger.info('when_idle delivery degraded to interrupt after delay', {
          heldMs: now - head.enqueuedAt,
        });
        this.whenIdleQueue.shift();
        this.deliverNow(head);
        continue;
      }
      this.scheduleAt(Math.min(now + this.options.idlePollMs, degradeAt));
      return;
    }
  }

  private deliverNow(item: PendingDelivery): void {
    this.lastDeliveryAt = this.now();
    try {
      this.ports.deliver(item.content);
    } catch (err) {
      // The content stays in the log (the durable record); the talker-side
      // failure is loop-owned territory (its deliver() never throws while
      // healthy, so this is teardown or a bug).
      this.logger.error('delivery to talker failed', {
        error: errorMessageOf(err),
      });
    }
  }

  private channelIdle(): boolean {
    const signal = this.ports.idleSignal;
    if (signal) {
      try {
        return signal() === true;
      } catch (err) {
        this.logger.warn('idle signal threw; treating as not idle', {
          error: errorMessageOf(err),
        });
        return false;
      }
    }
    return this.ports.talkerIdle();
  }

  private scheduleAt(at: number): void {
    if (this.destroyed) return;
    if (this.pumpTimer !== null) {
      if (at >= this.pumpTimerAt) return;
      clearTimeout(this.pumpTimer);
    }
    this.pumpTimerAt = at;
    const timer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, Math.max(0, at - this.now()));
    timer.unref?.();
    this.pumpTimer = timer;
  }

  private notifySettled(): void {
    if (this.settleWaiters.length === 0) return;
    const waiters = this.settleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private refillInterruptTokens(now: number): void {
    const capacity = this.options.interruptBucketCapacity;
    if (this.interruptTokens >= capacity) {
      this.lastTokenRefillAt = now;
      return;
    }
    const earned = Math.floor((now - this.lastTokenRefillAt) / this.options.interruptRefillMs);
    if (earned > 0) {
      this.interruptTokens = Math.min(capacity, this.interruptTokens + earned);
      this.lastTokenRefillAt += earned * this.options.interruptRefillMs;
    }
  }

  private pruneRecentHashes(now: number): void {
    const cutoff = now - this.options.deliveryDedupWindowMs;
    this.recentDeliveryHashes = this.recentDeliveryHashes.filter((entry) => entry.at >= cutoff);
  }
}
