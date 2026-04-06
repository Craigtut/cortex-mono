import { Container, Text, Markdown, Spacer } from '@mariozechner/pi-tui';
import type { TUI } from '@mariozechner/pi-tui';
import { colors, markdownTheme } from './theme.js';
import { ToolCallComponent } from './tool-display.js';
import { SubAgentComponent } from './sub-agent-display.js';
import type { PermissionPromptComponent } from './permissions.js';

/**
 * Manages the chatContainer: adds child components for each message,
 * tool call, notification, and permission prompt.
 *
 * Follows the Mastra Code pattern: when a tool call starts mid-message,
 * the current assistant message is frozen and a new one starts after
 * the tool component.
 */
export class TranscriptManager {
  /** The current streaming assistant message Markdown component. */
  private currentAssistantMarkdown: Markdown | null = null;
  /** Accumulated text for the current streaming assistant message. */
  private currentAssistantText = '';
  /** Map of active tool call components by tool call ID. */
  private toolCalls = new Map<string, ToolCallComponent>();
  /** Map of active sub-agent components by task ID. */
  private subAgents = new Map<string, SubAgentComponent>();
  /** Throttle renders to avoid overwhelming the terminal during rapid events. */
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRenderTime = 0;
  private static readonly MIN_RENDER_INTERVAL_MS = 100;

  constructor(
    private chatContainer: Container,
    private tui: TUI,
  ) {}

