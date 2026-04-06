/**
 * Utility for truncating content lines with collapse/expand support.
 *
 * Pure function (not a component). Returns truncated lines with a
 * "... N more lines (ctrl+e to expand)" indicator when collapsed.
 */

import chalk from 'chalk';

export type CollapseMode = 'head' | 'tail' | 'head-tail';

export interface CollapseOptions {
  /** Truncation mode: show head, tail, or both head and tail. */
  mode: CollapseMode;
  /** Maximum lines to show when collapsed. */
  limit: number;
  /** Lines to show at the top (head-tail mode). Default: ceil(limit * 0.6). */
  headLines?: number;
  /** Lines to show at the bottom (head-tail mode). Default: floor(limit * 0.4). */
  tailLines?: number;
  /** Whether the content is currently expanded. */
  expanded: boolean;
}

export interface CollapseResult {
  /** The (possibly truncated) lines to display. */
  lines: string[];
  /** Whether truncation was applied. */
  truncated: boolean;
  /** Number of hidden lines (0 if not truncated). */
  hiddenCount: number;
}

/**
 * Truncate content lines based on collapse options.
 *
 * When expanded or lines fit within the limit, returns all lines unchanged.
 * When collapsed, truncates according to the mode and appends a hint.
 */
export function collapseContent(lines: string[], options: CollapseOptions): CollapseResult {
  if (options.expanded || lines.length <= options.limit) {
    return { lines, truncated: false, hiddenCount: 0 };
  }

  const hiddenCount = lines.length - options.limit;
  const hint = chalk.dim(`  ... ${hiddenCount} more lines (ctrl+e to expand)`);

  switch (options.mode) {
    case 'head': {
      return {
        lines: [...lines.slice(0, options.limit), hint],
        truncated: true,
        hiddenCount,
      };
    }

    case 'tail': {
      return {
        lines: [hint, ...lines.slice(-options.limit)],
        truncated: true,
        hiddenCount,
      };
    }

    case 'head-tail': {
      const headCount = options.headLines ?? Math.ceil(options.limit * 0.6);
      const tailCount = options.tailLines ?? Math.floor(options.limit * 0.4);
      const headSlice = lines.slice(0, headCount);
      const tailSlice = lines.slice(-tailCount);
      const middleHidden = Math.max(0, lines.length - headCount - tailCount);
      const middleHint = chalk.dim(`  ... +${middleHidden} lines ...`);

      return {
        lines: [...headSlice, middleHint, ...tailSlice],
        truncated: true,
        hiddenCount: middleHidden,
      };
    }
  }
}
