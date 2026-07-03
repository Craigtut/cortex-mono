import { describe, expect, it } from 'vitest';
import { subAgentRenderer } from '../../src/tui/renderers/sub-agent-renderer.js';
import type { ToolRenderContext } from '../../src/tui/renderers/types.js';

function context(args: Record<string, unknown>): ToolRenderContext {
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
    status: 'pending',
    toolName: 'SubAgent',
    args,
  };
}

describe('subAgentRenderer.renderCall', () => {
  it('strips control-char injection from the instructions description', () => {
    const args = { instructions: 'Investigate\x1b]0;pwned\x07\x1b[31m\rthe bug' };
    const display = subAgentRenderer.renderCall(args, context(args));

    const joined = display.contentLines.join('\n');
    expect(joined).not.toContain('\x1b]');
    expect(joined).not.toContain('\x07');
    expect(joined).not.toContain('\r');
    expect(joined).toContain('Investigate');
  });
});
