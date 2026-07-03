/**
 * Shared glob-to-regex compiler for the Glob and Grep tools.
 *
 * Both tools previously carried their own compiler that copied every
 * non-glob character into the regex source UNESCAPED. That turned an
 * adversarial filename pattern such as `(a+)+$` into the catastrophic-
 * backtracking regex `/^(a+)+$$/`, which `.test()` runs synchronously per
 * candidate path, hanging the process (a denial-of-service).
 *
 * This compiler treats ONLY the glob metacharacters `* ? { } , [ ] .` as
 * syntax and regex-escapes every other character before inserting it, so
 * literal path characters can never bleed into regex control constructs.
 *
 * Supported glob semantics (unchanged):
 *   - a double star matches across path segments (with or without a
 *     trailing slash)
 *   - `*`       match any run of non-`/` characters
 *   - `?`       match a single non-`/` character
 *   - `{a,b}`   alternation
 *   - `[abc]`   character class
 */

/**
 * Escape a string so it is matched literally inside a regular expression.
 */
export function escapeRegexPart(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a glob pattern into an anchored `RegExp`. Only glob
 * metacharacters are interpreted; everything else is escaped, so the
 * result can never catastrophically backtrack on hostile input.
 */
export function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i]!;

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**` (optionally followed by `/`) matches across path segments.
        if (pattern[i + 2] === '/' || pattern[i + 2] === undefined) {
          regex += '(?:.+/)?';
          i += pattern[i + 2] === '/' ? 3 : 2;
          continue;
        }
      }
      // `*` matches anything except a path separator.
      regex += '[^/]*';
      i++;
    } else if (char === '?') {
      regex += '[^/]';
      i++;
    } else if (char === '{') {
      const closeIdx = pattern.indexOf('}', i);
      if (closeIdx === -1) {
        // No closing brace: treat `{` as a literal.
        regex += '\\{';
        i++;
      } else {
        const alternatives = pattern.slice(i + 1, closeIdx).split(',');
        regex += '(?:' + alternatives.map(escapeRegexPart).join('|') + ')';
        i = closeIdx + 1;
      }
    } else if (char === '[') {
      const closeIdx = pattern.indexOf(']', i);
      if (closeIdx === -1) {
        // No closing bracket: treat `[` as a literal.
        regex += '\\[';
        i++;
      } else {
        // Character class passes through as-is (glob classes map onto regex
        // classes); a class cannot introduce quantifier backtracking.
        regex += pattern.slice(i, closeIdx + 1);
        i = closeIdx + 1;
      }
    } else {
      // Any other character is a literal path character: escape it so it is
      // never interpreted as a regex operator.
      regex += escapeRegexPart(char);
      i++;
    }
  }

  return new RegExp(`^${regex}$`);
}
