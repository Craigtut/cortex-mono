import { describe, expect, it } from 'vitest';
import { writeRenderer } from '../../src/tui/renderers/write-renderer.js';
import type { ToolRenderContext } from '../../src/tui/renderers/types.js';

function context(): ToolRenderContext {
  return {
    expanded: false,
    termWidth: 100,
    maxContentWidth: 96,
    theme: {
      primary: '#00E5CC',
      accent: '#FFB347',
      error: '#FF6B6B',
      success: '#4ADE80',
      muted: '#6B7280',
      border: '#008577',
      borderMuted: '#4B5563',
      diffAdd: '#4ADE80',
      diffRemove: '#FF6B6B',
      diffContext: '#6B7280',
      lineNumber: '#6B7280',
      statusPending: '#6B7280',
      statusSuccess: '#4ADE80',
      statusError: '#FF6B6B',
      bgDefault: '#1a1a2e',
      bgError: '#2e1a1a',
    },
    status: 'error',
    toolName: 'Write',
    args: { file_path: '/etc/hosts' },
  };
}

describe('writeRenderer', () => {
  it('surfaces the refusal message for a blocked write', () => {
    const display = writeRenderer.renderResult(
      { content: [{ type: 'text', text: 'You must Read this file before overwriting it.' }] },
      { filePath: '/etc/hosts', isCreate: false, bytesWritten: 0, diff: null, originalContent: null },
      context(),
    );

    expect(display.contentLines.join('\n')).toContain('You must Read this file before overwriting it.');
    expect(display.footerText).toBe('rejected');
  });

  it('strips control-char injection from a refusal message', () => {
    const display = writeRenderer.renderResult(
      { content: [{ type: 'text', text: 'Refusing to write\x1b]0;pwned\x07\r to critical path' }] },
      { filePath: '/etc/passwd', isCreate: false, bytesWritten: 0, diff: null, originalContent: null },
      context(),
    );

    const joined = display.contentLines.join('\n');
    expect(joined).not.toContain('\x1b');
    expect(joined).not.toContain('\x07');
    expect(joined).not.toContain('\r');
  });

  it('does not treat a truncate-to-empty write as a rejection', () => {
    const display = writeRenderer.renderResult(
      { content: [{ type: 'text', text: 'Updated /tmp/file.txt (0 bytes)' }] },
      {
        filePath: '/tmp/file.txt',
        isCreate: false,
        bytesWritten: 0,
        diff: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: ['-old line'] }],
        originalContent: 'old line\n',
      },
      context(),
    );

    expect(display.footerText).not.toBe('rejected');
    expect(display.contentLines).toHaveLength(0);
  });

  it('reports a created file with no body', () => {
    const display = writeRenderer.renderResult(
      { content: [{ type: 'text', text: 'Created /tmp/new.txt (12 bytes)' }] },
      { filePath: '/tmp/new.txt', isCreate: true, bytesWritten: 12, diff: null, originalContent: null },
      context(),
    );

    expect(display.footerText).toBe('created');
    expect(display.contentLines).toHaveLength(0);
  });
});
