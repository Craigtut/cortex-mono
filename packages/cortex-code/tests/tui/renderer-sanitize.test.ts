import { describe, expect, it } from 'vitest';
import { editRenderer } from '../../src/tui/renderers/edit-renderer.js';
import { readRenderer } from '../../src/tui/renderers/read-renderer.js';
import { grepRenderer } from '../../src/tui/renderers/grep-renderer.js';
import { globRenderer } from '../../src/tui/renderers/glob-renderer.js';
import { webFetchRenderer } from '../../src/tui/renderers/web-fetch-renderer.js';
import type { ToolRenderContext } from '../../src/tui/renderers/types.js';

function ctx(args: Record<string, unknown>): ToolRenderContext {
  return {
    expanded: false,
    termWidth: 120,
    maxContentWidth: 116,
    theme: {
      primary: '#00E5CC', accent: '#FFB347', error: '#FF6B6B', success: '#4ADE80',
      muted: '#6B7280', border: '#008577', borderMuted: '#4B5563',
      diffAdd: '#4ADE80', diffRemove: '#FF6B6B', diffContext: '#6B7280', lineNumber: '#6B7280',
      statusPending: '#6B7280', statusSuccess: '#4ADE80', statusError: '#FF6B6B',
      bgDefault: '#1a1a2e', bgError: '#2e1a1a',
    },
    status: 'error',
    toolName: 'Tool',
    args,
  };
}

/** chalk only emits SGR (ESC "["), never BEL or OSC (ESC "]"); those signal injection. */
function assertNoEscapeInjection(s: string): void {
  expect(s).not.toContain('\x07');
  expect(s).not.toContain('\x1b]');
  expect(s).not.toContain('\r');
}

const INJECT = '\x1b]0;pwned\x07\x1b[31m\rHACK';

describe('per-tool renderer sanitization (defense-in-depth)', () => {
  it('edit rejection message is sanitized', () => {
    const display = editRenderer.renderResult(
      { content: [{ type: 'text', text: `refused ${INJECT}` }] },
      { filePath: '/tmp/x.ts', replacementCount: 0, diff: [] },
      ctx({ file_path: '/tmp/x.ts' }),
    );
    assertNoEscapeInjection(display.contentLines.join('\n'));
    expect(display.contentLines.join('\n')).toContain('HACK');
  });

  it('edit diff body (file content) is sanitized', () => {
    const display = editRenderer.renderResult(
      {},
      {
        filePath: '/tmp/x.ts',
        replacementCount: 1,
        diff: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`+const a = 1 ${INJECT}`] }],
      },
      ctx({ file_path: '/tmp/x.ts' }),
    );
    assertNoEscapeInjection(display.contentLines.join('\n'));
  });

  it('edit error and old_string are sanitized', () => {
    const display = editRenderer.renderError(
      `not found ${INJECT}`,
      { file_path: '/tmp/x.ts', old_string: `needle ${INJECT}` },
      ctx({ file_path: '/tmp/x.ts' }),
    );
    assertNoEscapeInjection(display.contentLines.join('\n'));
  });

  it('read error text is sanitized', () => {
    const display = readRenderer.renderError!(
      `weird failure ${INJECT}`,
      { file_path: '/tmp/x.ts' },
      ctx({ file_path: '/tmp/x.ts' }),
    );
    assertNoEscapeInjection([display.headerText, ...display.contentLines].join('\n'));
  });

  it('grep header pattern is sanitized', () => {
    const display = grepRenderer.renderCall({ pattern: `foo${INJECT}` }, ctx({ pattern: `foo${INJECT}` }));
    // Plain header (no chalk), so no ESC at all should survive.
    expect(display.headerText).not.toContain('\x1b');
    assertNoEscapeInjection(display.headerText);
  });

  it('glob header pattern is sanitized', () => {
    const display = globRenderer.renderCall({ pattern: `**/*${INJECT}` }, ctx({ pattern: `**/*${INJECT}` }));
    expect(display.headerText).not.toContain('\x1b');
    assertNoEscapeInjection(display.headerText);
  });

  it('web-fetch domain and error are sanitized for an unparseable URL', () => {
    const badUrl = `not-a-url ${INJECT}`;
    const display = webFetchRenderer.renderError!(badUrl, { url: badUrl }, ctx({ url: badUrl }));
    assertNoEscapeInjection([display.headerText, ...display.contentLines].join('\n'));
  });
});
