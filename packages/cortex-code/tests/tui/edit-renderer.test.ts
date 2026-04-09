import { describe, expect, it } from 'vitest';
import { editRenderer } from '../../src/tui/renderers/edit-renderer.js';

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('editRenderer', () => {
  it('windows around the first raw diff change before colorizing', () => {
    const result = editRenderer.renderResult(
      { content: [{ type: 'text', text: 'Made 1 replacement' }] },
      {
        filePath: '/tmp/example.ts',
        replacementCount: 1,
        replaceAll: false,
        diff: [{
          oldStart: 10,
          oldLines: 1,
          newStart: 10,
          newLines: 1,
          lines: [
            ' context 1',
            ' context 2',
            ' context 3',
            ' context 4',
            ' context 5',
            ' context 6',
            ' context 7',
            ' context 8',
            ' context 9',
            ' context 10',
            '-old line',
            '+new line',
            ' context after',
          ],
        }],
      },
      {
        expanded: true,
        termWidth: 120,
        maxContentWidth: 116,
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
        status: 'success',
        toolName: 'Edit',
        args: {},
      },
    );

    expect(result.contentLines).toHaveLength(6);
    expect(stripAnsi(result.contentLines[0] ?? '')).toBe('  context 8');
    expect(stripAnsi(result.contentLines[3] ?? '')).toBe('- old line');
    expect(stripAnsi(result.contentLines[4] ?? '')).toBe('+ new line');
  });
});
