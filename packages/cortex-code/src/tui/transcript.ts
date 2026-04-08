import { Container, Text, Markdown, Spacer } from '@mariozechner/pi-tui';
import type { TUI } from '@mariozechner/pi-tui';
import { stripWorkingTags } from '@animus-labs/cortex';
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
import type { FreezeDiagnostics } from '../diagnostics/freeze.js';

/**
 * Manages the chatContainer: adds child components for each message,
 * tool call, notification, and permission prompt.
 *
 * Follows the Mastra Code pattern: when a tool call starts mid-message,
 * the current assistant message is frozen and a new one starts after
 * the tool component.
 */

/** Tools that render as compact single-line summaries (no content box). */
const COMPACT_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'Write', 'WebFetch', 'TaskOutput',
]);

type TranscriptItemCategory = 'compact-tool' | 'other' | 'spacer' | null;

export class TranscriptManager {
  /** The current streaming assistant message Markdown component. */
  private currentAssistantMarkdown: Markdown | null = null;
  /** Accumulated text for the current streaming assistant message. */
  private currentAssistantText = '';
  /** Map of active tool call components by tool call ID. */
  private toolCalls = new Map<string, ToolExecutionComponent>();
  /** Track running sub-agent IDs for the activity indicator. */
  private runningSubAgents = new Set<string>();
  private activityIndicator: Text | null = null;
  /** Tracks the category of the last item added to chatContainer for spacing decisions. */
  private lastAddedItemCategory: TranscriptItemCategory = null;
  /** Throttle renders to avoid overwhelming the terminal during rapid events. */
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRenderTime = 0;
  private static readonly MIN_RENDER_INTERVAL_MS = 100;

  constructor(
    private chatContainer: Container,
    private tui: TUI,
    private activityContainer?: Container,
    private diagnostics?: FreezeDiagnostics,
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

  /**
   * Add a spacer before a new item unless:
   * - Nothing has been added yet
   * - The previous item was already a spacer
   * - A compact tool follows another compact tool (keeps exploration blocks tight)
   */
  private maybeAddSpacer(isCompactTool: boolean): void {
    if (this.lastAddedItemCategory === null) return;
    if (this.lastAddedItemCategory === 'spacer') return;
    if (isCompactTool && this.lastAddedItemCategory === 'compact-tool') return;

    this.chatContainer.addChild(new Spacer(1));
    // Don't set lastAddedItemCategory here; the caller sets it for the actual item.
  }

  /** Add the startup banner to the transcript. */
  addBanner(version: string, project: string, branch: string): void {
    this.diagnostics?.recordTranscriptMutation('banner');
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
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(colors.muted(`  v${version}`), 0, 0));
    this.chatContainer.addChild(new Text(colors.muted(`  Project: ${project}`), 0, 0));
    if (branch) {
      this.chatContainer.addChild(new Text(colors.muted(`  Branch: ${branch}`), 0, 0));
    }
    this.chatContainer.addChild(new Text(colors.muted('  /help for commands'), 0, 0));
    this.chatContainer.addChild(new Spacer(1));
    this.lastAddedItemCategory = 'spacer';
  }

