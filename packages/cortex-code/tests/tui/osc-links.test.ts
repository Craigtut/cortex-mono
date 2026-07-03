import { describe, expect, it } from 'vitest';
import { fileLink } from '../../src/tui/renderers/osc-links.js';

describe('fileLink', () => {
  it('encodes file URLs safely for OSC hyperlinks', () => {
    const linked = fileLink('/tmp/has space.txt', 'space file');

    expect(linked).toContain('file:///tmp/has%20space.txt');
    expect(linked).toContain('space file');
  });

  it('strips injected control bytes from the display label', () => {
    // A malicious label tries to close the OSC 8 sequence early and inject ANSI.
    const linked = fileLink('/tmp/x.txt', 'ab\x07cd\x1b[31m');

    expect(linked).toContain('abcd[31m');
    // Only the two structural BELs remain (open terminator + close terminator).
    expect(linked.split('\x07')).toHaveLength(3);
  });
});
