import { type Component, type Focusable, visibleWidth, truncateToWidth, matchesKey } from '@mariozechner/pi-tui';
import chalk from 'chalk';

const BG = chalk.bgHex('#1a1a2e');
const BORDER = chalk.hex('#008577');
const TITLE_COLOR = chalk.hex('#00E5CC');
const LINE_NUM = chalk.hex('#4B5563');
const SCROLL_BAR = chalk.hex('#00E5CC');
const HINT = chalk.hex('#6B7280');
const CONTENT = chalk.hex('#d1d5db');

/**
 * A read-only scrollable text viewer rendered inside an overlay.
 *
 * Manages its own scroll offset and renders only the visible slice.
 * Uses pi-tui's keybinding system for input handling.
 * q or Escape to close.
 */
export class ScrollableViewer implements Component, Focusable {
  focused = false;

  private lines: string[];
  private scrollOffset = 0;
  private readonly title: string;
  private readonly onClose: () => void;

  constructor(title: string, content: string, onClose: () => void) {
    this.title = title;
    this.onClose = onClose;
    this.lines = content.split('\n');
  }

  handleInput(data: string): void {
    const viewportHeight = this.getViewportHeight();

    // Close
    if (matchesKey(data, 'escape') || data === 'q') {
      this.onClose();
      return;
    }

    // Scroll
    if (matchesKey(data, 'up')) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (matchesKey(data, 'down')) {
      this.scrollOffset = Math.min(this.maxScroll(viewportHeight), this.scrollOffset + 1);
    } else if (matchesKey(data, 'pageUp')) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
    } else if (matchesKey(data, 'pageDown')) {
      this.scrollOffset = Math.min(this.maxScroll(viewportHeight), this.scrollOffset + viewportHeight);
    } else if (matchesKey(data, 'home')) {
      this.scrollOffset = 0;
    } else if (matchesKey(data, 'end')) {
      this.scrollOffset = this.maxScroll(viewportHeight);
    }
  }

  invalidate(): void {
    // No cache to clear
  }

  render(width: number): string[] {
    const viewportHeight = this.getViewportHeight();
    const innerWidth = width - 2; // border chars only

    const totalLines = this.lines.length;

    // Clamp scroll
    if (this.scrollOffset > this.maxScroll(viewportHeight)) this.scrollOffset = this.maxScroll(viewportHeight);
    if (this.scrollOffset < 0) this.scrollOffset = 0;

    const output: string[] = [];

    // Top border with title
    const titleText = ` ${this.title} `;
    const titleLen = visibleWidth(titleText);
    const dashAfter = Math.max(0, innerWidth - 1 - titleLen);
    output.push(
      BORDER('\u256D\u2500') + TITLE_COLOR(titleText) + BORDER('\u2500'.repeat(dashAfter)) + BORDER('\u256E'),
    );

    // Scroll position info line
    const endLine = Math.min(this.scrollOffset + viewportHeight, totalLines);
    const posInfo = `Lines ${this.scrollOffset + 1}-${endLine} of ${totalLines}`;
    const posInfoLen = posInfo.length;
    const posPad = Math.max(0, innerWidth - 1 - posInfoLen);
    output.push(
      BORDER('\u2502') + BG(' ' + HINT(posInfo) + ' '.repeat(posPad)) + BORDER('\u2502'),
    );

    // Separator
    output.push(
      BORDER('\u251C') + BORDER('\u2500'.repeat(innerWidth)) + BORDER('\u2524'),
    );

    // Content lines with line numbers
    const lineNumWidth = String(totalLines).length;
    const numPrefixWidth = lineNumWidth + 3; // "NNN | "

    for (let i = 0; i < viewportHeight; i++) {
      const lineIdx = this.scrollOffset + i;
      if (lineIdx < totalLines) {
        const num = LINE_NUM(String(lineIdx + 1).padStart(lineNumWidth, ' ') + ' \u2502 ');
        const maxContentWidth = Math.max(1, innerWidth - 1 - numPrefixWidth);
        const line = this.lines[lineIdx] ?? '';
        const truncated = truncateToWidth(line, maxContentWidth);
        const lineLen = visibleWidth(truncated);
        const pad = Math.max(0, innerWidth - 1 - numPrefixWidth - lineLen);
        output.push(
          BORDER('\u2502') + BG(' ' + num + CONTENT(truncated) + ' '.repeat(pad)) + BORDER('\u2502'),
        );
      } else {
        output.push(
          BORDER('\u2502') + BG(' '.repeat(innerWidth)) + BORDER('\u2502'),
        );
      }
    }

    // Scroll bar overlay (modify right border of content lines)
    if (totalLines > viewportHeight) {
      const barHeight = Math.max(1, Math.round((viewportHeight / totalLines) * viewportHeight));
      const barStart = Math.round((this.scrollOffset / totalLines) * viewportHeight);

      for (let i = 0; i < viewportHeight; i++) {
        const outputIdx = i + 3; // offset past title + info + separator
        const isBar = i >= barStart && i < barStart + barHeight;
        if (isBar && output[outputIdx]) {
          const existing = output[outputIdx]!;
          const lastBorderPos = existing.lastIndexOf('\u2502');
          if (lastBorderPos > 0) {
            output[outputIdx] = existing.substring(0, lastBorderPos) + SCROLL_BAR('\u2588');
          }
        }
      }
    }

    // Bottom border
    output.push(
      BORDER('\u2570') + BORDER('\u2500'.repeat(innerWidth)) + BORDER('\u256F'),
    );

    // Hint line (outside the box)
    const hintText = '  \u2191\u2193 scroll  PgUp/PgDn page  Home/End jump  q/Esc close';
    output.push(HINT(truncateToWidth(hintText, width)));

    return output;
  }

  private getViewportHeight(): number {
    const termRows = process.stdout.rows || 40;
    // chrome: top border (1) + info line (1) + separator (1) + bottom border (1) + hint (1) = 5
    // margin: overlay offset from edges = 2 (top + bottom)
    return Math.max(5, termRows - 5 - 2);
  }

  private maxScroll(viewportHeight: number): number {
    return Math.max(0, this.lines.length - viewportHeight);
  }
}
