import { Container, Text, Markdown, Spacer } from '@earendil-works/pi-tui';
import type { TUI } from '@earendil-works/pi-tui';
import { stripWorkingTags } from '@animus-labs/cortex';
import { colors, markdownTheme } from './theme.js';
import { ToolExecutionComponent } from './renderers/tool-execution.js';
import { ToolGroupComponent, type ToolGroupKind } from './renderers/tool-group.js';
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
  'Write', 'TaskOutput',
]);

const GROUPED_TOOLS = new Map<string, ToolGroupKind>([
  ['Read', 'exploration'],
  ['Glob', 'exploration'],
  ['Grep', 'exploration'],
  ['WebFetch', 'web'],
]);

type TranscriptItemCategory = 'compact-tool' | 'tool-group' | 'routine-notification' | 'other' | 'spacer' | null;

interface ExpandableTranscriptItem {
  readonly isExpanded: boolean;
  toggleExpand(): void;
  dispose(): void;
}

type ToolTranscriptComponent = ToolExecutionComponent | ToolGroupComponent;

export type NotificationSeverity = 'routine' | 'important' | 'error';

export class TranscriptManager {
  /** The current streaming assistant message Markdown component. */
  private currentAssistantMarkdown: Markdown | null = null;
  /** Accumulated raw text for the current visible assistant segment. */
  private currentAssistantText = '';
  /** Accumulated raw text streamed during the current assistant turn. */
  private assistantTurnText = '';
  /** Raw offset where the current visible assistant segment started. */
  private currentAssistantSegmentStart = 0;
  /** Map of active tool call components by tool call ID. */
  private toolCalls = new Map<string, ToolTranscriptComponent>();
  private activeToolGroups = new Map<ToolGroupKind, ToolGroupComponent>();
  private lastExpandable: ExpandableTranscriptItem | null = null;
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
   * - A compact tool follows another compact tool
   */
  private maybeAddSpacer(isCompactTool: boolean): void {
    if (this.lastAddedItemCategory === null) return;
    if (this.lastAddedItemCategory === 'spacer') return;
    if (isCompactTool && this.lastAddedItemCategory === 'compact-tool') return;

    this.chatContainer.addChild(new Spacer(1));
    // Don't set lastAddedItemCategory here; the caller sets it for the actual item.
  }

