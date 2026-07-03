import { describe, it, expect } from 'vitest';
import { globToRegex, escapeRegexPart } from '../../../src/tools/shared/glob-to-regex.js';

describe('globToRegex', () => {
  // --- ReDoS resistance (the reason this module exists) ---

  describe('ReDoS resistance', () => {
    it('compiles an adversarial pattern to a literal matcher, not a backtracking bomb', () => {
      // `(a+)+$` is a classic catastrophic-backtracking source. The old
      // compilers copied these characters into the regex source verbatim,
      // producing `/^(a+)+$$/`. The fixed compiler escapes them, so the
      // pattern only ever matches the literal string `(a+)+$`.
      const regex = globToRegex('(a+)+$');

      expect(regex.test('(a+)+$')).toBe(true);
      expect(regex.test('aaaa')).toBe(false);
    });

    it('does not catastrophically backtrack on long non-matching input', () => {
      const regex = globToRegex('(a+)+$');
      // A vulnerable /^(a+)+$$/ would take exponential time on this input.
      const hostile = 'a'.repeat(50_000) + '!';

      const start = performance.now();
      const matched = regex.test(hostile);
      const elapsedMs = performance.now() - start;

      expect(matched).toBe(false);
      // Escaped-literal matching is effectively instant; allow generous slack
      // for slow CI while still failing hard on exponential blow-up.
      expect(elapsedMs).toBeLessThan(1000);
    });

    it('escapes other regex metacharacters into literals', () => {
      // Each of these would otherwise alter regex structure.
      expect(globToRegex('a+b').test('a+b')).toBe(true);
      expect(globToRegex('a+b').test('aaab')).toBe(false);
      expect(globToRegex('(x|y)').test('(x|y)')).toBe(true);
      expect(globToRegex('(x|y)').test('x')).toBe(false);
      expect(globToRegex('a^b$c').test('a^b$c')).toBe(true);
    });
  });

  // --- Preserved glob semantics ---

  describe('glob semantics', () => {
    it('* matches within a path segment but not across separators', () => {
      expect(globToRegex('*.ts').test('file.ts')).toBe(true);
      expect(globToRegex('*.ts').test('file.js')).toBe(false);
      expect(globToRegex('*.ts').test('dir/file.ts')).toBe(false);
    });

    it('** matches across path segments', () => {
      const regex = globToRegex('**/*.ts');
      expect(regex.test('root.ts')).toBe(true);
      expect(regex.test('src/deep.ts')).toBe(true);
      expect(regex.test('a/b/c/deep.ts')).toBe(true);
      expect(regex.test('root.js')).toBe(false);
    });

    it('? matches exactly one non-separator character', () => {
      expect(globToRegex('file?.ts').test('file1.ts')).toBe(true);
      expect(globToRegex('file?.ts').test('file.ts')).toBe(false);
      expect(globToRegex('file?.ts').test('file12.ts')).toBe(false);
      expect(globToRegex('a?b').test('a/b')).toBe(false);
    });

    it('{a,b} alternation', () => {
      const regex = globToRegex('*.{js,jsx}');
      expect(regex.test('a.js')).toBe(true);
      expect(regex.test('a.jsx')).toBe(true);
      expect(regex.test('a.ts')).toBe(false);
    });

    it('[abc] character class', () => {
      const regex = globToRegex('file[123].ts');
      expect(regex.test('file1.ts')).toBe(true);
      expect(regex.test('file2.ts')).toBe(true);
      expect(regex.test('file4.ts')).toBe(false);
    });

    it('literal dots are matched literally', () => {
      const regex = globToRegex('a.b');
      expect(regex.test('a.b')).toBe(true);
      expect(regex.test('axb')).toBe(false);
    });

    it('combines ** with alternation', () => {
      const regex = globToRegex('**/*.{js,jsx}');
      expect(regex.test('a.js')).toBe(true);
      expect(regex.test('src/a.jsx')).toBe(true);
      expect(regex.test('src/nested/a.js')).toBe(true);
      expect(regex.test('a.ts')).toBe(false);
    });
  });

  describe('escapeRegexPart', () => {
    it('escapes all regex control characters', () => {
      expect(escapeRegexPart('a+b')).toBe('a\\+b');
      expect(escapeRegexPart('(a)')).toBe('\\(a\\)');
      expect(escapeRegexPart('a.b')).toBe('a\\.b');
    });
  });
});
