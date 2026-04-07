/**
 * ReadToolRenderer: compact single-line renderer for file reads.
 *
 * Read results don't show content preview since the file content goes
 * to the LLM context, not the user's display. Shows just the file path,
 * line range, and status.
 */

import chalk from 'chalk';
import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import type { ReadDetails } from '@animus-labs/cortex';
import { shortenPath } from './path-utils.js';
import { fileLink } from './osc-links.js';
import { registerRenderer } from './registry.js';

const readRenderer: ToolRenderer = {
  renderCall(args: Record<string, unknown>, _context: ToolRenderContext): ToolCallDisplay {
    const filePath = String(args['file_path'] ?? '');
    const shortPath = shortenPath(filePath);
    const linkedPath = fileLink(filePath, shortPath);

    return {
      headerText: `read ${linkedPath}`,
      contentLines: [],
      footerText: '',
    };
  },

  renderResult(_result: unknown, details: unknown, _context: ToolRenderContext): ToolResultDisplay {
    const d = details as ReadDetails | undefined;
    const filePath = d?.filePath ?? '';
    const shortPath = shortenPath(filePath);
    const linkedPath = fileLink(filePath, shortPath);

    // Range info
    const startLine = d?.startLine ?? 1;
    const endLine = d ? startLine + d.totalLines - 1 : 0;
    const rangeInfo = d && d.totalLines > 0 ? `:${startLine}-${endLine}` : '';
    const lineCount = d ? `${d.totalLines} lines` : '';
    const truncInfo = d?.truncated ? ' (truncated)' : '';

    return {
      headerText: `read ${linkedPath}${rangeInfo}`,
      contentLines: [],
      footerText: `${lineCount}${truncInfo}`,
    };
  },

  renderError(error: string, args: Record<string, unknown>, context: ToolRenderContext): ToolResultDisplay {
    const filePath = String(args['file_path'] ?? '');
    const shortPath = shortenPath(filePath);
    const errorColor = chalk.hex(context.theme.error);

    let errorText: string;
    if (error.includes('ENOENT') || error.includes('no such file') || error.includes('does not exist')) {
      errorText = `File not found: ${shortPath}`;
    } else if (error.includes('EACCES') || error.includes('permission denied')) {
      errorText = `Permission denied: ${shortPath}`;
    } else {
      errorText = error.split('\n')[0] ?? error;
    }

    return {
      headerText: `read ${shortPath}`,
      contentLines: [errorColor(errorText)],
      footerText: '',
    };
  },
};

registerRenderer('Read', readRenderer);
export { readRenderer };
