/**
 * Edit tool: make precise string replacements in existing files.
 *
 * Supports exact string matching with a uniqueness constraint
 * (when replaceAll is false). Enforces read-before-edit via ReadRegistry.
 * Handles line ending normalization for cross-platform compatibility.
 *
 * Reference: docs/cortex/tools/edit.md
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Type, type Static } from 'typebox';
import type { EditHistory } from './shared/edit-history.js';
import type { FileMutationLock } from './shared/file-mutation-lock.js';
import type { ReadRegistry } from './shared/read-registry.js';
import type { ToolContentDetails } from '../types.js';
import { computeDiff, type DiffHunk } from './write.js';
import type { CortexToolRuntime } from './runtime.js';
import { attachRuntimeAwareTool } from './runtime.js';
import { isCriticalPathOrDescendant } from './bash/safety.js';
import {
  findMatch,
  findNearestMatch,
  reindentReplacement,
  type MatchResult,
} from './shared/edit-matcher.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const EditParams = Type.Object({
  file_path: Type.String({ description: 'Absolute path to the file to edit' }),
  old_string: Type.String({ description: 'The exact text to find and replace' }),
  new_string: Type.String({ description: 'The replacement text (must differ from old_string)' }),
  replace_all: Type.Optional(
    Type.Boolean({
      description: 'Replace all occurrences. Default: false (replace first unique match).',
      default: false,
    }),
  ),
});

export type EditParamsType = Static<typeof EditParams>;

// ---------------------------------------------------------------------------
// Details type
// ---------------------------------------------------------------------------

export interface EditDetails {
  filePath: string;
  oldString: string;
  newString: string;
  replacementCount: number;
  replaceAll: boolean;
  diff: DiffHunk[];
  originalContent: string;
  /**
   * Which matcher tier resolved the edit. Useful for consumers that want
   * to surface "we applied a fuzzy match" in the UI. Absent when no edit
   * was performed (errors, identical strings, etc.).
   */
  matchTier?: 'exact' | 'line-trimmed' | 'indentation-flexible';
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface EditToolConfig {
  runtime?: CortexToolRuntime | undefined;
  readRegistry?: ReadRegistry | undefined;
  fileMutationLock?: FileMutationLock | undefined;
  /**
   * Undo stack. When provided, every successful edit pushes a
   * pre-mutation snapshot so `UndoEdit` can restore the prior state.
   * Optional — tests and embedded consumers that don't expose undo
   * may omit it; the tool degrades gracefully to current behavior.
   */
  editHistory?: EditHistory | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AppliedTier = 'exact' | 'line-trimmed' | 'indentation-flexible';

interface AppliedReplacement {
  newContent: string;
  replacementCount: number;
  tier: AppliedTier;
}

/**
 * Given a successful match (not `none` and not `ambiguous`), produce the
 * rebuilt file content along with the replacement count and the tier
 * that resolved the edit. Caller is responsible for having already
 * rejected `none`, `ambiguous`, and the tier-1 `count>1 && !replaceAll`
 * case. Returns null when `match` is one of those guarded states, which
 * is a programming error at the call site.
 */
function applyReplacement(
  match: MatchResult,
  normalizedContent: string,
  normalizedOldString: string,
  normalizedNewString: string,
  replaceAll: boolean,
): AppliedReplacement | null {
  if (match.kind === 'exact') {
    if (replaceAll) {
      return {
        newContent: normalizedContent
          .split(normalizedOldString)
          .join(normalizedNewString),
        replacementCount: match.count,
        tier: 'exact',
      };
    }
    return {
      newContent:
        normalizedContent.slice(0, match.startIndex) +
        normalizedNewString +
        normalizedContent.slice(match.startIndex + match.matchedLength),
      replacementCount: 1,
      tier: 'exact',
    };
  }
  if (match.kind === 'line-trimmed') {
    return {
      newContent:
        normalizedContent.slice(0, match.startIndex) +
        normalizedNewString +
        normalizedContent.slice(match.startIndex + match.matchedLength),
      replacementCount: 1,
      tier: 'line-trimmed',
    };
  }
  if (match.kind === 'indentation-flexible') {
    const reindented = reindentReplacement(
      normalizedNewString,
      match.needleIndent,
      match.haystackIndent,
    );
    return {
      newContent:
        normalizedContent.slice(0, match.startIndex) +
        reindented +
        normalizedContent.slice(match.startIndex + match.matchedLength),
      replacementCount: 1,
      tier: 'indentation-flexible',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createEditTool(config: EditToolConfig): {
  name: string;
  description: string;
  parameters: typeof EditParams;
  execute: (params: EditParamsType) => Promise<ToolContentDetails<EditDetails>>;
} {
  const readRegistry = config.runtime?.readRegistry ?? config.readRegistry;
  if (!readRegistry) {
    throw new Error('createEditTool requires either runtime or readRegistry');
  }
  const fileMutationLock = config.runtime?.fileMutationLock ?? config.fileMutationLock;
  const editHistory = config.runtime?.editHistory ?? config.editHistory;

  /** Build a no-op result for early returns. */
  function noChange(
    filePath: string, oldString: string, newString: string,
    replaceAll: boolean, text: string, originalContent = '',
  ): ToolContentDetails<EditDetails> {
    return {
      content: [{ type: 'text', text }],
      details: { filePath, oldString, newString, replacementCount: 0, replaceAll, diff: [], originalContent },
    };
  }

  const tool = {
    name: 'Edit',
    description:
      'Make precise string replacements in an existing file. ' +
      'You MUST Read the file before using this tool. The edit will be rejected if the file has not been read first.',
    parameters: EditParams,

    async execute(params: EditParamsType): Promise<ToolContentDetails<EditDetails>> {
      const filePath = path.resolve(params.file_path);
      const oldString = params.old_string;
      const newString = params.new_string;
      const replaceAll = params.replace_all ?? false;

      if (isCriticalPathOrDescendant(filePath)) {
        return noChange(filePath, oldString, newString, replaceAll,
          `Refusing to edit critical system path: ${filePath}`);
      }

      // Check identical strings (no lock needed)
      if (oldString === newString) {
        return noChange(filePath, oldString, newString, replaceAll,
          'old_string and new_string are identical. No change needed.');
      }

      // Check file exists (no lock needed)
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return noChange(filePath, oldString, newString, replaceAll,
            `File does not exist: ${filePath}`);
        }
        if (code === 'EACCES') {
          return noChange(filePath, oldString, newString, replaceAll,
            `Permission denied: ${filePath}`);
        }
        throw err;
      }

      // Acquire per-file mutation lock (serializes concurrent same-file edits)
      const release = fileMutationLock ? await fileMutationLock.acquire(filePath) : undefined;
      try {
        // Enforce read-before-edit
        if (!readRegistry.hasBeenRead(filePath)) {
          return noChange(filePath, oldString, newString, replaceAll,
            'You must Read this file before editing it.');
        }

        // Mtime freshness check: reject if file changed since last Read.
        // Using strict greater-than (not !==) to tolerate Windows/cloud-sync
        // quirks where mtime can go backwards without a real modification.
        // When mtime does indicate a change, fall back to a content-hash
        // comparison (only possible for full reads) so formatter-style
        // touches that don't change bytes still allow the edit.
        const readState = readRegistry.getState(filePath);
        let originalBuffer: Buffer | undefined;
        if (readState) {
          const currentStat = await fs.promises.stat(filePath);
          if (currentStat.mtimeMs > readState.timestamp) {
            let contentUnchanged = false;
            if (readState.contentHash) {
              originalBuffer = await fs.promises.readFile(filePath);
              const currentHash = crypto.createHash('sha256')
                .update(originalBuffer).digest('hex');
              contentUnchanged = currentHash === readState.contentHash;
            }
            if (!contentUnchanged) {
              readRegistry.invalidate(filePath);
              return noChange(filePath, oldString, newString, replaceAll,
                'File was modified since last Read. Read the file again before editing.');
            }
          }
        }

        // Read the file content (reusing the buffer if we already loaded it
        // for the content-hash fallback).
        const originalContent = originalBuffer
          ? originalBuffer.toString('utf8')
          : await fs.promises.readFile(filePath, 'utf8');

        // Normalize line endings for matching: \r\n -> \n
        // We'll do matching on normalized content but track whether the
        // original had \r\n so we can preserve the original style.
        const hadCRLF = originalContent.includes('\r\n');
        const normalizedContent = originalContent.replace(/\r\n/g, '\n');
        const normalizedOldString = oldString.replace(/\r\n/g, '\n');
        const normalizedNewString = newString.replace(/\r\n/g, '\n');

        // Resolve the match via the tiered cascade (see edit-matcher.ts):
        //   tier 1: exact                 — substring indexOf
        //   tier 2: line-trimmed           — tolerates trailing whitespace
        //   tier 3: indentation-flexible   — tolerates leading indent delta
        // replace_all semantics apply only to tier 1; tier 2 and tier 3
        // always resolve to a single replacement (ambiguity there rejects).
        const match = findMatch(normalizedContent, normalizedOldString);

        if (match.kind === 'none') {
          const hint = findNearestMatch(normalizedContent, normalizedOldString);
          const text = hint
            ? `The specified text was not found in the file.\n\nNearest match in ${path.basename(filePath)}:\n${hint.snippet}`
            : 'The specified text was not found in the file.';
          return noChange(
            filePath, oldString, newString, replaceAll, text, originalContent,
          );
        }

        if (match.kind === 'ambiguous') {
          const tolerance =
            match.tier === 'line-trimmed'
              ? 'trailing-whitespace tolerance'
              : 'indentation tolerance';
          const lines = match.matchLines.join(', ');
          const suffix = match.count > match.matchLines.length ? ' (first 3 shown)' : '';
          return {
            content: [{
              type: 'text',
              text:
                `Found ${match.count} possible matches on lines ${lines}${suffix} via ${tolerance}. ` +
                'No exact match exists. Tighten old_string to uniquely identify the edit location.',
            }],
            details: {
              filePath, oldString, newString,
              replacementCount: 0, replaceAll, diff: [], originalContent,
            },
          };
        }

        if (match.kind === 'exact' && !replaceAll && match.count > 1) {
          const lines = match.matchLines.join(', ');
          const suffix = match.count > match.matchLines.length ? ' (first 3 shown)' : '';
          return {
            content: [{
              type: 'text',
              text:
                `Found ${match.count} exact matches on lines ${lines}${suffix}. ` +
                'Provide more surrounding context to uniquely identify the edit location, or pass replace_all: true.',
            }],
            details: {
              filePath, oldString, newString,
              replacementCount: 0, replaceAll, diff: [], originalContent,
            },
          };
        }

        const applied = applyReplacement(
          match, normalizedContent, normalizedOldString, normalizedNewString, replaceAll,
        );
        if (!applied) {
          // Unreachable: above guards cover 'none' and 'ambiguous'. Treat
          // as a programming error rather than silently succeeding.
          throw new Error(`Unexpected match kind: ${match.kind}`);
        }
        const newNormalizedContent = applied.newContent;
        const replacementCount = applied.replacementCount;
        const matchTier = applied.tier;

        // Restore original line ending style if it was CRLF
        const finalContent = hadCRLF
          ? newNormalizedContent.replace(/\n/g, '\r\n')
          : newNormalizedContent;

        // Compute diff
        const diff = computeDiff(originalContent, finalContent);

        // Atomic write: write to temp file, then rename
        const tempPath = path.join(path.dirname(filePath), `.edit-${crypto.randomUUID()}.tmp`);
        try {
          await fs.promises.writeFile(tempPath, finalContent, 'utf8');
          try {
            await fs.promises.rename(tempPath, filePath);
          } catch {
            // Rename may fail on Windows if target is open. Fall back to direct write.
            await fs.promises.writeFile(filePath, finalContent, 'utf8');
            try { await fs.promises.unlink(tempPath); } catch { /* ignore */ }
          }
        } catch (writeErr) {
          try { await fs.promises.unlink(tempPath); } catch { /* ignore */ }
          throw writeErr;
        }

        // Refresh read state: the agent's own edit is authoritative knowledge
        // of current file contents, so subsequent edits don't require a re-read.
        // We record the new mtime and a content hash of what we just wrote so
        // external modifications still trigger the freshness check above.
        // Also capture an EditHistory snapshot (when enabled) so UndoEdit
        // can restore the prior contents while being able to detect
        // post-edit external modifications.
        try {
          const postStat = await fs.promises.stat(filePath);
          const postHash = crypto.createHash('sha256')
            .update(finalContent, 'utf8').digest('hex');
          readRegistry.markRead(filePath, {
            timestamp: postStat.mtimeMs,
            contentHash: postHash,
          });
          editHistory?.record(filePath, {
            originalContent,
            postMutationMtimeMs: postStat.mtimeMs,
            postMutationContentHash: postHash,
            source: 'Edit',
          });
        } catch {
          readRegistry.invalidate(filePath);
        }

        const plural = replacementCount === 1 ? 'replacement' : 'replacements';
        const tierSuffix =
          matchTier === 'line-trimmed'
            ? ' (matched after trailing-whitespace tolerance)'
            : matchTier === 'indentation-flexible'
              ? ' (matched after indentation tolerance)'
              : '';
        return {
          content: [{
            type: 'text',
            text: `Made ${replacementCount} ${plural} in ${filePath}${tierSuffix}`,
          }],
          details: {
            filePath, oldString, newString,
            replacementCount, replaceAll, diff, originalContent,
            matchTier,
          },
        };
      } finally {
        release?.();
      }
    },
  };

  return attachRuntimeAwareTool(tool, {
    toolKind: 'Edit',
    cloneForRuntime: (runtime) => createEditTool({
      ...config,
      runtime,
      readRegistry: runtime.readRegistry,
      fileMutationLock: runtime.fileMutationLock,
      editHistory: runtime.editHistory,
    }),
  });
}
