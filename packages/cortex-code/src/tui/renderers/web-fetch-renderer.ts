/**
 * WebFetchToolRenderer: compact single-line renderer for web fetches.
 *
 * Shows URL/domain, HTTP status, and size on a single line.
 * The fetched content goes to LLM context; the user just needs
 * to see what was fetched and whether it succeeded.
 */

import chalk from 'chalk';
import type { ToolRenderer, ToolRenderContext, ToolCallDisplay, ToolResultDisplay } from './types.js';
import type { WebFetchDetails } from '@animus-labs/cortex';
import { registerRenderer } from './registry.js';

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

  renderResult(_result: unknown, details: unknown, _context: ToolRenderContext): ToolResultDisplay {
    const d = details as WebFetchDetails | undefined;
    const domain = d ? extractDomain(d.finalUrl) : '';
    const status = d ? `${d.statusCode}` : '';
    const size = d ? formatBytes(d.markdownSize || d.rawSize) : '';
    const cacheHit = d?.cacheHit ? ' cached' : '';

    const statsParts = [status, size + cacheHit].filter(Boolean);

    return {
      headerText: `fetch ${domain}`,
      contentLines: [],
      footerText: statsParts.join(', '),
    };
  },

  renderError(error: string, args: Record<string, unknown>, context: ToolRenderContext): ToolResultDisplay {
    const url = String(args['url'] ?? '');
    const domain = extractDomain(url);
    const errorColor = chalk.hex(context.theme.error);

    let errorText: string;
    if (error.includes('timeout') || error.includes('ETIMEDOUT')) {
      errorText = 'timed out';
    } else if (error.includes('ENOTFOUND') || error.includes('DNS')) {
      errorText = 'DNS lookup failed';
    } else {
      errorText = error.split('\n')[0] ?? 'failed';
    }

    return {
      headerText: `fetch ${domain}`,
      contentLines: [errorColor(errorText)],
      footerText: '',
    };
  },
};

registerRenderer('WebFetch', webFetchRenderer);
export { webFetchRenderer };
