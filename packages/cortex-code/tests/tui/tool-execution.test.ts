import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { requestRenderSpy, advanceSpinnerSpy } = vi.hoisted(() => ({
  requestRenderSpy: vi.fn(),
  advanceSpinnerSpy: vi.fn(),
}));

vi.mock('@animus-labs/cortex', () => ({
  estimateTokens: () => 0,
  TOOL_RESULT_WORKING_TAGS_REMINDER: '[working-tags-reminder]',
}));

vi.mock('../../src/tui/renderers/bordered-box.js', () => ({
  BorderedBox: class MockBorderedBox {
    setContent(..._args: unknown[]): void {}
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
