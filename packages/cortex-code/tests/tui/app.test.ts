import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loaderStartSpy,
  loaderStopSpy,
  requestRenderSpy,
  doRenderSpy,
  logDebugSpy,
  logErrorSpy,
  logWarnSpy,
  renderState,
} = vi.hoisted(() => ({
  loaderStartSpy: vi.fn(),
  loaderStopSpy: vi.fn(),
  requestRenderSpy: vi.fn(),
  doRenderSpy: vi.fn(),
  logDebugSpy: vi.fn(),
  logErrorSpy: vi.fn(),
  logWarnSpy: vi.fn(),
  renderState: { throwCount: 0 },
}));

vi.mock('@mariozechner/pi-tui', () => {
  class MockProcessTerminal {
    columns = 120;
    rows = 40;
    start(): void {}
    stop(): void {}
    hideCursor(): void {}
    showCursor(): void {}
  }

  class MockContainer {
    children: unknown[] = [];

    addChild(child: unknown): void {
      this.children.push(child);
    }

    removeChild(child: unknown): void {
      this.children = this.children.filter(item => item !== child);
    }

    clear(): void {
      this.children = [];
    }
  }

  class MockTUI extends MockContainer {
    focused: unknown = null;
    previousLines: string[] = ['stale'];
    previousWidth = 80;
    previousHeight = 24;
    cursorRow = 5;
    hardwareCursorRow = 5;
    maxLinesRendered = 5;
    previousViewportTop = 2;
    renderRequested = false;
    stopped = false;

    constructor(_terminal: unknown) {
      super();
    }

    setFocus(component: unknown): void {
      this.focused = component;
    }

    start(): void {}
    stop(): void {}
    requestRender(): void {
      requestRenderSpy();
    }

    doRender(): void {
      doRenderSpy();
      if (renderState.throwCount > 0) {
        renderState.throwCount -= 1;
        throw new Error('render boom');
      }
    }
  }

  class MockLoader {
    constructor(..._args: unknown[]) {
      this.start();
    }

    start(): void {
      loaderStartSpy();
    }

    stop(): void {
      loaderStopSpy();
    }
  }

  class MockSpacer {}
  class MockText {
    constructor(..._args: unknown[]) {}
    setText(..._args: unknown[]): void {}
  }

  return {
    TUI: MockTUI,
    ProcessTerminal: MockProcessTerminal,
    Container: MockContainer,
    Spacer: MockSpacer,
    Text: MockText,
    Loader: MockLoader,
  };
});

vi.mock('../../src/tui/editor.js', () => ({
  CustomEditor: class MockEditor {
    setText(): void {}
    refreshCommands(): void {}
    getText(): string { return ''; }
    addToHistory(): void {}
  },
}));

vi.mock('../../src/tui/status.js', () => ({
  StatusBar: class MockStatusBar {
    setState(): void {}
    showHint(): void {}
  },
}));

vi.mock('../../src/tui/transcript.js', () => ({
  TranscriptManager: class MockTranscriptManager {
    clear(): void {}
    toggleExpand(): void {}
    toggleExpandAll(): void {}
  },
}));

vi.mock('../../src/tui/theme.js', () => ({
  editorTheme: {},
  colors: {
    primary: (text: string) => text,
    muted: (text: string) => text,
  },
}));

vi.mock('../../src/logger.js', () => ({
  log: {
    debug: logDebugSpy,
    error: logErrorSpy,
    warn: logWarnSpy,
  },
}));

import { App } from '../../src/tui/app.js';

describe('App status spinner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loaderStartSpy.mockClear();
    loaderStopSpy.mockClear();
    requestRenderSpy.mockClear();
    doRenderSpy.mockClear();
    logDebugSpy.mockClear();
    logErrorSpy.mockClear();
    logWarnSpy.mockClear();
    renderState.throwCount = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a custom status indicator instead of starting a pi-tui loader', () => {
    const app = new App({
      onSubmit: () => {},
      onAbort: () => {},
      onExit: () => {},
    }, '/tmp/project');

    app.showStatusSpinner('Thinking...');

    expect(loaderStartSpy).not.toHaveBeenCalled();
    expect(app.statusContainer.children).toHaveLength(2);
  });

  it('replaces the previous status indicator cleanly', () => {
    const app = new App({
      onSubmit: () => {},
      onAbort: () => {},
      onExit: () => {},
    }, '/tmp/project');

    app.showStatusSpinner('Thinking...');
    app.showStatusSpinner('Still thinking...');

    expect(loaderStartSpy).not.toHaveBeenCalled();
    expect(loaderStopSpy).not.toHaveBeenCalled();
    expect(app.statusContainer.children).toHaveLength(2);
  });

  it('animates the status indicator on a timer tick', async () => {
    const app = new App({
      onSubmit: () => {},
      onAbort: () => {},
      onExit: () => {},
    }, '/tmp/project');

    app.showStatusSpinner('Thinking...');
    doRenderSpy.mockClear();

    await vi.advanceTimersByTimeAsync(250);

    expect(doRenderSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('starts and stops freeze diagnostics with the app lifecycle', () => {
    const diagnostics = {
      start: vi.fn(),
      stop: vi.fn(),
      recordKeypress: vi.fn(),
      recordRenderRequested: vi.fn(),
      recordRenderCompleted: vi.fn(),
      recordTranscriptMutation: vi.fn(),
    };

    const app = new App({
      onSubmit: () => {},
      onAbort: () => {},
      onExit: () => {},
    }, '/tmp/project', diagnostics as never);

    app.start();
    app.stop();

    expect(diagnostics.start).toHaveBeenCalledTimes(1);
    expect(diagnostics.stop).toHaveBeenCalledTimes(1);
  });

  it('retries a failed render with a forced redraw instead of crashing', async () => {
    renderState.throwCount = 1;

    const app = new App({
      onSubmit: () => {},
      onAbort: () => {},
      onExit: () => {},
    }, '/tmp/project');

    app.tui.requestRender();
    await vi.runAllTimersAsync();

    expect(doRenderSpy).toHaveBeenCalledTimes(2);
    expect(logErrorSpy).toHaveBeenCalledTimes(1);
    expect(logWarnSpy).toHaveBeenCalledWith('[TUI] render recovered via forced redraw');
    expect((app.tui as unknown as Record<string, unknown>)['previousLines']).toEqual([]);
    expect((app.tui as unknown as Record<string, unknown>)['previousWidth']).toBe(-1);
  });

  it('logs a traced render start and end for the next render', async () => {
    const app = new App({
      onSubmit: () => {},
      onAbort: () => {},
      onExit: () => {},
    }, '/tmp/project');

    app.traceNextRender('tool-start:Write:tool-1');
    app.tui.requestRender();
    await vi.runAllTimersAsync();

    expect(logDebugSpy).toHaveBeenCalledWith('[TUI] render start', expect.objectContaining({
      reasons: ['tool-start:Write:tool-1'],
    }));
    expect(logDebugSpy).toHaveBeenCalledWith('[TUI] render end', expect.objectContaining({
      reasons: ['tool-start:Write:tool-1'],
    }));
  });
});