  /**
   * Request a TUI render, throttled to avoid flooding the terminal with output
   * during rapid event bursts (tool calls, streaming chunks). This prevents
   * the terminal from force-scrolling to the bottom on every event.
   */
  private throttledRender(): void {
    const now = Date.now();
    const elapsed = now - this.lastRenderTime;

    if (elapsed >= TranscriptManager.MIN_RENDER_INTERVAL_MS) {
      // Enough time has passed, render immediately
      this.lastRenderTime = now;
      this.throttledRender();
    } else if (!this.renderTimer) {
      // Schedule a render for when the throttle window expires
      const delay = TranscriptManager.MIN_RENDER_INTERVAL_MS - elapsed;
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null;
        this.lastRenderTime = Date.now();
        this.throttledRender();
      }, delay);
    }
    // If a timer is already pending, skip (the pending render will pick up all changes)
  }

  /** Force an immediate render (for user-initiated actions like submit). */
  private immediateRender(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    this.lastRenderTime = Date.now();
    this.throttledRender();
  }

  /** Add the startup banner to the transcript. */
  addBanner(version: string, project: string, branch: string): void {
    this.chatContainer.addChild(new Spacer(1));

    // Each line as its own Text component to prevent word-wrapping from breaking alignment.
    // Block characters (U+2588 etc.) are full-width in some terminals, so each line
    // must render independently.
    const artLines = [
      '   ██████╗ ██████╗ ██████╗ ████████╗███████╗██╗  ██╗',
      '  ██╔════╝██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝',
      '  ██║     ██║   ██║██████╔╝   ██║   █████╗   ╚███╔╝',
      '  ██║     ██║   ██║██╔══██╗   ██║   ██╔══╝   ██╔██╗',
      '  ╚██████╗╚██████╔╝██║  ██║   ██║   ███████╗██╔╝ ██╗',
      '   ╚═════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝',
    ];
    for (const line of artLines) {
      this.chatContainer.addChild(new Text(colors.primary(line), 0, 0));
    }
    this.chatContainer.addChild(new Text('                                                     ' + colors.primaryMuted('code'), 0, 0));
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(colors.muted(`  v${version}`), 0, 0));
    this.chatContainer.addChild(new Text(colors.muted(`  Project: ${project}`), 0, 0));
    if (branch) {
      this.chatContainer.addChild(new Text(colors.muted(`  Branch: ${branch}`), 0, 0));
    }
    this.chatContainer.addChild(new Text(colors.muted('  /help for commands'), 0, 0));
    this.chatContainer.addChild(new Spacer(1));
  }

  /** Add a user message to the transcript. */
  addUserMessage(text: string): void {
    this.finalizeCurrentAssistant();
    this.chatContainer.addChild(new Text(text, 2, 0, colors.userMessageBg));
    this.chatContainer.addChild(new Spacer(1));
  }

  /** Start a new assistant message (renders streaming content). */
  startAssistantMessage(): void {
    this.finalizeCurrentAssistant();
    this.currentAssistantText = '';
    this.currentAssistantMarkdown = new Markdown('', 0, 0, markdownTheme);
    this.chatContainer.addChild(this.currentAssistantMarkdown);
  }

  /** Append streaming text to the current assistant message. */
  appendAssistantChunk(chunk: string): void {
    if (!this.currentAssistantMarkdown) {
      this.startAssistantMessage();
    }
    this.currentAssistantText += chunk;
    // Full re-render with accumulated text.
    // Pi-tui's differential renderer only redraws changed lines.
    this.currentAssistantMarkdown!.setText(this.currentAssistantText);
    // Request a TUI render so the update is visible immediately
    this.throttledRender();
  }

  /** Finalize the current assistant message (e.g., strip working tags). */
  finalizeAssistantMessage(finalText?: string): void {
    if (this.currentAssistantMarkdown && finalText !== undefined) {
      this.currentAssistantText = finalText;
      this.currentAssistantMarkdown.setText(finalText);
    }
    this.finalizeCurrentAssistant();
  }

  /**
   * Start a tool call display.
   * Freezes the current assistant message and adds the tool call inline.
   */
  startToolCall(toolCallId: string, toolName: string, argsSummary: string): void {
    // SubAgent tool calls are displayed via the SubAgentComponent (Agent line),
    // not as a separate tool call line. Skip rendering to avoid duplication.
    if (toolName === 'SubAgent') return;

    // Freeze current assistant message (Mastra Code pattern)
    this.freezeCurrentAssistant();

    const toolComponent = new ToolCallComponent(this.tui, toolName, argsSummary);
    this.toolCalls.set(toolCallId, toolComponent);
    this.chatContainer.addChild(toolComponent);
    this.throttledRender();
  }

  /** Complete a tool call with its result. */
  completeToolCall(toolCallId: string, result: string, durationMs: number): void {
    const tc = this.toolCalls.get(toolCallId);
    if (tc) {
      tc.complete(result, durationMs);
    }
    // Start a new assistant message segment for any post-tool text
    this.currentAssistantText = '';
    this.currentAssistantMarkdown = new Markdown('', 0, 0, markdownTheme);
    this.chatContainer.addChild(this.currentAssistantMarkdown);
    this.throttledRender();
  }

  /** Fail a tool call with an error. */
  failToolCall(toolCallId: string, error: string, durationMs: number): void {
    const tc = this.toolCalls.get(toolCallId);
    if (tc) {
      tc.fail(error, durationMs);
    }
    // Start a new assistant message segment
    this.currentAssistantText = '';
    this.currentAssistantMarkdown = new Markdown('', 0, 0, markdownTheme);
    this.chatContainer.addChild(this.currentAssistantMarkdown);
    this.throttledRender();
  }

  /** Start a sub-agent display with tree-drawing characters. */
  startSubAgent(taskId: string, description: string): void {
    this.freezeCurrentAssistant();
    const component = new SubAgentComponent(this.tui, taskId, description);
    this.subAgents.set(taskId, component);
    this.chatContainer.addChild(component);
  }

  /** Complete a sub-agent with its result and usage stats. */
  completeSubAgent(
    taskId: string,
    result: string,
    usage: { tokenCount: number; durationMs: number; cost: number },
  ): void {
    const sa = this.subAgents.get(taskId);
    if (sa) {
      sa.complete(result, usage);
    }
  }

  /** Fail a sub-agent. */
  failSubAgent(taskId: string, error: string): void {
    const sa = this.subAgents.get(taskId);
    if (sa) {
      sa.fail(error);
    }
  }

  /** Add a system notification (compaction, error, etc.). */
  addNotification(title: string, message: string): void {
    const header = colors.primaryMuted(`\u2500\u2500\u2500 ${title} ` + '\u2500'.repeat(Math.max(0, 56 - title.length)));
    this.chatContainer.addChild(new Text(header));
    this.chatContainer.addChild(new Text(colors.muted(message)));
    this.chatContainer.addChild(new Spacer(1));
    this.immediateRender();
  }

  /** Add a permission prompt inline in the transcript. */
  addPermissionPrompt(prompt: PermissionPromptComponent): void {
    this.chatContainer.addChild(prompt);
  }

  /** Toggle global expand/collapse for all tool results. */
  toggleGlobalExpand(): void {
    ToolCallComponent.globalExpanded = !ToolCallComponent.globalExpanded;
    for (const tc of this.toolCalls.values()) {
      tc.setExpanded(ToolCallComponent.globalExpanded);
    }
  }

  /** Clear the transcript. */
  clear(): void {
    this.chatContainer.clear();
    this.currentAssistantMarkdown = null;
    this.currentAssistantText = '';
    this.toolCalls.clear();
    this.subAgents.clear();
  }

  /** Freeze the current assistant message (stop updating it). */
  private freezeCurrentAssistant(): void {
    if (this.currentAssistantMarkdown) {
      // The Markdown component stays in the container with its last content.
      // We just stop tracking it so new text goes to a new component.
      this.currentAssistantMarkdown = null;
      this.currentAssistantText = '';
    }
  }

  /** Finalize and detach the current assistant message. */
  private finalizeCurrentAssistant(): void {
    if (this.currentAssistantMarkdown) {
      // Remove empty trailing markdown components
      if (!this.currentAssistantText.trim()) {
        this.chatContainer.removeChild(this.currentAssistantMarkdown);
      } else {
        this.chatContainer.addChild(new Spacer(1));
      }
      this.currentAssistantMarkdown = null;
      this.currentAssistantText = '';
    }
  }
}
