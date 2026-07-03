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
    group.completeToolCall('tool-1', null, { totalCount: 4 }, 10);
    group.startToolCall('tool-2', 'Read', { file_path: '/tmp/project/src/index.ts' });
    group.completeToolCall('tool-2', null, { filePath: '/tmp/project/src/index.ts', startLine: 1, totalLines: 10 }, 5);
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
    group.completeToolCall('edit-1', null, {
      filePath: '/tmp/project/src/login.ts',
      replacementCount: 1,
      diff: [{
        oldStart: 1, oldLines: 1, newStart: 1, newLines: 2,
        lines: [' context', '-const x = old', '+const x = new'],
      }],
    }, 5);
    group.close();

    const collapsed = group.render(80);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]).toContain('Changed 1 file');
    // The file path is shown on a dimmed second line.
    expect(collapsed[1]).toContain('login.ts');

    group.toggleExpand();
    const expanded = group.render(80);
    expect(expanded.length).toBeGreaterThan(1);
    expect(expanded.join('\n')).toContain('login.ts');
  });

  it('expands grouped work into individual tool entries', () => {
    const group = new ToolGroupComponent('web');

    group.startToolCall('tool-1', 'WebFetch', { url: 'https://docs.example.com/page' });
    group.completeToolCall('tool-1', null, { finalUrl: 'https://docs.example.com/page', statusCode: 200, markdownSize: 2048 }, 20);
    group.toggleExpand();

    expect(group.render(100).length).toBeGreaterThan(1);
  });

  it('strips control-char injection from a diff body (file content)', () => {
    const group = new ToolGroupComponent('changes');
    group.startToolCall('edit-1', 'Edit', { file_path: '/tmp/project/app.ts' });
    group.completeToolCall('edit-1', null, {
      filePath: '/tmp/project/app.ts',
      replacementCount: 1,
      diff: [{
        oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
        lines: ['-const a = 1', '+const a = 2 \x1b]0;pwned\x07\x1b[31m\rHACK'],
      }],
    }, 5);
    group.toggleExpand();

    const joined = group.render(120).join('\n');
    expect(joined).not.toContain('\x1b]0;');
    expect(joined).not.toContain('\x07');
    expect(joined).not.toContain('\r');
    // The visible text survives; only the escape bytes are removed.
    expect(joined).toContain('HACK');
  });

  it('strips control-char injection from a grouped result summary', () => {
    const group = new ToolGroupComponent('exploration');
    group.startToolCall('g-1', 'Glob', { pattern: '**/*\x1b]0;x\x07.ts' });
    group.completeToolCall('g-1', null, { totalCount: 2 }, 5);
    group.toggleExpand();

    const joined = group.render(120).join('\n');
    expect(joined).not.toContain('\x1b');
    expect(joined).not.toContain('\x07');
  });

  it('strips control-char injection from a grouped tool error', () => {
    const group = new ToolGroupComponent('web');
    group.startToolCall('w-1', 'WebFetch', { url: 'https://x.test' });
    group.failToolCall('w-1', 'boom\x1b]0;evil\x07\x1b[31m spoof', 5);
    group.toggleExpand();

    const joined = group.render(120).join('\n');
    expect(joined).not.toContain('\x1b');
    expect(joined).not.toContain('\x07');
    expect(joined).toContain('boom');
  });

  it('surfaces a refused Write as an error with its refusal message', () => {
    const group = new ToolGroupComponent('changes');
    group.startToolCall('w-1', 'Write', { file_path: '/etc/hosts' });
    group.completeToolCall(
      'w-1',
      { content: [{ type: 'text', text: 'You must Read this file before overwriting it.' }] },
      { filePath: '/etc/hosts', isCreate: false, bytesWritten: 0, diff: null },
      5,
    );
    group.close();
    group.toggleExpand();

    const joined = group.render(120).join('\n');
    // Red status dot (error color 0xFF6B6B family) and the refusal text shown.
    expect(joined).toContain('You must Read this file before overwriting it.');
  });

  it('does not flag a truncate-to-empty Write (0 bytes but a real diff) as refused', () => {
    const group = new ToolGroupComponent('changes');
    group.startToolCall('w-1', 'Write', { file_path: '/tmp/file.txt' });
    group.completeToolCall(
      'w-1',
      { content: [{ type: 'text', text: 'Updated /tmp/file.txt (0 bytes)' }] },
      {
        filePath: '/tmp/file.txt',
        isCreate: false,
        bytesWritten: 0,
        diff: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: ['-old line'] }],
      },
      5,
    );
    group.close();

    const joined = group.render(120).join('\n');
    expect(joined).not.toContain('You must Read');
    expect(joined).toContain('file.txt');
  });
});
