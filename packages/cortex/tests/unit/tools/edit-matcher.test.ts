import { describe, it, expect } from 'vitest';
import {
  findMatch,
  findNearestMatch,
  reindentReplacement,
  type MatchResult,
} from '../../../src/tools/shared/edit-matcher.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function expectExact(r: MatchResult): Extract<MatchResult, { kind: 'exact' }> {
  if (r.kind !== 'exact') throw new Error(`expected exact match, got ${r.kind}`);
  return r;
}

function expectLineTrimmed(
  r: MatchResult,
): Extract<MatchResult, { kind: 'line-trimmed' }> {
  if (r.kind !== 'line-trimmed') {
    throw new Error(`expected line-trimmed match, got ${r.kind}`);
  }
  return r;
}

function expectIndented(
  r: MatchResult,
): Extract<MatchResult, { kind: 'indentation-flexible' }> {
  if (r.kind !== 'indentation-flexible') {
    throw new Error(`expected indentation-flexible match, got ${r.kind}`);
  }
  return r;
}

function expectAmbiguous(
  r: MatchResult,
): Extract<MatchResult, { kind: 'ambiguous' }> {
  if (r.kind !== 'ambiguous') {
    throw new Error(`expected ambiguous, got ${r.kind}`);
  }
  return r;
}

/** Apply a MatchResult back to the haystack and return the rebuilt content. */
function applyMatch(
  haystack: string,
  match: MatchResult,
  newString: string,
): string {
  if (match.kind === 'none' || match.kind === 'ambiguous') {
    throw new Error(`cannot apply ${match.kind}`);
  }
  const replacement =
    match.kind === 'indentation-flexible'
      ? reindentReplacement(newString, match.needleIndent, match.haystackIndent)
      : newString;
  return (
    haystack.slice(0, match.startIndex) +
    replacement +
    haystack.slice(match.startIndex + match.matchedLength)
  );
}

// ---------------------------------------------------------------------------
// Tier 1: exact
// ---------------------------------------------------------------------------

