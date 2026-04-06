/**
 * WriteToolRenderer: renders file write results with syntax-highlighted
 * content preview.
 */

import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import type { WriteDetails } from '@animus-labs/cortex';
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

const writeRenderer: ToolRenderer = {
  renderCall(args: Record<string, unknown>, _context: ToolRenderContext): ToolCallDisplay {
    const filePath = String(args['file_path'] ?? '');
    const shortPath = shortenPath(filePath);
    const linkedPath = fileLink(filePath, shortPath);

    return {
      contentLines: [],
      footerText: `write ${linkedPath}`,
    };
  },

  renderResult(result: unknown, details: unknown, context: ToolRenderContext): ToolResultDisplay {
    const d = details as WriteDetails | undefined;
    const filePath = d?.filePath ?? '';
    const text = extractTextContent(result);

    // Syntax highlight the written content
    const highlightedLines = highlightFile(text, filePath);

    // Add line numbers
    const maxLineNumWidth = String(highlightedLines.length).length;
    const numberedLines = highlightedLines.map((line, i) => {
      const lineNum = String(i + 1).padStart(maxLineNumWidth);
      const numColor = context.theme.lineNumber;
      return `\x1b[38;2;${hexToRgb(numColor)}m${lineNum}\x1b[0m  ${line}`;
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
    const createInfo = d?.isCreate ? ' (created)' : '';

    return {
      contentLines: lines,
      footerText: `write ${linkedPath}${createInfo}`,
    };
  },
};

/** Convert hex color (#RRGGBB) to "R;G;B" for ANSI escape. */
function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r};${g};${b}`;
}

registerRenderer('Write', writeRenderer);
export { writeRenderer };
