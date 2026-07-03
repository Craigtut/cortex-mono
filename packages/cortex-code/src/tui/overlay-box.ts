import { type Component, type Focusable, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { palette } from './theme.js';

const OVERLAY_BG = chalk.bgHex(palette.panelBg);
const BORDER_COLOR = chalk.hex(palette.accentDeep);

/**
 * Wraps content lines with a box-drawing border and dark background.
 * Used for overlays to visually separate them from the transcript.
 * Forwards input to the inner component so SelectList etc. work inside overlays.
 */
export class OverlayBox implements Component, Focusable {
  private innerComponent: Component;
  private title: string;
  private activeChild: Component | null = null;
  focused = false;

  constructor(innerComponent: Component, title: string = '') {
    this.innerComponent = innerComponent;
    this.title = title;
  }

  /**
   * Designate which inner component receives keyboard input.
   *
   * pi-tui only dispatches input to the component registered as the overlay
   * (this OverlayBox), never to its detached descendants: calling
   * tui.setFocus() on an inner child gets redirected back to the overlay
   * wrapper, because pi-tui's focus-restore treats overlay children as
   * unmounted (its mounted-check walks the base tree, not the overlay stack).
   * So the overlay stays the TUI focus target and forwards keystrokes to the
   * active child set here. Without this, input lands on the inner Container
   * (which has no handleInput) and is silently dropped.
   */
  setActiveChild(child: Component | null): void {
    this.activeChild = child;
  }

  handleInput(data: string): void {
    // Route to the designated active child, falling back to the inner
    // container. The inner container is a plain Container with no handleInput,
    // so absent an active child, input is dropped.
    const target = this.activeChild ?? this.innerComponent;
    target.handleInput?.(data);
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
