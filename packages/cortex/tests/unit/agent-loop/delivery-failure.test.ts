import { describe, it, expect, vi } from 'vitest';
import {
  boundedPolicyFor,
  DeadLetterStore,
  partitionExhausted,
} from '../../../src/agent-loop/delivery-failure.js';
import { DEFAULT_RETRY_POLICY } from '../../../src/retry-policy.js';

const limits = { maxAttempts: 3, maxElapsedMs: 1_000 };

describe('delivery budgets', () => {
  it('caps the run policy at what is left of the oldest item\'s budget', () => {
    const policy = boundedPolicyFor(
      DEFAULT_RETRY_POLICY,
      [{ firstDeliveryAttemptAt: 900 }, { firstDeliveryAttemptAt: 600 }, {}],
      limits,
      1_000,
    );
    expect(policy.maxElapsedMs).toBe(600);
    expect(boundedPolicyFor(DEFAULT_RETRY_POLICY, [{ firstDeliveryAttemptAt: 0 }], limits, 5_000).maxElapsedMs).toBe(0);
  });

  it('charges an attempt and splits on the attempt cap and the elapsed budget', () => {
    const fresh: { deliveryAttempts?: number; firstDeliveryAttemptAt?: number } = {};
    const capped = { deliveryAttempts: 2, firstDeliveryAttemptAt: 1_000 };
    const late = { deliveryAttempts: 0, firstDeliveryAttemptAt: 0 };
    const { retry, exhausted } = partitionExhausted([fresh, capped, late], limits, 1_000);
    expect(retry).toEqual([fresh]);
    expect(exhausted).toEqual([capped, late]);
    expect(fresh).toEqual({ deliveryAttempts: 1, firstDeliveryAttemptAt: 1_000 });
    expect(capped.deliveryAttempts).toBe(3);
  });

  it('does not charge an uncounted attempt, and fatal exhausts everything', () => {
    const item = { deliveryAttempts: 2, firstDeliveryAttemptAt: 1_000 };
    expect(partitionExhausted([item], limits, 1_000, { countAttempt: false }).retry).toEqual([item]);
    expect(item.deliveryAttempts).toBe(2);
    expect(partitionExhausted([{}], limits, 1_000, { fatal: true }).exhausted).toHaveLength(1);
  });
});

describe('DeadLetterStore', () => {
  it('keeps the newest entries within the cap and notifies handlers', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = new DeadLetterStore(logger, 2);
    const seen = vi.fn();
    store.handlers.add(seen);
    store.recordWake([{ content: 'a' }, { content: 'b', deliveryAttempts: 2 }, { content: 'c' }], 'boom');
    expect(store.list().map((entry) => entry.message)).toEqual(['b', 'c']);
    expect(store.list()[0]).toMatchObject({ kind: 'wake_delivery', taskId: 'wake-delivery', attempts: 2, lastError: 'boom' });
    expect(seen).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith('dead-letter cap reached; evicting oldest entries', expect.anything());
  });
});
