import { dirname } from 'node:path';

const PACKAGE_MANAGERS = new Set([
  'npm', 'npx', 'yarn', 'pnpm', 'bun', 'deno', 'pip', 'pip3',
  'cargo', 'go', 'gem', 'composer', 'dotnet', 'mvn', 'gradle',
]);

/**
 * Extract a suggested "always allow" pattern from a tool call.
 * Returns a pattern string like "git *" for Bash or "src/auth/*" for file tools.
 */
export function extractPattern(toolName: string, toolArgs: unknown): string {
  const args = toolArgs as Record<string, unknown>;

  switch (toolName) {
    case 'Bash': {
      const command = String(args['command'] ?? '');
      const tokens = command.trim().split(/\s+/);
      const first = tokens[0] ?? '';

      // Package managers: use first two tokens (e.g., "npm run *")
      if (PACKAGE_MANAGERS.has(first) && tokens.length > 1) {
        return `${first} ${tokens[1]} *`;
      }

      // Default: first token as prefix (e.g., "git *")
      return first ? `${first} *` : '';
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
