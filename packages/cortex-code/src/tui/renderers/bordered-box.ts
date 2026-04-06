/**
 * BorderedBox: pi-tui Component that wraps content with box-drawing borders.
 *
 * Renders as:
 *   ╭──
 *   │  content line 1
 *   │  content line 2
 *   ╰── footer text ✓ 1.2s
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

export class BorderedBox implements Component {
  private contentLines: string[] = [];
  private footerText = '';
  private status: ToolStatus = 'pending';
  private durationMs?: number;
  private belowBoxLines: string[] = [];

  /**
   * Update the box content.
   */
  setContent(
    lines: string[],
    footer: string,
    status: ToolStatus,
    durationMs?: number,
  ): void {
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

  invalidate(): void {
    // No cached state to clear; render is always fresh
  }

  render(width: number): string[] {
    const theme = getToolTheme();
    const borderColor = chalk.hex(theme.border);
    const mutedBorder = chalk.hex(theme.borderMuted);
    const contentWidth = Math.max(width - 4, 10); // │ + space + content + space
    const lines: string[] = [];

    // Top border: ╭──
    lines.push(borderColor('\u256D\u2500\u2500'));

    // Content lines: │  content
    if (this.contentLines.length > 0) {
      for (const line of this.contentLines) {
        const truncated = truncateToWidth(line, contentWidth);
        lines.push(mutedBorder('\u2502') + '  ' + truncated);
      }
    }

    // Footer: ╰── footer text ✓ 1.2s
    const icon = this.getStatusIcon(theme);
    const duration = this.durationMs !== undefined ? ` ${formatDuration(this.durationMs)}` : '';
    const footerContent = `${this.footerText} ${icon}${duration}`;
    lines.push(borderColor('\u2570\u2500\u2500 ') + footerContent);

    // Below-box lines (not inside the border)
    for (const belowLine of this.belowBoxLines) {
      const truncated = truncateToWidth(belowLine, width);
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
