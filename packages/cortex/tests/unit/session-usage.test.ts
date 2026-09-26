import { describe, it, expect } from 'vitest';
import {
  accumulateTurn,
  accumulateUtility,
  addSessionUsage,
  cloneSessionUsage,
  diffSessionUsage,
  isZeroSessionUsage,
  zeroSessionUsage,
} from '../../src/session-usage.js';
import type { CortexUsage, SessionUsage } from '../../src/types.js';

function usage(input: number, output: number, total: number): CortexUsage {
  return {
    input,
    output,
    cacheRead: 1,
    cacheWrite: 2,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

function sample(): SessionUsage {
  return {
    totalCost: 1,
    totalTurns: 2,
    tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4 },
    utility: { observer: { calls: 1, cost: 0.5, tokens: { input: 5, output: 6, cacheRead: 0, cacheWrite: 0 } } },
  };
}

describe('session-usage', () => {
  it('zero is zero, and a utility bucket makes it non-zero', () => {
    expect(isZeroSessionUsage(zeroSessionUsage())).toBe(true);
    const withBucket = zeroSessionUsage();
    accumulateUtility(withBucket, 'observer', usage(0, 0, 0));
    expect(isZeroSessionUsage(withBucket)).toBe(false);
  });

  it('clone does not alias tokens or utility buckets', () => {
    const original = sample();
    const copy = cloneSessionUsage(original);
    copy.tokens.input = 99;
    copy.utility!['observer']!.tokens.input = 99;
    expect(original.tokens.input).toBe(10);
    expect(original.utility!['observer']!.tokens.input).toBe(5);
  });

  it('add sums counters and merges utility categories without mutating inputs', () => {
    const a = sample();
    const b: SessionUsage = {
      ...sample(),
      utility: { reflector: { calls: 2, cost: 1, tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } },
    };
    const sum = addSessionUsage(a, b);
    expect(sum.totalCost).toBe(2);
    expect(sum.totalTurns).toBe(4);
    expect(sum.tokens).toEqual({ input: 20, output: 40, cacheRead: 6, cacheWrite: 8 });
    expect(Object.keys(sum.utility!)).toEqual(['observer', 'reflector']);
    expect(a.utility!['reflector']).toBeUndefined();
  });

  it('diff inverts add', () => {
    const baseline = sample();
    const live = addSessionUsage(baseline, sample());
    expect(diffSessionUsage(live, baseline)).toEqual(sample());
  });

  it('accumulateTurn counts a turn; accumulateUtility does not', () => {
    const target = zeroSessionUsage();
    accumulateTurn(target, usage(10, 5, 0.25));
    accumulateUtility(target, 'observer', usage(3, 2, 0.5));
    accumulateUtility(target, 'observer', usage(3, 2, 0.5));
    expect(target.totalTurns).toBe(1);
    expect(target.totalCost).toBe(1.25);
    expect(target.tokens).toEqual({ input: 16, output: 9, cacheRead: 3, cacheWrite: 6 });
    expect(target.utility!['observer']).toEqual({
      calls: 2,
      cost: 1,
      tokens: { input: 6, output: 4, cacheRead: 2, cacheWrite: 4 },
    });
  });
});
