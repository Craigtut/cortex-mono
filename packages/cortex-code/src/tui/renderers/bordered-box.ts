/**
 * BorderedBox: pi-tui Component that wraps content with box-drawing borders.
 *
 * Renders as:
 *   ╭── read ~/path/to/file.ts
 *   │  content line 1
 *   │  content line 2
 *   ╰── 163 lines ✓ 42ms
 *
 * Or compact (no content):
 *   ╰── read ~/path/to/file.ts ✓ 42ms
 *
 * Used as the universal container for all tool renderers.
 */

import { type Component, visibleWidth, truncateToWidth } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { ToolStatus } from './types.js';
import { getToolTheme } from '../theme.js';
import { formatDuration } from './path-utils.js';

const STATUS_ICONS: Record<ToolStatus, string> = {
  pending: '\u22EF',   // ⋯
  streaming: '\u22EF', // ⋯
  success: '\u2713',   // ✓
  error: '\u2717',     // ✗
};

const SPINNER_FRAMES = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];

export class BorderedBox implements Component {
  private headerText = '';
  private contentLines: string[] = [];
  private footerText = '';
  private status: ToolStatus = 'pending';
  private durationMs?: number;
  private belowBoxLines: string[] = [];
  private spinnerFrame = 0;

  /**
   * Update the box content.
   */
  setContent(
    header: string,
    lines: string[],
    footer: string,
    status: ToolStatus,
    durationMs?: number,
  ): void {
    this.headerText = header;
    this.contentLines = lines;
    this.footerText = footer;
    this.status = status;
    if (durationMs !== undefined) {
      this.durationMs = durationMs;
    }
  }

  /**
   * Set lines to display below the box (e.g., exit codes, diagnostics).
   */
  setBelowBox(lines: string[]): void {
    this.belowBoxLines = lines;
  }

  /**
   * Advance the spinner animation frame.
   * Call this from an external timer (e.g., ToolExecutionComponent).
   */
  advanceSpinner(): void {
    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
  }

  invalidate(): void {
    // No cached state to clear; render is always fresh
  }

  render(width: number): string[] {
    const theme = getToolTheme();
    const borderColor = chalk.hex(theme.border);
    const mutedBorder = chalk.hex(theme.borderMuted);
    const contentWidth = Math.max(width - 4, 10); // │ + space + content + space
    const lines: string[] = [];
    const hasContent = this.contentLines.length > 0;
    const isPending = this.status === 'pending' || this.status === 'streaming';

    // Status icon and duration
    const icon = this.getStatusIcon(theme);
    const duration = this.durationMs !== undefined ? ` ${formatDuration(this.durationMs)}` : '';

    // Border prefix is 4 visible chars ("╭── " or "╰── "), leaving the rest for content
    const borderPrefixWidth = 4;
    const maxLineContent = width - borderPrefixWidth;

    if (!hasContent && !isPending) {
      // Compact mode (complete, no content): single line
      // ╰── read ~/path/to/file.ts  ✓ 42ms
      const footerParts = [this.headerText];
      if (this.footerText) footerParts.push(this.footerText);
      const footerContent = `${footerParts.join('  ')} ${icon}${duration}`;
      lines.push(borderColor('\u2570\u2500\u2500 ') + truncateToWidth(footerContent, maxLineContent));
    } else if (!hasContent && isPending) {
      // Compact pending: single line with spinner
      // ⠋ read ~/path/to/file.ts...
      const spinner = chalk.hex(theme.statusPending)(SPINNER_FRAMES[this.spinnerFrame]!);
      const pendingText = `${spinner} ${this.headerText}${chalk.hex(theme.muted)('...')}`;
      lines.push(truncateToWidth(pendingText, width));
    } else {
      // Full box with header
      // ╭── read ~/path/to/file.ts
      if (isPending) {
        // Reserve 2 chars for " ⋯" spinner suffix
        const spinner = chalk.hex(theme.statusPending)(SPINNER_FRAMES[this.spinnerFrame]!);
        const truncatedHeader = this.headerText
          ? truncateToWidth(this.headerText, maxLineContent - 2) + ' ' + spinner
          : spinner;
        lines.push(borderColor('\u256D\u2500\u2500 ') + truncatedHeader);
      } else {
        const truncatedHeader = this.headerText
          ? truncateToWidth(this.headerText, maxLineContent)
          : '';
        lines.push(borderColor('\u256D\u2500\u2500') + (truncatedHeader ? ' ' + truncatedHeader : ''));
      }

      // Content lines: │  content
      for (const line of this.contentLines) {
        const truncated = truncateToWidth(line, contentWidth);
        lines.push(mutedBorder('\u2502') + '  ' + truncated);
      }

      // Pending with no content yet: show spinner line
      if (isPending && !hasContent) {
        const spinner = chalk.hex(theme.statusPending)(SPINNER_FRAMES[this.spinnerFrame]!);
        lines.push(mutedBorder('\u2502') + '  ' + spinner + chalk.hex(theme.muted)(' Working...'));
      }

      // Footer: ╰── stats ✓ 42ms
      const footerContent = this.footerText
        ? `${this.footerText} ${icon}${duration}`
        : `${icon}${duration}`;
      lines.push(borderColor('\u2570\u2500\u2500 ') + truncateToWidth(footerContent, maxLineContent));
    }

    // Below-box lines (not inside the border, indented 4 chars)
    for (const belowLine of this.belowBoxLines) {
      const truncated = truncateToWidth(belowLine, width - 4);
      lines.push('    ' + truncated);
    }

    return lines;
  }

  private getStatusIcon(theme: ReturnType<typeof getToolTheme>): string {
    const icon = STATUS_ICONS[this.status];
    switch (this.status) {
      case 'pending':
      case 'streaming':
        return chalk.hex(theme.statusPending)(icon);
      case 'success':
        return chalk.hex(theme.statusSuccess)(icon);
      case 'error':
        return chalk.hex(theme.statusError)(icon);
    }
  }
}
