import { Container, Text, Markdown, Spacer } from '@mariozechner/pi-tui';
import type { TUI } from '@mariozechner/pi-tui';
import { colors, markdownTheme } from './theme.js';
import { ToolExecutionComponent } from './renderers/tool-execution.js';
// Import renderers to trigger their self-registration with the registry
import './renderers/read-renderer.js';
import './renderers/edit-renderer.js';
import './renderers/write-renderer.js';
import './renderers/bash-renderer.js';
import './renderers/grep-renderer.js';
import './renderers/glob-renderer.js';
import './renderers/web-fetch-renderer.js';
import './renderers/sub-agent-renderer.js';
import './renderers/task-output-renderer.js';
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
  private toolCalls = new Map<string, ToolExecutionComponent>();
  /** Live background sub-agent rows pinned near the bottom of the layout. */
  private backgroundSubAgents = new Map<string, { component: ToolExecutionComponent; completed: boolean }>();
  private backgroundOrder: string[] = [];
  /** Throttle renders to avoid overwhelming the terminal during rapid events. */
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRenderTime = 0;
  private static readonly MIN_RENDER_INTERVAL_MS = 100;
  private static readonly MAX_BACKGROUND_ROWS = 4;

  constructor(
    private chatContainer: Container,
    private tui: TUI,
    private activityContainer: Container,
  ) {}

  /**
   * Request a TUI render, throttled to avoid flooding the terminal with output
   * during rapid event bursts (tool calls, streaming chunks).
   */
  private throttledRender(): void {
    const now = Date.now();
    const elapsed = now - this.lastRenderTime;

    if (elapsed >= TranscriptManager.MIN_RENDER_INTERVAL_MS) {
      this.lastRenderTime = now;
      this.tui.requestRender();
    } else if (!this.renderTimer) {
      const delay = TranscriptManager.MIN_RENDER_INTERVAL_MS - elapsed;
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null;
        this.lastRenderTime = Date.now();
        this.tui.requestRender();
      }, delay);
    }
  }

  /** Force an immediate render (for user-initiated actions like submit). */
  private immediateRender(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    this.lastRenderTime = Date.now();
    this.tui.requestRender();
  }

  /** Add the startup banner to the transcript. */
  addBanner(version: string, project: string, branch: string): void {
    this.chatContainer.addChild(new Spacer(1));

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
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(text, 2, 1, colors.userMessageBg));
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
    this.currentAssistantMarkdown!.setText(this.currentAssistantText);
    this.throttledRender();
  }

  /** Finalize the current assistant message (e.g., strip working tags). */
  finalizeAssistantMessage(finalText?: string): void {
    if (this.currentAssistantMarkdown && finalText !== undefined) {
      this.currentAssistantText = finalText;
      this.currentAssistantMarkdown.setText(finalText);
    }
    this.finalizeCurrentAssistant();
    this.immediateRender();
  }

  /**
   * Start a tool call display with per-tool rendering.
   * Freezes the current assistant message and adds the tool execution inline.
   */
  startToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
    // Freeze current assistant message (Mastra Code pattern)
    this.freezeCurrentAssistant();

    const toolComponent = new ToolExecutionComponent(toolName, this.tui);
    toolComponent.start(args);
    this.toolCalls.set(toolCallId, toolComponent);
    this.chatContainer.addChild(toolComponent);
    this.throttledRender();
  }

  /** Start a sub-agent call, routing background work to the activity panel. */
  startSubAgentCall(toolCallId: string, args: Record<string, unknown>): void {
    if (!args['background']) {
      this.startToolCall(toolCallId, 'SubAgent', args);
      return;
    }

    const toolComponent = new ToolExecutionComponent('SubAgent', this.tui);
    toolComponent.start(args);
    this.backgroundSubAgents.set(toolCallId, { component: toolComponent, completed: false });
    this.backgroundOrder.push(toolCallId);
    this.activityContainer.addChild(toolComponent);
    this.pruneBackgroundSubAgents();
    this.throttledRender();
  }

  /** Update a tool call with streaming partial result. */
  updateToolCall(toolCallId: string, partialResult: unknown): void {
    const tc = this.toolCalls.get(toolCallId);
    if (tc) {
      tc.streamUpdate(partialResult);
      this.throttledRender();
    }
  }

  /** Complete a tool call with its result. */
  completeToolCall(toolCallId: string, result: unknown, details: unknown, durationMs: number): void {
    const tc = this.toolCalls.get(toolCallId);
    if (tc) {
      tc.complete(result, details, durationMs);
    }
    this.currentAssistantText = '';
    this.currentAssistantMarkdown = null;
    this.throttledRender();
  }

  /** Complete a sub-agent call from either the transcript or background panel. */
  completeSubAgentCall(
    toolCallId: string,
    result: unknown,
    status: string,
    usage: unknown,
  ): void {
    const u = typeof usage === 'object' && usage !== null
      ? usage as Record<string, unknown>
      : {};
    const details = {
      background: this.backgroundSubAgents.has(toolCallId),
      turns: Number(u['turns'] ?? 0),
      durationMs: Number(u['durationMs'] ?? 0),
      cost: Number(u['cost'] ?? 0),
      status,
      toolCalls: u['toolCalls'],
    };
    const durationMs = Number(u['durationMs'] ?? 0);

    const background = this.backgroundSubAgents.get(toolCallId);
    if (background) {
      background.component.complete(result, details, durationMs);
      background.completed = true;
      this.pruneBackgroundSubAgents();
      this.throttledRender();
      return;
    }

    this.completeToolCall(toolCallId, result, details, durationMs);
  }

  /** Fail a tool call with an error. */
  failToolCall(toolCallId: string, error: string, durationMs: number): void {
    const tc = this.toolCalls.get(toolCallId);
    if (tc) {
      tc.fail(error, durationMs);
    }
    this.currentAssistantText = '';
    this.currentAssistantMarkdown = null;
    this.throttledRender();
  }

  /** Fail a sub-agent call from either the transcript or background panel. */
  failSubAgentCall(toolCallId: string, error: string): void {
    const background = this.backgroundSubAgents.get(toolCallId);
    if (background) {
      background.component.fail(error, 0);
      background.completed = true;
      this.pruneBackgroundSubAgents();
      this.throttledRender();
      return;
    }

    this.failToolCall(toolCallId, error, 0);
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

  /** Remove a permission prompt after the user has decided. */
  removePermissionPrompt(prompt: PermissionPromptComponent): void {
    this.chatContainer.removeChild(prompt);
  }

  /** Toggle expand/collapse for the most recent tool (Ctrl+E). */
  toggleExpand(): void {
    const lastFocused = ToolExecutionComponent.lastFocused;
    if (lastFocused) {
      lastFocused.toggleExpand();
      this.tui.requestRender();
    }
  }

  /** Toggle expand/collapse for all tool results (Ctrl+Shift+E). */
  toggleExpandAll(): void {
    // Detect majority state: if any are collapsed, expand all; otherwise collapse all
    let anyCollapsed = false;
    for (const tc of this.getAllToolComponents()) {
      if (!tc.isExpanded) {
        anyCollapsed = true;
        break;
      }
    }
    const targetState = anyCollapsed; // expand if any collapsed, collapse if all expanded

    for (const tc of this.getAllToolComponents()) {
      if (tc.isExpanded !== targetState) {
        tc.toggleExpand();
      }
    }
    this.tui.requestRender();
  }

  /** Clear the transcript. */
  clear(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    for (const tc of this.toolCalls.values()) {
      tc.dispose();
    }
    for (const activity of this.backgroundSubAgents.values()) {
      activity.component.dispose();
    }
    this.chatContainer.clear();
    this.activityContainer.clear();
    this.currentAssistantMarkdown = null;
    this.currentAssistantText = '';
    this.toolCalls.clear();
    this.backgroundSubAgents.clear();
    this.backgroundOrder = [];
  }

  private *getAllToolComponents(): Iterable<ToolExecutionComponent> {
    yield* this.toolCalls.values();
    for (const activity of this.backgroundSubAgents.values()) {
      yield activity.component;
    }
  }

  private pruneBackgroundSubAgents(): void {
    // Remove completed background sub-agents from the activity panel immediately.
    // The parent agent processes the result in the normal chat flow, so the
    // completed box doesn't need to stay pinned at the bottom.
    for (const taskId of [...this.backgroundOrder]) {
      const activity = this.backgroundSubAgents.get(taskId);
      if (!activity?.completed) continue;

      activity.component.dispose();
      this.activityContainer.removeChild(activity.component);
      this.backgroundSubAgents.delete(taskId);
      this.backgroundOrder = this.backgroundOrder.filter(id => id !== taskId);
    }

    // Prune oldest running sub-agents if over the limit
    while (this.backgroundOrder.length > TranscriptManager.MAX_BACKGROUND_ROWS) {
      const removableIndex = this.backgroundOrder.findIndex((id) => this.backgroundSubAgents.get(id)?.completed);
      if (removableIndex === -1) break;

      const [taskId] = this.backgroundOrder.splice(removableIndex, 1);
      if (!taskId) break;

      const activity = this.backgroundSubAgents.get(taskId);
      if (!activity) continue;

      activity.component.dispose();
      this.activityContainer.removeChild(activity.component);
      this.backgroundSubAgents.delete(taskId);
    }
  }

  /** Freeze the current assistant message (stop updating it). */
  private freezeCurrentAssistant(): void {
    if (this.currentAssistantMarkdown) {
      this.currentAssistantMarkdown = null;
      this.currentAssistantText = '';
    }
  }

  /** Finalize and detach the current assistant message. */
  private finalizeCurrentAssistant(): void {
    if (this.currentAssistantMarkdown) {
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
