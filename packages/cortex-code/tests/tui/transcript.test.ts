import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestRenderSpy = vi.fn();
const toolDisposeSpy = vi.fn();

vi.mock('@earendil-works/pi-tui', () => {
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

  class MockText {
    args: unknown[];
    text: unknown;

    constructor(...args: unknown[]) {
      this.args = args;
      this.text = args[0];
    }

    setText(text: string): void {
      this.text = text;
    }
  }

  class MockMarkdown {
    text = '';

    constructor(text: string, ..._args: unknown[]) {
      this.text = text;
    }

    setText(text: string): void {
      this.text = text;
    }
  }

  class MockSpacer {
    constructor(..._args: unknown[]) {}
  }

  return {
    Container: MockContainer,
    Text: MockText,
    Markdown: MockMarkdown,
    Spacer: MockSpacer,
  };
});

vi.mock('../../src/tui/renderers/read-renderer.js', () => ({}));
vi.mock('../../src/tui/renderers/edit-renderer.js', () => ({}));
vi.mock('../../src/tui/renderers/write-renderer.js', () => ({}));
vi.mock('../../src/tui/renderers/bash-renderer.js', () => ({}));
vi.mock('../../src/tui/renderers/grep-renderer.js', () => ({}));
vi.mock('../../src/tui/renderers/glob-renderer.js', () => ({}));
vi.mock('../../src/tui/renderers/web-fetch-renderer.js', () => ({}));
vi.mock('../../src/tui/renderers/sub-agent-renderer.js', () => ({}));
vi.mock('../../src/tui/renderers/task-output-renderer.js', () => ({}));
vi.mock('../../src/tui/renderers/tool-execution.js', () => ({
  ToolExecutionComponent: class MockToolExecutionComponent {
    static lastFocused: MockToolExecutionComponent | null = null;
    isExpanded = false;

    constructor(..._args: unknown[]) {}

    start(): void {}
    streamUpdate(): void {}
    complete(): void {}
    fail(): void {}

    toggleExpand(): void {
      this.isExpanded = !this.isExpanded;
    }

    dispose(): void {
      toolDisposeSpy();
    }
  },
}));

vi.mock('../../src/tui/renderers/tool-group.js', () => ({
  ToolGroupComponent: class MockToolGroupComponent {
    readonly groupKind: string;
    isExpanded = false;
    starts: string[] = [];
    completeArgs: unknown[][] = [];

    constructor(groupKind: string) {
      this.groupKind = groupKind;
    }

    startToolCall(id: string): void {
      this.starts.push(id);
    }

    completeToolCall(...args: unknown[]): void {
      this.completeArgs.push(args);
    }
    failToolCall(): void {}
    close(): void {}

    toggleExpand(): void {
      this.isExpanded = !this.isExpanded;
    }

    dispose(): void {
      toolDisposeSpy();
    }
  },
}));

vi.mock('../../src/tui/theme.js', () => ({
  colors: {
    primary: (text: string) => text,
    primaryMuted: (text: string) => text,
    muted: (text: string) => text,
    accent: (text: string) => text,
    error: (text: string) => text,
    success: (text: string) => text,
    userMessageBg: (text: string) => text,
  },
  markdownTheme: {},
  palette: {
    accentBright: '#B8E23E',
    accentMid: '#81A52E',
    accentDeep: '#4A691F',
  },
}));

import { Container } from '@earendil-works/pi-tui';
import { TranscriptManager } from '../../src/tui/transcript.js';

