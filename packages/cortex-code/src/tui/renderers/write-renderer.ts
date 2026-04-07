/**
 * WriteToolRenderer: compact single-line renderer for file writes.
 *
 * Shows file path and created/modified status on a single line.
 */

import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import type { WriteDetails } from '@animus-labs/cortex';
import { shortenPath } from './path-utils.js';
import { fileLink } from './osc-links.js';
import { registerRenderer } from './registry.js';

const writeRenderer: ToolRenderer = {
  renderCall(args: Record<string, unknown>, _context: ToolRenderContext): ToolCallDisplay {
    const filePath = String(args['file_path'] ?? '');
    const shortPath = shortenPath(filePath);
    const linkedPath = fileLink(filePath, shortPath);

    return {
      headerText: `write ${linkedPath}`,
      contentLines: [],
      footerText: '',
    };
  },

  renderResult(_result: unknown, details: unknown, _context: ToolRenderContext): ToolResultDisplay {
    const d = details as WriteDetails | undefined;
    const filePath = d?.filePath ?? '';
    const shortPath = shortenPath(filePath);
    const linkedPath = fileLink(filePath, shortPath);
    const createInfo = d?.isCreate ? 'created' : '';

    return {
      headerText: `write ${linkedPath}`,
      contentLines: [],
      footerText: createInfo,
    };
  },
};

registerRenderer('Write', writeRenderer);
export { writeRenderer };
