/**
 * GlobToolRenderer: compact single-line renderer for file listings.
 *
 * Shows pattern, path, and file count on a single line.
 */

import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import type { GlobDetails } from '@animus-labs/cortex';
import { shortenPath } from './path-utils.js';
import { registerRenderer } from './registry.js';

const globRenderer: ToolRenderer = {
  renderCall(args: Record<string, unknown>, _context: ToolRenderContext): ToolCallDisplay {
    const pattern = String(args['pattern'] ?? '');
    const searchPath = String(args['path'] ?? '');
    const shortPath = searchPath ? shortenPath(searchPath) : '';

    return {
      headerText: `glob ${pattern}${shortPath ? ` in ${shortPath}` : ''}`,
      contentLines: [],
      footerText: '',
    };
  },

  renderResult(_result: unknown, details: unknown, context: ToolRenderContext): ToolResultDisplay {
    const d = details as GlobDetails | undefined;
    const pattern = String(context.args['pattern'] ?? '');
    const searchPath = String(context.args['path'] ?? '');
    const shortPath = searchPath ? shortenPath(searchPath) : '';
    const count = d?.totalCount ?? 0;
    const truncInfo = d?.truncated ? ' (truncated)' : '';

    return {
      headerText: `glob ${pattern}${shortPath ? ` in ${shortPath}` : ''}`,
      contentLines: [],
      footerText: `${count} files${truncInfo}`,
    };
  },
};

registerRenderer('Glob', globRenderer);
export { globRenderer };
