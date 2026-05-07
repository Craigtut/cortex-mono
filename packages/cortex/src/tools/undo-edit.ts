/**
 * UndoEdit tool: revert the most recent Edit or Write on a single file.
 *
 * Uses the per-runtime `EditHistory` stack: every successful Edit /
 * Write push a pre-mutation snapshot, and `UndoEdit` pops the top
 * snapshot to restore the prior state.
 *
 * The undo is guarded: we verify the current on-disk state still
 * matches what we recorded at the moment the mutation completed (via
 * mtime + SHA-256 hash). If anything has diverged since — another
 * Edit/Write that wasn't history-tracked, a formatter, cloud sync —
 * we refuse rather than overwrite unrelated changes.
 *
 * Reference: docs/cortex/tools/undo-edit.md
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import type { EditHistory, EditHistoryEntry } from './shared/edit-history.js';
import type { FileMutationLock } from './shared/file-mutation-lock.js';
import type { ReadRegistry } from './shared/read-registry.js';
import type { ToolContentDetails } from '../types.js';
import type { CortexToolRuntime } from './runtime.js';
import { attachRuntimeAwareTool } from './runtime.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const UndoEditParams = Type.Object({
  file_path: Type.String({
    description: 'Absolute path to the file whose most recent Edit or Write should be reverted.',
  }),
});

export type UndoEditParamsType = Static<typeof UndoEditParams>;

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

export interface UndoEditDetails {
  filePath: string;
  /** The tool whose mutation was reverted (when the undo succeeds). */
  revertedSource?: 'Edit' | 'Write';
  /** True when the undo removed a file that Write had created. */
  deleted?: boolean;
  /** True when the undo restored prior content to an existing file. */
  restored?: boolean;
  /** True when the undo was rejected (no history, stale state, etc.). */
  rejected?: boolean;
  /** Remaining history depth for this file after the operation. */
  remainingDepth?: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface UndoEditToolConfig {
  runtime?: CortexToolRuntime | undefined;
  editHistory?: EditHistory | undefined;
  readRegistry?: ReadRegistry | undefined;
  fileMutationLock?: FileMutationLock | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashBytes(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function rejection(
  filePath: string,
  text: string,
  remainingDepth: number,
): ToolContentDetails<UndoEditDetails> {
  return {
    content: [{ type: 'text', text }],
    details: { filePath, rejected: true, remainingDepth },
  };
}

/**
 * Atomically write the restored content to disk. Mirrors the pattern
 * used by Edit and Write so concurrent consumers observe a coherent
 * file at all times.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.undo-${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.promises.writeFile(tempPath, content, 'utf8');
    try {
      await fs.promises.rename(tempPath, filePath);
    } catch {
      // Rename may fail on Windows if the target is open. Fall back to a
      // direct write and clean up the temp file.
      await fs.promises.writeFile(filePath, content, 'utf8');
      try { await fs.promises.unlink(tempPath); } catch { /* ignore */ }
    }
  } catch (err) {
    try { await fs.promises.unlink(tempPath); } catch { /* ignore */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createUndoEditTool(config: UndoEditToolConfig): {
  name: string;
  description: string;
  parameters: typeof UndoEditParams;
  execute: (params: UndoEditParamsType) => Promise<ToolContentDetails<UndoEditDetails>>;
} {
  const editHistory = config.runtime?.editHistory ?? config.editHistory;
  if (!editHistory) {
    throw new Error('createUndoEditTool requires either runtime or editHistory');
  }
  const readRegistry = config.runtime?.readRegistry ?? config.readRegistry;
  const fileMutationLock = config.runtime?.fileMutationLock ?? config.fileMutationLock;

  const tool = {
    name: 'UndoEdit',
    description:
      'Revert the most recent Edit or Write on a single file, returning it to the state it had before the last mutation. ' +
      'Only reverts the most recent mutation; call repeatedly to roll back multiple steps (bounded history). ' +
      'Refuses if the file has been modified externally since the mutation was recorded.',
    parameters: UndoEditParams,

    async execute(
      params: UndoEditParamsType,
    ): Promise<ToolContentDetails<UndoEditDetails>> {
      const filePath = path.resolve(params.file_path);

      const release = fileMutationLock ? await fileMutationLock.acquire(filePath) : undefined;
      try {
        // Peek-then-pop pattern isn't expressible directly since `pop`
        // returns the entry. We pop immediately and, on abort, push it
        // back so the stack isn't silently truncated by a rejected
        // undo.
        const entry = editHistory.pop(filePath);
        if (!entry) {
          return rejection(
            filePath,
            `No recorded Edit or Write to undo for ${filePath}.`,
            0,
          );
        }

        const restoreEntry = (): void => editHistory.record(filePath, entry);
        const remainingAfter = editHistory.depth(filePath);

        // Verify current on-disk state matches what we recorded when
        // the mutation completed. Any mismatch means the file drifted
        // and undoing would stomp unrelated changes.
        const verification = await verifyPostMutationState(filePath, entry);
        if (verification.kind === 'drift') {
          restoreEntry();
          return rejection(
            filePath,
            `Cannot undo: ${verification.reason} Read the file to resync, then issue an explicit Edit or Write.`,
            remainingAfter + 1,
          );
        }

        // Apply the revert.
        if (entry.originalContent === null) {
          // Write created the file; undo = delete.
          try {
            await fs.promises.unlink(filePath);
          } catch (err) {
            restoreEntry();
            const msg = err instanceof Error ? err.message : String(err);
            return rejection(
              filePath,
              `Cannot undo: failed to delete ${filePath}: ${msg}`,
              remainingAfter + 1,
            );
          }
          readRegistry?.invalidate(filePath);
          return {
            content: [{
              type: 'text',
              text: `Undid ${entry.source} of ${filePath} (file deleted; was created by the prior ${entry.source}).`,
            }],
            details: {
              filePath,
              revertedSource: entry.source,
              deleted: true,
              rejected: false,
              remainingDepth: remainingAfter,
            },
          };
        }

        // Existing file — restore prior content.
        try {
          await atomicWrite(filePath, entry.originalContent);
        } catch (err) {
          restoreEntry();
          const msg = err instanceof Error ? err.message : String(err);
          return rejection(
            filePath,
            `Cannot undo: failed to restore ${filePath}: ${msg}`,
            remainingAfter + 1,
          );
        }

        // Refresh read state: after a successful undo, the agent's
        // knowledge of the file is the restored content.
        try {
          const postStat = await fs.promises.stat(filePath);
          const postHash = hashBytes(entry.originalContent);
          readRegistry?.markRead(filePath, {
            timestamp: postStat.mtimeMs,
            contentHash: postHash,
          });
        } catch {
          readRegistry?.invalidate(filePath);
        }

        return {
          content: [{
            type: 'text',
            text: `Undid ${entry.source} of ${filePath} (restored ${entry.originalContent.length} character${entry.originalContent.length === 1 ? '' : 's'} of prior content).`,
          }],
          details: {
            filePath,
            revertedSource: entry.source,
            restored: true,
            rejected: false,
            remainingDepth: remainingAfter,
          },
        };
      } finally {
        release?.();
      }
    },
  };

  return attachRuntimeAwareTool(tool, {
    toolKind: 'UndoEdit',
    cloneForRuntime: (runtime) => createUndoEditTool({
      ...config,
      runtime,
      editHistory: runtime.editHistory,
      readRegistry: runtime.readRegistry,
      fileMutationLock: runtime.fileMutationLock,
    }),
  });
}

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

type VerificationResult = { kind: 'ok' } | { kind: 'drift'; reason: string };

/**
 * Confirm that the file on disk still carries the exact post-mutation
 * fingerprint we recorded. Two axes:
 *   - existence:   the file must be present iff we expected it to be
 *   - identity:    bytes must hash to the recorded value
 * mtime is checked first as a cheap short-circuit; on mtime mismatch
 * the hash check is authoritative (formatters / cloud sync can touch
 * mtime without changing bytes).
 */
async function verifyPostMutationState(
  filePath: string,
  entry: EditHistoryEntry,
): Promise<VerificationResult> {
  let stat: fs.Stats | undefined;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        kind: 'drift',
        reason: 'the file has been deleted since the recorded mutation.',
      };
    }
    return {
      kind: 'drift',
      reason: `the file is inaccessible (${code ?? 'unknown error'}).`,
    };
  }

  // Fast path: mtime matches exactly. (We use equality here because
  // we're comparing against our OWN previously-recorded mtime, not a
  // user-provided read state — quirks around mtime going backwards
  // aren't relevant when both values came from our writes.)
  if (stat.mtimeMs === entry.postMutationMtimeMs) return { kind: 'ok' };

  // mtime drifted — confirm via hash before rejecting, since formatters
  // and cloud-sync can touch mtime without changing bytes.
  const bytes = await fs.promises.readFile(filePath);
  const currentHash = hashBytes(bytes);
  if (currentHash === entry.postMutationContentHash) return { kind: 'ok' };

  return {
    kind: 'drift',
    reason: 'the file has been modified since the recorded mutation.',
  };
}
