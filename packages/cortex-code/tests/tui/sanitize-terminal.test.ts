import { describe, expect, it } from 'vitest';
import {
  sanitizeTerminalText,
  sanitizeTerminalLine,
} from '../../src/tui/renderers/sanitize-terminal.js';

describe('sanitizeTerminalText', () => {
  it('strips ESC, BEL, and CR bytes', () => {
    const raw = 'safe\x1b[31mred\x07bell\rcarriage';
    const out = sanitizeTerminalText(raw);
    expect(out).not.toMatch(/[\x1b\x07\r]/);
    expect(out).toBe('safe[31mredbellcarriage');
  });

  it('strips an OSC 8 hyperlink injection', () => {
    const raw = 'click \x1b]8;;http://evil\x07here\x1b]8;;\x07';
    const out = sanitizeTerminalText(raw);
    // Neutralized: the ESC introducer and BEL terminator are gone, so the
    // remaining "]8;;" is inert printable text, not an escape sequence.
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('\x07');
    expect(out).toContain('click ');
  });

  it('strips an OSC 52 clipboard-write injection', () => {
    const raw = '\x1b]52;c;ZXZpbA==\x07visible';
    const out = sanitizeTerminalText(raw);
    expect(out).not.toContain('\x1b');
    expect(out).toContain('visible');
  });

  it('strips DEL and C1 control characters', () => {
    const raw = 'a\x7fb\x9dc';
    expect(sanitizeTerminalText(raw)).toBe('abc');
  });

  it('preserves newlines and tabs for multi-line output', () => {
    const raw = 'line1\n\tindented\nline3';
    expect(sanitizeTerminalText(raw)).toBe('line1\n\tindented\nline3');
  });

  it('caps length at the provided maximum', () => {
    const raw = 'x'.repeat(100);
    expect(sanitizeTerminalText(raw, 10)).toHaveLength(10);
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeTerminalText('')).toBe('');
  });
});

describe('sanitizeTerminalLine', () => {
  it('strips control characters and flattens newlines/tabs to spaces', () => {
    const raw = 'first\x1b[2Kline\nsecond\ttabbed';
    const out = sanitizeTerminalLine(raw);
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\t');
    expect(out).toBe('first[2Kline second tabbed');
  });

  it('caps length for compact single-line UI', () => {
    expect(sanitizeTerminalLine('y'.repeat(5000)).length).toBe(2000);
  });
});
