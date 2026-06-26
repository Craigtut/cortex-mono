import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  resolveRetryPolicy,
  backoffForAttempt,
  shouldRetry,
  isRetryableCategory,
} from '../../src/retry-policy.js';
import type { ClassifiedError } from '../../src/types.js';

function err(
  category: ClassifiedError['category'],
  severity: ClassifiedError['severity'],
): ClassifiedError {
  return { category, severity, originalMessage: 'x' };
}

describe('resolveRetryPolicy', () => {
  it('returns the defaults when given nothing', () => {
    expect(resolveRetryPolicy()).toEqual(DEFAULT_RETRY_POLICY);
  });

  it('merges a partial override over the defaults', () => {
    const p = resolveRetryPolicy({ maxAttempts: 30 });
    expect(p.maxAttempts).toBe(30);
    expect(p.backoffMs).toEqual(DEFAULT_RETRY_POLICY.backoffMs);
    expect(p.enabled).toBe(true);
  });

  it('replaces retryableCategories wholesale', () => {
    const p = resolveRetryPolicy({ retryableCategories: ['network'] });
    expect(p.retryableCategories).toEqual(['network']);
  });

  it('repairs nonsensical overrides', () => {
    const p = resolveRetryPolicy({
      backoffMs: [] as number[],
      maxBackoffMs: -5,
      maxAttempts: -1,
      retryableCategories: undefined as unknown as ClassifiedError['category'][],
    });
    expect(p.backoffMs).toEqual(DEFAULT_RETRY_POLICY.backoffMs);
    expect(p.maxBackoffMs).toBe(DEFAULT_RETRY_POLICY.maxBackoffMs);
    expect(p.maxAttempts).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
    expect(p.retryableCategories).toEqual(DEFAULT_RETRY_POLICY.retryableCategories);
  });

  it('allows disabling and a zero attempt count', () => {
    const p = resolveRetryPolicy({ enabled: false, maxAttempts: 0 });
    expect(p.enabled).toBe(false);
    expect(p.maxAttempts).toBe(0);
  });
});

describe('backoffForAttempt', () => {
  const policy = DEFAULT_RETRY_POLICY;

  it('follows the schedule then caps at maxBackoffMs', () => {
    expect(backoffForAttempt(policy, 0)).toBe(120_000); // 2m
    expect(backoffForAttempt(policy, 1)).toBe(240_000); // 4m
    expect(backoffForAttempt(policy, 2)).toBe(480_000); // 8m
    expect(backoffForAttempt(policy, 3)).toBe(600_000); // cap 10m
    expect(backoffForAttempt(policy, 50)).toBe(600_000);
  });

  it('clamps a schedule entry above the cap', () => {
    const p = resolveRetryPolicy({ backoffMs: [5_000_000], maxBackoffMs: 600_000 });
    expect(backoffForAttempt(p, 0)).toBe(600_000);
  });
});

describe('shouldRetry', () => {
  const policy = DEFAULT_RETRY_POLICY;
  const ctx = { retryIndex: 0, elapsedMs: 0, aborted: false };

  it('retries transient categories', () => {
    expect(shouldRetry(err('network', 'retry'), ctx, policy)).toBe(true);
    expect(shouldRetry(err('server_error', 'retry'), ctx, policy)).toBe(true);
    expect(shouldRetry(err('rate_limit', 'retry'), ctx, policy)).toBe(true);
  });

  it('does not retry fatal, human-actionable, or unknown failures', () => {
    expect(shouldRetry(err('authentication', 'fatal'), ctx, policy)).toBe(false);
    expect(shouldRetry(err('context_overflow', 'recoverable'), ctx, policy)).toBe(false);
    // A 404 / bad endpoint classifies as unknown -> must surface, not spin.
    expect(shouldRetry(err('unknown', 'recoverable'), ctx, policy)).toBe(false);
  });

  it('never retries when aborted', () => {
    expect(shouldRetry(err('network', 'retry'), { ...ctx, aborted: true }, policy)).toBe(false);
  });

  it('never retries when disabled', () => {
    const disabled = resolveRetryPolicy({ enabled: false });
    expect(shouldRetry(err('network', 'retry'), ctx, disabled)).toBe(false);
  });

  it('stops once attempts are exhausted', () => {
    expect(shouldRetry(err('network', 'retry'), { ...ctx, retryIndex: 19 }, policy)).toBe(true);
    expect(shouldRetry(err('network', 'retry'), { ...ctx, retryIndex: 20 }, policy)).toBe(false);
  });

  it('stops once the elapsed ceiling is passed', () => {
    const capped = resolveRetryPolicy({ maxElapsedMs: 10_000 });
    expect(shouldRetry(err('network', 'retry'), { ...ctx, elapsedMs: 9_999 }, capped)).toBe(true);
    expect(shouldRetry(err('network', 'retry'), { ...ctx, elapsedMs: 10_000 }, capped)).toBe(false);
  });
});

describe('isRetryableCategory', () => {
  it('reflects the policy set', () => {
    expect(isRetryableCategory('network', DEFAULT_RETRY_POLICY)).toBe(true);
    expect(isRetryableCategory('authentication', DEFAULT_RETRY_POLICY)).toBe(false);
  });
});
