/**
 * Syntax highlighting wrapper around cli-highlight.
 *
 * Provides language detection from file extensions and an LRU cache
 * for performance. Falls back to plain text on highlight failure.
 */

import { highlight } from 'cli-highlight';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
  '.cs': 'csharp',
  '.html': 'html', '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.json': 'json',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'ini',
  '.xml': 'xml',
  '.sql': 'sql',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.ps1': 'powershell',
  '.md': 'markdown',
  '.dockerfile': 'dockerfile',
  '.graphql': 'graphql', '.gql': 'graphql',
  '.lua': 'lua',
  '.r': 'r',
  '.pl': 'perl',
  '.ex': 'elixir', '.exs': 'elixir',
  '.erl': 'erlang',
  '.hs': 'haskell',
  '.scala': 'scala',
  '.vim': 'vim',
  '.proto': 'protobuf',
  '.tf': 'hcl',
};

/**
 * Detect language from a file path's extension.
 * Returns undefined if the extension is not recognized.
 */
export function detectLanguage(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext];

}

// ---------------------------------------------------------------------------
// LRU Cache
// ---------------------------------------------------------------------------

const MAX_CACHE_SIZE = 50;
const cache = new Map<string, string[]>();

function getCacheKey(code: string, language: string | undefined): string {
  // Simple hash: use first 100 chars + length + language
  const prefix = code.slice(0, 100);
  return `${language ?? 'auto'}:${code.length}:${prefix}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Highlight code and return ANSI-colored lines.
 *
 * @param code - The source code to highlight
 * @param language - Language name (auto-detected if omitted)
 * @returns Array of ANSI-colored lines
 */
export function highlightCode(code: string, language?: string): string[] {
  if (!code) return [];

  const key = getCacheKey(code, language);
  const cached = cache.get(key);
  if (cached) return cached;

  let highlighted: string;
  try {
    highlighted = highlight(code, {
      language: language,
      ignoreIllegals: true,
    });
  } catch {
    // Fall back to plain text on any highlight failure
    highlighted = code;
  }

  const lines = highlighted.split('\n');

  // LRU eviction
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value as string;
    cache.delete(firstKey);
  }
  cache.set(key, lines);

  return lines;
}

/**
 * Highlight code from a file, auto-detecting language from the file path.
 */
export function highlightFile(code: string, filePath: string): string[] {
  const language = detectLanguage(filePath);
  return highlightCode(code, language);
}
