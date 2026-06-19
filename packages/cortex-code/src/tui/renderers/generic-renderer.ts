/**
 * Generic fallback renderer for unknown tools and MCP tools.
 *
 * Shows a clean "server: tool" name. Raw JSON args are intentionally not
 * displayed (noise); the result is shown collapsed.
 */

import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import { collapseContent } from './collapsible-content.js';

const DEFAULT_COLLAPSED_LINES = 4;

/**
 * Format a tool name for display. MCP tools use "mcp__server__tool" format;
 * strip the prefix and render as "server: tool" for readability.
 */
function formatToolName(name: string): string {
  let n = name;
  if (n.startsWith('mcp__')) {
    n = n.slice(5);
  }
  if (n.includes('__')) {
    const [server, ...rest] = n.split('__');
    return `${server}: ${rest.join('_')}`;
  }
  return n.toLowerCase();
}

export const genericRenderer: ToolRenderer = {
  renderCall(_args: Record<string, unknown>, context: ToolRenderContext): ToolCallDisplay {
    return {
      headerText: formatToolName(context.toolName),
      contentLines: [],
      footerText: '',
    };
  },

  renderResult(result: unknown, _details: unknown, context: ToolRenderContext): ToolResultDisplay {
    let text: string;
    if (typeof result === 'string') {
      text = result;
    } else if (result && typeof result === 'object' && 'content' in (result as Record<string, unknown>)) {
      const content = (result as Record<string, unknown>)['content'];
      if (Array.isArray(content)) {
        text = content
          .filter((c: unknown) => c && typeof c === 'object' && (c as Record<string, unknown>)['type'] === 'text')
          .map((c: unknown) => (c as Record<string, string>)['text'])
          .join('\n');
      } else {
        text = JSON.stringify(result, null, 2);
      }
    } else {
      text = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result ?? '');
    }

    const allLines = text.split('\n');
    const { lines } = collapseContent(allLines, {
      mode: 'head',
      limit: DEFAULT_COLLAPSED_LINES,
      expanded: context.expanded,
    });

    return {
      headerText: formatToolName(context.toolName),
      contentLines: lines,
      footerText: '',
    };
  },
};
