import { describe, it, expect } from 'vitest';
import {
  EditHistory,
  MAX_STACK_DEPTH,
  type EditHistoryEntry,
} from '../../../src/tools/shared/edit-history.js';

function makeEntry(tag: string, source: 'Edit' | 'Write' = 'Edit'): EditHistoryEntry {
  return {
    originalContent: `content-${tag}`,
    postMutationMtimeMs: 1_000 + tag.length,
    postMutationContentHash: `hash-${tag}`,
    source,
  };
}

describe('EditHistory', () => {
  it('returns undefined when popping an unknown path', () => {
    const h = new EditHistory();
    expect(h.pop('/tmp/no-such-file')).toBeUndefined();
    expect(h.depth('/tmp/no-such-file')).toBe(0);
  });

  it('pops entries LIFO for a single file', () => {
    const h = new EditHistory();
    h.record('/tmp/a.txt', makeEntry('one'));
    h.record('/tmp/a.txt', makeEntry('two'));
    h.record('/tmp/a.txt', makeEntry('three'));
    expect(h.depth('/tmp/a.txt')).toBe(3);

    expect(h.pop('/tmp/a.txt')?.originalContent).toBe('content-three');
    expect(h.pop('/tmp/a.txt')?.originalContent).toBe('content-two');
    expect(h.pop('/tmp/a.txt')?.originalContent).toBe('content-one');
    expect(h.pop('/tmp/a.txt')).toBeUndefined();
  });

  it('isolates stacks between files', () => {
    const h = new EditHistory();
    h.record('/tmp/a.txt', makeEntry('A'));
    h.record('/tmp/b.txt', makeEntry('B'));

    expect(h.pop('/tmp/a.txt')?.originalContent).toBe('content-A');
    expect(h.pop('/tmp/b.txt')?.originalContent).toBe('content-B');
  });

  it('normalizes paths so relative and absolute refer to the same stack', () => {
    const h = new EditHistory();
    h.record('/tmp/a.txt', makeEntry('one'));

    // Pop via the same absolute path (simplest normalization check
    // that doesn't depend on process.cwd()).
    expect(h.pop('/tmp/a.txt')?.originalContent).toBe('content-one');

    // Also verify that trailing-slash / redundant-segment variants
    // normalize to the same key.
    h.record('/tmp/sub/../a.txt', makeEntry('two'));
    expect(h.pop('/tmp/a.txt')?.originalContent).toBe('content-two');
  });

  it('bounds the per-file stack to MAX_STACK_DEPTH, dropping the oldest entry', () => {
    const h = new EditHistory();
    for (let i = 0; i < MAX_STACK_DEPTH + 3; i++) {
      h.record('/tmp/a.txt', makeEntry(String(i)));
    }
    expect(h.depth('/tmp/a.txt')).toBe(MAX_STACK_DEPTH);

    // Popping yields the most recent; the earliest entries have been dropped.
    const top = h.pop('/tmp/a.txt')!;
    expect(top.originalContent).toBe(`content-${MAX_STACK_DEPTH + 2}`);
  });

  it('clear() removes all stacks', () => {
    const h = new EditHistory();
    h.record('/tmp/a.txt', makeEntry('A'));
    h.record('/tmp/b.txt', makeEntry('B'));
    h.clear();
    expect(h.pop('/tmp/a.txt')).toBeUndefined();
    expect(h.pop('/tmp/b.txt')).toBeUndefined();
    expect(h.depth('/tmp/a.txt')).toBe(0);
  });

  it('stores the recorded source (Edit vs Write) verbatim', () => {
    const h = new EditHistory();
    h.record('/tmp/a.txt', makeEntry('edit', 'Edit'));
    h.record('/tmp/a.txt', makeEntry('write', 'Write'));

    expect(h.pop('/tmp/a.txt')?.source).toBe('Write');
    expect(h.pop('/tmp/a.txt')?.source).toBe('Edit');
  });

  it('supports null originalContent (file-created-by-Write case)', () => {
    const h = new EditHistory();
    h.record('/tmp/new.txt', {
      originalContent: null,
      postMutationMtimeMs: 42,
      postMutationContentHash: 'h',
      source: 'Write',
    });
    const popped = h.pop('/tmp/new.txt');
    expect(popped).toBeDefined();
    expect(popped!.originalContent).toBeNull();
  });
});
