/**
 * ToolExecutionComponent: pi-tui Component that manages the full lifecycle
 * of a tool call display.
 *
 * Creates a BorderedBox internally, looks up the ToolRenderer from the
 * registry, and manages state transitions: pending -> streaming -> success/error.
 * Handles per-tool expand/collapse state.
 */

import type { Component } from '@mariozechner/pi-tui';
import { BorderedBox } from './bordered-box.js';
import { getRenderer } from './registry.js';
import { getToolTheme } from '../theme.js';
import type {
  ToolRenderer,
  ToolRenderContext,
  ToolStatus,
} from './types.js';

export class ToolExecutionComponent implements Component {
  /** Tracks the most recently started tool for Ctrl+E toggle. */
  static lastFocused: ToolExecutionComponent | null = null;

  private readonly box = new BorderedBox();
  private readonly renderer: ToolRenderer;
  private readonly toolName: string;
  private args: Record<string, unknown> = {};
  private status: ToolStatus = 'pending';
  private expanded = false;
  private durationMs?: number;
  private startTime = Date.now();

  // Stored for re-rendering after expand/collapse toggle
  private lastResult?: unknown;
  private lastDetails?: unknown;
  private lastError?: string;
  private lastStreamUpdate?: unknown;

  constructor(toolName: string) {
    this.toolName = toolName;
    this.renderer = getRenderer(toolName);
  }

  /**
   * Initialize with tool call args. Called when tool_call_start fires.
   */
  start(args: Record<string, unknown>): void {
    this.args = args;
    this.status = 'pending';
    this.startTime = Date.now();
    ToolExecutionComponent.lastFocused = this;
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
      this.box.setContent(display.contentLines, this.formatFooter(display.footerText), this.status);
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

  private formatFooter(rendererFooter: string): string {
    const toolLower = this.toolName.toLowerCase();
    // If the renderer already includes the tool name, use as-is
    if (rendererFooter.startsWith(toolLower)) {
      return rendererFooter;
    }
    // Replace generic "tool" placeholder with actual tool name
    if (rendererFooter === 'tool') {
      return toolLower;
    }
    return rendererFooter;
  }

  private rebuildDisplay(): void {
    const context = this.buildContext();

    if (this.status === 'pending') {
      const display = this.renderer.renderCall(this.args, context);
      this.box.setContent(display.contentLines, this.formatFooter(display.footerText), this.status);
      return;
    }

    if (this.status === 'error' && this.lastError) {
      if (this.renderer.renderError) {
        const display = this.renderer.renderError(this.lastError, this.args, context);
        this.box.setContent(display.contentLines, this.formatFooter(display.footerText), this.status, this.durationMs);
        if (display.belowBoxLines) {
          this.box.setBelowBox(display.belowBoxLines);
        }
      } else {
        // Generic error display
        const errorLines = this.lastError.split('\n');
        this.box.setContent(errorLines, this.formatFooter(this.toolName.toLowerCase()), this.status, this.durationMs);
      }
      return;
    }

    if (this.lastResult !== undefined) {
      const display = this.renderer.renderResult(this.lastResult, this.lastDetails, context);
      this.box.setContent(display.contentLines, this.formatFooter(display.footerText), this.status, this.durationMs);
      if (display.belowBoxLines) {
        this.box.setBelowBox(display.belowBoxLines);
      }
      return;
    }

    // Streaming state with no result yet
    if (this.lastStreamUpdate && this.renderer.renderStreamUpdate) {
      const display = this.renderer.renderStreamUpdate(this.lastStreamUpdate, context);
      this.box.setContent(display.contentLines, this.formatFooter(display.footerText), this.status);
    }
  }
}
