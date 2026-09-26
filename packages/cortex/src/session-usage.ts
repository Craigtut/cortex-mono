/**
 * SessionUsage arithmetic.
 *
 * A loop accumulates its session-lifetime usage with the mutating
 * accumulators; the facade composes loops' usage (baseline plus live delta
 * across a restore) with the pure operations, which never alias their
 * inputs.
 */

import type { CortexUsage, SessionUsage, UtilityUsageBucket } from './types.js';

export function zeroSessionUsage(): SessionUsage {
  return {
    totalCost: 0,
    totalTurns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function zeroBucket(): UtilityUsageBucket {
  return { calls: 0, cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

export function isZeroSessionUsage(usage: SessionUsage): boolean {
  return (
    usage.totalCost === 0 &&
    usage.totalTurns === 0 &&
    usage.tokens.input === 0 &&
    usage.tokens.output === 0 &&
    usage.tokens.cacheRead === 0 &&
    usage.tokens.cacheWrite === 0 &&
    (usage.utility === undefined || Object.keys(usage.utility).length === 0)
  );
}

/** Deep copy, including the per-category utility buckets. */
export function cloneSessionUsage(usage: SessionUsage): SessionUsage {
  const copy: SessionUsage = {
    totalCost: usage.totalCost,
    totalTurns: usage.totalTurns,
    tokens: { ...usage.tokens },
  };
  if (usage.utility) {
    copy.utility = Object.fromEntries(
      Object.entries(usage.utility).map(([category, bucket]) => [
        category,
        { ...bucket, tokens: { ...bucket.tokens } },
      ]),
    );
  }
  return copy;
}

/** a + b, per counter and per utility category. */
export function addSessionUsage(a: SessionUsage, b: SessionUsage): SessionUsage {
  const sum = cloneSessionUsage(a);
  sum.totalCost += b.totalCost;
  sum.totalTurns += b.totalTurns;
  sum.tokens.input += b.tokens.input;
  sum.tokens.output += b.tokens.output;
  sum.tokens.cacheRead += b.tokens.cacheRead;
  sum.tokens.cacheWrite += b.tokens.cacheWrite;
  if (b.utility) {
    sum.utility ??= {};
    for (const [category, bucket] of Object.entries(b.utility)) {
      const target: UtilityUsageBucket = sum.utility[category] ?? zeroBucket();
      sum.utility[category] = {
        calls: target.calls + bucket.calls,
        cost: target.cost + bucket.cost,
        tokens: {
          input: target.tokens.input + bucket.tokens.input,
          output: target.tokens.output + bucket.tokens.output,
          cacheRead: target.tokens.cacheRead + bucket.tokens.cacheRead,
          cacheWrite: target.tokens.cacheWrite + bucket.tokens.cacheWrite,
        },
      };
    }
  }
  return sum;
}

/**
 * live minus baseline, per counter. Both reads come from the same loop's
 * monotonically growing counters (baseline taken at restore time), so
 * every difference is non-negative by construction.
 */
export function diffSessionUsage(live: SessionUsage, baseline: SessionUsage): SessionUsage {
  const delta: SessionUsage = {
    totalCost: live.totalCost - baseline.totalCost,
    totalTurns: live.totalTurns - baseline.totalTurns,
    tokens: {
      input: live.tokens.input - baseline.tokens.input,
      output: live.tokens.output - baseline.tokens.output,
      cacheRead: live.tokens.cacheRead - baseline.tokens.cacheRead,
      cacheWrite: live.tokens.cacheWrite - baseline.tokens.cacheWrite,
    },
  };
  if (live.utility) {
    delta.utility = {};
    for (const [category, bucket] of Object.entries(live.utility)) {
      const base = baseline.utility?.[category];
      delta.utility[category] = {
        calls: bucket.calls - (base?.calls ?? 0),
        cost: bucket.cost - (base?.cost ?? 0),
        tokens: {
          input: bucket.tokens.input - (base?.tokens.input ?? 0),
          output: bucket.tokens.output - (base?.tokens.output ?? 0),
          cacheRead: bucket.tokens.cacheRead - (base?.tokens.cacheRead ?? 0),
          cacheWrite: bucket.tokens.cacheWrite - (base?.tokens.cacheWrite ?? 0),
        },
      };
    }
  }
  return delta;
}

function addTokens(target: SessionUsage['tokens'], usage: CortexUsage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
}

/** Add one agentic turn's usage to `target` in place. */
export function accumulateTurn(target: SessionUsage, usage: CortexUsage): void {
  target.totalCost += usage.cost.total;
  target.totalTurns += 1;
  addTokens(target.tokens, usage);
}

/**
 * Add one utility call's usage to `target` in place: the session totals
 * (not the turn count) and the category's bucket.
 */
export function accumulateUtility(target: SessionUsage, category: string, usage: CortexUsage): void {
  target.totalCost += usage.cost.total;
  addTokens(target.tokens, usage);
  target.utility ??= {};
  const bucket = (target.utility[category] ??= zeroBucket());
  bucket.calls += 1;
  bucket.cost += usage.cost.total;
  addTokens(bucket.tokens, usage);
}