describe('TranscriptManager', () => {
  beforeEach(() => {
    requestRenderSpy.mockClear();
    toolDisposeSpy.mockClear();
  });

  it('requests an immediate render when finalizing the assistant message', () => {
    const chat = new Container();
    const tui = { requestRender: requestRenderSpy };
    const transcript = new TranscriptManager(chat as never, tui as never);

    transcript.startAssistantMessage();
    transcript.finalizeAssistantMessage('done');

    expect(requestRenderSpy).toHaveBeenCalledTimes(1);
  });

  it('routes background subagents to the chat container inline', () => {
    const chat = new Container();
    const tui = { requestRender: requestRenderSpy };
    const transcript = new TranscriptManager(chat as never, tui as never);

    transcript.startSubAgentCall('task-1', {
      instructions: 'do work',
      background: true,
    });

    // Background sub-agents go inline in the chat, same as foreground
    expect(chat.children).toHaveLength(1);
  });

  it('groups consecutive exploration tools into one transcript row', () => {
    const chat = new Container();
    const tui = { requestRender: requestRenderSpy };
    const transcript = new TranscriptManager(chat as never, tui as never);

    transcript.startToolCall('tool-1', 'Glob', { pattern: '**/*.ts' });
    transcript.completeToolCall('tool-1', {}, { totalCount: 3 }, 10);
    transcript.startToolCall('tool-2', 'Read', { file_path: '/tmp/project/src/index.ts' });

    expect(chat.children).toHaveLength(1);
  });

  it('forwards the tool result (not just details) to the grouped component', () => {
    const chat = new Container();
    const tui = { requestRender: requestRenderSpy };
    const transcript = new TranscriptManager(chat as never, tui as never);

    transcript.startToolCall('w-1', 'Write', { file_path: '/etc/hosts' });
    const result = { content: [{ type: 'text', text: 'You must Read this file first.' }] };
    const details = { filePath: '/etc/hosts', isCreate: false, bytesWritten: 0, diff: null };
    transcript.completeToolCall('w-1', result, details, 5);

    // The grouped component must receive (id, result, details, durationMs) so it
    // can detect a refusal and show the message. Dropping result was the bug.
    const group = chat.children[0] as { completeArgs: unknown[][] };
    expect(group.completeArgs).toHaveLength(1);
    expect(group.completeArgs[0]).toEqual(['w-1', result, details, 5]);
  });

  it('keeps exploration grouped across hidden assistant turns', () => {
    const chat = new Container();
    const tui = { requestRender: requestRenderSpy };
    const transcript = new TranscriptManager(chat as never, tui as never);

    transcript.startToolCall('tool-1', 'Glob', { pattern: '**/*.ts' });
    transcript.completeToolCall('tool-1', {}, { totalCount: 3 }, 10);
    transcript.startAssistantMessage();
    transcript.appendAssistantChunk('<working>checking what to read next</working>');
    transcript.startToolCall('tool-2', 'Read', { file_path: '/tmp/project/src/index.ts' });

    expect(chat.children).toHaveLength(1);
  });

  it('does not duplicate streamed assistant text when a tool turn finalizes', () => {
    const chat = new Container();
    const tui = { requestRender: requestRenderSpy };
    const transcript = new TranscriptManager(chat as never, tui as never);
    const leakedToolText = '<multi_tool_use.parallel THOOK use across the entire codebase.>';

    transcript.startAssistantMessage();
    transcript.appendAssistantChunk(leakedToolText);
    transcript.startToolCall('tool-1', 'Bash', { command: 'echo ok' });
    transcript.completeToolCall('tool-1', {}, {}, 10);
    transcript.finalizeAssistantMessage(leakedToolText);

    const markdownTexts = chat.children
      .filter((child): child is { text: string } => (
        typeof child === 'object' &&
        child !== null &&
        typeof (child as { text?: unknown }).text === 'string'
      ))
      .map(child => child.text);

    expect(markdownTexts).toEqual([leakedToolText]);
  });

  it('renders routine single-line notifications compactly', () => {
    const chat = new Container();
    const tui = { requestRender: requestRenderSpy };
    const transcript = new TranscriptManager(chat as never, tui as never);

    transcript.addNotification('Model', 'Switched to gpt-5.5.');

    expect(chat.children).toHaveLength(1);
  });

  it('renders a single-line error as one compact alert with a glyph and action', () => {
    const chat = new Container();
    const tui = { requestRender: requestRenderSpy };
    const transcript = new TranscriptManager(chat as never, tui as never);

    transcript.addNotification('Authentication expired', '', {
      severity: 'error',
      action: 'run /login to reconnect',
    });

    expect(chat.children).toHaveLength(1);
    const text = (chat.children[0] as { text: string }).text;
    expect(text).toContain('✕');
    expect(text).toContain('Authentication expired');
    expect(text).toContain('run /login to reconnect');
    // No heavyweight box rule.
    expect(text).not.toContain('───');
  });

  it('renders a multi-line notification as a light glyph header over its body', () => {
    const chat = new Container();
    const tui = { requestRender: requestRenderSpy };
    const transcript = new TranscriptManager(chat as never, tui as never);

    transcript.addNotification(
      'Available Commands',
      '  /help  Show help\n  /model  Switch model',
    );

    // Glyph header + raw body + trailing spacer, and no full-width rule.
    expect(chat.children).toHaveLength(3);
    const header = (chat.children[0] as { text: string }).text;
    expect(header).toContain('Available Commands');
    expect(header).not.toContain('───');
    const body = (chat.children[1] as { text: string }).text;
    expect(body).toContain('/help');
    expect(body).toContain('/model');
  });

  it('shows a single in-place retry status line and updates it in place', () => {
    const chat = new Container();
    const activity = new Container();
    const tui = { requestRender: requestRenderSpy };
    const transcript = new TranscriptManager(chat as never, tui as never, activity as never);

    transcript.setRetryStatus({
      phase: 'waiting',
      attempt: 1,
      maxAttempts: 20,
      secondsRemaining: 120,
      detail: 'fetch failed: read ECONNRESET',
    });
    expect(activity.children).toHaveLength(1);
    const line = activity.children[0] as { args: unknown[]; setText?: (t: string) => void };

    // Updating reuses the same node (in place), not a new child.
    transcript.setRetryStatus({ phase: 'waiting', attempt: 1, maxAttempts: 20, secondsRemaining: 60 });
    expect(activity.children).toHaveLength(1);
    expect(activity.children[0]).toBe(line);

    // The retry line never goes in the transcript flow.
    expect(chat.children).toHaveLength(0);
  });

  it('clears the retry status line', () => {
    const chat = new Container();
    const activity = new Container();
    const tui = { requestRender: requestRenderSpy };
    const transcript = new TranscriptManager(chat as never, tui as never, activity as never);

    transcript.setRetryStatus({ phase: 'failed', attempt: 3, maxAttempts: 3, detail: 'read ECONNRESET' });
    expect(activity.children).toHaveLength(1);

    transcript.clearRetryStatus();
    expect(activity.children).toHaveLength(0);
  });

  it('disposes transcript rows when clearing', () => {
    const chat = new Container();
    const tui = { requestRender: requestRenderSpy };
    const transcript = new TranscriptManager(chat as never, tui as never);

    transcript.startToolCall('tool-1', 'Read', {});
    transcript.startSubAgentCall('task-1', {
      instructions: 'do work',
      background: true,
    });
    transcript.clear();

    expect(toolDisposeSpy).toHaveBeenCalledTimes(2);
  });
});
