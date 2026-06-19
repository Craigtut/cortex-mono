import { describe, expect, it } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { ToolGroupComponent } from '../../src/tui/renderers/tool-group.js';

describe('ToolGroupComponent', () => {
  it('shows active grouped work as a compact two-line status', () => {
    const group = new ToolGroupComponent('exploration');

    group.startToolCall('tool-1', 'Glob', { pattern: '**/*.ts' });

    const lines = group.render(80);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Exploring');
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  it('collapses completed grouped work to one summary line', () => {
    const group = new ToolGroupComponent('exploration');

    group.startToolCall('tool-1', 'Glob', { pattern: '**/*.ts' });
    group.completeToolCall('tool-1', { totalCount: 4 }, 10);
    group.startToolCall('tool-2', 'Read', { file_path: '/tmp/project/src/index.ts' });
    group.completeToolCall('tool-2', { filePath: '/tmp/project/src/index.ts', startLine: 1, totalLines: 10 }, 5);
    group.close();

    const lines = group.render(80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Explored');
    expect(lines[0]).not.toContain('\u2570');
    expect(lines[0]).not.toContain('\u2502');
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(80);
  });

  it('folds edits into a "Changed N files" headline with diff counts', () => {
    const group = new ToolGroupComponent('changes');

    group.startToolCall('edit-1', 'Edit', { file_path: '/tmp/project/src/login.ts' });
    group.completeToolCall('edit-1', {
      filePath: '/tmp/project/src/login.ts',
      replacementCount: 1,
      diff: [{
        oldStart: 1, oldLines: 1, newStart: 1, newLines: 2,
        lines: [' context', '-const x = old', '+const x = new'],
      }],
    }, 5);
    group.close();

    const collapsed = group.render(80);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toContain('Changed 1 file');

    group.toggleExpand();
    const expanded = group.render(80);
    expect(expanded.length).toBeGreaterThan(1);
    expect(expanded.join('\n')).toContain('login.ts');
  });

  it('expands grouped work into individual tool entries', () => {
    const group = new ToolGroupComponent('web');

    group.startToolCall('tool-1', 'WebFetch', { url: 'https://docs.example.com/page' });
    group.completeToolCall('tool-1', { finalUrl: 'https://docs.example.com/page', statusCode: 200, markdownSize: 2048 }, 20);
    group.toggleExpand();

    expect(group.render(100).length).toBeGreaterThan(1);
  });
});
