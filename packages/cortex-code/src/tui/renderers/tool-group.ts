/**
 * ToolGroupComponent: folds a run of low-signal tool calls into a single
 * living line in the activity stream.
 *
 *   Exploration / web (read-only): the content already went to the model, so
 *   the user only needs to know it happened and roughly how much.
 *
 *   Changes (Edit / Write): the work product. Folded to "Changed N files +a -r";
 *   expand (ctrl+e) reveals the per-file diffs.
 */

import { type Component, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import type { DiffHunk, EditDetails, WriteDetails } from '@animus-labs/cortex';
import { getToolTheme, type ToolTheme } from '../theme.js';
import { formatDuration, shortenPath } from './path-utils.js';

export type ToolGroupKind = 'exploration' | 'web' | 'changes';

type GroupedToolStatus = 'pending' | 'success' | 'error';

interface GroupedToolEntry {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  status: GroupedToolStatus;
  startedAt: number;
  durationMs?: number;
  summary: string;
  error?: string;
  // Populated for the 'changes' kind.
  filePath?: string;
  additions?: number;
  removals?: number;
  bodyLines?: string[];
}

interface GroupLabel {
  /** Shown while the group is open. */
  active: string;
  /** Past-tense verb for the collapsed headline. */
  verb: string;
  /** Noun counted in the headline ("file" -> "4 files"). */
  noun: string;
}

const GROUP_LABELS: Record<ToolGroupKind, GroupLabel> = {
  exploration: { active: 'Exploring', verb: 'Explored', noun: 'file' },
  web: { active: 'Researching', verb: 'Researched', noun: 'page' },
  changes: { active: 'Editing', verb: 'Changed', noun: 'file' },
};

const DOT = '●';
const ACTIVE_GLYPH = '⋯';
const CONNECTOR = '⎿';
const MAX_DIFF_LINES = 12;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 60);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function diffCounts(diff: DiffHunk[] | null | undefined): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const hunk of diff ?? []) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) removals += 1;
    }
  }
  return { additions, removals };
}

/** Flatten, window around the first change, cap, and colorize a diff for expansion. */
function formatDiffBody(diff: DiffHunk[] | null | undefined, theme: ToolTheme): string[] {
  const flat: string[] = [];
  for (const hunk of diff ?? []) flat.push(...hunk.lines);
  if (flat.length === 0) return [];

  const firstChange = flat.findIndex(line => line.startsWith('+') || line.startsWith('-'));
  const start = firstChange > 3 ? firstChange - 3 : 0;
  let windowed = flat.slice(start);
  let truncated = false;
  if (windowed.length > MAX_DIFF_LINES) {
    windowed = windowed.slice(0, MAX_DIFF_LINES);
    truncated = true;
  }

  const out = windowed.map(line => {
    if (line.startsWith('+')) return chalk.hex(theme.diffAdd)('+ ' + line.slice(1));
    if (line.startsWith('-')) return chalk.hex(theme.diffRemove)('- ' + line.slice(1));
    return chalk.hex(theme.diffContext)('  ' + line.slice(1));
  });
  if (truncated) out.push(chalk.hex(theme.muted)('…'));
  return out;
}

function startSummary(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read': {
      const filePath = String(args['file_path'] ?? args['path'] ?? '');
      return `read ${shortenPath(filePath)}`;
    }
    case 'Glob': {
      const pattern = String(args['pattern'] ?? '');
      const searchPath = String(args['path'] ?? '');
      return `glob ${pattern}${searchPath ? ` in ${shortenPath(searchPath)}` : ''}`;
    }
    case 'Grep': {
      const pattern = String(args['pattern'] ?? '');
      const searchPath = String(args['path'] ?? '');
      return `grep /${pattern}/${searchPath ? ` in ${shortenPath(searchPath)}` : ''}`;
    }
    case 'WebFetch': {
      const url = String(args['url'] ?? '');
      return `fetch ${domainFromUrl(url)}`;
    }
    case 'Edit':
      return `edit ${shortenPath(String(args['file_path'] ?? ''))}`;
    case 'Write':
      return `write ${shortenPath(String(args['file_path'] ?? ''))}`;
    default:
      return toolName.toLowerCase();
  }
}

