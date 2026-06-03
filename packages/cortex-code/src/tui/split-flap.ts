import { Container, Text, type TUI } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { flapTiming } from '@animus-labs/brand';
import { palette } from './theme.js';

/**
 * The Cortex Code wordmark rendered as a split-flap board. The mark is one
 * frame of the board: cells riffle through the flap alphabet on startup, then
 * settle left to right, the way a Solari board resolves into place.
 *
 * Characters only, no background fill. The terminal owns the surface behind
 * the cells; we draw the frame and the letters.
 */

/** The wordmark, one glyph per cell: ‹cortex›_ */
const WORDMARK = ['‹', 'c', 'o', 'r', 't', 'e', 'x', '›', '_'] as const;

/** Glyphs a cell rolls through before it lands. Lowercase, to match the mark. */
const TUMBLE = 'abcdefghijklmnopqrstuvwxyz0123456789<>/.:_‹›'.split('');

/** Inner width of the board frame (between the vertical bars). */
const INNER_WIDTH = 30;
/** Left indent so the board lines up with the readout below it. */
const INDENT = '  ';
/** Cells are spaced one column apart: glyph + space + glyph ... */
const CONTENT_LEFT_PAD = 2;

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------
/** How long the whole board riffles before the first cell starts to settle. */
const INITIAL_HOLD_MS = 1000;
/** Gap between one cell locking and the next, so it settles left to right. */
const SETTLE_STAGGER_MS = 150;
/** Sampling interval for the animation. ~25fps is smooth in a terminal. */
const FRAME_MS = 40;
/** How fast a riffling cell swaps glyphs (the brand's top-speed flip). */
const RIFFLE_MS = flapTiming.topMs;
/** A short decelerating brake into the target: the satisfying "thunk". */
const BRAKE_MS = [
  Math.round(flapTiming.topMs * 0.75),
  flapTiming.topMs,
  Math.round((flapTiming.topMs + flapTiming.endMs) / 2),
  flapTiming.endMs,
];
const BRAKE_CUM = BRAKE_MS.reduce<number[]>((acc, d) => {
  acc.push((acc[acc.length - 1] ?? 0) + d);
  return acc;
}, []);
const BRAKE_TOTAL = BRAKE_CUM[BRAKE_CUM.length - 1] ?? 0;

const frame = chalk.hex(palette.accentDeep);
const lit = chalk.hex(palette.accentBright).bold;
const tumbling = chalk.hex(palette.accentMid).bold;

interface Cell {
  char: string;
  settled: boolean;
}

interface CellPlan {
  target: string;
  targetIdx: number;
  /** When this cell stops riffling and begins braking into its target. */
  settleStart: number;
  /** When this cell is fully locked. */
  lockAt: number;
  /** Per-cell riffle phase offset, so cells do not roll in lockstep. */
  riffleOffset: number;
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

function boxTop(): string {
  return INDENT + frame('╭' + '─'.repeat(INNER_WIDTH) + '╮');
}

function boxBottom(): string {
  return INDENT + frame('╰' + '─'.repeat(INNER_WIDTH) + '╯');
}

function contentLine(cells: Cell[]): string {
  const glyphs = cells.map((c) => (c.settled ? lit : tumbling)(c.char)).join(' ');
  // Visible width of the cell strip: one column per glyph, one space between.
  const stripWidth = cells.length * 2 - 1;
  const trailing = Math.max(0, INNER_WIDTH - CONTENT_LEFT_PAD - stripWidth);
  return (
    INDENT +
    frame('│') +
    ' '.repeat(CONTENT_LEFT_PAD) +
    glyphs +
    ' '.repeat(trailing) +
    frame('│')
  );
}

function settledCells(): Cell[] {
  return WORDMARK.map((char) => ({ char, settled: true }));
}

/** The glyph a cell shows at time `t`, given its plan. */
function cellAt(plan: CellPlan, t: number): Cell {
  // Riffle: roll forward through the tumble alphabet.
  if (t < plan.settleStart) {
    const idx = mod(plan.riffleOffset + Math.floor(t / RIFFLE_MS), TUMBLE.length);
    return { char: TUMBLE[idx] ?? plan.target, settled: false };
  }
  // Brake: step through the last few glyphs into the target, decelerating.
  const bt = t - plan.settleStart;
  let k = 0;
  while (k < BRAKE_CUM.length && bt >= (BRAKE_CUM[k] ?? 0)) k++;
  const stepsFromTarget = BRAKE_MS.length - 1 - k;
  if (k >= BRAKE_MS.length || stepsFromTarget <= 0) {
    return { char: plan.target, settled: true };
  }
  const idx = mod(plan.targetIdx - stepsFromTarget, TUMBLE.length);
  return { char: TUMBLE[idx] ?? plan.target, settled: false };
}

/**
 * Append the split-flap board to a container. The frame draws once; the inner
 * row riffles and settles. On a non-interactive stream, or when `animate` is
 * false, the board renders in its settled state with no animation.
 */
export function addSplitFlapBoard(
  container: Container,
  tui: TUI,
  { animate = true }: { animate?: boolean } = {},
): void {
  const content = new Text('', 0, 0);

  container.addChild(new Text(boxTop(), 0, 0));
  container.addChild(content);
  container.addChild(new Text(boxBottom(), 0, 0));

  if (!animate || !process.stdout.isTTY) {
    content.setText(contentLine(settledCells()));
    return;
  }

  const plans: CellPlan[] = WORDMARK.map((target, i) => {
    const settleStart = INITIAL_HOLD_MS + i * SETTLE_STAGGER_MS;
    return {
      target,
      targetIdx: Math.max(0, TUMBLE.indexOf(target)),
      settleStart,
      lockAt: settleStart + BRAKE_TOTAL,
      riffleOffset: i * 7, // a fixed, cheap desync between cells
    };
  });
  const totalMs = Math.max(...plans.map((p) => p.lockAt));

  const renderAt = (t: number): void => {
    content.setText(contentLine(plans.map((p) => cellAt(p, t))));
  };

  // Paint the first riffle frame so the board never flashes empty.
  renderAt(0);

  let elapsed = 0;
  const tick = (): void => {
    elapsed += FRAME_MS;
    if (elapsed >= totalMs) {
      content.setText(contentLine(settledCells()));
      tui.requestRender();
      return;
    }
    renderAt(elapsed);
    tui.requestRender();
    setTimeout(tick, FRAME_MS);
  };
  setTimeout(tick, FRAME_MS);
}
