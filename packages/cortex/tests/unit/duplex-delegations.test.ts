import { describe, it, expect } from 'vitest';
import { DelegationRegistry, highestTaskAlias } from '../../src/duplex/delegations.js';

function registry(clock = { t: 1_000 }, maxAgeMs = 60_000): DelegationRegistry {
  return new DelegationRegistry({ now: () => clock.t, maxAgeMs });
}

describe('DelegationRegistry', () => {
  it('retires on any directive seq the delegation owns, steers included', () => {
    const reg = registry();
    const alias = reg.reserveAlias();
    reg.open(alias, 'index the repo', 10);
    reg.addSteer(alias, 12);
    // A run that consumed only the steer answers the spawn's delegation.
    reg.retireFor([{ kind: 'directive', seq: 12 }]);
    expect(reg.activeAliases()).toEqual([]);
    expect(reg.snapshot()[0]?.completedAt).not.toBeNull();
    // A later steer makes it outstanding again.
    reg.addSteer(alias, 14);
    expect(reg.activeAliases()).toEqual([alias]);
  });

  it('treats a run as cancelled only when every tag belongs to cancelled work', () => {
    const reg = registry();
    const a = reg.reserveAlias();
    reg.open(a, 'a', 1);
    const b = reg.reserveAlias();
    reg.open(b, 'b', 2);
    reg.markCancelled(a, 3);
    expect(reg.servesOnlyCancelled([{ kind: 'directive', seq: 1 }, { kind: 'directive', seq: 3 }])).toBe(true);
    expect(reg.servesOnlyCancelled([{ kind: 'directive', seq: 1 }, { kind: 'directive', seq: 2 }])).toBe(false);
    expect(reg.servesOnlyCancelled([{ kind: 'utterance', seq: 1 }])).toBe(false);
    expect(reg.servesOnlyCancelled([])).toBe(false);
  });

  it('ages out delegations by last activity, not creation', () => {
    const clock = { t: 0 };
    const reg = registry(clock, 100);
    const alias = reg.reserveAlias();
    reg.open(alias, 'long job', 1);
    clock.t = 90;
    reg.addSteer(alias, 2);
    clock.t = 150;
    expect(reg.snapshot().map((d) => d.alias)).toEqual([alias]);
    clock.t = 191;
    expect(reg.snapshot()).toEqual([]);
  });

  it('restores outstanding work as interrupted and never reissues a logged alias', () => {
    const reg = registry();
    const interrupted = reg.restoreState({
      nextAliasNumber: 2,
      delegations: [
        { alias: 'task-1', instructions: 'x', seq: 5, createdAt: 0, cancelled: false, completedAt: null, directiveSeqs: [5], lastActivityAt: 0 },
      ],
    }, highestTaskAlias(['task-1', 'task-7', 'lk-3', undefined]));
    expect(interrupted.map((d) => d.alias)).toEqual(['task-1']);
    expect(reg.activeAliases()).toEqual([]);
    expect(reg.reserveAlias()).toBe('task-8');
  });
});
