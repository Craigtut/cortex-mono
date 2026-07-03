/**
 * Shared glob matcher for the Glob and Grep tools.
 *
 * This replaces the old "compile the glob to a RegExp and call .test()"
 * approach, which had two denial-of-service problems:
 *
 *   1. Metacharacter injection: literal path characters were copied into the
 *      regex source unescaped, so a filename pattern like `(a+)+$` became the
 *      catastrophic-backtracking regex `/^(a+)+$$/`.
 *   2. Multi-wildcard blow-up: even a pattern made of only legal `*` compiled
 *      to `[^/]*[^/]*…`, and a run like `*a*a*a…!` against a long string of
 *      `a` backtracked exponentially.
 *
 * Both are impossible here. The pattern is tokenized once and matched with a
 * bottom-up dynamic program over (tokenIndex, inputIndex) states. Each state is
 * computed exactly once, so the total work is bounded by
 * O(patternTokens * inputLength) with no recursion. There is no regex engine
 * driving the match, so exponential backtracking simply cannot occur.
 *
 * Supported glob semantics (unchanged from the previous compiler):
 *   - a leading `**` segment (`** /`) matches zero or more complete path
 *     segments, so `** /foo` stays anchored at a directory boundary.
 *   - a trailing `**` matches the rest of the path, separators included.
 *   - `*`       matches any run of non-`/` characters
 *   - `?`       matches a single non-`/` character
 *   - `{a,b}`   alternation over literal alternatives
 *   - `[abc]`   character class (one character)
 */

type Token =
  | { t: 'literal'; ch: string }
  | { t: 'single' } // ? -> one non-slash character
  | { t: 'star' } // * -> zero or more non-slash characters
  | { t: 'globstarSlash' } // **/ -> zero or more complete path segments
  | { t: 'globstarEnd' } // trailing ** -> the rest of the path, slashes included
  | { t: 'class'; re: RegExp } // [abc] -> a single character in the class
  | { t: 'alt'; options: string[] }; // {a,b} -> one of several literal alternatives

/** A compiled glob. `test` reports whether an input path matches. */
export interface GlobMatcher {
  test(input: string): boolean;
}

/**
 * Tokenize a glob pattern. Only glob metacharacters are interpreted; every
 * other character becomes a literal that is matched byte-for-byte, so it can
 * never be reinterpreted as matcher syntax.
 */
function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i]!;

    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          tokens.push({ t: 'globstarSlash' });
          i += 3;
          continue;
        }
        if (pattern[i + 2] === undefined) {
          tokens.push({ t: 'globstarEnd' });
          i += 2;
          continue;
        }
        // `**` followed by a non-slash: falls through and collapses with the
        // run of stars below into a single `*` (equivalent to `[^/]*[^/]*`).
      }
      // Collapse a run of consecutive `*` into one star token.
      while (pattern[i] === '*') i++;
      tokens.push({ t: 'star' });
      continue;
    }

    if (ch === '?') {
      tokens.push({ t: 'single' });
      i++;
      continue;
    }

    if (ch === '{') {
      const closeIdx = pattern.indexOf('}', i);
      if (closeIdx === -1) {
        tokens.push({ t: 'literal', ch: '{' });
        i++;
        continue;
      }
      const options = pattern.slice(i + 1, closeIdx).split(',');
      tokens.push({ t: 'alt', options });
      i = closeIdx + 1;
      continue;
    }

    if (ch === '[') {
      const closeIdx = pattern.indexOf(']', i);
      if (closeIdx !== -1) {
        const classSrc = pattern.slice(i, closeIdx + 1); // includes [ ]
        try {
          // A single-character class regex has no quantifier, so it cannot
          // backtrack. If the class is malformed, fall through to treating
          // `[` as a literal.
          const re = new RegExp(`^(?:${classSrc})$`);
          tokens.push({ t: 'class', re });
          i = closeIdx + 1;
          continue;
        } catch {
          // fall through: treat `[` as a literal character
        }
      }
      tokens.push({ t: 'literal', ch: '[' });
      i++;
      continue;
    }

    tokens.push({ t: 'literal', ch });
    i++;
  }

  return tokens;
}

/**
 * Match the token stream against the whole input (anchored at both ends) with
 * a bottom-up dynamic program. `dp[si]` for the current token means "can
 * tokens[ti..] match input[si..]". Rows are filled from the last token back to
 * the first, and within a row from the end of the input back to the start, so
 * every wildcard transition reads an already-computed value. The work is
 * bounded by O(tokens * inputLength); there is no recursion and no regex
 * backtracking, so it cannot blow the stack or hang.
 */
function matchTokens(tokens: Token[], s: string): boolean {
  const n = tokens.length;
  const m = s.length;

  // dp for tokens[n..] (the empty tail): matches only at end of input.
  let next = new Uint8Array(m + 1);
  next[m] = 1;

  for (let ti = n - 1; ti >= 0; ti--) {
    const tok = tokens[ti]!;
    const cur = new Uint8Array(m + 1);

    if (tok.t === 'globstarSlash') {
      // `(?:.+/)?`: nothing, or one or more chars ending at a slash. Precompute
      // "some slash at position >= si can start the rest" right-to-left so each
      // cell is O(1).
      const afterSlash = new Uint8Array(m + 1);
      for (let si = m - 1; si >= 0; si--) {
        afterSlash[si] =
          (s[si] === '/' && next[si + 1]) || afterSlash[si + 1] ? 1 : 0;
      }
      for (let si = m; si >= 0; si--) {
        // The `.+` requires at least one character before the slash, so look
        // for an eligible slash from si+1 onward.
        cur[si] = next[si] || (si < m && afterSlash[si + 1]!) ? 1 : 0;
      }
      next = cur;
      continue;
    }

    for (let si = m; si >= 0; si--) {
      let v = 0;
      switch (tok.t) {
        case 'literal':
          v = si < m && s[si] === tok.ch && next[si + 1]! ? 1 : 0;
          break;
        case 'single':
          v = si < m && s[si] !== '/' && next[si + 1]! ? 1 : 0;
          break;
        case 'class':
          v = si < m && tok.re.test(s[si]!) && next[si + 1]! ? 1 : 0;
          break;
        case 'alt':
          for (const opt of tok.options) {
            if (s.startsWith(opt, si) && next[si + opt.length]!) {
              v = 1;
              break;
            }
          }
          break;
        case 'star':
          // Nothing, or consume one non-slash char and stay on this token.
          v = next[si] || (si < m && s[si] !== '/' && cur[si + 1]!) ? 1 : 0;
          break;
        case 'globstarEnd':
          // Nothing, or consume one char (slashes allowed) and stay.
          v = next[si] || (si < m && cur[si + 1]!) ? 1 : 0;
          break;
      }
      cur[si] = v;
    }

    next = cur;
  }

  return next[0] === 1;
}

/**
 * Compile a glob pattern into a reusable matcher. Compilation is done once;
 * the returned matcher can be tested against many paths cheaply.
 */
export function compileGlob(pattern: string): GlobMatcher {
  const tokens = tokenize(pattern);
  return { test: (input: string) => matchTokens(tokens, input) };
}
