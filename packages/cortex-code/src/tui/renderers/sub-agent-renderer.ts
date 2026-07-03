/**
 * SubAgentRenderer: renders sub-agent execution with real-time nested
 * tool call visibility (foreground) or post-completion summary (background).
 */

import chalk from 'chalk';
import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import type { SubAgentDetails } from '@animus-labs/cortex';
import { collapseContent } from './collapsible-content.js';
import { sanitizeTerminalText } from './sanitize-terminal.js';
import { registerRenderer } from './registry.js';

const MAX_DESCRIPTION_LINES = 5;
const MAX_ACTIVITY_LINES = 15;
const MAX_LIVE_ACTIVITY_LINES = 5;

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

const subAgentRenderer: ToolRenderer = {
  renderCall(args: Record<string, unknown>, context: ToolRenderContext): ToolCallDisplay {
    // Instructions are model-authored and rendered as the call description.
    const instructions = sanitizeTerminalText(String(args['instructions'] ?? ''));
    const background = Boolean(args['background']);
    const modeLabel = background
      ? chalk.hex(context.theme.muted)(' [background]')
      : '';

    // Word-wrap and cap description
    const descLines = instructions.split('\n').slice(0, MAX_DESCRIPTION_LINES);
    if (instructions.split('\n').length > MAX_DESCRIPTION_LINES) {
      descLines.push(chalk.hex(context.theme.muted)('...'));
    }

    // Model ID from args (passed via onSubAgentSpawned)
    const modelId = context.args['modelId'] as string | undefined;
    const modelLabel = modelId
      ? chalk.hex(context.theme.muted)(` (${modelId})`)
      : '';

    return {
      headerText: `Delegated${modelLabel}${modeLabel}`,
      contentLines: descLines,
      footerText: '',
    };
  },

  renderResult(result: unknown, details: unknown, context: ToolRenderContext): ToolResultDisplay {
    const d = details as SubAgentDetails | undefined;
    let text = sanitizeTerminalText(extractTextContent(result));

    // Strip <working> tags from sub-agent output (LLM reasoning, not for display)
    text = text.replace(/<working>[\s\S]*?<\/working>/g, '').trim();

    const contentLines: string[] = [];

    // Compact tool summary: "Read x14, Bash x2" instead of vertical list
    const resultObj = result as Record<string, unknown> | undefined;
    const toolCalls = (resultObj?.['toolCalls'] ?? (details as Record<string, unknown> | undefined)?.['toolCalls']) as
      Array<{ name: string; error?: string }> | undefined;

    if (toolCalls && toolCalls.length > 0) {
      const counts = new Map<string, number>();
      for (const tc of toolCalls) {
        counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1);
      }
      const summary = [...counts.entries()]
        .map(([name, count]) => count > 1 ? `${name} x${count}` : name)
        .join(', ');
      contentLines.push(chalk.hex(context.theme.muted)(summary));
    }

    // Show result text (stripped of working tags)
    if (text) {
      const textLines = text.split('\n');
      const { lines } = collapseContent(textLines, {
        mode: 'head',
        limit: MAX_ACTIVITY_LINES,
        expanded: context.expanded,
      });
      contentLines.push(...lines);
    }

    // Model ID from details or args
    const modelId = d?.modelId ?? (context.args['modelId'] as string | undefined);

    // Header
    const headerParts: string[] = ['Delegated'];
    if (modelId) {
      headerParts.push(chalk.hex(context.theme.muted)(`(${modelId})`));
    }

    // Footer: stats. Duration is owned by the activity line (shown when slow).
    const statsParts: string[] = [];
    if (d?.turns) {
      statsParts.push(`${d.turns} turns`);
    }
    if (d?.status && d.status !== 'completed') {
      statsParts.push(d.status);
    }

    return {
      headerText: headerParts.join(' '),
      contentLines: contentLines.length > 0
        ? contentLines
        : [chalk.hex(context.theme.muted)('(no output)')],
      footerText: statsParts.join(' '),
    };
  },

  renderStreamUpdate(update: unknown, context: ToolRenderContext): ToolResultDisplay {
    // Stream updates from child events show nested tool calls
    const u = update as {
      toolCalls?: Array<{ name: string; status: string; summary?: string }>;
      description?: string;
    } | undefined;

    const contentLines: string[] = [];

    // Description
    if (u?.description) {
      const descLines = sanitizeTerminalText(u.description).split('\n').slice(0, MAX_DESCRIPTION_LINES);
      contentLines.push(...descLines);
      contentLines.push(chalk.hex(context.theme.borderMuted)('\u2500'.repeat(20)));
    }

    // Nested tool calls
    if (u?.toolCalls) {
      const earlierCount = Math.max(0, u.toolCalls.length - MAX_LIVE_ACTIVITY_LINES);
      if (earlierCount > 0) {
        contentLines.push(chalk.hex(context.theme.muted)(`${earlierCount} earlier tool calls`));
      }

      const recentCalls = u.toolCalls.slice(-MAX_LIVE_ACTIVITY_LINES);
      for (const call of recentCalls) {
        const icon = call.status === 'success'
          ? chalk.hex(context.theme.statusSuccess)('\u2713')
          : call.status === 'error'
            ? chalk.hex(context.theme.statusError)('\u2717')
            : chalk.hex(context.theme.statusPending)('\u22EF');
        const summary = call.summary ? ` ${chalk.hex(context.theme.muted)(sanitizeTerminalText(call.summary))}` : '';
        contentLines.push(`${icon} ${sanitizeTerminalText(call.name)}${summary}`);
      }
    }

    return {
      headerText: u?.toolCalls ? `Delegated (${u.toolCalls.length} tools)` : 'Delegated',
      contentLines: contentLines.length > 0
        ? contentLines
        : [chalk.hex(context.theme.muted)('Working...')],
      footerText: '',
    };
  },

  renderError(error: string, _args: Record<string, unknown>, context: ToolRenderContext): ToolResultDisplay {
    return {
      headerText: 'Delegated',
      contentLines: [chalk.hex(context.theme.error)(sanitizeTerminalText(error))],
      footerText: '',
    };
  },
};

registerRenderer('SubAgent', subAgentRenderer);
export { subAgentRenderer };
