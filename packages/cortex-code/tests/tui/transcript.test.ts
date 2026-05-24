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

    constructor(...args: unknown[]) {
      this.args = args;
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

    constructor(groupKind: string) {
      this.groupKind = groupKind;
    }

    startToolCall(id: string): void {
      this.starts.push(id);
    }

    completeToolCall(): void {}
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
    userMessageBg: (text: string) => text,
  },
  markdownTheme: {},
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
