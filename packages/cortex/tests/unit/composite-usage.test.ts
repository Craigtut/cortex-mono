import { describe, it, expect } from 'vitest';
import { CompositeUsage } from '../../src/facade/composite-usage.js';
import type { SessionUsage } from '../../src/types.js';

function spent(cost: number, turns = 1): SessionUsage {
  return {
    totalCost: cost,
    totalTurns: turns,
    tokens: { input: cost * 10, output: cost * 20, cacheRead: 0, cacheWrite: 0 },
  };
}

describe('CompositeUsage', () => {
  it('reports live readings unchanged before any restore', () => {
    const ledger = new CompositeUsage();
    const breakdown = ledger.breakdown({ reasoner: spent(2), talker: spent(1), lookups: spent(0.5) });
    expect(breakdown.perLoop.reasoner.totalCost).toBe(2);
    expect(breakdown.perLoop.talker?.totalCost).toBe(1);
    expect(breakdown.perLoop.lookups?.totalCost).toBe(0.5);
    expect(breakdown.total.totalCost).toBe(3.5);
  });

  it('adds only the delta since the restore on top of the restored baseline', () => {
    const ledger = new CompositeUsage();
    // The live counters had already reached 5 when the restore happened;
    // none of that belongs to the restored session.
    ledger.rebase(
      { total: spent(10), perLoop: { talker: spent(3), reasoner: spent(7) } },
      { reasoner: spent(5), talker: spent(1), lookups: null },
    );
    const total = ledger.total({ reasoner: spent(6), talker: spent(1.5), lookups: null });
    expect(total.totalCost).toBeCloseTo(7 + 1 + 3 + 0.5);
  });

  it('is idempotent across repeated restores of the same artifact', () => {
    const ledger = new CompositeUsage();
    const artifact = { total: spent(4), perLoop: { talker: null, reasoner: spent(4) } };
    ledger.rebase(artifact, { reasoner: spent(1), talker: null, lookups: null });
    ledger.rebase(artifact, { reasoner: spent(1), talker: null, lookups: null });
    expect(ledger.total({ reasoner: spent(1), talker: null, lookups: null }).totalCost).toBe(4);
  });

  it('carries a restored talker and lookup side through a mode that has neither', () => {
    const ledger = new CompositeUsage();
    ledger.rebase(
      { total: spent(6), perLoop: { talker: spent(2), reasoner: spent(3), lookups: spent(1) } },
      { reasoner: spent(0, 0), talker: null, lookups: null },
    );
    const breakdown = ledger.breakdown({ reasoner: spent(0, 0), talker: null, lookups: null });
    expect(breakdown.perLoop.talker?.totalCost).toBe(2);
    expect(breakdown.perLoop.lookups?.totalCost).toBe(1);
    expect(breakdown.total.totalCost).toBe(6);
  });

  it('omits an all-zero lookup bucket and reports no talker when none exists', () => {
    const ledger = new CompositeUsage();
    const breakdown = ledger.breakdown({ reasoner: spent(1), talker: null, lookups: spent(0, 0) });
    expect(breakdown.perLoop.talker).toBeNull();
    expect('lookups' in breakdown.perLoop).toBe(false);
  });
});