function resultSummary(toolName: string, args: Record<string, unknown>, details: unknown): string {
  const d = asRecord(details);

  switch (toolName) {
    case 'Read': {
      const filePath = String(d['filePath'] ?? args['file_path'] ?? args['path'] ?? '');
      const totalLines = Number(d['totalLines'] ?? 0);
      const startLine = Number(d['startLine'] ?? 1);
      const endLine = totalLines > 0 ? startLine + totalLines - 1 : 0;
      const range = totalLines > 0 ? `:${startLine}-${endLine}` : '';
      const trunc = d['truncated'] ? ' truncated' : '';
      return `read ${shortenPath(filePath)}${range}${totalLines > 0 ? `, ${totalLines} lines${trunc}` : ''}`;
    }
    case 'Glob': {
      const count = Number(d['totalCount'] ?? 0);
      const trunc = d['truncated'] ? ' truncated' : '';
      return `${startSummary(toolName, args)}, ${count} files${trunc}`;
    }
    case 'Grep': {
      const matches = Number(d['totalMatches'] ?? 0);
      return `${startSummary(toolName, args)}, ${matches} matches`;
    }
    case 'WebFetch': {
      const finalUrl = String(d['finalUrl'] ?? args['url'] ?? '');
      const status = d['statusCode'] ? String(d['statusCode']) : '';
      const size = Number(d['markdownSize'] ?? d['rawSize'] ?? 0);
      const stats = [status, size > 0 ? formatBytes(size) : ''].filter(Boolean).join(', ');
      return `fetch ${domainFromUrl(finalUrl)}${stats ? `, ${stats}` : ''}`;
    }
    default:
      return startSummary(toolName, args);
  }
}

export class ToolGroupComponent implements Component {
  private readonly entries: GroupedToolEntry[] = [];
  private readonly startedAt = Date.now();
  private expanded = false;
  private completedAt: number | null = null;
  private open = true;

  constructor(readonly groupKind: ToolGroupKind) {}

  startToolCall(id: string, toolName: string, args: Record<string, unknown>): void {
    this.completedAt = null;
    this.open = true;
    this.entries.push({
      id,
      toolName,
      args,
      status: 'pending',
      startedAt: Date.now(),
      summary: startSummary(toolName, args),
    });
  }

  completeToolCall(id: string, details: unknown, durationMs: number): void {
    const entry = this.findEntry(id);
    if (!entry) return;
    entry.status = 'success';
    entry.durationMs = durationMs;

    if (this.groupKind === 'changes') {
      this.applyChangeDetails(entry, details);
    } else {
      entry.summary = resultSummary(entry.toolName, entry.args, details);
    }
  }

  failToolCall(id: string, error: string, durationMs: number): void {
    const entry = this.findEntry(id);
    if (!entry) return;
    entry.status = 'error';
    entry.durationMs = durationMs;
    entry.error = error.split('\n')[0] ?? error;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.completedAt = Date.now();
  }

