import { describe, expect, it } from 'vitest';
import { collapseContent } from '../../src/tui/renderers/collapsible-content.js';

describe('collapseContent head-tail mode', () => {
  it('produces no tail lines when tailLines is 0 (no slice(-0) duplication)', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    const result = collapseContent(lines, {
      mode: 'head-tail',
      limit: 3,
      headLines: 2,
      tailLines: 0,
      expanded: false,
    });

    // head (2) + a single middle hint, and crucially no duplicated tail.
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]).toBe('a');
    expect(result.lines[1]).toBe('b');
    expect(result.lines[2]).toContain('+3 lines');
    expect(result.lines).not.toContain('c');
    expect(result.lines).not.toContain('e');
    expect(result.hiddenCount).toBe(3);
  });

  it('keeps head and tail when tailLines is positive', () => {
    const lines = ['a', 'b', 'c', 'd', 'e', 'f'];
    const result = collapseContent(lines, {
      mode: 'head-tail',
      limit: 4,
      headLines: 2,
      tailLines: 2,
      expanded: false,
    });

    expect(result.lines[0]).toBe('a');
    expect(result.lines[1]).toBe('b');
    expect(result.lines[result.lines.length - 2]).toBe('e');
    expect(result.lines[result.lines.length - 1]).toBe('f');
    expect(result.hiddenCount).toBe(2);
  });

  it('returns all lines unchanged when expanded', () => {
    const lines = ['a', 'b', 'c'];
    const result = collapseContent(lines, {
      mode: 'head-tail',
      limit: 1,
      tailLines: 0,
      expanded: true,
    });

    expect(result.lines).toEqual(lines);
    expect(result.truncated).toBe(false);
  });
});
