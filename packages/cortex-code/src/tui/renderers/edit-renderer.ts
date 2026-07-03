/**
 * EditToolRenderer: renders file edit results with line-level colored diffs.
 */

import chalk from 'chalk';
import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import type { EditDetails, DiffHunk } from '@animus-labs/cortex';
import { collapseContent } from './collapsible-content.js';
import { shortenPath } from './path-utils.js';
import { fileLink } from './osc-links.js';
import { sanitizeTerminalText, sanitizeTerminalLine } from './sanitize-terminal.js';
import { registerRenderer } from './registry.js';

const COLLAPSED_LINES = 15;
const CONTEXT_LINES_BEFORE = 3;

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

function flattenDiffHunks(hunks: DiffHunk[]): string[] {
  const lines: string[] = [];
  for (const hunk of hunks) {
    lines.push(...hunk.lines);
  }
  return lines;
}

function colorizeDiffLines(lines: string[], theme: ToolRenderContext['theme']): string[] {
  const rendered: string[] = [];
  const addColor = chalk.hex(theme.diffAdd);
  const removeColor = chalk.hex(theme.diffRemove);
  const contextColor = chalk.hex(theme.diffContext);

  for (const line of lines) {
    // Diff content is raw file content; strip control chars before colorizing.
    if (line.startsWith('+')) {
      rendered.push(addColor('+ ' + sanitizeTerminalText(line.slice(1))));
    } else if (line.startsWith('-')) {
      rendered.push(removeColor('- ' + sanitizeTerminalText(line.slice(1))));
    } else {
      rendered.push(contextColor('  ' + sanitizeTerminalText(line.slice(1))));
    }
  }

  return rendered;
}

function windowAroundFirstChange(
  rawDiffLines: string[],
  contextBefore: number,
): string[] {
  const firstChangeIdx = rawDiffLines.findIndex(line => !line.startsWith(' '));

  if (firstChangeIdx <= contextBefore) {
    return rawDiffLines;
  }

  return rawDiffLines.slice(firstChangeIdx - contextBefore);
}

const editRenderer: ToolRenderer = {
  renderCall(args: Record<string, unknown>, _context: ToolRenderContext): ToolCallDisplay {
    const filePath = String(args['file_path'] ?? '');
    const shortPath = shortenPath(filePath);
    const linkedPath = fileLink(filePath, shortPath);

    return {
      headerText: `edit ${linkedPath}`,
      contentLines: [],
      footerText: '',
    };
  },

  renderResult(result: unknown, details: unknown, context: ToolRenderContext): ToolResultDisplay {
    const d = details as EditDetails | undefined;
    const filePath = d?.filePath ?? '';

    // Detect read-before-edit rejection: replacementCount 0 with no diff
    // means the edit was rejected, not applied. Show as a warning.
    const resultText = extractResultText(result);
    const isRejection = d?.replacementCount === 0 && (!d?.diff || d.diff.length === 0);

    if (isRejection && resultText) {
      const shortPath = sanitizeTerminalLine(shortenPath(filePath));
      return {
        headerText: `edit ${shortPath}`,
        contentLines: [chalk.hex(context.theme.muted)(sanitizeTerminalText(resultText))],
        footerText: 'rejected',
      };
    }

    let diffLines: string[];
    if (d?.diff && d.diff.length > 0) {
      const rawDiffLines = flattenDiffHunks(d.diff);
      const windowedDiffLines = windowAroundFirstChange(rawDiffLines, CONTEXT_LINES_BEFORE);

      const { lines } = collapseContent(windowedDiffLines, {
        mode: 'head',
        limit: COLLAPSED_LINES,
        expanded: context.expanded,
      });

      diffLines = colorizeDiffLines(lines, context.theme);
    } else {
      diffLines = resultText ? sanitizeTerminalText(resultText).split('\n') : ['(edit applied)'];
      const { lines } = collapseContent(diffLines, {
        mode: 'head',
        limit: COLLAPSED_LINES,
        expanded: context.expanded,
      });
      diffLines = lines;
    }

    // Footer
    const shortPath = shortenPath(filePath);
    const linkedPath = fileLink(filePath, shortPath);
    const lineInfo = d?.diff?.[0] ? `:${d.diff[0].newStart}` : '';
    const countInfo = d && d.replacementCount > 1 ? `(${d.replacementCount} replacements)` : '';

    return {
      headerText: `edit ${linkedPath}${lineInfo}`,
      contentLines: diffLines,
      footerText: countInfo.trim(),
    };
  },

  renderError(error: string, args: Record<string, unknown>, context: ToolRenderContext): ToolResultDisplay {
    const filePath = String(args['file_path'] ?? '');
    const shortPath = sanitizeTerminalLine(shortenPath(filePath));
    const rawOldString = String(args['old_string'] ?? '').slice(0, 60);
    const oldString = sanitizeTerminalLine(rawOldString);
    const safeError = sanitizeTerminalText(error);
    const errorColor = chalk.hex(context.theme.error);

    let errorLines: string[];
    if (error.includes('not found') || error.includes('not unique')) {
      errorLines = [
        errorColor(safeError),
        chalk.hex(context.theme.muted)(`  Searched for: "${oldString}${rawOldString.length >= 60 ? '...' : ''}"`),
      ];
    } else {
      errorLines = [errorColor(safeError)];
    }

    return {
      headerText: `edit ${shortPath}`,
      contentLines: errorLines,
      footerText: '',
    };
  },
};

registerRenderer('Edit', editRenderer);
export { editRenderer };
