/**
 * GlobToolRenderer: renders file listing results with file count in footer.
 */

import chalk from 'chalk';
import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import type { GlobDetails } from '@animus-labs/cortex';
import { collapseContent } from './collapsible-content.js';
import { shortenPath } from './path-utils.js';
import { registerRenderer } from './registry.js';

const COLLAPSED_LINES = 12;

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

const globRenderer: ToolRenderer = {
  renderCall(args: Record<string, unknown>, _context: ToolRenderContext): ToolCallDisplay {
    const pattern = String(args['pattern'] ?? '');
    const searchPath = String(args['path'] ?? '');
    const shortPath = searchPath ? shortenPath(searchPath) : '';

    return {
      contentLines: [],
      footerText: `glob ${pattern}${shortPath ? ` in ${shortPath}` : ''}`,
    };
  },

  renderResult(result: unknown, details: unknown, context: ToolRenderContext): ToolResultDisplay {
    const d = details as GlobDetails | undefined;
    const text = extractTextContent(result);
    const fileLines = text.split('\n').filter(l => l.trim().length > 0);

    // Shorten paths for display
    const displayLines = fileLines.map(line => shortenPath(line.trim()));

    const { lines } = collapseContent(displayLines, {
      mode: 'head',
      limit: COLLAPSED_LINES,
      expanded: context.expanded,
    });

    // Footer with pattern, path, and file count
    const pattern = String(context.args['pattern'] ?? '');
    const searchPath = String(context.args['path'] ?? '');
    const shortPath = searchPath ? shortenPath(searchPath) : '';
    const count = d?.totalCount ?? fileLines.length;
    const truncInfo = d?.truncated ? ' (truncated)' : '';

    return {
      contentLines: lines.length > 0 ? lines : [chalk.hex(context.theme.muted)('(no files found)')],
      footerText: `glob ${pattern}${shortPath ? ` in ${shortPath}` : ''}  ${count} files${truncInfo}`,
    };
  },
};

registerRenderer('Glob', globRenderer);
export { globRenderer };
