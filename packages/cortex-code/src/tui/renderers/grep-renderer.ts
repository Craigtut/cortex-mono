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
 * Colorize grep output: file paths in accent, line numbers in muted.
 */
function colorizeGrepOutput(text: string, theme: ToolRenderContext['theme']): string[] {
  const lines = text.split('\n');
  const colored: string[] = [];
  const accentColor = chalk.hex(theme.accent);
  const mutedColor = chalk.hex(theme.muted);

  for (const line of lines) {
    if (!line.trim()) continue;

    // Lines with ":" are matches (file:line:content or just file:line)
    // Lines without ":" might be file headers (files_with_matches mode)
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const beforeColon = line.slice(0, colonIdx);
      const rest = line.slice(colonIdx);

      // Check if it looks like a file path (contains / or \)
      if (beforeColon.includes('/') || beforeColon.includes('\\')) {
        colored.push(accentColor(shortenPath(beforeColon)) + mutedColor(rest.slice(0, rest.indexOf(':', 1) + 1)) + rest.slice(rest.indexOf(':', 1) + 1));
      } else {
        colored.push(mutedColor(beforeColon + ':') + rest.slice(1));
      }
    } else {
      // Standalone file path or header
      colored.push(accentColor(shortenPath(line)));
    }
  }

  return colored;
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
    const coloredLines = colorizeGrepOutput(text, context.theme);

    const { lines } = collapseContent(coloredLines, {
      mode: 'head',
      limit: COLLAPSED_LINES,
      expanded: context.expanded,
    });

    // Footer with match count
    const matchInfo = d ? `  ${d.totalMatches} matches` : '';
    const pattern = ''; // Pattern was in renderCall
    const footer = `grep${matchInfo}`;

    return {
      contentLines: lines.length > 0 ? lines : [chalk.hex(context.theme.muted)('(no matches)')],
      footerText: footer,
    };
  },
};

registerRenderer('Grep', grepRenderer);
export { grepRenderer };
