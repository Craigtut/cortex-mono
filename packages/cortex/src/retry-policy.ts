/**
 * Pure helpers for cortex's background retry loop.
 *
 * The loop itself lives in CortexAgent.prompt() (it drives agent.prompt /
 * agent.continue). Everything decidable without touching agent state lives
 * here so it can be unit-tested in isolation: default policy, policy merge,
 * the backoff schedule, and the retry gate.
 *
 * Reference: error-recovery.md
 */

import type { ClassifiedError, ErrorCategory, RetryPolicy } from './types.js';

/**
 * Built-in defaults: retry transient categories with a 2m -> 4m -> 8m backoff
 * capped at 10m, up to 20 times (~3h window) before giving up.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  retryableCategories: ['network', 'server_error', 'rate_limit'],
  backoffMs: [120_000, 240_000, 480_000],
  maxBackoffMs: 600_000,
  maxAttempts: 20,
};

/**
 * Merge a partial policy over the defaults. Undefined fields fall back to the
 * default; `retryableCategories` and `backoffMs` are replaced wholesale (not
 * concatenated) when provided.
 */
export function resolveRetryPolicy(partial?: Partial<RetryPolicy>): RetryPolicy {
  const merged: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    ...(partial ?? {}),
  };
  // Guard against nonsensical overrides that would make the loop misbehave.
  if (!Array.isArray(merged.retryableCategories)) {
    merged.retryableCategories = DEFAULT_RETRY_POLICY.retryableCategories;
  }
  if (!Array.isArray(merged.backoffMs) || merged.backoffMs.length === 0) {
    merged.backoffMs = DEFAULT_RETRY_POLICY.backoffMs;
  }
  if (!Number.isFinite(merged.maxBackoffMs) || merged.maxBackoffMs <= 0) {
    merged.maxBackoffMs = DEFAULT_RETRY_POLICY.maxBackoffMs;
  }
  if (!Number.isInteger(merged.maxAttempts) || merged.maxAttempts < 0) {
    merged.maxAttempts = DEFAULT_RETRY_POLICY.maxAttempts;
  }
  return merged;
}

/**
 * Backoff delay (ms) before the retry at `retryIndex` (0-based: 0 is the first
 * retry). Indices within the schedule use it directly; indices past the end
 * fall back to `maxBackoffMs`. Every value is clamped to `maxBackoffMs` so a
 * long schedule entry can never exceed the cap.
 */
export function backoffForAttempt(policy: RetryPolicy, retryIndex: number): number {
  const scheduled = policy.backoffMs[retryIndex] ?? policy.maxBackoffMs;
  return Math.min(policy.maxBackoffMs, Math.max(0, scheduled));
}

/** Context for a retry decision, captured at the moment of failure. */
export interface RetryDecisionContext {
  /** Retries already scheduled so far (0-based index of the NEXT retry). */
  retryIndex: number;
  /** Elapsed ms since the first failure of this turn. */
  elapsedMs: number;
  /** Whether the turn was aborted (user/system cancellation). */
  aborted: boolean;
}

/**
 * Decide whether a failed turn should be retried in the background.
 *
 * Retries only transient categories, never when aborted, fatal, out of
 * attempts, or past the elapsed ceiling. A 404 (classified `unknown`) and
 * auth failures are deliberately excluded so they surface to the user.
 */
export function shouldRetry(
  error: ClassifiedError,
  ctx: RetryDecisionContext,
  policy: RetryPolicy,
): boolean {
  if (!policy.enabled) return false;
  if (ctx.aborted) return false;
  if (error.severity === 'fatal') return false;
  if (!isRetryableCategory(error.category, policy)) return false;
  if (ctx.retryIndex >= policy.maxAttempts) return false;
  if (policy.maxElapsedMs !== undefined && ctx.elapsedMs >= policy.maxElapsedMs) {
    return false;
  }
  return true;
}

/** Whether a category is in the policy's retryable set. */
export function isRetryableCategory(
  category: ErrorCategory,
  policy: RetryPolicy,
): boolean {
  return policy.retryableCategories.includes(category);
}
