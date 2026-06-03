/**
 * The content model for a split-flap board. A scene is a set of placements;
 * the compositor flattens them onto a character grid that the renderer diffs
 * against to animate. Pure and renderer-agnostic, shared by the web and TUI.
 */

export interface Placement {
  text: string;
  /** Row index, 0-based from the top. */
  row: number;
  /** Start column for left align. Ignored for center and right. */
  col?: number;
  align?: 'left' | 'center' | 'right';
}

export interface Scene {
  /** How long this scene rests before the director advances, ms. */
  hold: number;
  placements: Placement[];
}

/**
 * Flatten placements onto a rows x cols grid of characters (row-major), filling
 * empty space with blanks. Out-of-bounds characters are clipped.
 */
export function composite(
  placements: Placement[],
  rows: number,
  cols: number,
): string[] {
  const buf: string[] = new Array(rows * cols).fill(' ');
  for (const p of placements) {
    if (p.row < 0 || p.row >= rows) continue;
    const text = p.text.toUpperCase();
    let start: number;
    if (p.align === 'center') start = Math.floor((cols - text.length) / 2);
    else if (p.align === 'right') start = cols - text.length;
    else start = p.col ?? 0;
    for (let i = 0; i < text.length; i++) {
      const col = start + i;
      if (col < 0 || col >= cols) continue;
      buf[p.row * cols + col] = text[i]!;
    }
  }
  return buf;
}