  /** Add the startup banner to the transcript. */
  addBanner(
    version: string,
    project: string,
    branch: string,
    update?: { latestVersion: string; packageName: string },
  ): void {
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
    if (update) {
      this.chatContainer.addChild(
        new Text(colors.accent(`  → ${update.latestVersion} available`), 0, 0),
      );
      this.chatContainer.addChild(
        new Text(colors.muted(`    Update: npm i -g ${update.packageName}@latest`), 0, 0),
      );
    }
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
    this.closeActiveToolGroups();
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(text, 2, 1, colors.userMessageBg));
    this.chatContainer.addChild(new Spacer(1));
    this.lastAddedItemCategory = 'spacer';
    this.diagnostics?.recordTranscriptMutation('user_message');
  }

  /** Start a new assistant message (renders streaming content). */
  startAssistantMessage(): void {
    this.finalizeCurrentAssistant();
    this.currentAssistantText = '';
    this.currentAssistantMarkdown = null;
    this.assistantTurnText = '';
    this.currentAssistantSegmentStart = 0;
    this.diagnostics?.recordTranscriptMutation('assistant_start');
  }

  /** Append streaming text to the current assistant message. */
  appendAssistantChunk(chunk: string): void {
    this.assistantTurnText += chunk;
    this.currentAssistantText += chunk;
    // Strip working tags for display; raw text stays in currentAssistantText
    const displayText = stripWorkingTags(this.currentAssistantText);
    if (displayText.trim()) {
      this.closeActiveToolGroups();
    }
    if (!this.currentAssistantMarkdown) {
      if (!displayText.trim()) {
        this.diagnostics?.recordTranscriptMutation('assistant_chunk');
        this.throttledRender();
        return;
      }

      this.maybeAddSpacer(false);
      this.currentAssistantMarkdown = new Markdown(displayText, 0, 0, markdownTheme);
      this.chatContainer.addChild(this.currentAssistantMarkdown);
      this.lastAddedItemCategory = 'other';
    } else {
      this.currentAssistantMarkdown.setText(displayText);
    }
    this.diagnostics?.recordTranscriptMutation('assistant_chunk');
    this.throttledRender();
  }

  /** Finalize the current assistant message (e.g., strip working tags). */
  finalizeAssistantMessage(finalText?: string): void {
    const displayText = finalText !== undefined
      ? this.getFinalAssistantDisplayText(finalText)
      : undefined;
    if (finalText !== undefined) {
      this.currentAssistantText = this.currentAssistantMarkdown
        ? this.getFinalAssistantSegmentText(finalText)
        : displayText ?? '';
    }
    if (displayText?.trim()) {
      this.closeActiveToolGroups();
    }
    if (finalText !== undefined && displayText?.trim() && !this.currentAssistantMarkdown) {
      this.maybeAddSpacer(false);
      this.currentAssistantMarkdown = new Markdown(displayText, 0, 0, markdownTheme);
      this.chatContainer.addChild(this.currentAssistantMarkdown);
      this.lastAddedItemCategory = 'other';
    } else if (this.currentAssistantMarkdown && finalText !== undefined) {
      this.currentAssistantMarkdown.setText(displayText ?? finalText);
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

    const groupKind = GROUPED_TOOLS.get(toolName);
    if (groupKind) {
      const toolGroup = this.getOrCreateToolGroup(groupKind);
      toolGroup.startToolCall(toolCallId, toolName, args);
      this.toolCalls.set(toolCallId, toolGroup);
      this.lastExpandable = toolGroup;
      this.diagnostics?.recordTranscriptMutation('tool_group_start');
      this.throttledRender();
      return;
    }

    this.closeActiveToolGroups();
    const isCompact = COMPACT_TOOLS.has(toolName);
    this.maybeAddSpacer(isCompact);

    const toolComponent = new ToolExecutionComponent(toolName, this.tui);
    toolComponent.start(args);
    this.toolCalls.set(toolCallId, toolComponent);
    this.lastExpandable = toolComponent;
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
    if (tc instanceof ToolExecutionComponent) {
      tc.streamUpdate(partialResult);
      this.diagnostics?.recordTranscriptMutation('tool_update');
      this.throttledRender();
    }
  }

  /** Complete a tool call with its result. */
  completeToolCall(toolCallId: string, result: unknown, details: unknown, durationMs: number): void {
    const tc = this.toolCalls.get(toolCallId);
    if (tc instanceof ToolGroupComponent) {
      tc.completeToolCall(toolCallId, details, durationMs);
    } else if (tc) {
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
    if (tc instanceof ToolGroupComponent) {
      tc.failToolCall(toolCallId, error, durationMs);
    } else if (tc) {
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
  addNotification(
    title: string,
    message: string,
    options?: { severity?: NotificationSeverity },
  ): void {
    this.closeActiveToolGroups();
    const severity = options?.severity ?? this.inferNotificationSeverity(title, message);
    if (severity === 'routine' && !message.includes('\n')) {
      this.addRoutineNotification(title, message);
      return;
    }

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
    this.closeActiveToolGroups();
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
    const lastFocused = this.lastExpandable ?? ToolExecutionComponent.lastFocused;
    if (lastFocused) {
      lastFocused.toggleExpand();
      this.tui.requestRender();
    }
  }

  /** Toggle expand/collapse for all tool results (Ctrl+Shift+E). */
  toggleExpandAll(): void {
    // Detect majority state: if any are collapsed, expand all; otherwise collapse all
    let anyCollapsed = false;
    const components = new Set(this.toolCalls.values());
    for (const tc of components) {
      if (!tc.isExpanded) {
        anyCollapsed = true;
        break;
      }
    }
    const targetState = anyCollapsed; // expand if any collapsed, collapse if all expanded

    for (const tc of components) {
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
    for (const tc of new Set(this.toolCalls.values())) {
      tc.dispose();
    }
    this.chatContainer.clear();
    this.currentAssistantMarkdown = null;
    this.currentAssistantText = '';
    this.assistantTurnText = '';
    this.currentAssistantSegmentStart = 0;
    this.toolCalls.clear();
    this.activeToolGroups.clear();
    this.lastExpandable = null;
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
      this.currentAssistantSegmentStart = this.assistantTurnText.length;
    }
  }

  private getFinalAssistantSegmentText(finalText: string): string {
    if (
      this.assistantTurnText &&
      finalText.startsWith(this.assistantTurnText) &&
      this.currentAssistantSegmentStart <= finalText.length
    ) {
      return finalText.slice(this.currentAssistantSegmentStart);
    }
    return finalText;
  }

  private getFinalAssistantDisplayText(finalText: string): string {
    const fullDisplayText = stripWorkingTags(finalText);

    if (this.currentAssistantMarkdown) {
      return stripWorkingTags(this.getFinalAssistantSegmentText(finalText));
    }

    if (!this.assistantTurnText) {
      return fullDisplayText;
    }

    const streamedDisplayText = stripWorkingTags(this.assistantTurnText);
    if (!streamedDisplayText) {
      return fullDisplayText;
    }

    if (fullDisplayText === streamedDisplayText) {
      return '';
    }

    if (fullDisplayText.startsWith(streamedDisplayText)) {
      return fullDisplayText.slice(streamedDisplayText.length).trimStart();
    }

    return fullDisplayText;
  }

  private getOrCreateToolGroup(groupKind: ToolGroupKind): ToolGroupComponent {
    const activeGroup = this.activeToolGroups.get(groupKind);
    if (activeGroup) {
      return activeGroup;
    }

    for (const [kind, group] of this.activeToolGroups) {
      if (kind !== groupKind) {
        group.close();
        this.activeToolGroups.delete(kind);
      }
    }

    this.maybeAddSpacer(false);
    const group = new ToolGroupComponent(groupKind);
    this.chatContainer.addChild(group);
    this.activeToolGroups.set(groupKind, group);
    this.lastAddedItemCategory = 'tool-group';
    return group;
  }

  closeActiveToolGroups(): void {
    for (const group of this.activeToolGroups.values()) {
      group.close();
    }
    this.activeToolGroups.clear();
  }

  private addRoutineNotification(title: string, message: string): void {
    if (
      this.lastAddedItemCategory !== null &&
      this.lastAddedItemCategory !== 'spacer' &&
      this.lastAddedItemCategory !== 'routine-notification'
    ) {
      this.chatContainer.addChild(new Spacer(1));
    }

    const label = colors.primaryMuted(title);
    this.chatContainer.addChild(new Text(`  ${label}${colors.muted(`: ${message}`)}`));
    this.lastAddedItemCategory = 'routine-notification';
    this.diagnostics?.recordTranscriptMutation('notification_routine');
    this.immediateRender();
  }

  private inferNotificationSeverity(title: string, message: string): NotificationSeverity {
    const text = `${title} ${message}`.toLowerCase();
    if (
      text.includes('error') ||
      text.includes('failed') ||
      text.includes('failure') ||
      text.includes('denied') ||
      text.includes('limit') ||
      text.includes('rate') ||
      text.includes('connection') ||
      text.includes('authentication') ||
      text.includes('exhausted') ||
      text.includes('degraded')
    ) {
      return 'important';
    }

    return 'routine';
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
