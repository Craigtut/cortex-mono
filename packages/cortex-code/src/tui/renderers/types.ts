/**
 * Types for the per-tool renderer system.
 *
 * Each tool type registers a ToolRenderer that controls how its call header
 * and result are displayed inside a BorderedBox. Unknown tools fall back to
 * GenericToolRenderer.
 */

import type { ToolTheme } from '../theme.js';

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type ToolStatus = 'pending' | 'streaming' | 'success' | 'error';

// ---------------------------------------------------------------------------
// Render context
// ---------------------------------------------------------------------------

/**
 * Contextual information passed to every renderer method.
 */
export interface ToolRenderContext {
  /** Whether the tool result is expanded (show all lines). */
  expanded: boolean;
  /** Terminal width in columns. */
  termWidth: number;
  /** Available content width (termWidth minus border chars and padding). */
  maxContentWidth: number;
  /** Active theme colors. */
  theme: ToolTheme;
  /** Current tool status. */
  status: ToolStatus;
  /** Execution duration in milliseconds (set after completion). */
  durationMs?: number;
  /** The tool name (e.g., "Read", "mcp__server__tool"). Available in all render methods. */
  toolName: string;
  /** The original tool call arguments. Available in all render methods. */
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Renderer display types
// ---------------------------------------------------------------------------

/**
 * Output from renderCall: what to show when the tool starts.
 */
export interface ToolCallDisplay {
  /** Lines to show inside the bordered box (above the footer). */
  contentLines: string[];
  /** Footer summary text (tool name + args summary). */
  footerText: string;
}

/**
 * Output from renderResult: what to show when the tool completes.
 */
export interface ToolResultDisplay {
  /** Lines to show inside the bordered box. */
  contentLines: string[];
  /** Updated footer text (may include duration, match count, etc.). */
  footerText: string;
  /** Lines to show below the box (e.g., LSP diagnostics, exit codes). */
  belowBoxLines?: string[];
}

// ---------------------------------------------------------------------------
// Renderer interface
// ---------------------------------------------------------------------------

/**
 * Per-tool renderer. Each built-in tool registers one of these.
 * The ToolExecutionComponent delegates to the renderer for display.
 */
export interface ToolRenderer {
  /** Render the tool call header (shown when the tool starts). */
  renderCall(args: Record<string, unknown>, context: ToolRenderContext): ToolCallDisplay;

  /** Render the tool result (shown after completion). */
  renderResult(result: unknown, details: unknown, context: ToolRenderContext): ToolResultDisplay;

  /** Render a streaming update (for bash, sub-agent). Optional. */
  renderStreamUpdate?(update: unknown, context: ToolRenderContext): ToolResultDisplay;

  /** Render tool-specific error state. Falls back to generic error display if absent. */
  renderError?(error: string, args: Record<string, unknown>, context: ToolRenderContext): ToolResultDisplay;
}
