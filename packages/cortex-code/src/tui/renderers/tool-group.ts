import { type Component, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { getToolTheme } from '../theme.js';
import { formatDuration, shortenPath } from './path-utils.js';

export type ToolGroupKind = 'exploration' | 'web';

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
}

const GROUP_LABELS: Record<ToolGroupKind, { active: string; complete: string }> = {
  exploration: { active: 'Exploring codebase', complete: 'explored codebase' },
  web: { active: 'Researching web', complete: 'web research' },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
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

  constructor(readonly groupKind: ToolGroupKind) {}

  startToolCall(id: string, toolName: string, args: Record<string, unknown>): void {
    this.completedAt = null;
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
    entry.summary = resultSummary(entry.toolName, entry.args, details);
    this.completedAt = this.hasPendingEntries() ? null : Date.now();
  }

  failToolCall(id: string, error: string, durationMs: number): void {
    const entry = this.findEntry(id);
    if (!entry) return;
    entry.status = 'error';
    entry.durationMs = durationMs;
    entry.error = error.split('\n')[0] ?? error;
    this.completedAt = this.hasPendingEntries() ? null : Date.now();
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
    const active = this.hasPendingEntries();
    const hasError = this.entries.some(entry => entry.status === 'error');
    const labels = GROUP_LABELS[this.groupKind];
    const icon = active
      ? chalk.hex(theme.statusPending)('\u22EF')
      : hasError
        ? chalk.hex(theme.statusError)('\u2717')
        : chalk.hex(theme.statusSuccess)('\u2713');
    const label = active ? labels.active : labels.complete;
    const counts = this.formatCounts();
    const duration = !active && this.completedAt
      ? chalk.hex(theme.muted)(` ${formatDuration(this.completedAt - this.startedAt)}`)
      : '';
    const summary = `${icon} ${label}${counts ? ` ${chalk.hex(theme.muted)(counts)}` : ''}${duration}`;

    if (!this.expanded) {
      const latest = this.entries[this.entries.length - 1];
      if (active && latest) {
        return this.clampLines([
          summary,
          chalk.hex(theme.muted)(`  latest ${this.formatEntry(latest)}`),
        ], width);
      }

      return this.clampLines([chalk.hex(theme.border)('\u2570\u2500\u2500 ') + summary], width);
    }

    const border = chalk.hex(theme.border);
    const mutedBorder = chalk.hex(theme.borderMuted);
    const lines = [
      border('\u256D\u2500\u2500 ') + summary,
      ...this.entries.map(entry => `${mutedBorder('\u2502')}  ${this.formatEntry(entry)}`),
      border('\u2570\u2500\u2500 ') + `${this.entries.length} tool calls`,
    ];

    return this.clampLines(lines, width);
  }

  private findEntry(id: string): GroupedToolEntry | undefined {
    return this.entries.find(entry => entry.id === id);
  }

  private hasPendingEntries(): boolean {
    return this.entries.some(entry => entry.status === 'pending');
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

  private formatEntry(entry: GroupedToolEntry): string {
    const theme = getToolTheme();
    const icon = entry.status === 'success'
      ? chalk.hex(theme.statusSuccess)('\u2713')
      : entry.status === 'error'
        ? chalk.hex(theme.statusError)('\u2717')
        : chalk.hex(theme.statusPending)('\u22EF');
    const duration = entry.durationMs !== undefined
      ? chalk.hex(theme.muted)(` ${formatDuration(entry.durationMs)}`)
      : '';
    const error = entry.error ? chalk.hex(theme.error)(` ${entry.error}`) : '';
    return `${icon} ${entry.summary}${duration}${error}`;
  }

  private clampLines(lines: string[], width: number): string[] {
    return lines.map(line => visibleWidth(line) > width ? truncateToWidth(line, width) : line);
  }
}
