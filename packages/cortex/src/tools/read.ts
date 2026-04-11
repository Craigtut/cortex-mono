/**
 * Read tool: read file contents from the local filesystem.
 *
 * Returns file content with line numbers in `cat -n` format.
 * Handles text files, images (base64 ImageContent), and
 * detects binary files.
 *
 * Reference: docs/cortex/tools/read.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import type { ReadRegistry } from './shared/read-registry.js';
import type { ToolContentDetails } from '../types.js';
import type { CortexToolRuntime } from './runtime.js';
import { attachRuntimeAwareTool } from './runtime.js';
import { estimateTokens } from '../token-estimator.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ReadParams = Type.Object({
  file_path: Type.String({ description: 'Absolute path to the file to read' }),
  offset: Type.Optional(
    Type.Number({ description: 'Line number to start reading from (1-based). Only provide if the file is too large to read at once.' }),
  ),
  limit: Type.Optional(
    Type.Number({ description: 'Maximum number of lines to read. Only provide if the file is too large to read at once.' }),
  ),
  pages: Type.Optional(
    Type.String({ description: 'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Max 20 pages per request.' }),
  ),
});

export type ReadParamsType = Static<typeof ReadParams>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;

/** Pre-read gate for full reads (no offset/limit provided). */
const MAX_FULL_READ_BYTES = 256 * 1024; // 256 KB

/** Hard ceiling even with offset/limit. Beyond this, use Bash. */
const MAX_READABLE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Post-read token ceiling on formatted output. */
const MAX_OUTPUT_TOKENS = 25_000;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Device files that would hang the process: infinite output or blocking input.
 * Checked by path only (no I/O).
 */
const BLOCKED_DEVICE_PATHS = new Set([
  // Infinite output
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  // Blocks waiting for input
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  // Nonsensical to read
  '/dev/stdout',
  '/dev/stderr',
  // fd aliases for stdin/stdout/stderr
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
]);

function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true;
  // /proc/self/fd/0-2 and /proc/<pid>/fd/0-2 are Linux aliases for stdio
  if (
    filePath.startsWith('/proc/') &&
    (filePath.endsWith('/fd/0') ||
      filePath.endsWith('/fd/1') ||
      filePath.endsWith('/fd/2'))
  )
    return true;
  return false;
}

// ---------------------------------------------------------------------------
// Details type
// ---------------------------------------------------------------------------

export interface ReadDetails {
  filePath: string;
  totalLines: number;
  byteSize: number;
  truncated: boolean;
  truncatedLines: boolean;
  truncatedChars: boolean;
  /** Starting line number (1-based) for the content returned. */
  startLine: number;
  /** True when the read was rejected by a size/token gate (content is an error message, not file data). */
  rejected?: boolean;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ReadToolConfig {
  runtime?: CortexToolRuntime | undefined;
  readRegistry?: ReadRegistry | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect if a buffer contains binary content.
 * A file is considered binary if it contains null bytes in the first 8KB.
 */
function isBinaryBuffer(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Try to detect and decode file content with common encodings.
 * Handles UTF-8, UTF-16 LE/BE (via BOM), and falls back to Latin-1.
 */
function decodeFileContent(buffer: Buffer): string {
  // Check for UTF-16 BOM
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return buffer.toString('utf16le');
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      // UTF-16 BE: swap bytes and decode as UTF-16 LE
      const swapped = Buffer.alloc(buffer.length);
      for (let i = 0; i < buffer.length - 1; i += 2) {
        swapped[i] = buffer[i + 1]!;
        swapped[i + 1] = buffer[i]!;
      }
      return swapped.toString('utf16le');
    }
  }

  // Check for UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString('utf8').slice(1); // Skip the BOM character
  }

  // Try UTF-8 first (most common)
  const utf8 = buffer.toString('utf8');

  // Check for replacement characters that suggest bad UTF-8 decoding
  // Only fall back to Latin-1 if there are many replacement chars
  const replacementCount = (utf8.match(/\ufffd/g) ?? []).length;
  if (replacementCount > 0 && replacementCount > buffer.length * 0.01) {
    return buffer.toString('latin1');
  }

  return utf8;
}

/**
 * Format lines with `cat -n` style line numbers.
 * Format: spaces + line_number + tab + content
 */
function formatWithLineNumbers(
  lines: string[],
  startLine: number,
): string {
  const maxLineNum = startLine + lines.length - 1;
  const width = String(maxLineNum).length;

  return lines
    .map((line, i) => {
      const lineNum = startLine + i;
      const paddedNum = String(lineNum).padStart(width + 2);
      // Truncate long lines
      const truncatedLine =
        line.length > MAX_LINE_LENGTH
          ? line.slice(0, MAX_LINE_LENGTH) + '... [truncated]'
          : line;
      return `${paddedNum}\t${truncatedLine}`;
    })
    .join('\n');
}

