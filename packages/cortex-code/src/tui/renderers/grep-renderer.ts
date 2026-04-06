/**
 * GrepToolRenderer: renders search results grouped by file path
 * with match count in the footer.
 */

import chalk from 'chalk';
import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import type { GrepDetails } from '@animus-labs/cortex';
import { collapseContent } from './collapsible-content.js';
import { shortenPath } from './path-utils.js';
import { registerRenderer } from './registry.js';

const COLLAPSED_LINES = 10;

function extractTextContent(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'content' in (result as Record<string, unknown>)) {
    const content = (result as Record<string, unknown>)['content'];
    if (Array.isArray(content)) {
      return content
        .filter((c: unknown) => c && typeof c === 'object' && (c as Record<string, unknown>)['type'] === 'text')
        .map((c: unknown) => (c as Record<string, string>)['text'])
        .join('\n');
    }
  }
  return String(result ?? '');
}

/**
 * Parse ripgrep output and group matches under file headers.
 *
 * Input format varies:
 * - "file:line:content" (content mode with line numbers)
 * - "file" (files_with_matches mode)
 * - "file:count" (count mode)
 */
function groupByFile(text: string, theme: ToolRenderContext['theme']): string[] {
  const rawLines = text.split('\n').filter(l => l.trim().length > 0);
  const accentColor = chalk.hex(theme.accent);
  const mutedColor = chalk.hex(theme.muted);

  // Group lines by file path
  const groups = new Map<string, string[]>();
  const fileOrder: string[] = [];

  for (const line of rawLines) {
    // Try to parse "file:lineNum:content" or "file:lineNum"
    const match = line.match(/^(.+?):(\d+)[:](.*)/);
    if (match) {
      const [, filePath, lineNum, content] = match;
      if (!groups.has(filePath!)) {
        groups.set(filePath!, []);
        fileOrder.push(filePath!);
      }
      groups.get(filePath!)!.push(`  ${mutedColor(lineNum + ':')} ${content}`);
    } else {
      // Standalone file path (files_with_matches) or unrecognized format
      if (!groups.has(line)) {
        groups.set(line, []);
        fileOrder.push(line);
      }
    }
  }

  // Build output with file headers
  const output: string[] = [];
  for (const filePath of fileOrder) {
    output.push(accentColor(shortenPath(filePath)));
    const matches = groups.get(filePath) ?? [];
    output.push(...matches);
  }

  return output;
}

const grepRenderer: ToolRenderer = {
  renderCall(args: Record<string, unknown>, _context: ToolRenderContext): ToolCallDisplay {
    const pattern = String(args['pattern'] ?? '');
    const searchPath = String(args['path'] ?? '');
    const shortPath = searchPath ? shortenPath(searchPath) : '';

    return {
      contentLines: [],
      footerText: `grep /${pattern}/${shortPath ? ` in ${shortPath}` : ''}`,
    };
  },

  renderResult(result: unknown, details: unknown, context: ToolRenderContext): ToolResultDisplay {
    const d = details as GrepDetails | undefined;
    const text = extractTextContent(result);
    const groupedLines = groupByFile(text, context.theme);

    const { lines } = collapseContent(groupedLines, {
      mode: 'head',
      limit: COLLAPSED_LINES,
      expanded: context.expanded,
    });

    // Footer with pattern and match count (args available via context)
    const pattern = String(context.args['pattern'] ?? '');
    const searchPath = String(context.args['path'] ?? '');
    const shortPath = searchPath ? shortenPath(searchPath) : '';
    const matchCount = d?.totalMatches ?? 0;

    return {
      contentLines: lines.length > 0 ? lines : [chalk.hex(context.theme.muted)('(no matches)')],
      footerText: `grep /${pattern}/${shortPath ? ` in ${shortPath}` : ''}  ${matchCount} matches`,
    };
  },
};

registerRenderer('Grep', grepRenderer);
export { grepRenderer };
