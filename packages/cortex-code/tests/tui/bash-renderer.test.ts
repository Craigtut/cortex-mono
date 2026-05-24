import { describe, expect, it } from 'vitest';
import { bashRenderer } from '../../src/tui/renderers/bash-renderer.js';
import type { ToolRenderContext } from '../../src/tui/renderers/types.js';

function context(command = 'npm audit --omit=dev --json'): ToolRenderContext {
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
    status: 'success',
    toolName: 'Bash',
    args: { command },
  };
}

describe('bashRenderer', () => {
  it('shows a nonzero exit code once as command outcome metadata', () => {
    const display = bashRenderer.renderResult(
      {
        content: [{
          type: 'text',
          text: '{\n  "vulnerabilities": {}\n}\nExit code: 1',
        }],
      },
      { exitCode: 1 },
      context(),
    );

    expect(display.contentLines.join('\n')).not.toContain('Exit code: 1');
    expect(display.belowBoxLines?.join('\n')).toContain('Command exited with code 1');
  });
});
