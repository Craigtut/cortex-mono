import { Container, Text, Markdown, Spacer } from '@earendil-works/pi-tui';
import type { TUI } from '@earendil-works/pi-tui';
import { stripWorkingTags } from '@animus-labs/cortex';
import { colors, markdownTheme } from './theme.js';
import { addSplitFlapBoard } from './split-flap.js';
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
import type { InlinePromptComponent } from './permissions.js';
import type { FreezeDiagnostics } from '../diagnostics/freeze.js';

/**
 * Manages the chatContainer: adds child components for each message,
 * tool call, notification, and permission prompt.
 *
 * Follows the Mastra Code pattern: when a tool call starts mid-message,
 * the current assistant message is frozen and a new one starts after
 * the tool component.
 */

/**
 * Low-signal and work-product tools that fold into a single living group line
 * rather than each getting their own row.
 */
const GROUPED_TOOLS = new Map<string, ToolGroupKind>([
  ['Read', 'exploration'],
  ['Glob', 'exploration'],
  ['Grep', 'exploration'],
  ['WebFetch', 'web'],
  ['Edit', 'changes'],
  ['Write', 'changes'],
]);

type TranscriptItemCategory = 'activity' | 'routine-notification' | 'other' | 'spacer' | null;

interface ExpandableTranscriptItem {
  readonly isExpanded: boolean;
  toggleExpand(): void;
  dispose(): void;
}

type ToolTranscriptComponent = ToolExecutionComponent | ToolGroupComponent;

/**
 * Visual severity of a notification. It drives the leading glyph and its color;
 * everything else in the line stays muted so severity is what the eye catches.
 */
export type NotificationSeverity = 'error' | 'warning' | 'info' | 'success';

/** Leading glyph + tint for each severity. Single-width glyphs only. */
const SEVERITY_STYLE: Record<
  NotificationSeverity,
  { glyph: string; tint: (s: string) => string }
> = {
  error: { glyph: '✕', tint: colors.error }, // ✕ cinnabar
  warning: { glyph: '⚠', tint: colors.accent }, // ⚠ amber
  info: { glyph: '•', tint: colors.primaryMuted }, // • olive
  success: { glyph: '✓', tint: colors.success }, // ✓ green
};

/** View model for the compact background-retry status line. */
export interface RetryStatusView {
  /** waiting = counting down to next attempt; reconnecting = attempt in flight; failed = gave up. */
  phase: 'waiting' | 'reconnecting' | 'failed';
  /** 1-based attempt index. */
  attempt: number;
  /** Total retries allowed. */
  maxAttempts: number;
  /** Seconds until the next attempt (waiting phase only). */
  secondsRemaining?: number;
  /** Concise cause detail (e.g. "fetch failed: read ECONNRESET"). */
  detail?: string;
}