/**
 * Format byte count as a human-readable string (KB or MB).
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Build a rejection result for size/token gate failures.
 * Returns an error message as tool content with `rejected: true` in details.
 */
function makeRejection(filePath: string, byteSize: number, message: string): ToolContentDetails<ReadDetails> {
  return {
    content: [{ type: 'text', text: message }],
    details: {
      filePath,
      totalLines: 0,
      byteSize,
      truncated: false,
      truncatedLines: false,
      truncatedChars: false,
      startLine: 1,
      rejected: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createReadTool(config: ReadToolConfig): {
  name: string;
  description: string;
  parameters: typeof ReadParams;
  execute: (params: ReadParamsType) => Promise<ToolContentDetails<ReadDetails>>;
} {
  const readRegistry = config.runtime?.readRegistry ?? config.readRegistry;
  if (!readRegistry) {
    throw new Error('createReadTool requires either runtime or readRegistry');
  }

  const tool = {
    name: 'Read',
    description: [
      'Read file contents from the local filesystem.',
      'Returns content with line numbers in cat -n format.',
      '',
      'Size limits:',
      `- Files up to ${formatBytes(MAX_FULL_READ_BYTES)}: read in full (no offset/limit needed)`,
      `- Files ${formatBytes(MAX_FULL_READ_BYTES)} to ${formatBytes(MAX_READABLE_BYTES)}: must provide offset and limit`,
      `- Files over ${formatBytes(MAX_READABLE_BYTES)}: use Bash (head, tail, sed) instead`,
      `- Output capped at ~${MAX_OUTPUT_TOKENS.toLocaleString()} tokens; reduce limit if exceeded`,
      '',
      'For searching file contents, use Grep instead of reading the whole file.',
    ].join('\n'),
    parameters: ReadParams,

    async execute(params: ReadParamsType): Promise<ToolContentDetails<ReadDetails>> {
      const filePath = path.resolve(params.file_path);
      const offset = params.offset ?? 1;
      const limit = params.limit ?? DEFAULT_LIMIT;

      // Block device paths that would hang (infinite output or blocking input)
      if (isBlockedDevicePath(filePath)) {
        return {
          content: [{ type: 'text', text: `Cannot read '${params.file_path}': this device file would block or produce infinite output.` }],
          details: {
            filePath,
            totalLines: 0,
            byteSize: 0,
            truncated: false,
            truncatedLines: false,
            truncatedChars: false,
            startLine: 1,
          },
        };
      }

      // Check if path exists
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return {
            content: [{ type: 'text', text: `File does not exist: ${filePath}` }],
            details: {
              filePath,
              totalLines: 0,
              byteSize: 0,
              truncated: false,
              truncatedLines: false,
              truncatedChars: false,
              startLine: 1,
            },
          };
        }
        if (code === 'EACCES') {
          return {
            content: [{ type: 'text', text: `Permission denied: ${filePath}` }],
            details: {
              filePath,
              totalLines: 0,
              byteSize: 0,
              truncated: false,
              truncatedLines: false,
              truncatedChars: false,
              startLine: 1,
            },
          };
        }
        throw err;
      }

      // Cannot read directories
      if (stat.isDirectory()) {
        return {
          content: [{ type: 'text', text: 'Cannot read a directory. Use `ls` via Bash.' }],
          details: {
            filePath,
            totalLines: 0,
            byteSize: 0,
            truncated: false,
            truncatedLines: false,
            truncatedChars: false,
            startLine: 1,
          },
        };
      }

      // Gate 1: Absolute size ceiling - reject files > 10 MB entirely
      if (stat.size > MAX_READABLE_BYTES) {
        return makeRejection(
          filePath,
          stat.size,
          `File is too large to read (${formatBytes(stat.size)}, limit ${formatBytes(MAX_READABLE_BYTES)}). Use Bash with head, tail, or sed to extract specific sections.`,
        );
      }

      const ext = path.extname(filePath).toLowerCase();

      // Handle image files
      if (IMAGE_EXTENSIONS.has(ext)) {
        const buffer = await fs.promises.readFile(filePath);
        const mimeType = IMAGE_MIME_TYPES[ext] ?? 'application/octet-stream';
        const base64 = buffer.toString('base64');

        readRegistry.markRead(filePath, { timestamp: stat.mtimeMs });

        return {
          content: [{ type: 'image', data: base64, mimeType }],
          details: {
            filePath,
            totalLines: 0,
            byteSize: stat.size,
            truncated: false,
            truncatedLines: false,
            truncatedChars: false,
            startLine: 1,
          },
        };
      }

      // Handle PDF files
      if (ext === '.pdf') {
        return {
          content: [{ type: 'text', text: 'PDF file detected. PDF text extraction requires the pdf-parse package (not yet installed). Use Bash with a PDF tool to read this file.' }],
          details: {
            filePath,
            totalLines: 0,
            byteSize: stat.size,
            truncated: false,
            truncatedLines: false,
            truncatedChars: false,
            startLine: 1,
          },
        };
      }

      // Gate 2: Full-read size gate - reject full reads of files > 256 KB
      const hasExplicitRange = params.offset !== undefined || params.limit !== undefined;
      if (!hasExplicitRange && stat.size > MAX_FULL_READ_BYTES) {
        return makeRejection(
          filePath,
          stat.size,
          `File is too large to read in full (${formatBytes(stat.size)}, limit ${formatBytes(MAX_FULL_READ_BYTES)}). Provide offset and limit to read a specific range, or use Grep to search for specific content.`,
        );
      }

      // File-unchanged dedup: if we already read this exact range and the
      // file hasn't changed on disk, return a stub. The earlier Read result
      // is still in context, so re-sending wastes tokens.
      const existingState = readRegistry.getState(filePath);
      if (existingState && existingState.offset !== undefined) {
        const rangeMatch =
          existingState.offset === offset && existingState.limit === limit;
        if (rangeMatch && stat.mtimeMs === existingState.timestamp) {
          return {
            content: [{ type: 'text', text: `[File unchanged since last read: ${filePath}]` }],
            details: {
              filePath,
              totalLines: 0,
              byteSize: stat.size,
              truncated: false,
              truncatedLines: false,
              truncatedChars: false,
              startLine: 1,
            },
          };
        }
      }

      // Read the raw buffer
      const buffer = await fs.promises.readFile(filePath);

      // Binary detection (not image, not PDF)
      if (isBinaryBuffer(buffer)) {
        return {
          content: [{ type: 'text', text: 'Binary file detected. Cannot display as text.' }],
          details: {
            filePath,
            totalLines: 0,
            byteSize: stat.size,
            truncated: false,
            truncatedLines: false,
            truncatedChars: false,
            startLine: 1,
          },
        };
      }

      // Decode and split into lines
      const content = decodeFileContent(buffer);
      const allLines = content.split('\n');
      const totalLines = allLines.length;

      // Handle empty file
      if (totalLines === 0 || (totalLines === 1 && allLines[0] === '')) {
        readRegistry.markRead(filePath, { timestamp: stat.mtimeMs, offset, limit });
        return {
          content: [{ type: 'text', text: `[File is empty: ${filePath}]` }],
          details: {
            filePath,
            totalLines: 0,
            byteSize: stat.size,
            truncated: false,
            truncatedLines: false,
            truncatedChars: false,
            startLine: 1,
          },
        };
      }

      // Apply offset and limit
      const startIdx = Math.max(0, offset - 1); // Convert 1-based to 0-based
      const endIdx = Math.min(totalLines, startIdx + limit);
      const selectedLines = allLines.slice(startIdx, endIdx);

      const truncatedLines = endIdx < totalLines;
      const truncatedChars = selectedLines.some((line) => line.length > MAX_LINE_LENGTH);

      // Format with line numbers
      const formatted = formatWithLineNumbers(selectedLines, startIdx + 1);

      // Gate 3: Post-read token estimation
      const estimatedTokenCount = estimateTokens(formatted);
      if (estimatedTokenCount > MAX_OUTPUT_TOKENS) {
        const suggestedLimit = Math.floor(limit * MAX_OUTPUT_TOKENS / estimatedTokenCount);
        return makeRejection(
          filePath,
          stat.size,
          `Read result too large (estimated ~${estimatedTokenCount.toLocaleString()} tokens, limit ${MAX_OUTPUT_TOKENS.toLocaleString()}). ` +
          `The file has ${totalLines} lines. Use a smaller limit (try limit: ${Math.max(1, suggestedLimit)}) ` +
          `or use Grep to find the specific content you need.`,
        );
      }

      // Only mark as read after passing all gates, so rejected reads
      // can be retried without hitting the dedup stub.
      readRegistry.markRead(filePath, { timestamp: stat.mtimeMs, offset, limit });

      let text = formatted;
      if (truncatedLines) {
        text += `\n\n[Showing lines ${startIdx + 1}-${endIdx} of ${totalLines} total. Use offset/limit to read more.]`;
      }

      return {
        content: [{ type: 'text', text }],
        details: {
          filePath,
          totalLines,
          byteSize: stat.size,
          truncated: truncatedLines || truncatedChars,
          truncatedLines,
          truncatedChars,
          startLine: offset,
        },
      };
    },
  };

  return attachRuntimeAwareTool(tool, {
    toolKind: 'Read',
    cloneForRuntime: (runtime) => createReadTool({
      ...config,
      runtime,
      readRegistry: runtime.readRegistry,
    }),
  });
}
