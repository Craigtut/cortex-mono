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

/** Extract the first line of a command for display (heredocs/multi-line commands must not leak newlines into headers). */
function commandHeader(command: string, maxLen = 77): string {
  const firstLine = command.split('\n')[0] ?? command;
  const display = firstLine.length > maxLen ? firstLine.slice(0, maxLen - 3) + '...' : firstLine;
  return `$ ${display}`;
}

const bashRenderer: ToolRenderer = {
  renderCall(args: Record<string, unknown>, _context: ToolRenderContext): ToolCallDisplay {
    return {
      headerText: commandHeader(String(args['command'] ?? '')),
      contentLines: [],
      footerText: '',
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

    // Header and footer
    const header = commandHeader(String(context.args['command'] ?? 'command'));

    // Below-box lines for error state
    const belowBoxLines: string[] = [];
    if (d?.exitCode !== null && d?.exitCode !== undefined && d.exitCode !== 0) {
      belowBoxLines.push(chalk.hex(context.theme.error)(`Exit code: ${d.exitCode}`));
    }
    if (d?.timedOut) {
      belowBoxLines.push(chalk.hex(context.theme.error)('Command timed out'));
    }

    const display: ToolResultDisplay = {
      headerText: header,
      contentLines: lines,
      footerText: '',
    };
    if (belowBoxLines.length > 0) {
      display.belowBoxLines = belowBoxLines;
    }
    return display;
  },

  renderStreamUpdate(update: unknown, context: ToolRenderContext): ToolResultDisplay {
    const u = update as { details?: BashStreamUpdate; content?: Array<{ text?: string }> } | undefined;
    const stdout = u?.details?.stdout ?? '';
    const totalLines = u?.details?.totalLines ?? 0;

    // Use args object as stable WeakMap key (same reference across all updates for one tool call)
    const buffer = getOrCreateBuffer(context.args);
    if (stdout) {
      buffer.append(stdout);
    }

    const visibleLines = buffer.getLines(STREAMING_WINDOW);

    return {
      headerText: commandHeader(String(context.args['command'] ?? 'command')),
      contentLines: visibleLines,
      footerText: `${totalLines} lines`,
    };
  },

  renderError(error: string, args: Record<string, unknown>, context: ToolRenderContext): ToolResultDisplay {
    const command = String(args['command'] ?? '').split('\n')[0]?.slice(0, 77) ?? '';
    const errorLines = error.split('\n');

    const { lines } = collapseContent(errorLines, {
      mode: 'head',
      limit: ERROR_HEAD + ERROR_TAIL,
      expanded: context.expanded,
    });

    return {
      headerText: `$ ${command}`,
      contentLines: lines,
      footerText: '',
      belowBoxLines: [chalk.hex(context.theme.error)(error.split('\n')[0] ?? 'Command failed')],
    };
  },
};

registerRenderer('Bash', bashRenderer);
export { bashRenderer };