/** Format whole seconds as m:ss (or s when under a minute). */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

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
  /** Compact, in-place line for background retry status (countdown/attempts). */
  private retryStatusLine: Text | null = null;
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
   * - One activity row (tool line or group) follows another: the activity
   *   stream packs contiguously, with blank lines only around prose.
   */
  private maybeAddSpacer(nextIsActivity: boolean): void {
    if (this.lastAddedItemCategory === null) return;
    if (this.lastAddedItemCategory === 'spacer') return;
    if (nextIsActivity && this.lastAddedItemCategory === 'activity') return;

    this.chatContainer.addChild(new Spacer(1));
    // Don't set lastAddedItemCategory here; the caller sets it for the actual item.
  }

  /** Add the startup banner to the transcript. */
  addBanner(
    version: string,
    project: string,
    branch: string,
    update?: { latestVersion: string; packageName: string },
    { animate = true }: { animate?: boolean } = {},
  ): void {
    this.diagnostics?.recordTranscriptMutation('banner');
    this.chatContainer.addChild(new Spacer(1));

    // The wordmark as a split-flap board. It settles on a fresh start; a
    // resumed session renders the settled logo with no animation.
    addSplitFlapBoard(this.chatContainer, this.tui, { animate });

    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(
      new Text(
        `  ${colors.primary('cortex code')}${colors.muted(' // coding agent')}`,
        0,
        0,
      ),
    );

    const meta = [`v${version}`, project, branch].filter(Boolean).join('  ·  ');
    this.chatContainer.addChild(new Text(colors.muted(`  ${meta}`), 0, 0));

    if (update) {
      this.chatContainer.addChild(
        new Text(colors.accent(`  → ${update.latestVersion} available`), 0, 0),
      );
      this.chatContainer.addChild(
        new Text(colors.muted(`    npm i -g ${update.packageName}@latest`), 0, 0),
      );
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
    this.maybeAddSpacer(true);

    const toolComponent = new ToolExecutionComponent(toolName, this.tui);
    toolComponent.start(args);
    this.toolCalls.set(toolCallId, toolComponent);
    this.lastExpandable = toolComponent;
    this.chatContainer.addChild(toolComponent);
    this.lastAddedItemCategory = 'activity';
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
      tc.completeToolCall(toolCallId, result, details, durationMs);
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

  /**
   * Add a system notification (error, compaction, MCP notice, etc.).
   *
   * A single-line message renders as a compact one-line alert
   * ("\u2715 Title \u00b7 detail \u00b7 action") so a routine failure costs one row, not a
   * boxed block. Pass `action` for the accented call-to-action (e.g. a
   * "/login" suggestion). A multi-line message keeps a light glyph header over
   * its raw body, for content that is genuinely a block (command lists, tables).
   */
  addNotification(
    title: string,
    message: string,
    options?: { severity?: NotificationSeverity; action?: string },
  ): void {
    this.closeActiveToolGroups();
    const severity = options?.severity ?? this.inferSeverity(title, message);
    const body = message.trim();
    if (body.includes('\n')) {
      this.addNotificationBlock(severity, title, body);
    } else {
      this.addAlertLine(severity, title, body, options?.action);
    }
    this.diagnostics?.recordTranscriptMutation('notification');
    this.immediateRender();
  }

  /** Add an inline prompt (tool permission or network access) to the transcript. */
  addPermissionPrompt(prompt: InlinePromptComponent): void {
    this.closeActiveToolGroups();
    this.chatContainer.addChild(prompt);
    this.diagnostics?.recordTranscriptMutation('permission_prompt_added');
  }

  /** Remove an inline prompt after the user has decided. */
  removePermissionPrompt(prompt: InlinePromptComponent): void {
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

  /**
   * Render or update the compact, in-place background-retry status line.
   *
   * One muted line in the activity area that the session refreshes (countdown
   * ticks, attempt count) instead of stacking bordered error boxes. Replaces
   * the heavyweight notification for transient, auto-retried failures.
   */
  setRetryStatus(view: RetryStatusView): void {
    if (!this.activityContainer) return;
    const text = this.formatRetryStatus(view);
    if (this.retryStatusLine) {
      this.retryStatusLine.setText(text);
    } else {
      // A retry supersedes the "thinking" spinner; pack tight in the activity area.
      this.retryStatusLine = new Text(text, 0, 0);
      this.activityContainer.addChild(this.retryStatusLine);
    }
    this.diagnostics?.recordTranscriptMutation('retry_status');
    this.immediateRender();
  }

  /** Remove the retry status line (on success, abort, or a new turn). */
  clearRetryStatus(): void {
    if (this.retryStatusLine && this.activityContainer) {
      this.activityContainer.removeChild(this.retryStatusLine);
      this.retryStatusLine = null;
      this.diagnostics?.recordTranscriptMutation('retry_status_cleared');
      this.immediateRender();
    }
  }

  private formatRetryStatus(view: RetryStatusView): string {
    const counter = `retry ${view.attempt}/${view.maxAttempts}`;
    const detail = view.detail ? colors.muted(` · ${view.detail}`) : '';
    switch (view.phase) {
      case 'waiting': {
        const when =
          view.secondsRemaining !== undefined
            ? ` in ${formatDuration(view.secondsRemaining)}`
            : '';
        return (
          colors.accent(`⟳ Connection lost`) +
          colors.muted(` · ${counter}${when}`) +
          detail
        );
      }
      case 'reconnecting':
        return colors.accent(`⟳ Reconnecting…`) + colors.muted(` · ${counter}`);
      case 'failed': {
        // attempt 0 means no retries ran (policy disabled or non-resumable):
        // "gave up after 0 retries" would be nonsense.
        const head =
          view.attempt === 0
            ? `✕ Request failed`
            : `✕ Gave up after ${view.attempt} ${view.attempt === 1 ? 'retry' : 'retries'}`;
        return colors.error(head) + detail + colors.muted(` · send a message to retry`);
      }
    }
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

    this.maybeAddSpacer(true);
    const group = new ToolGroupComponent(groupKind);
    this.chatContainer.addChild(group);
    this.activeToolGroups.set(groupKind, group);
    this.lastAddedItemCategory = 'activity';
    return group;
  }

  closeActiveToolGroups(): void {
    for (const group of this.activeToolGroups.values()) {
      group.close();
    }
    this.activeToolGroups.clear();
  }

  /**
   * Compact one-line alert: "✕ Title · detail · action". The severity glyph
   * carries the color; consecutive alerts pack together with no blank line
   * between them so a burst of notices reads as a short stack, not a wall.
   */
  private addAlertLine(
    severity: NotificationSeverity,
    title: string,
    detail: string,
    action?: string,
  ): void {
    if (
      this.lastAddedItemCategory !== null &&
      this.lastAddedItemCategory !== 'spacer' &&
      this.lastAddedItemCategory !== 'routine-notification'
    ) {
      this.chatContainer.addChild(new Spacer(1));
    }

    const { glyph, tint } = SEVERITY_STYLE[severity];
    const segments = [`${tint(glyph)} ${tint(title)}`];
    if (detail) segments.push(colors.muted(detail));
    if (action) segments.push(colors.accent(action));
    this.chatContainer.addChild(new Text(`  ${segments.join(colors.muted(' · '))}`));
    this.lastAddedItemCategory = 'routine-notification';
    this.diagnostics?.recordTranscriptMutation('notification_routine');
  }

  /**
   * Multi-line notification: a light glyph header over the raw body. No full
   * width rule; the body keeps its own formatting (command lists, summaries).
   */
  private addNotificationBlock(
    severity: NotificationSeverity,
    title: string,
    body: string,
  ): void {
    this.maybeAddSpacer(false);
    const { glyph, tint } = SEVERITY_STYLE[severity];
    this.chatContainer.addChild(new Text(`  ${tint(glyph)} ${tint(title)}`));
    this.chatContainer.addChild(new Text(colors.muted(body)));
    this.chatContainer.addChild(new Spacer(1));
    this.lastAddedItemCategory = 'spacer';
  }

  private inferSeverity(title: string, message: string): NotificationSeverity {
    const text = `${title} ${message}`.toLowerCase();
    if (/\berror\b|failed|failure|denied|expired|invalid|unable|not found/.test(text)) {
      return 'error';
    }
    if (/degraded|exhausted|\bwarning\b|rate limit|\blimit\b/.test(text)) {
      return 'warning';
    }
    return 'info';
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
