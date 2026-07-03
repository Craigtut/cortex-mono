/**
 * WriteToolRenderer: compact single-line renderer for file writes.
 *
 * Shows file path and created/modified status on a single line.
 */

import chalk from 'chalk';
import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import type { WriteDetails } from '@animus-labs/cortex';
import { shortenPath } from './path-utils.js';
import { fileLink } from './osc-links.js';
import { sanitizeTerminalText } from './sanitize-terminal.js';
import { registerRenderer } from './registry.js';

function extractResultText(result: unknown): string {
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
  return '';
}

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

  renderResult(result: unknown, details: unknown, context: ToolRenderContext): ToolResultDisplay {
    const d = details as WriteDetails | undefined;
    const filePath = d?.filePath ?? '';
    const shortPath = shortenPath(filePath);

    // A refused write (critical path, read-before-write, or stale-mtime) returns
    // no bytes written, no diff, and is not a create. Surface the refusal text so
    // the operator sees WHY the write was blocked instead of just a red dot.
    const isRejection = d?.bytesWritten === 0 && d?.isCreate === false && (!d?.diff || d.diff.length === 0);
    const resultText = extractResultText(result);
    if (isRejection && resultText) {
      return {
        headerText: `write ${shortPath}`,
        contentLines: [chalk.hex(context.theme.muted)(sanitizeTerminalText(resultText))],
        footerText: 'rejected',
      };
    }

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