describe('findMatch — tier 1 (exact)', () => {
  it('finds a single exact match', () => {
    const r = expectExact(findMatch('hello world', 'world'));
    expect(r.count).toBe(1);
    expect(r.startIndex).toBe(6);
    expect(r.matchedLength).toBe(5);
    expect(r.matchLines).toEqual([1]);
  });

  it('reports count and line numbers for multiple exact matches', () => {
    const haystack = 'foo\nbar\nfoo\nbaz\nfoo\n';
    const r = expectExact(findMatch(haystack, 'foo'));
    expect(r.count).toBe(3);
    expect(r.matchLines).toEqual([1, 3, 5]);
  });

  it('caps sample line numbers at 3 regardless of total count', () => {
    const haystack = 'x\nx\nx\nx\nx\n';
    const r = expectExact(findMatch(haystack, 'x'));
    expect(r.count).toBe(5);
    // Sample is capped at 3 entries; full count lives in `count`.
    expect(r.matchLines).toEqual([1, 2, 3]);

    const bigger = 'x\n'.repeat(10);
    const r2 = expectExact(findMatch(bigger, 'x'));
    expect(r2.count).toBe(10);
    expect(r2.matchLines).toEqual([1, 2, 3]);
  });

  it('finds multi-line exact text', () => {
    const haystack = 'alpha\nbeta\ngamma\n';
    const r = expectExact(findMatch(haystack, 'beta\ngamma'));
    expect(r.count).toBe(1);
    expect(haystack.slice(r.startIndex, r.startIndex + r.matchedLength)).toBe(
      'beta\ngamma',
    );
  });

  it('returns none for empty needle', () => {
    expect(findMatch('hello', '').kind).toBe('none');
  });

  it('returns none when needle is longer than haystack', () => {
    expect(findMatch('hi', 'hello').kind).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Tier 2: line-trimmed (trailing whitespace tolerance)
// ---------------------------------------------------------------------------

describe('findMatch — tier 2 (line-trimmed)', () => {
  it('matches when needle has trailing whitespace the haystack lacks', () => {
    // Needle carries trailing spaces that the haystack line does not, so
    // tier 1 indexOf fails and tier 2 catches it.
    const haystack = 'foo\nbar\n';
    const needle = 'foo   ';
    const r = expectLineTrimmed(findMatch(haystack, needle));
    expect(haystack.slice(r.startIndex, r.startIndex + r.matchedLength)).toBe(
      'foo',
    );
  });

  it('matches multi-line needles with trailing whitespace mismatches', () => {
    // Needle has trailing whitespace that haystack lacks → no tier 1 match.
    const haystack = 'alpha\nbeta\ngamma\n';
    const needle = 'alpha   \nbeta\ngamma ';
    const r = expectLineTrimmed(findMatch(haystack, needle));
    expect(haystack.slice(r.startIndex, r.startIndex + r.matchedLength)).toBe(
      'alpha\nbeta\ngamma',
    );
  });

  it('rejects tier-2 ambiguity instead of silently picking the first', () => {
    // Needle has a trailing space that neither haystack line contains,
    // so tier 1 fails (no substring) but tier 2 matches both lines.
    const haystack = 'alpha\nalpha\n';
    const needle = 'alpha ';
    const a = expectAmbiguous(findMatch(haystack, needle));
    expect(a.tier).toBe('line-trimmed');
    expect(a.count).toBe(2);
    expect(a.matchLines).toEqual([1, 2]);
  });

  it('replaces correctly after tier 2 match, overwriting trailing garbage', () => {
    // Needle has trailing whitespace that haystack lacks. After tier 2
    // matches, replacement must land cleanly — no stray whitespace.
    const haystack = 'const x = 1;\nconst y = 2;\n';
    const needle = 'const x = 1;   ';
    const r = findMatch(haystack, needle);
    const out = applyMatch(haystack, r, 'const x = 42;');
    expect(out).toBe('const x = 42;\nconst y = 2;\n');
  });
});

// ---------------------------------------------------------------------------
// Tier 3: indentation-flexible
// ---------------------------------------------------------------------------

describe('findMatch — tier 3 (indentation-flexible)', () => {
  it('matches when needle is indented less than the haystack region', () => {
    const haystack = [
      'class Foo {',
      '    constructor() {',
      '        this.x = 1;',
      '    }',
      '}',
      '',
    ].join('\n');
    const needle = ['constructor() {', '    this.x = 1;', '}'].join('\n');
    const r = expectIndented(findMatch(haystack, needle));
    expect(r.needleIndent).toBe('');
    expect(r.haystackIndent).toBe('    ');
    // The matched span is the original haystack region with its 4-space indent.
    expect(haystack.slice(r.startIndex, r.startIndex + r.matchedLength)).toBe(
      '    constructor() {\n        this.x = 1;\n    }',
    );
  });

  it('matches when needle is indented MORE than the haystack region', () => {
    const haystack = 'function f() {\n  return 1;\n}\n';
    const needle = '      function f() {\n        return 1;\n      }';
    const r = expectIndented(findMatch(haystack, needle));
    expect(r.needleIndent).toBe('      ');
    expect(r.haystackIndent).toBe('');
  });

  it('re-indents the replacement to match haystack indent', () => {
    const haystack = [
      'class Foo {',
      '    constructor() {',
      '        this.x = 1;',
      '    }',
      '}',
      '',
    ].join('\n');
    const needle = ['constructor() {', '    this.x = 1;', '}'].join('\n');
    const replacement = ['constructor() {', '    this.x = 99;', '}'].join('\n');
    const r = findMatch(haystack, needle);
    const out = applyMatch(haystack, r, replacement);
    expect(out).toBe(
      [
        'class Foo {',
        '    constructor() {',
        '        this.x = 99;',
        '    }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('rejects ambiguous tier 3 matches', () => {
    // Needle is MORE indented than the haystack region, so tier 1 cannot
    // find it as a substring. Tier 2 also fails because line contents
    // don't match after trimming trailing whitespace alone. Tier 3
    // strips common leading indent on both sides and finds two matches.
    const haystack = ['function f() {', '  x();', '  x();', '}', ''].join('\n');
    const needle = '    x();';
    const r = expectAmbiguous(findMatch(haystack, needle));
    expect(r.tier).toBe('indentation-flexible');
    expect(r.count).toBe(2);
  });

  it('tolerates blank lines inside the block without collapsing indent', () => {
    const haystack = [
      '    function f() {',
      '',
      '        return 1;',
      '    }',
      '',
    ].join('\n');
    const needle = ['function f() {', '', '    return 1;', '}'].join('\n');
    const r = expectIndented(findMatch(haystack, needle));
    expect(r.needleIndent).toBe('');
    expect(r.haystackIndent).toBe('    ');
  });

  it('aligns uniform tab-indented haystack with uniform space-indented needle', () => {
    // Tier 3 strips whatever leading whitespace is COMMON on each side,
    // regardless of whether it is tabs or spaces. A block consistently
    // indented with tabs on disk and consistently indented with spaces in
    // the needle is still a legitimate match.
    const haystack = '\tfunction f() {\n\t    return 1;\n\t}\n';
    const needle = '    function f() {\n        return 1;\n    }';
    const r = expectIndented(findMatch(haystack, needle));
    expect(r.needleIndent).toBe('    ');
    expect(r.haystackIndent).toBe('\t');
  });

  it('returns none when the haystack window has no coherent common indent', () => {
    // First line of the window uses a tab, second uses spaces — no
    // common prefix. After stripping the empty common indent, the lines
    // still contain the original whitespace, so tier 3 cannot align them
    // with the uniformly-indented needle.
    const haystack = '\tfoo();\n    foo();\n';
    const needle = '  foo();\n  foo();';
    const r = findMatch(haystack, needle);
    expect(r.kind).toBe('none');
  });

  it('does not promote a zero-delta tier 3 match (handled by earlier tiers)', () => {
    // When needleIndent === haystackIndent, tier 2 or tier 1 should have
    // matched. The tier 3 guard ensures we don't masquerade as tier 3.
    const haystack = 'if (true) {\n    foo();\n}\n';
    const needle = 'if (true) {\n    foo();\n}';
    // Tier 1 finds this exactly (1 match). Tier 3 never runs. Just verify
    // the exact path wins.
    expect(findMatch(haystack, needle).kind).toBe('exact');
  });
});

// ---------------------------------------------------------------------------
// Tier ordering and ambiguity precedence
// ---------------------------------------------------------------------------

describe('findMatch — tier ordering', () => {
  it('prefers exact match over fuzzy when both would succeed', () => {
    const haystack = 'foo\n    foo\n';
    const needle = 'foo';
    // Exact finds 2 matches — caller handles via replace_all, NOT fuzzy.
    const r = expectExact(findMatch(haystack, needle));
    expect(r.count).toBe(2);
  });

  it('does not fall through to tier 2 when tier 1 has matches', () => {
    // Even if tier 1 is ambiguous (multiple), we don't try tier 2 — the
    // caller decides based on replace_all.
    const haystack = 'foo\nfoo\n';
    const r = findMatch(haystack, 'foo');
    expect(r.kind).toBe('exact');
  });

  it('reports tier-2 ambiguity rather than falling through to tier 3', () => {
    // Tier 1 finds 0 (needle has trailing space haystack lacks); tier 2
    // finds multiple trim-matches. Must stop at tier 2 rather than
    // masquerading as the (weaker) tier 3 result.
    const haystack = 'key\nkey\nother\nkey\n';
    const needle = 'key   ';
    const r = expectAmbiguous(findMatch(haystack, needle));
    expect(r.tier).toBe('line-trimmed');
    expect(r.count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Nearest-match hint
// ---------------------------------------------------------------------------

describe('findNearestMatch', () => {
  it('returns a snippet with ±3 lines of context around the best candidate', () => {
    const haystack = [
      'line 1',
      'line 2',
      'line 3',
      'const foo = bar();',
      'line 5',
      'line 6',
      'line 7',
    ].join('\n');
    const hint = findNearestMatch(haystack, 'const foo = baz();');
    expect(hint).toBeDefined();
    expect(hint!.bestLine).toBe(4);
    expect(hint!.bestRatio).toBeGreaterThan(0.7);
    // Snippet must contain the candidate line with an arrow marker.
    expect(hint!.snippet).toContain('const foo = bar();');
    expect(hint!.snippet).toContain('<- nearest');
  });

  it('returns undefined when the needle is only whitespace', () => {
    expect(findNearestMatch('line 1\nline 2\n', '\n  \n')).toBeUndefined();
  });

  it('returns undefined when no line is sufficiently similar', () => {
    const haystack = 'abc\ndef\nghi\n';
    const needle = 'XX YY ZZ QQ WW';
    expect(findNearestMatch(haystack, needle)).toBeUndefined();
  });

  it('handles haystacks smaller than the context window', () => {
    const haystack = 'const foo = 1;';
    const hint = findNearestMatch(haystack, 'const foo = 2;');
    expect(hint).toBeDefined();
    expect(hint!.bestLine).toBe(1);
    // Snippet must still render even though there are no surrounding lines.
    expect(hint!.snippet.split('\n').length).toBe(1);
  });

  it('caps the scan to avoid pathological Levenshtein on huge files', () => {
    const big = 'x\n'.repeat(5000);
    const hint = findNearestMatch(big, 'y');
    // Should not throw; may or may not find something, but must return quickly.
    expect(hint === undefined || hint.bestLine <= 2000).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reindentReplacement
// ---------------------------------------------------------------------------

describe('reindentReplacement', () => {
  it('returns input unchanged when indents match', () => {
    expect(reindentReplacement('foo\nbar', '  ', '  ')).toBe('foo\nbar');
  });

  it('shifts replacement right by (haystackIndent - needleIndent)', () => {
    // Needle was dedented (indent=""), haystack had 4-space indent, so
    // replacement gets 4-space indent prepended to each non-empty line.
    const replacement = 'line a\nline b';
    expect(reindentReplacement(replacement, '', '    ')).toBe(
      '    line a\n    line b',
    );
  });

  it('shifts replacement left when needle was over-indented', () => {
    // Model provided replacement at 6 spaces, haystack region had 2 spaces.
    const replacement = '      line a\n      line b';
    expect(reindentReplacement(replacement, '      ', '  ')).toBe(
      '  line a\n  line b',
    );
  });

  it('preserves blank lines without adding indent to them', () => {
    const replacement = 'line a\n\nline b';
    expect(reindentReplacement(replacement, '', '    ')).toBe(
      '    line a\n\n    line b',
    );
  });

  it('does not strip leading whitespace that does not match needleIndent', () => {
    // If a replacement line is less-indented than needleIndent, leave it.
    const replacement = 'foo\n  inner';
    expect(reindentReplacement(replacement, '    ', '      ')).toBe(
      '      foo\n      ' + '  inner',
    );
    // After reindent: "foo" has no matching leading indent, so it gets just
    // haystackIndent prepended. "  inner" starts with 2 spaces, not 4, so
    // leading-strip is a no-op and haystackIndent is prepended verbatim.
  });
});
