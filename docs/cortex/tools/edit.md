# Edit Tool

Make precise string replacements in existing files.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `file_path` | string | Yes | Absolute path to the file to edit |
| `old_string` | string | Yes | The exact text to find and replace |
| `new_string` | string | Yes | The replacement text (must differ from old_string) |
| `replace_all` | boolean | No | Replace all occurrences. Default: false (replace first unique match). |

## Returns

**`content`** (sent to the LLM):
- Confirmation: number of replacements made
- File path

**`details`** (sent to UI/logs only):
- Full file path
- The old and new strings
- Structured diff (array of hunks for UI rendering)
- Original file content before edit
- Whether `replace_all` was used
- `matchTier`: which matcher tier resolved the edit (`exact`, `line-trimmed`, or `indentation-flexible`). Absent when no edit was performed.

## Implementation Notes

### Uniqueness Constraint
When `replace_all` is false, `old_string` must appear exactly once in the file. If it matches multiple locations, the tool returns an error asking the model to provide more surrounding context to make the match unique. This is a deliberate safety mechanism that forces the model to be precise about where it's editing.

### Read-Before-Edit Contract
The file must have been Read in the current agentic loop before it can be edited. The tool fails if the file hasn't been Read first. This ensures the model has seen the current state of the file.

### Undo snapshot
After every successful edit, the tool pushes a snapshot onto the per-file `EditHistory` stack (original contents + post-edit mtime + post-edit hash) so [UndoEdit](./undo-edit.md) can revert the mutation in a single call. History is per-loop and bounded (5 entries per file).

### Matching

The matcher runs a three-tier cascade, short-circuiting at the first tier that finds a match. Implementation lives in `packages/cortex/src/tools/shared/edit-matcher.ts` — a pure, I/O-free module that Edit orchestrates.

**Tier 1 — exact** (`indexOf`). The only tier that honors `replace_all`; the uniqueness constraint (`!replace_all` + multi-match) is enforced here. On ambiguity, the error message lists the specific line numbers where matches occur and reminds the model that `replace_all: true` is the escape hatch.

**Tier 2 — line-trimmed.** Tolerates per-line trailing whitespace differences between `old_string` and the file. The matched span on disk includes any trailing whitespace the file had, so the replacement overwrites it cleanly rather than leaving stray characters. Runs only when tier 1 finds zero matches. Must be uniquely matched; ambiguity at this tier rejects with the tolerance level named in the error.

**Tier 3 — indentation-flexible.** Strips the common leading indent from both `old_string` and each candidate haystack window (tabs and spaces are both recognized as indent characters), and also tolerates trailing whitespace. When a unique match resolves, `new_string` is re-indented to match the haystack's indent before it is written to disk — strip `needleIndent`, prepend `haystackIndent`, per non-empty line. Runs only when tiers 1 and 2 find zero matches. Must be uniquely matched.

Other matching properties:
- Multi-line replacements supported (both `old_string` and `new_string` can span multiple lines).
- The model should use the line number prefixes from Read output to understand indentation but never include the line number prefix itself in `old_string` or `new_string`.
- **Line ending normalization**: CRLF is normalized to LF before matching at all tiers. Output preserves the file's original line ending style.
- The matcher is NOT regex; `old_string` is always literal text.

### Nearest-match hints

When no tier matches, the error includes a `<- nearest` annotated snippet: the single line in the file with the highest Levenshtein-ratio similarity to the first non-empty line of `old_string`, plus ±3 lines of surrounding context. The hint is suppressed if no line scores above 0.5 similarity (random gibberish produces no hint). Scan is capped at 2,000 lines to bound Levenshtein cost on large files.

### Error Handling

| Condition | Behavior |
|-----------|----------|
| File not found | Return error in `content`: "File does not exist: {path}" |
| Permission denied | Return error in `content`: "Permission denied: {path}" |
| `old_string` not found | Return error in `content`: "The specified text was not found in the file." + nearest-match snippet (when a similar line exists) |
| `old_string` matches multiple locations (tier 1) | Return error in `content`: "Found {N} exact matches on lines {list}. Provide more surrounding context to uniquely identify the edit location, or pass `replace_all: true`." |
| Ambiguous tier 2 or tier 3 match | Return error in `content`: "Found {N} possible matches on lines {list} via {trailing-whitespace \| indentation} tolerance. No exact match exists. Tighten old_string to uniquely identify the edit location." |
| `old_string` equals `new_string` | Return error in `content`: "old_string and new_string are identical. No change needed." |
| Read-before-edit violation | Return error in `content`: "You must Read this file before editing it." |

### System Prompt Guidance
The system prompt should instruct:
- Always prefer Edit over Write for modifying existing files.
- When an edit fails due to non-unique match, provide more surrounding context lines to disambiguate.
- Do not use `sed` or `awk` via Bash for file editing.
- Prefer exact indentation from Read output, but know that the tool tolerates trailing-whitespace and indentation mismatches when the match is still unambiguous.