  toggleExpand(): void {
    this.expanded = !this.expanded;
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  dispose(): void {}

  invalidate(): void {}

  render(width: number): string[] {
    const theme = getToolTheme();

    if (this.open) {
      const summary = `${chalk.hex(theme.accent)(ACTIVE_GLYPH)}  ${GROUP_LABELS[this.groupKind].active}…${this.activeDescriptor(theme)}`;
      const latest = this.entries[this.entries.length - 1];
      if (latest && !this.expanded) {
        return this.clampLines([
          summary,
          chalk.hex(theme.muted)(` ${CONNECTOR} ${latest.summary}`),
        ], width);
      }
      if (this.expanded) {
        return this.clampLines([summary, ...this.expandedBody(theme)], width);
      }
      return this.clampLines([summary], width);
    }

    const headline = `${this.statusDot(theme)}  ${this.headline(theme)}${this.durationSuffix(theme)}`;
    if (!this.expanded) {
      return this.clampLines([headline], width);
    }
    return this.clampLines([headline, ...this.expandedBody(theme)], width);
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private findEntry(id: string): GroupedToolEntry | undefined {
    return this.entries.find(entry => entry.id === id);
  }

  private applyChangeDetails(entry: GroupedToolEntry, details: unknown): void {
    const theme = getToolTheme();
    const d = details as (EditDetails & WriteDetails) | undefined;
    const filePath = String(d?.filePath ?? entry.args['file_path'] ?? '');
    const shortPath = shortenPath(filePath);
    const { additions, removals } = diffCounts(d?.diff);
    const isCreate = (d as WriteDetails | undefined)?.isCreate === true;

    entry.filePath = filePath;
    entry.additions = additions;
    entry.removals = removals;
    entry.bodyLines = formatDiffBody(d?.diff, theme);

    const counts = this.formatCountBadge(additions, removals, theme);
    const tag = isCreate && !counts ? chalk.hex(theme.muted)('created') : counts;
    entry.summary = `${shortPath}${tag ? `  ${tag}` : ''}`;
  }

  /** "+12 -3" with add/remove colors, or '' when there is nothing to count. */
  private formatCountBadge(additions: number, removals: number, theme: ToolTheme): string {
    const parts: string[] = [];
    if (additions > 0) parts.push(chalk.hex(theme.diffAdd)(`+${additions}`));
    if (removals > 0) parts.push(chalk.hex(theme.diffRemove)(`-${removals}`));
    return parts.join(' ');
  }

  /** Muted descriptor shown next to the active label (current tool mix). */
  private activeDescriptor(theme: ToolTheme): string {
    const counts = this.formatCounts();
    return counts ? `  ${chalk.hex(theme.muted)(counts)}` : '';
  }

  private headline(theme: ToolTheme): string {
    const label = GROUP_LABELS[this.groupKind];
    if (this.groupKind === 'changes') {
      const files = new Set(this.entries.map(e => e.filePath ?? e.summary)).size;
      let additions = 0;
      let removals = 0;
      for (const entry of this.entries) {
        additions += entry.additions ?? 0;
        removals += entry.removals ?? 0;
      }
      const badge = this.formatCountBadge(additions, removals, theme);
      return `${label.verb} ${files} ${pluralize(label.noun, files)}${badge ? `  ${badge}` : ''}`;
    }
    const count = this.entries.length;
    return `${label.verb} ${count} ${pluralize(label.noun, count)}`;
  }

  private durationSuffix(theme: ToolTheme): string {
    if (!this.completedAt) return '';
    const elapsed = this.completedAt - this.startedAt;
    if (elapsed < 1000) return '';
    return `  ${chalk.hex(theme.muted)(formatDuration(elapsed))}`;
  }

  private expandedBody(theme: ToolTheme): string[] {
    const lines: string[] = [];
    for (const entry of this.entries) {
      lines.push(`   ${this.entryDot(entry, theme)} ${entry.summary}${this.entryError(entry, theme)}`);
      for (const body of entry.bodyLines ?? []) {
        lines.push(`     ${body}`);
      }
    }
    return lines;
  }

  private statusDot(theme: ToolTheme): string {
    const hasError = this.entries.some(entry => entry.status === 'error');
    return hasError
      ? chalk.hex(theme.statusError)(DOT)
      : chalk.hex(theme.statusSuccess)(DOT);
  }

  private entryDot(entry: GroupedToolEntry, theme: ToolTheme): string {
    if (entry.status === 'error') return chalk.hex(theme.statusError)(DOT);
    if (entry.status === 'pending') return chalk.hex(theme.accent)(ACTIVE_GLYPH);
    return chalk.hex(theme.statusSuccess)(DOT);
  }

  private entryError(entry: GroupedToolEntry, theme: ToolTheme): string {
    return entry.error ? chalk.hex(theme.error)(`  ${entry.error}`) : '';
  }

  private formatCounts(): string {
    const counts = new Map<string, number>();
    for (const entry of this.entries) {
      counts.set(entry.toolName, (counts.get(entry.toolName) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([name, count]) => count > 1 ? `${name} x${count}` : name)
      .join(', ');
  }

  private clampLines(lines: string[], width: number): string[] {
    return lines.map(line => visibleWidth(line) > width ? truncateToWidth(line, width) : line);
  }
}
