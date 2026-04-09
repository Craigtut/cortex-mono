import { describe, expect, it } from 'vitest';
import { fileLink } from '../../src/tui/renderers/osc-links.js';

describe('fileLink', () => {
  it('encodes file URLs safely for OSC hyperlinks', () => {
    const linked = fileLink('/tmp/has space.txt', 'space file');

    expect(linked).toContain('file:///tmp/has%20space.txt');
    expect(linked).toContain('space file');
  });
});
