/**
 * Edit matcher: resolve an Edit tool `old_string` against a file's content
 * via a tiered cascade.
 *
 * Tiers (short-circuit on the first that yields any match):
 *   1. exact               — raw indexOf, caller handles multi-match based on replace_all
 *   2. line-trimmed        — per-line trailing-whitespace tolerance; must be unique
 *   3. indentation-flexible — strips common leading indent on both sides,
 *                             also tolerates trailing whitespace; must be unique
 *
 * Also exports `findNearestMatch` for "did you mean...?" error hints when
 * no tier matches, and `reindentReplacement` for producing a replacement
 * string that respects the haystack's indentation when tier 3 matched.
 *
 * This module is intentionally pure and I/O-free so the cascade can be
 * exhaustively unit-tested without the filesystem.
 */

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type MatchResult =
  | {
      kind: 'exact';
      /** Char offset in haystack where the first match begins. */
      startIndex: number;
      /** Length of the matched span (equals needle.length). */
      matchedLength: number;
      /** Total number of exact occurrences in haystack. */
      count: number;
      /**
       * 1-based line numbers where each match begins. Capped at the first
       * 3 entries (diagnostic use only; full count is in `count`).
       */
      matchLines: number[];
    }
  | {
      kind: 'line-trimmed';
      startIndex: number;
      matchedLength: number;
    }
  | {
      kind: 'indentation-flexible';
      startIndex: number;
      matchedLength: number;
      /** Common leading indent of the needle's non-empty lines. */
      needleIndent: string;
      /** Common leading indent of the matched haystack window. */
      haystackIndent: string;
    }
  | {
      kind: 'ambiguous';
      tier: 'line-trimmed' | 'indentation-flexible';
      count: number;
      /** 1-based line numbers, first 3. */
      matchLines: number[];
    }
  | { kind: 'none' };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the tiered matcher. Both arguments should already be line-ending
 * normalized (CRLF -> LF) by the caller.
 */
export function findMatch(haystack: string, needle: string): MatchResult {
  // Note: we intentionally do NOT bail on needle.length > haystack.length.
  // Tier 3 tolerates over-indented needles, so a longer-than-haystack needle
  // can still produce a valid match after common-indent stripping.
  if (needle.length === 0) return { kind: 'none' };

  const exact = findExact(haystack, needle);
  if (exact.kind === 'exact') return exact;

  const trimmed = findLineTrimmed(haystack, needle);
  if (trimmed.kind !== 'none') return trimmed;

  return findIndentationFlexible(haystack, needle);
}

/**
 * Re-indent a replacement string so it fits the haystack's indentation
 * when tier 3 (indentation-flexible) matched.
 *
 * Strips up to `needleIndent` leading whitespace from each non-empty line
 * of `newString`, then prepends `haystackIndent`. Empty / whitespace-only
 * lines pass through untouched.
 */
