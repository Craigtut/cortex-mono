/**
 * Glob tool: find files by name pattern matching.
 *
 * Uses fast-glob for pattern matching and sorts results by
 * modification time (newest first). Respects .gitignore rules.
 *
 * Reference: docs/cortex/tools/glob.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Type, type Static } from 'typebox';
import type { ToolContentDetails } from '../types.js';
import {
  readGitignorePatterns,
  DEFAULT_IGNORE_PATTERNS,
} from './shared/gitignore.js';
import { compileGlob, type GlobMatcher } from './shared/glob-matcher.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const GlobParams = Type.Object({
  pattern: Type.String({ description: 'Glob pattern to match files against (e.g., "**/*.ts", "src/**/*.test.js")' }),
  path: Type.Optional(
    Type.String({ description: 'Directory to search in. Default: current working directory.' }),
  ),
});

export type GlobParamsType = Static<typeof GlobParams>;

// ---------------------------------------------------------------------------
// Details type
// ---------------------------------------------------------------------------

export interface GlobDetails {
  totalCount: number;
  truncated: boolean;
  durationMs: number;
  searchPath: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RESULTS = 100;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GlobToolConfig {
  /** Default search directory when no path param is given. */
  defaultCwd: string;
  /** Whether to respect .gitignore. Default: true. */
  respectGitignore?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a path matches any of the ignore patterns.
 */
function isIgnored(relativePath: string, ignorePatterns: string[]): boolean {
  const parts = relativePath.split('/');

  for (const pattern of ignorePatterns) {
    // Direct directory/file name match
    const cleanPattern = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;

    // Check if any path component matches
    if (!cleanPattern.includes('/')) {
      if (parts.some((part) => {
        if (cleanPattern.includes('*') || cleanPattern.includes('?')) {
          return compileGlob(cleanPattern).test(part);
        }
        return part === cleanPattern;
      })) {
        return true;
      }
    } else {
      // Full path pattern match
      if (compileGlob(cleanPattern).test(relativePath)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Walk a directory tree and collect file paths.
 *
 * Implemented as an iterative stack walk rather than recursion. This avoids
 * two failure modes on large trees: deep recursion blowing the call stack,
 * and (the one that actually bit us) `results.push(...subResults)` throwing
 * "Maximum call stack size exceeded" when a subdirectory yields more files
 * than the engine's function-argument limit. Symlinked directories are not
 * followed (Dirent.isDirectory() is false for symlinks), so cycles are safe.
 */
async function walkDirectory(
  rootDir: string,
  baseDir: string,
  ignorePatterns: string[],
): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop()!;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      // Skip directories we can't read
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(baseDir, fullPath).split(path.sep).join('/');

      // Check ignore patterns
      if (isIgnored(relativePath, ignorePatterns)) {
        continue;
      }

      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createGlobTool(config: GlobToolConfig): {
  name: string;
  description: string;
  parameters: typeof GlobParams;
  execute: (params: GlobParamsType) => Promise<ToolContentDetails<GlobDetails>>;
} {
  const respectGitignore = config.respectGitignore ?? true;

  return {
    name: 'Glob',
    description: 'Find files by name pattern. Returns paths sorted by modification time (newest first).',
    parameters: GlobParams,

    async execute(params: GlobParamsType): Promise<ToolContentDetails<GlobDetails>> {
      const searchPath = params.path ? path.resolve(params.path) : path.resolve(config.defaultCwd);
      const startTime = Date.now();

      // Verify search path exists
      try {
        const stat = await fs.promises.stat(searchPath);
        if (!stat.isDirectory()) {
          return {
            content: [{ type: 'text', text: `Directory does not exist: ${searchPath}` }],
            details: {
              totalCount: 0,
              truncated: false,
              durationMs: Date.now() - startTime,
              searchPath,
            },
          };
        }
      } catch {
        return {
          content: [{ type: 'text', text: `Directory does not exist: ${searchPath}` }],
          details: {
            totalCount: 0,
            truncated: false,
            durationMs: Date.now() - startTime,
            searchPath,
          },
        };
      }

      // Collect ignore patterns
      let ignorePatterns: string[];
      if (respectGitignore) {
        const gitignorePatterns = await readGitignorePatterns(searchPath);
        ignorePatterns = gitignorePatterns.length > 0
          ? [...DEFAULT_IGNORE_PATTERNS, ...gitignorePatterns]
          : DEFAULT_IGNORE_PATTERNS;
      } else {
        ignorePatterns = [];
      }

      // Walk directory tree
      const allFiles = await walkDirectory(searchPath, searchPath, ignorePatterns);

      // Compile the glob pattern into a matcher for filtering
      const pattern = params.pattern;
      let matcher: GlobMatcher;
      try {
        matcher = compileGlob(pattern);
      } catch {
        return {
          content: [{ type: 'text', text: `Invalid glob pattern: ${pattern}` }],
          details: {
            totalCount: 0,
            truncated: false,
            durationMs: Date.now() - startTime,
            searchPath,
          },
        };
      }

      // Filter files by pattern
      const matchingFiles = allFiles.filter((filePath) => {
        const relativePath = path.relative(searchPath, filePath).split(path.sep).join('/');
        return matcher.test(relativePath);
      });

      // Sort by modification time (newest first)
      const filesWithMtime = await Promise.all(
        matchingFiles.map(async (filePath) => {
          try {
            const stat = await fs.promises.stat(filePath);
            return { filePath, mtime: stat.mtimeMs };
          } catch {
            return { filePath, mtime: 0 };
          }
        }),
      );

      filesWithMtime.sort((a, b) => b.mtime - a.mtime);

      const totalCount = filesWithMtime.length;
      const truncated = totalCount > MAX_RESULTS;
      const resultFiles = filesWithMtime.slice(0, MAX_RESULTS);

      // Normalize paths to forward slashes in output
      const outputPaths = resultFiles.map((f) => f.filePath.split(path.sep).join('/'));

      const durationMs = Date.now() - startTime;

      let text: string;
      if (outputPaths.length === 0) {
        text = 'No files matched the pattern.';
      } else {
        text = outputPaths.join('\n');
        if (truncated) {
          text += `\n\n[Showing ${MAX_RESULTS} of ${totalCount} matches. Use a more specific pattern to narrow results.]`;
        }
      }

      return {
        content: [{ type: 'text', text }],
        details: {
          totalCount,
          truncated,
          durationMs,
          searchPath,
        },
      };
    },
  };
}
