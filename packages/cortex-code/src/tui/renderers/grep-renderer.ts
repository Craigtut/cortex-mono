/**
 * GrepToolRenderer: compact single-line renderer for search results.
 *
 * Shows pattern, path, and match count on a single line by default.
 * Read-only search results go to LLM context; the user just needs
 * to see what was searched and how many matches.
 */

import chalk from 'chalk';
import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import type { GrepDetails } from '@animus-labs/cortex';
import { shortenPath } from './path-utils.js';
import { registerRenderer } from './registry.js';

const grepRenderer: ToolRenderer = {
  renderCall(args: Record<string, unknown>, _context: ToolRenderContext): ToolCallDisplay {
    const pattern = String(args['pattern'] ?? '');
    const searchPath = String(args['path'] ?? '');
    const shortPath = searchPath ? shortenPath(searchPath) : '';

    return {
      headerText: `grep /${pattern}/${shortPath ? ` in ${shortPath}` : ''}`,
      contentLines: [],
      footerText: '',
    };
  },

  renderResult(_result: unknown, details: unknown, _context: ToolRenderContext): ToolResultDisplay {
    const d = details as GrepDetails | undefined;
    const pattern = String(_context.args['pattern'] ?? '');
    const searchPath = String(_context.args['path'] ?? '');
    const shortPath = searchPath ? shortenPath(searchPath) : '';
    const matchCount = d?.totalMatches ?? 0;
    const noMatches = matchCount === 0;

    return {
      headerText: `grep /${pattern}/${shortPath ? ` in ${shortPath}` : ''}`,
      contentLines: noMatches ? [chalk.hex(_context.theme.muted)('(no matches)')] : [],
      footerText: noMatches ? '' : `${matchCount} matches`,
    };
  },
};

registerRenderer('Grep', grepRenderer);
export { grepRenderer };
