import { describe, expect, it } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { ActivityLine } from '../../src/tui/renderers/activity-line.js';

describe('ActivityLine', () => {
  it('clamps rendered lines to the available width', () => {
    const line = new ActivityLine();
    line.setContent(
      'grep /spawnSubAgent|spawnBackground|SubAgent.*system|systemPrompt.*sub|sub.*systemPrompt/ in packages/cortex/src/agent-loop.ts',
      [],
      '',
      'pending',
    );

    const rendered = line.render(60);

    for (const out of rendered) {
      expect(visibleWidth(out)).toBeLessThanOrEqual(60);
    }
  });

  it('renders borderless: no box-drawing characters', () => {
    const line = new ActivityLine();
    line.setContent('Ran npm run build', ['error TS2339'], 'exit 1', 'error', 10);

    const rendered = line.render(60).join('\n');

    expect(rendered).not.toContain('╭');
    expect(rendered).not.toContain('╰');
    expect(rendered).not.toContain('│');
  });

  it('normalizes embedded newlines across header, body, footer, and below lines', () => {
    const line = new ActivityLine();
    line.setContent(
      'Wrote /tmp/example.ts\ncreated',
      ['first line\nsecond line'],
      'footer\nok',
      'success',
      10,
    );
    line.setBelowBox(['exit code: 0\nstderr: none']);

    const rendered = line.render(60);

    // header + 2 body lines + 2 below lines = 5 lines, none with a raw newline.
    expect(rendered).toHaveLength(5);
    for (const out of rendered) {
      expect(out).not.toContain('\n');
      expect(visibleWidth(out)).toBeLessThanOrEqual(60);
    }
  });

  it('omits trivial durations and shows slow ones', () => {
    const fast = new ActivityLine();
    fast.setContent('Ran ls', [], '', 'success', 12);
    expect(fast.render(60).join('\n')).not.toContain('12ms');

    const slow = new ActivityLine();
    slow.setContent('Ran npm test', [], '', 'success', 4200);
    expect(slow.render(60).join('\n')).toContain('4.2s');
  });
});
