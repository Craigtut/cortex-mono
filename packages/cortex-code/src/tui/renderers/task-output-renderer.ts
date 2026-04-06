/**
 * TaskOutputRenderer: renders background task polling results.
 */

import chalk from 'chalk';
import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import type { TaskOutputDetails } from '@animus-labs/cortex';
import { collapseContent } from './collapsible-content.js';
import { registerRenderer } from './registry.js';

const COLLAPSED_LINES = 10;

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

const taskOutputRenderer: ToolRenderer = {
  renderCall(args: Record<string, unknown>, context: ToolRenderContext): ToolCallDisplay {
    const taskId = String(args['task_id'] ?? '');
    const action = String(args['action'] ?? 'poll');

    return {
      contentLines: [],
      footerText: `task ${action} ${chalk.hex(context.theme.muted)(taskId)}`,
    };
  },

  renderResult(result: unknown, details: unknown, context: ToolRenderContext): ToolResultDisplay {
    const d = details as TaskOutputDetails | undefined;
    const text = extractTextContent(result);
    const allLines = text.split('\n');

    const { lines } = collapseContent(allLines, {
      mode: 'head',
      limit: COLLAPSED_LINES,
      expanded: context.expanded,
    });

    // Status indicator
    const statusColor = d?.status === 'completed'
      ? context.theme.statusSuccess
      : d?.status === 'failed'
        ? context.theme.statusError
        : context.theme.statusPending;
    const statusText = d?.status ?? 'unknown';
    const taskId = d?.taskId ?? String(context.args['task_id'] ?? '');
    const action = d?.action ?? String(context.args['action'] ?? 'poll');

    return {
      contentLines: lines,
      footerText: `task ${action} ${chalk.hex(context.theme.muted)(taskId)} ${chalk.hex(statusColor)(statusText)}`,
    };
  },
};

registerRenderer('TaskOutput', taskOutputRenderer);
export { taskOutputRenderer };
