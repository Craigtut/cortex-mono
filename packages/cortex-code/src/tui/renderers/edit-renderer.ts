/**
 * EditToolRenderer: renders file edit results with line-level colored diffs.
 */

import chalk from 'chalk';
import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import type { EditDetails, DiffHunk } from '@animus-labs/cortex';
import { collapseContent } from './collapsible-content.js';
import { shortenPath } from './path-utils.js';
import { fileLink } from './osc-links.js';
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

function renderDiffHunks(hunks: DiffHunk[], theme: ToolRenderContext['theme']): string[] {
  const lines: string[] = [];
  const addColor = chalk.hex(theme.diffAdd);
  const removeColor = chalk.hex(theme.diffRemove);
  const contextColor = chalk.hex(theme.diffContext);

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        lines.push(addColor('+ ' + line.slice(1)));
      } else if (line.startsWith('-')) {
        lines.push(removeColor('- ' + line.slice(1)));
      } else {
        lines.push(contextColor('  ' + line.slice(1)));
      }
    }
  }

  return lines;
}

function windowAroundFirstChange(
  diffLines: string[],
  contextBefore: number,
): string[] {
  // Find the first non-context line (actual change).
  // Context lines start with two spaces; changed lines start with colored +/- symbols.
  const firstChangeIdx = diffLines.findIndex(line => !line.startsWith('  '));

  if (firstChangeIdx <= contextBefore) {
    return diffLines;
  }

  // Skip lines before the context window
  return diffLines.slice(firstChangeIdx - contextBefore);
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
      const shortPath = shortenPath(filePath);
      return {
        headerText: `edit ${shortPath}`,
        contentLines: [chalk.hex(context.theme.muted)(resultText)],
        footerText: 'rejected',
      };
    }

    let diffLines: string[];
    if (d?.diff && d.diff.length > 0) {
      diffLines = renderDiffHunks(d.diff, context.theme);
      diffLines = windowAroundFirstChange(diffLines, CONTEXT_LINES_BEFORE);
    } else {
      diffLines = resultText ? resultText.split('\n') : ['(edit applied)'];
    }

    // Collapse
    const { lines } = collapseContent(diffLines, {
      mode: 'head',
      limit: COLLAPSED_LINES,
      expanded: context.expanded,
    });

    // Footer
    const shortPath = shortenPath(filePath);
    const linkedPath = fileLink(filePath, shortPath);
    const lineInfo = d?.diff?.[0] ? `:${d.diff[0].newStart}` : '';
    const countInfo = d && d.replacementCount > 1 ? `(${d.replacementCount} replacements)` : '';

    return {
      headerText: `edit ${linkedPath}${lineInfo}`,
      contentLines: lines,
      footerText: countInfo.trim(),
    };
  },

  renderError(error: string, args: Record<string, unknown>, context: ToolRenderContext): ToolResultDisplay {
    const filePath = String(args['file_path'] ?? '');
    const shortPath = shortenPath(filePath);
    const oldString = String(args['old_string'] ?? '').slice(0, 60);
    const errorColor = chalk.hex(context.theme.error);

    let errorLines: string[];
    if (error.includes('not found') || error.includes('not unique')) {
      errorLines = [
        errorColor(error),
        chalk.hex(context.theme.muted)(`  Searched for: "${oldString}${oldString.length >= 60 ? '...' : ''}"`),
      ];
    } else {
      errorLines = [errorColor(error)];
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
