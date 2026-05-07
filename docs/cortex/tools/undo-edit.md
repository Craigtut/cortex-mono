# UndoEdit Tool

Revert the most recent `Edit` or `Write` on a single file.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `file_path` | string | Yes | Absolute path to the file whose most recent mutation should be reverted |

## Returns

**`content`** (sent to the LLM):
- Confirmation of the revert (`Undid Edit/Write of {path}...`) or
- A specific rejection reason (no history, file drifted, file deleted)

**`details`** (sent to UI/logs only):
- `filePath`
- `revertedSource`: `"Edit"` or `"Write"` — which tool the undone mutation came from
- `deleted`: true when the undo removed a file that Write had created
- `restored`: true when the undo restored prior content to an existing file
- `rejected`: true when the undo was refused (no history, stale state, etc.)
- `remainingDepth`: history entries still available for this file after the operation

## Implementation Notes

### How snapshots are captured

`Edit` and `Write` both push a snapshot onto a per-file stack in `EditHistory` immediately after a successful mutation. The snapshot records:
- The file's contents **before** the mutation (`null` when the file did not exist — i.e. `Write` created it)
- The file's mtime **after** the mutation
- A SHA-256 hash of the file's bytes **after** the mutation
- The source tool (`Edit` or `Write`)

`EditHistory` lives on `CortexToolRuntime` alongside `ReadRegistry` and `FileMutationLock`. It is cleared at the start of each agentic loop — history does not persist across loops, agents, or process boundaries.

### Stack bound

Per-file stack depth is capped at `MAX_STACK_DEPTH = 5`. When the cap is hit, the oldest entry is dropped so newer edits remain undoable. For rollbacks beyond five mutations, the model should Read the file and write the intended content directly.

### Drift detection

Before applying the revert, `UndoEdit` confirms the file on disk still carries the post-mutation fingerprint recorded when the snapshot was pushed. Mtime is checked first (cheap short-circuit); if mtime has drifted, a SHA-256 hash comparison is authoritative (formatters and cloud sync can touch mtime without changing bytes). If bytes have actually changed, the undo is refused and the entry is pushed back onto the stack — a rejected undo never silently truncates history.

### Concurrency

`UndoEdit` acquires the shared `FileMutationLock` for the target path, so it serializes against concurrent `Edit`, `Write`, and other `UndoEdit` calls on the same file. Mutations on other files proceed in parallel.

### Side effects on reverting

- If `originalContent` was a string → atomic write it back, then `readRegistry.markRead` with the restored bytes' mtime and hash. Subsequent `Edit` / `Write` calls do not require a re-Read.
- If `originalContent` was `null` → `unlink` the file, then `readRegistry.invalidate`. Subsequent attempts to `Edit` or `Write` the path require a fresh Read (for overwrites; creation does not).

### Error Handling

| Condition | Behavior |
|-----------|----------|
| No recorded mutation for this path | Return rejection: "No recorded Edit or Write to undo for {path}." |
| File deleted externally | Return rejection: "...the file has been deleted since the recorded mutation." |
| File modified externally (bytes differ) | Return rejection: "...the file has been modified since the recorded mutation." Entry pushed back onto the stack. |
| Filesystem error on delete / write | Return rejection with the underlying error message. Entry pushed back onto the stack. |

### System Prompt Guidance

The model should reach for `UndoEdit` when:
- It realizes its most recent `Edit` or `Write` was wrong and wants a one-call rollback instead of Read + Edit/Write again.
- A fuzzy-tier `Edit` resolved to an unexpected span and the model wants to retry with more surrounding context.

`UndoEdit` is not a general-purpose time machine: it covers only the agent's own mutations in the current loop. External changes (other tools, other processes, file syncs) are not undoable.
