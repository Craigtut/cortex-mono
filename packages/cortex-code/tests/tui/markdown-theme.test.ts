import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { markdownTheme } from '../../src/tui/theme.js';

// cli-highlight colors via its own chalk@4 instance (separate from cortex's
// chalk@5). Force that instance's level so highlighting emits ANSI regardless of
// whether the test runner is a TTY. This is the same chalk singleton that
// cli-highlight requires internally, so the level we set here is what it uses.
const require = createRequire(import.meta.url);
const chalk4Path = require.resolve('chalk', { paths: [require.resolve('cli-highlight')] });
(require(chalk4Path) as { level: number }).level = 3;

const ANSI = /\x1b\[/;

describe('markdownTheme', () => {
  describe('highlightCode', () => {
    it('actually syntax-highlights code (cli-highlight loads under ESM)', () => {
      const lines = markdownTheme.highlightCode!('fn main() {\n    let x = 42;\n}', 'rust');

      // Regression guard: a bare require() throws under ESM, which silently falls
      // back to unhighlighted lines (no ANSI). Real highlighting carries ANSI.
      expect(lines.join('\n')).toMatch(ANSI);
    });

    it('preserves the line structure of the source', () => {
      const lines = markdownTheme.highlightCode!('let a = 1;\nlet b = 2;\nlet c = 3;', 'rust');
      expect(lines).toHaveLength(3);
    });
  });

  describe('codeBlockBorder', () => {
    it('draws a short rule instead of literal backtick fences', () => {
      // pi-tui passes the raw fence text (```lang for the top, ``` for the bottom).
      const top = markdownTheme.codeBlockBorder('```rust');
      const bottom = markdownTheme.codeBlockBorder('```');

      for (const border of [top, bottom]) {
        expect(border).toContain('─────');
        expect(border).not.toContain('`');
        expect(border).not.toContain('rust');
      }
    });
  });
});
