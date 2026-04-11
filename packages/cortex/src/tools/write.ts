/**
 * Write tool: create a new file or overwrite an existing file.
 *
 * Enforces the read-before-write contract via ReadRegistry.
 * Performs atomic writes (write to temp, then rename) to prevent
 * partial writes on crash. Creates parent directories as needed.
 *
 * Reference: docs/cortex/tools/write.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import type { FileMutationLock } from './shared/file-mutation-lock.js';
import type { ReadRegistry } from './shared/read-registry.js';
import type { ToolContentDetails } from '../types.js';
import type { CortexToolRuntime } from './runtime.js';
import { attachRuntimeAwareTool } from './runtime.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const WriteParams = Type.Object({
  file_path: Type.String({ description: 'Absolute path to the file to write (must be absolute, not relative)' }),
  content: Type.String({ description: 'The full content to write to the file' }),
});

export type WriteParamsType = Static<typeof WriteParams>;

// ---------------------------------------------------------------------------
// Details type
// ---------------------------------------------------------------------------

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface WriteDetails {
  filePath: string;
  isCreate: boolean;
  bytesWritten: number;
  diff: DiffHunk[] | null;
  originalContent: string | null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WriteToolConfig {
  runtime?: CortexToolRuntime | undefined;
  readRegistry?: ReadRegistry | undefined;
  fileMutationLock?: FileMutationLock | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a safe line-level diff between two strings.
 *
 * This intentionally emits at most one changed hunk. The UI only needs a
 * compact, deterministic summary of the mutation, not a minimal diff.
 */
export function computeDiff(oldContent: string, newContent: string): DiffHunk[] {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  if (prefix === oldLines.length && prefix === newLines.length) {
    return [];
  }

  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (
    oldSuffix >= prefix &&
    newSuffix >= prefix &&
    oldLines[oldSuffix] === newLines[newSuffix]
  ) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const removedLines = oldSuffix >= prefix
    ? oldLines.slice(prefix, oldSuffix + 1).map((line) => `-${line}`)
    : [];
  const addedLines = newSuffix >= prefix
    ? newLines.slice(prefix, newSuffix + 1).map((line) => `+${line}`)
    : [];

  return [{
    oldStart: prefix + 1,
    oldLines: removedLines.length,
    newStart: prefix + 1,
    newLines: addedLines.length,
    lines: [...removedLines, ...addedLines],
  }];
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createWriteTool(config: WriteToolConfig): {
  name: string;
  description: string;
  parameters: typeof WriteParams;
  execute: (params: WriteParamsType) => Promise<ToolContentDetails<WriteDetails>>;
} {
  const readRegistry = config.runtime?.readRegistry ?? config.readRegistry;
  if (!readRegistry) {
    throw new Error('createWriteTool requires either runtime or readRegistry');
  }
  const fileMutationLock = config.runtime?.fileMutationLock ?? config.fileMutationLock;

  const tool = {
    name: 'Write',
    description:
      'Create a new file or overwrite an existing file on the local filesystem. ' +
      'If the file already exists, you MUST Read it before using this tool. The write will be rejected if an existing file has not been read first.',
    parameters: WriteParams,

    async execute(params: WriteParamsType): Promise<ToolContentDetails<WriteDetails>> {
      const filePath = path.resolve(params.file_path);
      const newContent = params.content;

      // Check if file exists (before acquiring lock)
      let fileExists = false;
      try {
        const stat = await fs.promises.stat(filePath);
        fileExists = stat.isFile();
      } catch {
        // File does not exist - that's fine for creation
      }

      // Acquire per-file mutation lock (serializes concurrent same-file writes)
      const release = fileMutationLock ? await fileMutationLock.acquire(filePath) : undefined;
      try {
        let originalContent: string | null = null;

        // Re-check existence after acquiring lock (another tool may have created/deleted it)
        try {
          const stat = await fs.promises.stat(filePath);
          fileExists = stat.isFile();
        } catch {
          fileExists = false;
        }

        // Enforce read-before-write for existing files
        if (fileExists && !readRegistry.hasBeenRead(filePath)) {
          return {
            content: [{ type: 'text', text: 'You must Read this file before overwriting it.' }],
            details: {
              filePath,
              isCreate: false,
              bytesWritten: 0,
              diff: null,
              originalContent: null,
            },
          };
        }

        // Read original content for diff (existing files only)
        if (fileExists) {
          try {
            originalContent = await fs.promises.readFile(filePath, 'utf8');
          } catch {
            // If we can't read for diff, continue without it
          }
        }

        // Create parent directories
        const parentDir = path.dirname(filePath);
        try {
          await fs.promises.mkdir(parentDir, { recursive: true });
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EACCES') {
            return {
              content: [{ type: 'text', text: `Cannot create directory: ${parentDir}` }],
              details: {
                filePath,
                isCreate: !fileExists,
                bytesWritten: 0,
                diff: null,
                originalContent,
              },
            };
          }
          throw err;
        }

        // Atomic write: write to temp file, then rename
        const tempPath = path.join(parentDir, `.write-${crypto.randomUUID()}.tmp`);
        try {
          await fs.promises.writeFile(tempPath, newContent, 'utf8');
          try {
            await fs.promises.rename(tempPath, filePath);
          } catch {
            // Rename may fail on Windows if target is open. Fall back to direct write.
            await fs.promises.writeFile(filePath, newContent, 'utf8');
            // Clean up temp file
            try {
              await fs.promises.unlink(tempPath);
            } catch {
              // Ignore cleanup errors
            }
          }
        } catch (err: unknown) {
          // Clean up temp file on error
          try {
            await fs.promises.unlink(tempPath);
          } catch {
            // Ignore cleanup errors
          }

          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EACCES') {
            return {
              content: [{ type: 'text', text: `Permission denied: ${filePath}` }],
              details: {
                filePath,
                isCreate: !fileExists,
                bytesWritten: 0,
                diff: null,
                originalContent,
              },
            };
          }
          if (code === 'ENOSPC') {
            return {
              content: [{ type: 'text', text: `Disk full. Cannot write to: ${filePath}` }],
              details: {
                filePath,
                isCreate: !fileExists,
                bytesWritten: 0,
                diff: null,
                originalContent,
              },
            };
          }
          if (code === 'ENAMETOOLONG') {
            return {
              content: [{ type: 'text', text: `Path exceeds system limit: ${filePath}` }],
              details: {
                filePath,
                isCreate: !fileExists,
                bytesWritten: 0,
                diff: null,
                originalContent,
              },
            };
          }
          throw err;
        }

        // Invalidate read state so the next mutation must re-read
        readRegistry.invalidate(filePath);

        const bytesWritten = Buffer.byteLength(newContent, 'utf8');
        const isCreate = !fileExists;

        // Compute diff for updates
        const diff = originalContent !== null ? computeDiff(originalContent, newContent) : null;

        const verb = isCreate ? 'Created' : 'Updated';
        return {
          content: [{ type: 'text', text: `${verb} ${filePath} (${bytesWritten} bytes)` }],
          details: {
            filePath,
            isCreate,
            bytesWritten,
            diff,
            originalContent,
          },
        };
      } finally {
        release?.();
      }
    },
  };

  return attachRuntimeAwareTool(tool, {
    toolKind: 'Write',
    cloneForRuntime: (runtime) => createWriteTool({
      ...config,
      runtime,
      readRegistry: runtime.readRegistry,
      fileMutationLock: runtime.fileMutationLock,
    }),
  });
}
