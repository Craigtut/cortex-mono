/**
 * Generic fallback renderer for unknown tools and MCP tools.
 *
 * Shows tool name (with MCP namespace) in footer, args as compact JSON,
 * result as text or JSON.
 */

import chalk from 'chalk';
import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import { collapseContent } from './collapsible-content.js';

const DEFAULT_COLLAPSED_LINES = 5;
const MAX_ARGS_WIDTH = 80;

/**
 * Format a tool name for display. MCP tools use "server__tool" format;
 * display as "server/tool" for readability.
 */
function formatToolName(name: string): string {
  if (name.includes('__')) {
    return name.replace('__', '/');
  }
  return name.toLowerCase();
}

export const genericRenderer: ToolRenderer = {
  renderCall(args: Record<string, unknown>, context: ToolRenderContext): ToolCallDisplay {
    const argsJson = JSON.stringify(args);
    const argsText = Object.keys(args).length > 0
      ? chalk.hex(context.theme.muted)(
          argsJson.length > MAX_ARGS_WIDTH
            ? argsJson.slice(0, MAX_ARGS_WIDTH - 3) + '...'
            : argsJson,
        )
      : '';

    return {
      contentLines: argsText ? [argsText] : [],
      footerText: formatToolName(context.toolName),
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
      contentLines: lines,
      footerText: formatToolName(context.toolName),
    };
  },
};
