/**
 * ActivityLine: pi-tui Component that renders a single tool call as one
 * borderless line in the activity stream.
 *
 * Layout (status dot in the gutter, optional indented body with a ⎿ connector):
 *
 *   ●  Ran npm run build  exit 1
 *    ⎿ error TS2339: Property 'foo' does not exist
 *
 * Or, the common single-line case (no body):
 *
 *   ●  Wrote new-file.ts
 *
 * No box drawing. The dot color carries status; the body is hidden unless the
 * renderer chose to surface it (errors, diffs) or the user expanded. Token
 * counts are never shown and duration only appears when an op was slow.
 */

import { type Component, visibleWidth, truncateToWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import type { ToolStatus } from './types.js';
import { getToolTheme } from '../theme.js';
import { formatDuration } from './path-utils.js';

const STATUS_DOT = '●'; // ●
const CONNECTOR = '⎿'; // ⎿
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Duration is noise below this threshold; only slow ops report a time. */
const NOTABLE_DURATION_MS = 2000;

function normalizeSingleLine(text: string): string {
  return text.replace(/\r?\n+/g, ' ').replace(/\t/g, '   ');
}

function normalizeLines(lines: string[]): string[] {
  const normalized: string[] = [];
  for (const line of lines) {
    const parts = line.replace(/\t/g, '   ').split(/\r?\n/);
    normalized.push(...parts);
  }
  return normalized;
}

export class ActivityLine implements Component {
  private headerText = '';
  private contentLines: string[] = [];
  private footerText = '';
  private status: ToolStatus = 'pending';
  private durationMs?: number;
  private belowBoxLines: string[] = [];
  private spinnerFrame = 0;

  /**
   * Update the line content. `resultTokens` is accepted for API parity with
   * the previous bordered renderer but intentionally never displayed.
   */
  setContent(
    header: string,
    lines: string[],
    footer: string,
    status: ToolStatus,
    durationMs?: number,
    _resultTokens?: number,
  ): void {
    this.headerText = normalizeSingleLine(header);
    this.contentLines = normalizeLines(lines);
    this.footerText = normalizeSingleLine(footer);
    this.status = status;
    if (durationMs !== undefined) {
      this.durationMs = durationMs;
    }
  }

  /** Set auxiliary lines below the body (e.g. diagnostics). Indented, muted. */
  setBelowBox(lines: string[]): void {
    this.belowBoxLines = normalizeLines(lines);
  }

  /** Advance the pending-spinner frame. Driven by ToolExecutionComponent's timer. */
  advanceSpinner(): void {
    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
  }

  invalidate(): void {
    // No cached state; render is always fresh.
  }

  render(width: number): string[] {
    const theme = getToolTheme();
    const muted = chalk.hex(theme.muted);
    const isPending = this.status === 'pending' || this.status === 'streaming';
    const lines: string[] = [];

    // Gutter is one visible glyph followed by two spaces -> content starts at col 3.
    const gutter = this.gutter(theme);
    const headerWidth = width - 3;

    if (isPending) {
      const header = this.headerText
        ? truncateToWidth(this.headerText, headerWidth - 1) + muted('…')
        : muted('Working…');
      lines.push(`${gutter}  ${header}`);
    } else {
      const headerContent = truncateToWidth(`${this.headerText}${this.metaSuffix(theme)}`, headerWidth);
      lines.push(`${gutter}  ${headerContent}`);
    }

    // Body: first line gets the ⎿ connector, the rest align beneath it.
    const bodyWidth = Math.max(width - 4, 10);
    this.contentLines.forEach((line, index) => {
      const prefix = index === 0 ? muted(` ${CONNECTOR} `) : '   ';
      lines.push(prefix + truncateToWidth(line, bodyWidth));
    });

    // Auxiliary below-body lines (already colorized by the renderer).
    for (const belowLine of this.belowBoxLines) {
      lines.push('   ' + truncateToWidth(belowLine, width - 3));
    }

    return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
  }

  private gutter(theme: ReturnType<typeof getToolTheme>): string {
    switch (this.status) {
      case 'pending':
      case 'streaming':
        return chalk.hex(theme.accent)(SPINNER_FRAMES[this.spinnerFrame]!);
      case 'error':
        return chalk.hex(theme.statusError)(STATUS_DOT);
      case 'success':
        return chalk.hex(theme.statusSuccess)(STATUS_DOT);
    }
  }

  /** Muted trailing metadata: the renderer's footer plus a duration when slow. */
  private metaSuffix(theme: ReturnType<typeof getToolTheme>): string {
    const parts: string[] = [];
    if (this.footerText) {
      parts.push(this.footerText);
    }
    if (this.durationMs !== undefined && this.durationMs >= NOTABLE_DURATION_MS) {
      parts.push(formatDuration(this.durationMs));
    }
    return parts.length > 0 ? '  ' + chalk.hex(theme.muted)(parts.join('  ')) : '';
  }
}
