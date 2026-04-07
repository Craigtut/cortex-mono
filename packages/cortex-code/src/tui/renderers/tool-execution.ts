/**
 * ToolExecutionComponent: pi-tui Component that manages the full lifecycle
 * of a tool call display.
 *
 * Creates a BorderedBox internally, looks up the ToolRenderer from the
 * registry, and manages state transitions: pending -> streaming -> success/error.
 * Handles per-tool expand/collapse state and animated spinner during execution.
 */

import type { Component, TUI } from '@mariozechner/pi-tui';
import { BorderedBox } from './bordered-box.js';
import { getRenderer } from './registry.js';
import { getToolTheme } from '../theme.js';
import type {
  ToolRenderer,
  ToolRenderContext,
  ToolStatus,
} from './types.js';

const SPINNER_INTERVAL_MS = 80;

export class ToolExecutionComponent implements Component {
  /** Tracks the most recently started tool for Ctrl+E toggle. */
  static lastFocused: ToolExecutionComponent | null = null;

  private readonly box = new BorderedBox();
  private readonly renderer: ToolRenderer;
  private readonly toolName: string;
  private tui: TUI | null = null;
  private args: Record<string, unknown> = {};
  private status: ToolStatus = 'pending';
  private expanded = false;
  private durationMs?: number;
  private startTime = Date.now();
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  // Stored for re-rendering after expand/collapse toggle
  private lastResult?: unknown;
  private lastDetails?: unknown;
  private lastError?: string;
  private lastStreamUpdate?: unknown;

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
    this.status = 'success';
    this.durationMs = durationMs;
    this.lastResult = result;
    this.lastDetails = details;
    this.lastStreamUpdate = undefined;
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

  // -----------------------------------------------------------------------
  // Spinner management
  // -----------------------------------------------------------------------

  private startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.box.advanceSpinner();
      this.tui?.requestRender();
    }, SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
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
      this.box.setContent(display.headerText, display.contentLines, display.footerText, this.status, this.durationMs);
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
}
