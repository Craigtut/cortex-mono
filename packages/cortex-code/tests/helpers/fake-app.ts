/**
 * A recording stand-in for the TUI App.
 *
 * Session tests assert on what the USER would see (a spinner that stays up,
 * a bubble that fills with the wrong loop's prose), so the fake records
 * every call in order rather than merely absorbing it.
 */

import { vi } from 'vitest';

export interface FakeApp {
  /** Ordered log of TUI calls, e.g. 'hideStatusSpinner', 'transcript.startAssistantMessage'. */
  calls: string[];
  /** Text appended to the assistant bubble, in order. */
  assistantChunks: string[];
  /** Text passed to finalizeAssistantMessage, in order. */
  finalized: Array<string | undefined>;
  /** True while a status spinner is showing. */
  spinnerVisible: boolean;
  /**
   * Accumulated footer state, merged from every `updateStatus` partial the
   * way the real App does. Tests feed this to a real StatusBar rather than
   * constructing renderer input themselves: what is under test is whether the
   * session's state reaches the footer, and a hand-built input would skip
   * exactly that half.
   */
  statusState: Record<string, unknown>;
  transcript: Record<string, ReturnType<typeof vi.fn>>;
  [k: string]: unknown;
}

export function createFakeApp(): FakeApp {
  const calls: string[] = [];
  const assistantChunks: string[] = [];
  const finalized: Array<string | undefined> = [];
  const record = (name: string) => vi.fn((..._args: unknown[]) => { calls.push(name); });

  const app: FakeApp = {
    calls,
    assistantChunks,
    finalized,
    spinnerVisible: false,
    statusState: {},
    transcript: {
      addUserMessage: record('transcript.addUserMessage'),
      addNotification: record('transcript.addNotification'),
      startAssistantMessage: record('transcript.startAssistantMessage'),
      appendAssistantChunk: vi.fn((chunk: string) => {
        calls.push('transcript.appendAssistantChunk');
        assistantChunks.push(chunk);
      }),
      finalizeAssistantMessage: vi.fn((text?: string) => {
        calls.push('transcript.finalizeAssistantMessage');
        finalized.push(text);
      }),
      closeActiveToolGroups: record('transcript.closeActiveToolGroups'),
      startToolCall: record('transcript.startToolCall'),
      updateToolCall: record('transcript.updateToolCall'),
      completeToolCall: record('transcript.completeToolCall'),
      failToolCall: record('transcript.failToolCall'),
      startSubAgentCall: record('transcript.startSubAgentCall'),
      completeSubAgentCall: record('transcript.completeSubAgentCall'),
      failSubAgentCall: record('transcript.failSubAgentCall'),
      setRetryStatus: record('transcript.setRetryStatus'),
      clearRetryStatus: record('transcript.clearRetryStatus'),
      addBanner: record('transcript.addBanner'),
    },
    showStatusSpinner: vi.fn(() => {
      calls.push('showStatusSpinner');
      app.spinnerVisible = true;
    }),
    hideStatusSpinner: vi.fn(() => {
      calls.push('hideStatusSpinner');
      app.spinnerVisible = false;
    }),
    focusEditor: record('focusEditor'),
    updateStatus: vi.fn((partial: Record<string, unknown>) => {
      calls.push('updateStatus');
      Object.assign(app.statusState, partial);
    }),
    removeWorkingTagSubtitle: record('removeWorkingTagSubtitle'),
    enqueueWorkingTagText: record('enqueueWorkingTagText'),
    traceNextRender: record('traceNextRender'),
    refreshCommands: record('refreshCommands'),
    start: record('start'),
    stop: record('stop'),
    terminal: { setTitle: vi.fn() },
    tui: { showOverlay: vi.fn() },
  };
  return app;
}
