/**
 * Utilities for path display and duration formatting in tool renderers.
 */

import * as os from 'node:os';
import { visibleWidth } from '@mariozechner/pi-tui';

const HOME = os.homedir();

/**
 * Replace the home directory prefix with ~ for display.
 */
export function shortenPath(fullPath: string): string {
  if (fullPath.startsWith(HOME)) {
    return '~' + fullPath.slice(HOME.length);
  }
  return fullPath;
}

/**
 * Truncate a path from the beginning with ... to fit within maxWidth.
 */
export function truncatePath(path: string, maxWidth: number): string {
  if (visibleWidth(path) <= maxWidth) return path;
  const prefix = '...';
  const available = maxWidth - prefix.length;
  if (available <= 0) return prefix.slice(0, maxWidth);
  return prefix + path.slice(-available);
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * Examples: "0.1s", "4.2s", "1m 30s"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
