/**
 * ToolExecutionComponent: pi-tui Component that manages the full lifecycle
 * of a tool call display.
 *
 * Creates a BorderedBox internally, looks up the ToolRenderer from the
 * registry, and manages state transitions: pending -> streaming -> success/error.
 * Handles per-tool expand/collapse state and animated spinner during execution.
 */

import type { Component, TUI } from '@mariozechner/pi-tui';
import { estimateTokens, TOOL_RESULT_WORKING_TAGS_REMINDER } from '@animus-labs/cortex';
import { BorderedBox } from './bordered-box.js';
import { getRenderer } from './registry.js';
import { getToolTheme } from '../theme.js';
import type {
  ToolRenderer,
  ToolRenderContext,
  ToolStatus,
} from './types.js';

const SPINNER_INTERVAL_MS = 250;

interface SpinnerGroup {
  components: Set<ToolExecutionComponent>;
  timer: ReturnType<typeof setInterval> | null;
}

export class ToolExecutionComponent implements Component {
  /** Tracks the most recently started tool for Ctrl+E toggle. */
  static lastFocused: ToolExecutionComponent | null = null;
  private static readonly spinnerGroups = new Map<TUI, SpinnerGroup>();

  private readonly box = new BorderedBox();
  private readonly renderer: ToolRenderer;
  private readonly toolName: string;
  private readonly tui: TUI | null;
  private args: Record<string, unknown> = {};
  private status: ToolStatus = 'pending';
  private expanded = false;
  private durationMs?: number;
  private startTime = Date.now();
  private spinnerRegistered = false;

  // Stored for re-rendering after expand/collapse toggle
  private lastResult?: unknown;
  private lastDetails?: unknown;
  private lastError?: string;
  private lastStreamUpdate?: unknown;
  private resultTokens?: number;

  constructor(toolName: string, tui?: TUI) {
    this.toolName = toolName;
    this.renderer = getRenderer(toolName);
    this.tui = tui ?? null;
  }

  /**
   * Initialize with tool call args. Called when tool_call_start fires.
   */
  start(args: Record<string, unknown>): void {
    this.args = args;
    this.status = 'pending';
    this.startTime = Date.now();
    ToolExecutionComponent.lastFocused = this;
    this.startSpinner();
    this.rebuildDisplay();
  }

  /**
   * Update with streaming partial result. Called on tool_call_update.
   */
  streamUpdate(partialResult: unknown): void {
    this.status = 'streaming';
    this.lastStreamUpdate = partialResult;

    if (this.renderer.renderStreamUpdate) {
      const display = this.renderer.renderStreamUpdate(partialResult, this.buildContext());
      this.box.setContent(display.headerText, display.contentLines, display.footerText, this.status);
      if (display.belowBoxLines) {
        this.box.setBelowBox(display.belowBoxLines);
      }
    }
  }

  /**
   * Mark as completed. Called on tool_call_end (success).
   */
  complete(result: unknown, details: unknown, durationMs: number): void {
    // Use event duration, but fall back to tool-reported duration from details
    // (pi-agent-core events may not carry durationMs; tools like Bash track it internally)
    this.durationMs = durationMs || this.extractDurationFromDetails(details) || (Date.now() - this.startTime);
    this.lastResult = this.stripOperationalText(result);
    this.lastDetails = details;
    this.lastStreamUpdate = undefined;
    this.resultTokens = this.estimateResultTokens(result);

    // Detect soft rejections (e.g., read-before-edit enforcement)
    // where the tool returns "success" but the operation was not performed.
    this.status = this.detectRejection(details) ? 'error' : 'success';

    this.stopSpinner();
    this.rebuildDisplay();
  }

  /**
   * Mark as failed. Called on tool_call_end (error).
   */
  fail(error: string, durationMs: number): void {
    this.status = 'error';
    this.durationMs = durationMs;
    this.lastError = error;
    this.lastStreamUpdate = undefined;
    this.stopSpinner();
    this.rebuildDisplay();
  }

  /**
   * Toggle expand/collapse for this tool.
   */
  toggleExpand(): void {
    this.expanded = !this.expanded;
    this.rebuildDisplay();
  }

  /** Whether this tool result is currently expanded. */
  get isExpanded(): boolean {
    return this.expanded;
  }

  invalidate(): void {
    this.box.invalidate();
  }

  render(width: number): string[] {
    return this.box.render(width);
  }

  dispose(): void {
    this.stopSpinner();
  }

  // -----------------------------------------------------------------------
  // Spinner management
  // -----------------------------------------------------------------------

  private startSpinner(): void {
    if (!this.tui || this.spinnerRegistered) {
      return;
    }

    const group = ToolExecutionComponent.getOrCreateSpinnerGroup(this.tui);
    group.components.add(this);
    this.spinnerRegistered = true;
  }

  private stopSpinner(): void {
    if (!this.tui || !this.spinnerRegistered) {
      return;
    }

    const group = ToolExecutionComponent.spinnerGroups.get(this.tui);
    this.spinnerRegistered = false;
    if (!group) {
      return;
    }

    group.components.delete(this);
    if (group.components.size === 0) {
      ToolExecutionComponent.destroySpinnerGroup(this.tui);
    }
  }

  private static getOrCreateSpinnerGroup(tui: TUI): SpinnerGroup {
    let group = ToolExecutionComponent.spinnerGroups.get(tui);
    if (!group) {
      group = {
        components: new Set<ToolExecutionComponent>(),
        timer: null,
      };
      ToolExecutionComponent.spinnerGroups.set(tui, group);
    }

    if (!group.timer) {
      group.timer = setInterval(() => {
        if (group.components.size === 0) {
          ToolExecutionComponent.destroySpinnerGroup(tui);
          return;
        }

        for (const component of group.components) {
          component.box.advanceSpinner();
        }
        tui.requestRender();
      }, SPINNER_INTERVAL_MS);
    }

    return group;
  }

