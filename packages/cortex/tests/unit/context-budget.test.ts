import { describe, expect, it } from 'vitest';
import { resolveContextBudget } from '../../src/context-budget.js';

describe('provider-independent context budgets', () => {
  it.each([
    { capacity: 200000, limit: 50000, effective: 50000 },
    { capacity: 200000, limit: 12000, effective: 12000 },
    { capacity: 8192, limit: null, effective: 8192 },
    { capacity: 8192, limit: 32000, effective: 8192 },
    { capacity: 8192, limit: 4096, effective: 4096 },
  ])('keeps backend capacity separate from compaction policy: %j', ({ capacity, limit, effective }) => {
    expect(resolveContextBudget(capacity, limit)).toMatchObject({ capacity, effective });
  });

  it('rejects invalid consumer budgets instead of poisoning compaction arithmetic', () => {
    for (const limit of [0, -1, NaN, Infinity, 1.5]) expect(() => resolveContextBudget(32768, limit)).toThrow();
  });

  it('provides a fallback only when capacity is unknown', () => {
    expect(resolveContextBudget(NaN, null)).toMatchObject({ capacity: 16384, effective: 16384 });
  });
});
