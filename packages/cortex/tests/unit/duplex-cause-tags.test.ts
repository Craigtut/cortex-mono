/**
 * Cause-tag helpers (D16): isCauseTag is the only validator between the
 * loop's `unknown` tag slot and a consent decision, so it must accept
 * exactly the facade-stamped shape: a real log entry type and a positive
 * integer seq. collectCauseTags flattens one nested level (the truncation
 * repair delivery carries a whole prior set in one slot) but must stay
 * bounded against pathological nesting.
 */
import { describe, it, expect } from 'vitest';
import { isCauseTag, collectCauseTags, latestCauseSeq } from '../../src/duplex/cause-tags.js';

describe('isCauseTag', () => {
  it('accepts facade-stamped tags of every entry kind it will meet', () => {
    expect(isCauseTag({ kind: 'utterance', seq: 1 })).toBe(true);
    expect(isCauseTag({ kind: 'delivery', seq: 42 })).toBe(true);
    expect(isCauseTag({ kind: 'directive', seq: 7 })).toBe(true);
    expect(isCauseTag({ kind: 'ask_answer', seq: 999 })).toBe(true);
  });

  it('rejects a kind outside the log entry vocabulary', () => {
    // The broker branches on kind; an unvetted string must not reach it.
    expect(isCauseTag({ kind: 'utterance-ish', seq: 5 })).toBe(false);
    expect(isCauseTag({ kind: '', seq: 5 })).toBe(false);
    expect(isCauseTag({ kind: 'UTTERANCE', seq: 5 })).toBe(false);
  });

  it('rejects a seq that is not a positive integer', () => {
    // A NaN seq would poison latestCauseSeq and stamp causedBy: NaN.
    expect(isCauseTag({ kind: 'utterance', seq: NaN })).toBe(false);
    expect(isCauseTag({ kind: 'utterance', seq: Infinity })).toBe(false);
    expect(isCauseTag({ kind: 'utterance', seq: 1.5 })).toBe(false);
    expect(isCauseTag({ kind: 'utterance', seq: 0 })).toBe(false);
    expect(isCauseTag({ kind: 'utterance', seq: -3 })).toBe(false);
  });

  it('rejects non-tag shapes', () => {
    expect(isCauseTag(null)).toBe(false);
    expect(isCauseTag(undefined)).toBe(false);
    expect(isCauseTag(5)).toBe(false);
    expect(isCauseTag('utterance')).toBe(false);
    expect(isCauseTag([{ kind: 'utterance', seq: 1 }])).toBe(false);
    expect(isCauseTag({ kind: 'utterance' })).toBe(false);
    expect(isCauseTag({ seq: 5 })).toBe(false);
  });
});

describe('collectCauseTags', () => {
  it('keeps valid tags and drops malformed ones', () => {
    const tags = collectCauseTags([
      { kind: 'utterance', seq: 3 },
      { kind: 'utterance-ish', seq: 5 },
      { kind: 'delivery', seq: NaN },
      'noise',
      { kind: 'delivery', seq: 8 },
    ]);
    expect(tags).toEqual([
      { kind: 'utterance', seq: 3 },
      { kind: 'delivery', seq: 8 },
    ]);
  });

  it('a malformed seq never reaches the log-stamping collapse', () => {
    expect(latestCauseSeq([{ kind: 'utterance', seq: NaN }])).toBeNull();
    expect(latestCauseSeq([{ kind: 'utterance', seq: NaN }, { kind: 'reply', seq: 4 }])).toBe(4);
  });

  it('flattens a nested set (the truncation-repair shape)', () => {
    const tags = collectCauseTags([
      [{ kind: 'utterance', seq: 2 }, { kind: 'delivery', seq: 6 }],
      { kind: 'directive', seq: 9 },
    ]);
    expect(tags).toEqual([
      { kind: 'utterance', seq: 2 },
      { kind: 'delivery', seq: 6 },
      { kind: 'directive', seq: 9 },
    ]);
  });

  it('survives a cyclic array instead of overflowing the stack', () => {
    // Nothing produces a cycle today, but the flatten runs inside dispatch
    // paths; the invariant must hold locally, not by arguing from producers.
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(collectCauseTags(cyclic)).toEqual([]);

    const cyclicWithTag: unknown[] = [{ kind: 'utterance', seq: 3 }];
    cyclicWithTag.push(cyclicWithTag);
    expect(collectCauseTags([cyclicWithTag])).toContainEqual({ kind: 'utterance', seq: 3 });
  });

  it('drops tags nested past the depth cap, keeps those within it', () => {
    const withinCap = [[[{ kind: 'utterance', seq: 2 }]]];
    expect(collectCauseTags(withinCap)).toEqual([{ kind: 'utterance', seq: 2 }]);

    const pastCap = [[[[[[{ kind: 'utterance', seq: 2 }]]]]]];
    expect(collectCauseTags(pastCap)).toEqual([]);
  });
});