  private static destroySpinnerGroup(tui: TUI): void {
    const group = ToolExecutionComponent.spinnerGroups.get(tui);
    if (!group) {
      return;
    }

    if (group.timer) {
      clearInterval(group.timer);
      group.timer = null;
    }
    ToolExecutionComponent.spinnerGroups.delete(tui);
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private buildContext(): ToolRenderContext {
    const theme = getToolTheme();
    const ctx: ToolRenderContext = {
      expanded: this.expanded,
      termWidth: process.stdout.columns ?? 80,
      maxContentWidth: Math.max((process.stdout.columns ?? 80) - 4, 10),
      theme,
      status: this.status,
      toolName: this.toolName,
      args: this.args,
    };
    if (this.durationMs !== undefined) {
      ctx.durationMs = this.durationMs;
    }
    return ctx;
  }

  private rebuildDisplay(): void {
    const context = this.buildContext();

    if (this.status === 'pending') {
      const display = this.renderer.renderCall(this.args, context);
      this.box.setContent(display.headerText, display.contentLines, display.footerText, this.status);
      return;
    }

    if (this.status === 'error' && this.lastError) {
      if (this.renderer.renderError) {
        const display = this.renderer.renderError(this.lastError, this.args, context);
        this.box.setContent(display.headerText, display.contentLines, display.footerText, this.status, this.durationMs);
        if (display.belowBoxLines) {
          this.box.setBelowBox(display.belowBoxLines);
        }
      } else {
        // Generic error display
        const errorLines = this.lastError.split('\n');
        this.box.setContent(this.toolName.toLowerCase(), errorLines, '', this.status, this.durationMs);
      }
      return;
    }

    if (this.lastResult !== undefined) {
      const display = this.renderer.renderResult(this.lastResult, this.lastDetails, context);
      this.box.setContent(display.headerText, display.contentLines, display.footerText, this.status, this.durationMs, this.resultTokens);
      if (display.belowBoxLines) {
        this.box.setBelowBox(display.belowBoxLines);
      }
      return;
    }

    // Streaming state with no result yet
    if (this.lastStreamUpdate && this.renderer.renderStreamUpdate) {
      const display = this.renderer.renderStreamUpdate(this.lastStreamUpdate, context);
      this.box.setContent(display.headerText, display.contentLines, display.footerText, this.status);
    }
  }

  /**
   * Extract duration from tool-specific details.
   * Tools like Bash track duration internally as details.duration.
   */
  private extractDurationFromDetails(details: unknown): number {
    if (!details || typeof details !== 'object') return 0;
    const d = details as Record<string, unknown>;
    // Bash: details.duration (ms), SubAgent: details.durationMs
    const duration = Number(d['duration'] ?? d['durationMs'] ?? 0);
    return duration > 0 ? duration : 0;
  }

  /**
   * Strip operational text (working tags reminder) from tool results.
   * This text is injected by Cortex for the LLM but should not be displayed.
   */
  private stripOperationalText(result: unknown): unknown {
    if (typeof result === 'string') {
      return result.replace('\n\n' + TOOL_RESULT_WORKING_TAGS_REMINDER, '').replace(TOOL_RESULT_WORKING_TAGS_REMINDER, '');
    }
    if (result && typeof result === 'object' && 'content' in (result as Record<string, unknown>)) {
      const r = result as Record<string, unknown>;
      if (Array.isArray(r['content'])) {
        const cleaned = (r['content'] as Array<Record<string, unknown>>).map(part => {
          if (part['type'] === 'text' && typeof part['text'] === 'string') {
            return {
              ...part,
              text: (part['text'] as string)
                .replace('\n\n' + TOOL_RESULT_WORKING_TAGS_REMINDER, '')
                .replace(TOOL_RESULT_WORKING_TAGS_REMINDER, ''),
            };
          }
          return part;
        });
        return { ...r, content: cleaned };
      }
    }
    return result;
  }

  /**
   * Detect soft rejections: tools that return "success" but the operation
   * was not actually performed (e.g., read-before-edit enforcement).
   */
  private detectRejection(details: unknown): boolean {
    if (!details || typeof details !== 'object') return false;
    const d = details as Record<string, unknown>;

    // Edit: replacementCount 0 with no diff means rejected
    if (this.toolName === 'Edit' && d['replacementCount'] === 0 &&
        (!d['diff'] || (Array.isArray(d['diff']) && (d['diff'] as unknown[]).length === 0))) {
      return true;
    }

    // Write: bytesWritten 0 for an existing file means rejected
    if (this.toolName === 'Write' && d['bytesWritten'] === 0 && d['isCreate'] === false) {
      return true;
    }

    return false;
  }

  /**
   * Estimate the token count of a tool result by extracting text content.
   */
  private estimateResultTokens(result: unknown): number {
    if (typeof result === 'string') {
      return estimateTokens(result);
    }
    if (result && typeof result === 'object' && 'content' in (result as Record<string, unknown>)) {
      const content = (result as Record<string, unknown>)['content'];
      if (Array.isArray(content)) {
        const text = content
          .filter((c: unknown) => c && typeof c === 'object' && (c as Record<string, unknown>)['type'] === 'text')
          .map((c: unknown) => (c as Record<string, string>)['text'])
          .join('\n');
        return estimateTokens(text);
      }
    }
    return 0;
  }
}
