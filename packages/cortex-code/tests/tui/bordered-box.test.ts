import { describe, expect, it } from 'vitest';
import { visibleWidth } from '@mariozechner/pi-tui';
import { BorderedBox } from '../../src/tui/renderers/bordered-box.js';

describe('BorderedBox', () => {
  it('clamps rendered lines to the available width', () => {
    const box = new BorderedBox();
    box.setContent(
      'grep /spawnSubAgent|spawnBackground|SubAgent.*system|systemPrompt.*sub|sub.*systemPrompt/ in packages/cortex/src/cortex-agent.ts',
      [],
      '',
      'pending',
    );

    const lines = box.render(60);

    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
  });

  it('normalizes embedded newlines in headers, content, footers, and below-box lines', () => {
    const box = new BorderedBox();
    box.setContent(
      'write /tmp/example.ts\ncreated',
      ['first line\nsecond line'],
      'footer\nok',
      'success',
      10,
    );
    box.setBelowBox(['exit code: 0\nstderr: none']);

    const lines = box.render(60);

    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(line).not.toContain('\n');
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
  });
});
