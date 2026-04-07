/**
 * WebFetchToolRenderer: renders web fetch results with HTTP status,
 * content type, size, and content preview.
 */

import chalk from 'chalk';
import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import type { WebFetchDetails } from '@animus-labs/cortex';
import { collapseContent } from './collapsible-content.js';
import { registerRenderer } from './registry.js';

const COLLAPSED_LINES = 8;

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
}

const webFetchRenderer: ToolRenderer = {
  renderCall(args: Record<string, unknown>, _context: ToolRenderContext): ToolCallDisplay {
    const url = String(args['url'] ?? '');
    const domain = extractDomain(url);

    return {
      headerText: `fetch ${domain}`,
      contentLines: [],
      footerText: '',
    };
  },

  renderResult(result: unknown, details: unknown, context: ToolRenderContext): ToolResultDisplay {
    const d = details as WebFetchDetails | undefined;
    const text = extractTextContent(result);
    const contentLines: string[] = [];

    // HTTP status and size header
    if (d) {
      const status = `HTTP ${d.statusCode}`;
      const size = formatBytes(d.markdownSize || d.rawSize);
      const cacheHit = d.cacheHit ? ' (cached)' : '';
      contentLines.push(chalk.hex(context.theme.muted)(`${status} (${size})${cacheHit}`));
      contentLines.push('');
    }

    // Content preview
    const textLines = text.split('\n');
    contentLines.push(...textLines);

    const { lines } = collapseContent(contentLines, {
      mode: 'head',
      limit: COLLAPSED_LINES,
      expanded: context.expanded,
    });

    // Footer
    const domain = d ? extractDomain(d.finalUrl) : '';

    return {
      headerText: `fetch ${domain}`,
      contentLines: lines,
      footerText: '',
    };
  },

  renderError(error: string, args: Record<string, unknown>, context: ToolRenderContext): ToolResultDisplay {
    const url = String(args['url'] ?? '');
    const domain = extractDomain(url);
    const errorColor = chalk.hex(context.theme.error);

    let errorLines: string[];
    if (error.includes('timeout') || error.includes('ETIMEDOUT')) {
      errorLines = [errorColor(`Request timed out: ${domain}`)];
    } else if (error.includes('ENOTFOUND') || error.includes('DNS')) {
      errorLines = [errorColor(`DNS lookup failed: ${domain}`)];
    } else if (error.includes('status')) {
      errorLines = [errorColor(error)];
    } else {
      errorLines = [errorColor(error)];
    }

    return {
      headerText: `fetch ${domain}`,
      contentLines: errorLines,
      footerText: '',
    };
  },
};

registerRenderer('WebFetch', webFetchRenderer);
export { webFetchRenderer };
