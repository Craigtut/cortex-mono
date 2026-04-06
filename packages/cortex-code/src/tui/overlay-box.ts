import { type Component, type Focusable, visibleWidth } from '@mariozechner/pi-tui';
import chalk from 'chalk';

const OVERLAY_BG = chalk.bgHex('#1a1a2e');
const BORDER_COLOR = chalk.hex('#008577');

/**
 * Wraps content lines with a box-drawing border and dark background.
 * Used for overlays to visually separate them from the transcript.
 * Forwards input to the inner component so SelectList etc. work inside overlays.
 */
export class OverlayBox implements Component, Focusable {
  private innerComponent: Component;
  private title: string;
  focused = false;

  constructor(innerComponent: Component, title: string = '') {
    this.innerComponent = innerComponent;
    this.title = title;
  }

  handleInput(data: string): void {
    // Forward input to the inner component (e.g., SelectList)
    if (this.innerComponent.handleInput) {
      this.innerComponent.handleInput(data);
    }
  }

  invalidate(): void {
    this.innerComponent.invalidate();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(width - 4, 10); // 2 border + 2 padding
    const innerLines = this.innerComponent.render(innerWidth);
    const contentWidth = width - 2; // Just the border chars

    const lines: string[] = [];

    // Top border: ╭─ Title ──────╮
    let topBar: string;
    if (this.title) {
      const titleText = ` ${this.title} `;
      const remaining = contentWidth - 1 - visibleWidth(titleText); // 1 for the ─ after ╭
      const dashAfter = Math.max(0, remaining);
      topBar = BORDER_COLOR('\u256D\u2500') + BORDER_COLOR(titleText) + BORDER_COLOR('\u2500'.repeat(dashAfter)) + BORDER_COLOR('\u256E');
    } else {
      topBar = BORDER_COLOR('\u256D' + '\u2500'.repeat(contentWidth) + '\u256E');
    }
    lines.push(topBar);

    // Empty line with background
    lines.push(BORDER_COLOR('\u2502') + OVERLAY_BG(' '.repeat(contentWidth)) + BORDER_COLOR('\u2502'));

    // Content lines with border and background
    for (const innerLine of innerLines) {
      const lineWidth = visibleWidth(innerLine);
      const pad = Math.max(0, contentWidth - 1 - lineWidth); // 1 for left padding
      lines.push(
        BORDER_COLOR('\u2502') + OVERLAY_BG(' ' + innerLine + ' '.repeat(pad)) + BORDER_COLOR('\u2502'),
      );
    }

    // Empty line with background
    lines.push(BORDER_COLOR('\u2502') + OVERLAY_BG(' '.repeat(contentWidth)) + BORDER_COLOR('\u2502'));

    // Bottom border: ╰──────────╯
    lines.push(BORDER_COLOR('\u2570' + '\u2500'.repeat(contentWidth) + '\u256F'));

    return lines;
  }
}
