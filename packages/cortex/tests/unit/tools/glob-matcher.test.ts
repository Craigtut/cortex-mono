import { describe, it, expect } from 'vitest';
import { compileGlob } from '../../../src/tools/shared/glob-matcher.js';

describe('compileGlob', () => {
  // --- DoS resistance (the reason this module exists) ---

  describe('DoS resistance', () => {
    it('treats regex metacharacters as literals, not backtracking constructs', () => {
      // `(a+)+$` is a classic catastrophic-backtracking source. The old
      // regex compiler copied these characters into the regex source
      // verbatim, producing `/^(a+)+$$/`. The matcher treats them as literal
      // path characters, so the pattern only matches the literal `(a+)+$`.
      const m = compileGlob('(a+)+$');
      expect(m.test('(a+)+$')).toBe(true);
      expect(m.test('aaaa')).toBe(false);
    });

    it('does not backtrack on a metachar-injection pattern with long input', () => {
      const m = compileGlob('(a+)+$');
      const hostile = 'a'.repeat(50_000) + '!';

      m.test('warmup'); // discard first-call JIT cost from the measurement
      const start = performance.now();
      const matched = m.test(hostile);
      const elapsedMs = performance.now() - start;

      expect(matched).toBe(false);
      // Linear matching is single-digit ms here; exponential backtracking would
      // be seconds-to-forever. 100ms cleanly separates the two.
      expect(elapsedMs).toBeLessThan(100);
    });

    it('does not blow up on a multi-star pattern against long input', () => {
      // Only-legal `*` still exploded under the old `[^/]*[^/]*…` regex:
      // `*a*a*a…!` against a run of `a` backtracked catastrophically. The
      // linear matcher resolves each (token, position) state once, so this
      // stays fast.
      const stars = '*a'.repeat(20) + '!'; // 20 stars, ends in an unmatched '!'
      const m = compileGlob(stars);
      const hostile = 'a'.repeat(5_000); // long, and never contains '!'

      m.test('warmup'); // discard first-call JIT cost from the measurement
      const start = performance.now();
      const matched = m.test(hostile);
      const elapsedMs = performance.now() - start;

      expect(matched).toBe(false);
      // The old `[^/]*[^/]*…` regex took ~10s at 10 stars and never finished at
      // 12; the linear matcher stays in single-digit ms.
      expect(elapsedMs).toBeLessThan(100);
    });

    it('escapes other regex metacharacters into literals', () => {
      expect(compileGlob('a+b').test('a+b')).toBe(true);
      expect(compileGlob('a+b').test('aaab')).toBe(false);
      expect(compileGlob('(x|y)').test('(x|y)')).toBe(true);
      expect(compileGlob('(x|y)').test('x')).toBe(false);
      expect(compileGlob('a^b$c').test('a^b$c')).toBe(true);
    });
  });

  // --- Preserved glob semantics ---

  describe('glob semantics', () => {
    it('* matches within a path segment but not across separators', () => {
      expect(compileGlob('*.ts').test('file.ts')).toBe(true);
      expect(compileGlob('*.ts').test('file.js')).toBe(false);
      expect(compileGlob('*.ts').test('dir/file.ts')).toBe(false);
    });

    it('** matches across path segments', () => {
      const m = compileGlob('**/*.ts');
      expect(m.test('root.ts')).toBe(true);
      expect(m.test('src/deep.ts')).toBe(true);
      expect(m.test('a/b/c/deep.ts')).toBe(true);
      expect(m.test('root.js')).toBe(false);
    });

    it('trailing ** matches the rest of the path including separators', () => {
      // Regression: trailing `**` must match the remaining path (slashes
      // included), otherwise it matches no file at all.
      const src = compileGlob('src/**');
      expect(src.test('src/foo.ts')).toBe(true);
      expect(src.test('src/a/b.ts')).toBe(true);
      expect(src.test('src/a/b/c/deep.ts')).toBe(true);
      // A sibling that merely starts with "src" is not under src/.
      expect(src.test('srcfoo.ts')).toBe(false);

      const docs = compileGlob('docs/**');
      expect(docs.test('docs/readme.md')).toBe(true);
      expect(docs.test('docs/guide/intro.md')).toBe(true);
    });

    it('**/ stays anchored at a directory boundary', () => {
      // `**/foo` must not match `xfoo` — the `**/` is a path boundary.
      const m = compileGlob('**/foo');
      expect(m.test('foo')).toBe(true);
      expect(m.test('a/foo')).toBe(true);
      expect(m.test('a/b/foo')).toBe(true);
      expect(m.test('xfoo')).toBe(false);
    });

    it('gitignore-style `dir/**` matches nested files (full-path branch)', () => {
      // This is exactly what grep.ts matchesGitignorePattern feeds to the
      // matcher for a `.gitignore` line like `dist/**`. It must match files
      // nested at any depth beneath the directory.
      const m = compileGlob('dist/**');
      expect(m.test('dist/bundle.js')).toBe(true);
      expect(m.test('dist/assets/app.css')).toBe(true);
      expect(m.test('dist/a/b/c/chunk.js')).toBe(true);
      // Not the sibling `distfoo`.
      expect(m.test('distfoo/x.js')).toBe(false);
    });

    it('** in the middle spans intermediate segments', () => {
      const m = compileGlob('a/**/b');
      expect(m.test('a/b')).toBe(true);
      expect(m.test('a/x/b')).toBe(true);
      expect(m.test('a/x/y/b')).toBe(true);
      expect(m.test('a/bc')).toBe(false);
    });

    it('? matches exactly one non-separator character', () => {
      expect(compileGlob('file?.ts').test('file1.ts')).toBe(true);
      expect(compileGlob('file?.ts').test('file.ts')).toBe(false);
      expect(compileGlob('file?.ts').test('file12.ts')).toBe(false);
      expect(compileGlob('a?b').test('a/b')).toBe(false);
    });

    it('{a,b} alternation', () => {
      const m = compileGlob('*.{js,jsx}');
      expect(m.test('a.js')).toBe(true);
      expect(m.test('a.jsx')).toBe(true);
      expect(m.test('a.ts')).toBe(false);
    });

    it('[abc] character class', () => {
      const m = compileGlob('file[123].ts');
      expect(m.test('file1.ts')).toBe(true);
      expect(m.test('file2.ts')).toBe(true);
      expect(m.test('file4.ts')).toBe(false);
    });

    it('[a-z] character range', () => {
      const m = compileGlob('[a-z].ts');
      expect(m.test('x.ts')).toBe(true);
      expect(m.test('1.ts')).toBe(false);
    });

    it('literal dots are matched literally', () => {
      const m = compileGlob('a.b');
      expect(m.test('a.b')).toBe(true);
      expect(m.test('axb')).toBe(false);
    });

    it('combines ** with alternation', () => {
      const m = compileGlob('**/*.{js,jsx}');
      expect(m.test('a.js')).toBe(true);
      expect(m.test('src/a.jsx')).toBe(true);
      expect(m.test('src/nested/a.js')).toBe(true);
      expect(m.test('a.ts')).toBe(false);
    });

    it('anchors the whole path (no partial matches)', () => {
      const m = compileGlob('*.ts');
      expect(m.test('a.ts.bak')).toBe(false);
      expect(m.test('x.ts')).toBe(true);
    });
  });
});
