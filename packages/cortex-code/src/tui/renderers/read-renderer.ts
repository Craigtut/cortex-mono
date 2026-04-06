/**
 * ReadToolRenderer: renders file read results with syntax highlighting,
 * line numbers, and collapsible content.
 */

import chalk from 'chalk';
import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import type { ReadDetails } from '@animus-labs/cortex';
import { collapseContent } from './collapsible-content.js';
import { highlightFile } from './syntax-highlighter.js';
import { shortenPath } from './path-utils.js';
import { fileLink } from './osc-links.js';
import { registerRenderer } from './registry.js';

const COLLAPSED_LINES = 20;

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

const readRenderer: ToolRenderer = {
  renderCall(args: Record<string, unknown>, _context: ToolRenderContext): ToolCallDisplay {
    const filePath = String(args['file_path'] ?? '');
    const shortPath = shortenPath(filePath);
    const linkedPath = fileLink(filePath, shortPath);

    return {
      contentLines: [],
      footerText: `read ${linkedPath}`,
    };
  },

  renderResult(result: unknown, details: unknown, context: ToolRenderContext): ToolResultDisplay {
    const d = details as ReadDetails | undefined;
    const filePath = d?.filePath ?? '';
    const text = extractTextContent(result);

    // Syntax highlight the content
    const highlightedLines = highlightFile(text, filePath);

    // Add line numbers from the actual offset
    const startLine = d?.startLine ?? 1;
    const maxLineNumWidth = String(startLine + highlightedLines.length - 1).length;
    const numberedLines = highlightedLines.map((line, i) => {
      const lineNum = String(startLine + i).padStart(maxLineNumWidth);
      return chalk.hex(context.theme.lineNumber)(lineNum) + '  ' + line;
    });

    // Collapse
    const { lines } = collapseContent(numberedLines, {
      mode: 'head',
      limit: COLLAPSED_LINES,
      expanded: context.expanded,
    });

    // Footer
    const shortPath = shortenPath(filePath);
    const linkedPath = fileLink(filePath, shortPath);
    const rangeStart = d?.startLine ?? 1;
    const rangeEnd = d ? rangeStart + d.totalLines - 1 : 0;
    const rangeInfo = d ? `:${rangeStart}-${rangeEnd}` : '';
    const truncInfo = d?.truncated ? ' (truncated)' : '';

    return {
      contentLines: lines,
      footerText: `read ${linkedPath}${rangeInfo}${truncInfo}`,
    };
  },

  renderError(error: string, args: Record<string, unknown>, context: ToolRenderContext): ToolResultDisplay {
    const filePath = String(args['file_path'] ?? '');
    const shortPath = shortenPath(filePath);
    const errorColor = chalk.hex(context.theme.error);

    let errorLines: string[];
    if (error.includes('ENOENT') || error.includes('no such file')) {
      errorLines = [errorColor(`File not found: ${shortPath}`)];
    } else if (error.includes('EACCES') || error.includes('permission denied')) {
      errorLines = [errorColor(`Permission denied: ${shortPath}`)];
    } else {
      errorLines = [errorColor(error)];
    }

    return {
      contentLines: errorLines,
      footerText: `read ${shortPath}`,
    };
  },
};

registerRenderer('Read', readRenderer);
export { readRenderer };
