import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestRenderSpy = vi.fn();
const toolDisposeSpy = vi.fn();

vi.mock('@mariozechner/pi-tui', () => {
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
    constructor(..._args: unknown[]) {}
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

vi.mock('../../src/tui/theme.js', () => ({
  colors: {
    primary: (text: string) => text,
    primaryMuted: (text: string) => text,
    muted: (text: string) => text,
    userMessageBg: (text: string) => text,
  },
  markdownTheme: {},
}));

import { Container } from '@mariozechner/pi-tui';
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
