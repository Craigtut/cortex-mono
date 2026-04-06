/**
 * BashToolRenderer: renders shell command output with head+tail truncation,
 * streaming support, and error state display.
 */

import chalk from 'chalk';
import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import type { BashDetails, BashStreamUpdate } from '@animus-labs/cortex';
import { collapseContent } from './collapsible-content.js';
import { StreamingBuffer } from './streaming-buffer.js';
import { registerRenderer } from './registry.js';

const COLLAPSED_HEAD = 3;
const COLLAPSED_TAIL = 2;
const ERROR_HEAD = 5;
const ERROR_TAIL = 5;
const STREAMING_WINDOW = 20;

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

// Per-tool-call streaming buffer (keyed by instance, managed externally)
const streamBuffers = new WeakMap<object, StreamingBuffer>();

function getOrCreateBuffer(key: object): StreamingBuffer {
  let buf = streamBuffers.get(key);
  if (!buf) {
    buf = new StreamingBuffer();
    streamBuffers.set(key, buf);
  }
  return buf;
}

const bashRenderer: ToolRenderer = {
  renderCall(args: Record<string, unknown>, _context: ToolRenderContext): ToolCallDisplay {
    const command = String(args['command'] ?? '');
    const displayCmd = command.length > 80 ? command.slice(0, 77) + '...' : command;

    return {
      contentLines: [],
      footerText: `$ ${displayCmd}`,
    };
  },

  renderResult(result: unknown, details: unknown, context: ToolRenderContext): ToolResultDisplay {
    const d = details as BashDetails | undefined;
    const text = extractTextContent(result);
    const allLines = text.split('\n').filter(l => l.length > 0 || text.includes('\n'));
    const isError = d ? (d.exitCode !== null && d.exitCode !== 0) : false;

    // Head+tail truncation: more lines on error
    const head = isError ? ERROR_HEAD : COLLAPSED_HEAD;
    const tail = isError ? ERROR_TAIL : COLLAPSED_TAIL;

    const { lines } = collapseContent(allLines, {
      mode: 'head-tail',
      limit: head + tail,
      headLines: head,
      tailLines: tail,
      expanded: context.expanded,
    });

    // Footer
    const command = d ? '' : ''; // Command was in renderCall
    const footer = `$ ${String((d as Record<string, unknown> | undefined)?.['command'] ?? 'command')}`.slice(0, 60);

    // Below-box lines for error state
    const belowBoxLines: string[] = [];
    if (d?.exitCode !== null && d?.exitCode !== undefined && d.exitCode !== 0) {
      belowBoxLines.push(chalk.hex(context.theme.error)(`Exit code: ${d.exitCode}`));
    }
    if (d?.timedOut) {
      belowBoxLines.push(chalk.hex(context.theme.error)('Command timed out'));
    }

    return {
      contentLines: lines,
      footerText: footer,
      belowBoxLines: belowBoxLines.length > 0 ? belowBoxLines : undefined,
    };
  },

  renderStreamUpdate(update: unknown, context: ToolRenderContext): ToolResultDisplay {
    const u = update as { details?: BashStreamUpdate; content?: Array<{ text?: string }> } | undefined;
    const stdout = u?.details?.stdout ?? '';
    const totalLines = u?.details?.totalLines ?? 0;

    // Use a singleton buffer for streaming display
    const bufferKey = context; // Use context as weak reference key
    const buffer = getOrCreateBuffer(bufferKey);
    if (stdout) {
      buffer.append(stdout);
    }

    const visibleLines = buffer.getLines(STREAMING_WINDOW);

    return {
      contentLines: visibleLines,
      footerText: `$ ... (${totalLines} lines)`,
    };
  },

  renderError(error: string, args: Record<string, unknown>, context: ToolRenderContext): ToolResultDisplay {
    const command = String(args['command'] ?? '').slice(0, 60);
    const errorLines = error.split('\n');

    const { lines } = collapseContent(errorLines, {
      mode: 'head',
      limit: ERROR_HEAD + ERROR_TAIL,
      expanded: context.expanded,
    });

    return {
      contentLines: lines,
      footerText: `$ ${command}`,
      belowBoxLines: [chalk.hex(context.theme.error)(error.split('\n')[0] ?? 'Command failed')],
    };
  },
};

registerRenderer('Bash', bashRenderer);
export { bashRenderer };
