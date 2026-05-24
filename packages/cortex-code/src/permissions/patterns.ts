import { dirname } from 'node:path';
import { extractBashPrefix } from './bash-command.js';

/**
 * Extract a suggested "always allow" pattern from a tool call.
 * Returns a pattern string like "git commit *" for Bash or "src/auth/*" for
 * file tools.
 */
export function extractPattern(toolName: string, toolArgs: unknown): string {
  const args = toolArgs as Record<string, unknown>;

  switch (toolName) {
    case 'Bash': {
      // Suggest a per-subcommand prefix ("git commit *", not "git *") so an
      // "always allow" doesn't auto-approve every other subcommand of the same
      // program, and never suggest a prefix for bare shells/wrappers.
      return extractBashPrefix(String(args['command'] ?? ''));
    }

    case 'Edit':
    case 'Write':
    case 'Read': {
      const filePath = String(args['file_path'] ?? args['path'] ?? '');
      if (!filePath) return '';
      const dir = dirname(filePath);
      return dir === '.' ? '*' : `${dir}/*`;
    }

    case 'Glob': {
      const pattern = String(args['pattern'] ?? '');
      return pattern || '';
    }

    case 'Grep': {
      // No meaningful sub-pattern for grep; tool-wide allow
      return '';
    }

    case 'WebFetch': {
      const url = String(args['url'] ?? '');
      try {
        const parsed = new URL(url);
        return parsed.hostname;
      } catch {
        return '';
      }
    }

    case 'SubAgent': {
      // Tool-wide allow for sub-agents
      return '';
    }

    default:
      return '';
  }
}

/**
 * Format a permission rule for display.
 * Returns e.g. "Bash(git *)" or "WebFetch(api.github.com)" or just "Grep".
 */
export function formatRule(toolName: string, pattern: string): string {
  if (!pattern) return toolName;
  return `${toolName}(${pattern})`;
}
