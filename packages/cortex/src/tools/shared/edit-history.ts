/**
 * Per-file pre-mutation snapshot stack.
 *
 * Both Edit and Write push a snapshot immediately AFTER each successful
 * mutation. The UndoEdit tool pops the most recent snapshot to revert
 * a file to its prior state, as long as the on-disk state still matches
 * what we recorded when the mutation completed (so we never undo on top
 * of unrelated external changes).
 *
 * Scoped per-agent via `CortexToolRuntime`, cleared on each loop reset
 * — history does not persist across agentic loops or across agents.
 *
 * The stack is intentionally bounded (`MAX_STACK_DEPTH`). An unbounded
 * stack would accumulate full file contents during long refactors and
 * bloat memory. A deep stack is also rarely useful for the agentic
 * loop: if the model wants to roll back more than a few edits, it's
 * more reliable to Read the file and write the intended content
 * directly.
 */

import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditHistoryEntry {
  /**
   * File contents BEFORE the mutation, or `null` when the file did not
   * exist before the mutation (created by Write). Undoing a `null`
   * entry deletes the file.
   */
  originalContent: string | null;
  /** mtime (ms since epoch) of the file immediately AFTER the mutation. */
  postMutationMtimeMs: number;
  /** SHA-256 hex digest of the file bytes immediately AFTER the mutation. */
  postMutationContentHash: string;
  /** Which tool created the entry (for diagnostics / undo messaging). */
  source: 'Edit' | 'Write';
}

/** Upper bound on snapshots retained per file. */
export const MAX_STACK_DEPTH = 5;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class EditHistory {
  private readonly stacks = new Map<string, EditHistoryEntry[]>();

  /**
   * Push a snapshot for `filePath`. When the per-file stack is at its
   * depth cap, the oldest entry is dropped so newer edits remain
   * undoable.
   */
  record(filePath: string, entry: EditHistoryEntry): void {
    const key = this.normalize(filePath);
    const stack = this.stacks.get(key);
    if (stack === undefined) {
      this.stacks.set(key, [entry]);
      return;
    }
    stack.push(entry);
    while (stack.length > MAX_STACK_DEPTH) stack.shift();
  }

  /**
   * Pop and return the most recent entry for `filePath`, or `undefined`
   * when the file has no recorded history.
   */
  pop(filePath: string): EditHistoryEntry | undefined {
    const key = this.normalize(filePath);
    const stack = this.stacks.get(key);
    if (!stack || stack.length === 0) return undefined;
    const entry = stack.pop()!;
    if (stack.length === 0) this.stacks.delete(key);
    return entry;
  }

  /** Current stack depth for `filePath` (0 when absent). Diagnostic use. */
  depth(filePath: string): number {
    return this.stacks.get(this.normalize(filePath))?.length ?? 0;
  }

  /** Drop all history. Called from `CortexToolRuntime.resetForLoop`. */
  clear(): void {
    this.stacks.clear();
  }

  private normalize(filePath: string): string {
    // Matches the normalization used by FileMutationLock and
    // ReadRegistry so keys stay consistent across the three.
    return path.resolve(filePath);
  }
}