  /** Add a user message to the transcript. */
  addUserMessage(text: string): void {
    this.finalizeCurrentAssistant();
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(text, 2, 1, colors.userMessageBg));
    this.chatContainer.addChild(new Spacer(1));
    this.lastAddedItemCategory = 'spacer';
    this.diagnostics?.recordTranscriptMutation('user_message');
  }

  /** Start a new assistant message (renders streaming content). */
  startAssistantMessage(): void {
    this.finalizeCurrentAssistant();
    this.maybeAddSpacer(false);
    this.currentAssistantText = '';
    this.currentAssistantMarkdown = new Markdown('', 0, 0, markdownTheme);
    this.chatContainer.addChild(this.currentAssistantMarkdown);
    this.lastAddedItemCategory = 'other';
    this.diagnostics?.recordTranscriptMutation('assistant_start');
  }

  /** Append streaming text to the current assistant message. */
  appendAssistantChunk(chunk: string): void {
    if (!this.currentAssistantMarkdown) {
      this.startAssistantMessage();
    }
    this.currentAssistantText += chunk;
    // Strip working tags for display; raw text stays in currentAssistantText
    const displayText = stripWorkingTags(this.currentAssistantText);
    this.currentAssistantMarkdown!.setText(displayText);
    this.diagnostics?.recordTranscriptMutation('assistant_chunk');
    this.throttledRender();
  }

  /** Finalize the current assistant message (e.g., strip working tags). */
  finalizeAssistantMessage(finalText?: string): void {
    if (this.currentAssistantMarkdown && finalText !== undefined) {
      this.currentAssistantText = finalText;
      this.currentAssistantMarkdown.setText(finalText);
    }
    this.finalizeCurrentAssistant();
    this.diagnostics?.recordTranscriptMutation('assistant_final');
    this.immediateRender();
  }

  /**
   * Start a tool call display with per-tool rendering.
   * Freezes the current assistant message and adds the tool execution inline.
   */
  startToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
    // Freeze current assistant message (Mastra Code pattern)
    this.freezeCurrentAssistant();

    const isCompact = COMPACT_TOOLS.has(toolName);
    this.maybeAddSpacer(isCompact);

    const toolComponent = new ToolExecutionComponent(toolName, this.tui);
    toolComponent.start(args);
    this.toolCalls.set(toolCallId, toolComponent);
    this.chatContainer.addChild(toolComponent);
    this.lastAddedItemCategory = isCompact ? 'compact-tool' : 'other';
    this.diagnostics?.recordTranscriptMutation('tool_start');
    this.throttledRender();
  }

  /** Start a sub-agent call (foreground or background) inline in the chat. */
  startSubAgentCall(toolCallId: string, args: Record<string, unknown>): void {
    this.startToolCall(toolCallId, 'SubAgent', args);
    this.runningSubAgents.add(toolCallId);
    this.updateActivityIndicator();
  }

  /** Update a tool call with streaming partial result. */
  updateToolCall(toolCallId: string, partialResult: unknown): void {
    const tc = this.toolCalls.get(toolCallId);
    if (tc) {
      tc.streamUpdate(partialResult);
      this.diagnostics?.recordTranscriptMutation('tool_update');
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
    this.diagnostics?.recordTranscriptMutation('tool_complete');
    this.throttledRender();
  }

  /** Complete a sub-agent call. */
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
      background: false,
      turns: Number(u['turns'] ?? 0),
      durationMs: Number(u['durationMs'] ?? 0),
      cost: Number(u['cost'] ?? 0),
      status,
      toolCalls: u['toolCalls'],
    };
    const durationMs = Number(u['durationMs'] ?? 0);
    this.completeToolCall(toolCallId, result, details, durationMs);
    this.runningSubAgents.delete(toolCallId);
    this.updateActivityIndicator();
  }

  /** Fail a tool call with an error. */
  failToolCall(toolCallId: string, error: string, durationMs: number): void {
    const tc = this.toolCalls.get(toolCallId);
    if (tc) {
      tc.fail(error, durationMs);
    }
    this.currentAssistantText = '';
    this.currentAssistantMarkdown = null;
    this.diagnostics?.recordTranscriptMutation('tool_failed');
    this.throttledRender();
  }

  /** Fail a sub-agent call. */
  failSubAgentCall(toolCallId: string, error: string): void {
    this.failToolCall(toolCallId, error, 0);
    this.runningSubAgents.delete(toolCallId);
    this.updateActivityIndicator();
  }

  /** Add a system notification (compaction, error, etc.). */
  addNotification(title: string, message: string): void {
    this.maybeAddSpacer(false);
    const header = colors.primaryMuted(`\u2500\u2500\u2500 ${title} ` + '\u2500'.repeat(Math.max(0, 56 - title.length)));
    this.chatContainer.addChild(new Text(header));
    this.chatContainer.addChild(new Text(colors.muted(message)));
    this.chatContainer.addChild(new Spacer(1));
    this.lastAddedItemCategory = 'spacer';
    this.diagnostics?.recordTranscriptMutation('notification');
    this.immediateRender();
  }

  /** Add a permission prompt inline in the transcript. */
  addPermissionPrompt(prompt: PermissionPromptComponent): void {
    this.chatContainer.addChild(prompt);
    this.diagnostics?.recordTranscriptMutation('permission_prompt_added');
  }

  /** Remove a permission prompt after the user has decided. */
  removePermissionPrompt(prompt: PermissionPromptComponent): void {
    this.chatContainer.removeChild(prompt);
    this.diagnostics?.recordTranscriptMutation('permission_prompt_removed');
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
    for (const tc of this.toolCalls.values()) {
      if (!tc.isExpanded) {
        anyCollapsed = true;
        break;
      }
    }
    const targetState = anyCollapsed; // expand if any collapsed, collapse if all expanded

    for (const tc of this.toolCalls.values()) {
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
    this.chatContainer.clear();
    this.currentAssistantMarkdown = null;
    this.currentAssistantText = '';
    this.toolCalls.clear();
    this.runningSubAgents.clear();
    this.lastAddedItemCategory = null;
    this.diagnostics?.recordTranscriptMutation('clear');
    this.updateActivityIndicator();
  }

  /**
   * Update the activity indicator in the activity container.
   * Shows a single compact line when sub-agents are running.
   */
  private updateActivityIndicator(): void {
    if (!this.activityContainer) return;

    const count = this.runningSubAgents.size;

    if (count === 0) {
      // No running sub-agents: remove indicator
      if (this.activityIndicator) {
        this.activityContainer.removeChild(this.activityIndicator);
        this.activityIndicator = null;
        this.diagnostics?.recordTranscriptMutation('activity_indicator_removed');
      }
      return;
    }

    // Build compact summary: "⋯ 2 subagents running"
    const label = count === 1 ? '1 subagent running' : `${count} subagents running`;
    const displayText = colors.muted(`\u22EF ${label}`);

    if (this.activityIndicator) {
      this.activityIndicator.setText(displayText);
    } else {
      this.activityIndicator = new Text(displayText, 0, 0);
      this.activityContainer.addChild(this.activityIndicator);
    }
    this.diagnostics?.recordTranscriptMutation('activity_indicator_updated');
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
        this.lastAddedItemCategory = 'spacer';
      }
      this.currentAssistantMarkdown = null;
      this.currentAssistantText = '';
    }
  }
}