export function reindentReplacement(
  newString: string,
  needleIndent: string,
  haystackIndent: string,
): string {
  if (needleIndent === haystackIndent) return newString;
  return newString
    .split('\n')
    .map((line) => {
      if (line.trim() === '') return line;
      const stripped = line.startsWith(needleIndent)
        ? line.slice(needleIndent.length)
        : line;
      return haystackIndent + stripped;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Nearest-match hint
// ---------------------------------------------------------------------------

export interface NearestMatch {
  /** 1-based line number of the best candidate. */
  bestLine: number;
  /** Similarity ratio in [0, 1]. */
  bestRatio: number;
  /**
   * Pre-formatted multi-line snippet with line numbers and an arrow on
   * the best candidate. Suitable for direct inclusion in an error message.
   */
  snippet: string;
}

/** Hard scan limit on large files; Levenshtein is O(m*n) per line. */
const NEAREST_MATCH_SCAN_CAP = 2000;
const NEAREST_MATCH_MIN_RATIO = 0.5;
const NEAREST_MATCH_CONTEXT = 3;

/**
 * Find the closest line in `haystack` to the first non-empty line of
 * `needle`, returning a diff-style snippet with ±3 lines of context.
 * Returns undefined when no reasonable candidate (ratio < 0.5) exists.
 */
export function findNearestMatch(
  haystack: string,
  needle: string,
): NearestMatch | undefined {
  const needleLines = needle.split('\n');
  const firstNonEmpty = needleLines.find((line) => line.trim() !== '');
  if (firstNonEmpty === undefined) return undefined;

  const haystackLines = haystack.split('\n');
  const scanLimit = Math.min(haystackLines.length, NEAREST_MATCH_SCAN_CAP);
  const needleTrim = firstNonEmpty.trim();

  let bestIdx = -1;
  let bestRatio = 0;

  for (let i = 0; i < scanLimit; i++) {
    const line = haystackLines[i]!;
    const lineTrim = line.trim();
    if (lineTrim === '') continue;
    const ratio = levenshteinRatio(needleTrim, lineTrim);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestIdx = i;
    }
  }

  if (bestIdx === -1 || bestRatio < NEAREST_MATCH_MIN_RATIO) return undefined;

  const start = Math.max(0, bestIdx - NEAREST_MATCH_CONTEXT);
  const end = Math.min(haystackLines.length - 1, bestIdx + NEAREST_MATCH_CONTEXT);
  const gutterWidth = String(end + 1).length;

  const rendered: string[] = [];
  for (let i = start; i <= end; i++) {
    const num = String(i + 1).padStart(gutterWidth);
    const marker = i === bestIdx ? '  <- nearest' : '';
    rendered.push(`  ${num} | ${haystackLines[i]}${marker}`);
  }

  return {
    bestLine: bestIdx + 1,
    bestRatio,
    snippet: rendered.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Tier 1: exact
// ---------------------------------------------------------------------------

function findExact(
  haystack: string,
  needle: string,
): Extract<MatchResult, { kind: 'exact' }> | { kind: 'none' } {
  const uniqueLines: number[] = [];
  let count = 0;
  let firstStart = -1;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    if (count === 1) firstStart = idx;
    // Keep up to 3 DISTINCT line numbers. Multiple hits on the same line
    // (e.g. replace_all of a short variable) should show one line, not
    // the same number repeated.
    if (uniqueLines.length < 3) {
      const line = charIndexToLine(haystack, idx);
      if (!uniqueLines.includes(line)) uniqueLines.push(line);
    }
    pos = idx + needle.length;
  }

  if (count === 0) return { kind: 'none' };
  return {
    kind: 'exact',
    startIndex: firstStart,
    matchedLength: needle.length,
    count,
    matchLines: uniqueLines,
  };
}

// ---------------------------------------------------------------------------
// Tier 2: line-trimmed (tolerates per-line trailing whitespace)
// ---------------------------------------------------------------------------

function findLineTrimmed(
  haystack: string,
  needle: string,
): MatchResult {
  const needleLines = needle.split('\n');
  const haystackLines = haystack.split('\n');
  if (needleLines.length > haystackLines.length) return { kind: 'none' };

  const needleTrimmed = needleLines.map(trimEnd);

  // Short-circuit when tier 2 would degenerate to tier 1: if trimming
  // changes nothing on either side, tier 1 has already run and either
  // found a match or not — re-running here would just rediscover the
  // same result.
  const needleEqual = arraysEqual(needleLines, needleTrimmed);
  if (needleEqual && !haystackHasTrailingWhitespace(haystackLines)) {
    return { kind: 'none' };
  }

  const windowLen = needleLines.length;
  const matches: number[] = [];

  for (let i = 0; i + windowLen <= haystackLines.length; i++) {
    let ok = true;
    for (let j = 0; j < windowLen; j++) {
      if (trimEnd(haystackLines[i + j]!) !== needleTrimmed[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(i);
  }

  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      tier: 'line-trimmed',
      count: matches.length,
      matchLines: matches.slice(0, 3).map((i) => i + 1),
    };
  }

  const span = linesToSpan(haystackLines, matches[0]!, windowLen);
  return {
    kind: 'line-trimmed',
    startIndex: span.startIndex,
    matchedLength: span.matchedLength,
  };
}

// ---------------------------------------------------------------------------
// Tier 3: indentation-flexible (common-indent strip + trailing trim)
// ---------------------------------------------------------------------------

function findIndentationFlexible(
  haystack: string,
  needle: string,
): MatchResult {
  const needleLines = needle.split('\n');
  const haystackLines = haystack.split('\n');
  if (needleLines.length > haystackLines.length) return { kind: 'none' };

  const needleIndent = commonLeadingIndent(needleLines);
  const needleCanonical = needleLines.map((line) =>
    trimEnd(stripLeading(line, needleIndent)),
  );

  // If the needle has no stripped content (e.g. entirely blank lines),
  // fall out — we'd match noise.
  if (needleCanonical.every((line) => line === '')) return { kind: 'none' };

  const windowLen = needleLines.length;
  const matches: Array<{ startLine: number; haystackIndent: string }> = [];

  for (let i = 0; i + windowLen <= haystackLines.length; i++) {
    const window = haystackLines.slice(i, i + windowLen);
    const windowIndent = commonLeadingIndent(window);
    let ok = true;
    for (let j = 0; j < windowLen; j++) {
      const canonical = trimEnd(stripLeading(window[j]!, windowIndent));
      if (canonical !== needleCanonical[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push({ startLine: i, haystackIndent: windowIndent });
  }

  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      tier: 'indentation-flexible',
      count: matches.length,
      matchLines: matches.slice(0, 3).map((m) => m.startLine + 1),
    };
  }

  const m = matches[0]!;
  const span = linesToSpan(haystackLines, m.startLine, windowLen);

  // Guard: if the indents are identical, tier 2 would have caught this
  // (or tier 1 already did). Promote to 'none' so we don't mask a true
  // no-match with a spurious tier 3 hit.
  if (needleIndent === m.haystackIndent) {
    return { kind: 'none' };
  }

  return {
    kind: 'indentation-flexible',
    startIndex: span.startIndex,
    matchedLength: span.matchedLength,
    needleIndent,
    haystackIndent: m.haystackIndent,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function trimEnd(s: string): string {
  return s.replace(/[ \t]+$/u, '');
}

function stripLeading(line: string, indent: string): string {
  return line.startsWith(indent) ? line.slice(indent.length) : line;
}

function haystackHasTrailingWhitespace(lines: string[]): boolean {
  for (const line of lines) {
    if (line.length > 0 && /[ \t]$/u.test(line)) return true;
  }
  return false;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Longest common leading whitespace prefix across non-empty lines.
 * Lines that are empty or whitespace-only are skipped so a blank line
 * inside a block doesn't collapse the shared indent to "".
 */
function commonLeadingIndent(lines: string[]): string {
  let common: string | undefined;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const m = /^[ \t]*/u.exec(line);
    const leading = m ? m[0] : '';
    if (common === undefined) {
      common = leading;
      continue;
    }
    let i = 0;
    const max = Math.min(common.length, leading.length);
    while (i < max && common[i] === leading[i]) i++;
    common = common.slice(0, i);
    if (common.length === 0) return '';
  }
  return common ?? '';
}

/**
 * Convert a (startLine, windowLen) line-index span into a (startIndex,
 * matchedLength) character span in the original haystack. Assumes the
 * haystack was split by '\n' — inner newlines are counted, but no
 * trailing newline is included in `matchedLength`.
 */
function linesToSpan(
  lines: string[],
  startLine: number,
  windowLen: number,
): { startIndex: number; matchedLength: number } {
  let startIndex = 0;
  for (let i = 0; i < startLine; i++) {
    startIndex += lines[i]!.length + 1;
  }
  let matchedLength = 0;
  for (let i = 0; i < windowLen; i++) {
    matchedLength += lines[startLine + i]!.length;
    if (i < windowLen - 1) matchedLength += 1;
  }
  return { startIndex, matchedLength };
}

/** Count 1-based line number of a character offset in haystack. */
function charIndexToLine(haystack: string, charIndex: number): number {
  let line = 1;
  for (let i = 0; i < charIndex && i < haystack.length; i++) {
    if (haystack.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Levenshtein (for findNearestMatch only)
// ---------------------------------------------------------------------------

function levenshteinRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  const dist = levenshteinDistance(a, b);
  return 1 - dist / max;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}
