import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { requestRenderSpy, advanceSpinnerSpy, setContentSpy } = vi.hoisted(() => ({
  requestRenderSpy: vi.fn(),
  advanceSpinnerSpy: vi.fn(),
  setContentSpy: vi.fn(),
}));

vi.mock('@animus-labs/cortex', () => ({
  estimateTokens: () => 0,
  TOOL_RESULT_WORKING_TAGS_REMINDER: '[working-tags-reminder]',
}));

vi.mock('../../src/tui/renderers/activity-line.js', () => ({
  ActivityLine: class MockActivityLine {
    setContent(...args: unknown[]): void {
      setContentSpy(...args);
    }
    setBelowBox(..._args: unknown[]): void {}
    invalidate(): void {}
    render(): string[] { return []; }

    advanceSpinner(): void {
      advanceSpinnerSpy();
    }
  },
}));

vi.mock('../../src/tui/renderers/registry.js', () => ({
  getRenderer: () => ({
    renderCall: () => ({
      headerText: 'tool',
      contentLines: [],
      footerText: '',
    }),
    renderResult: () => ({
      headerText: 'tool',
      contentLines: [],
      footerText: '',
    }),
    renderError: (error: string) => ({
      headerText: 'tool',
      contentLines: [error],
      footerText: '',
    }),
  }),
}));

vi.mock('../../src/tui/theme.js', () => ({
  getToolTheme: () => ({
    border: '#666666',
    borderMuted: '#555555',
    muted: '#999999',
    statusPending: '#aaaaaa',
    statusSuccess: '#00ff00',
    statusError: '#ff0000',
    error: '#ff0000',
  }),
}));

import { ToolExecutionComponent } from '../../src/tui/renderers/tool-execution.js';

describe('ToolExecutionComponent spinner animation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requestRenderSpy.mockClear();
    advanceSpinnerSpy.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('animates multiple pending tools with one render tick per TUI', () => {
    const tui = { requestRender: requestRenderSpy };
    const first = new ToolExecutionComponent('Read', tui as never);
    const second = new ToolExecutionComponent('SubAgent', tui as never);

    first.start({});
    second.start({});

    vi.advanceTimersByTime(250);

    expect(advanceSpinnerSpy).toHaveBeenCalledTimes(2);
    expect(requestRenderSpy).toHaveBeenCalledTimes(1);

    first.dispose();
    second.dispose();
  });

  it('stops the shared spinner ticker once pending tools finish', () => {
    const tui = { requestRender: requestRenderSpy };
    const first = new ToolExecutionComponent('Read', tui as never);
    const second = new ToolExecutionComponent('SubAgent', tui as never);

    first.start({});
    second.start({});
    first.complete('done', {}, 10);
    second.fail('failed', 10);
    requestRenderSpy.mockClear();
    advanceSpinnerSpy.mockClear();

    vi.advanceTimersByTime(250);

    expect(advanceSpinnerSpy).not.toHaveBeenCalled();
    expect(requestRenderSpy).not.toHaveBeenCalled();
  });
});

describe('ToolExecutionComponent Write rejection detection', () => {
  beforeEach(() => {
    setContentSpy.mockClear();
  });

  /** setContent(headerText, contentLines, footerText, status, ...) */
  function lastStatus(): string | undefined {
    const call = setContentSpy.mock.calls.at(-1);
    return call?.[3] as string | undefined;
  }

  it('flags a refused write (no bytes, no diff) as an error', () => {
    const tool = new ToolExecutionComponent('Write');
    tool.start({ file_path: '/etc/hosts' });
    tool.complete(
      { content: [{ type: 'text', text: 'You must Read this file before overwriting it.' }] },
      { filePath: '/etc/hosts', isCreate: false, bytesWritten: 0, diff: null },
      5,
    );

    expect(lastStatus()).toBe('error');
  });

  it('treats a truncate-to-empty write (0 bytes but a real diff) as success', () => {
    const tool = new ToolExecutionComponent('Write');
    tool.start({ file_path: '/tmp/file.txt' });
    tool.complete(
      { content: [{ type: 'text', text: 'Updated /tmp/file.txt (0 bytes)' }] },
      {
        filePath: '/tmp/file.txt',
        isCreate: false,
        bytesWritten: 0,
        diff: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: ['-old line'] }],
      },
      5,
    );

    expect(lastStatus()).toBe('success');
  });
});
