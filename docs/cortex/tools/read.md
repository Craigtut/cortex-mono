# Read Tool

Read the contents of a file from the local filesystem.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `file_path` | string | Yes | Absolute path to the file to read |
| `offset` | number | No | Line number to start reading from (1-based). Only provide if the file is too large to read at once. |
| `limit` | number | No | Maximum number of lines to read. Default: 2000. Only provide if the file is too large to read at once. |
| `pages` | string | No | Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Max 20 pages per request. |

## Returns

**`content`** (sent to the LLM):
- File contents with line numbers prepended (`cat -n` format: `spaces + line_number + tab + content`, 1-indexed)
- Lines exceeding 2000 characters are truncated
- Metadata: total lines in file, whether content was truncated

**`details`** (sent to UI/logs only):
- Full file path
- Total line count
- Byte size
- Whether the file was truncated (lines or characters)

## Implementation Notes

### Core Behavior
- Default: reads up to 2000 lines from the start of the file
- For large files, use `offset` and `limit` to read specific sections
- Returns a clear error if the file does not exist
- Cannot read directories (use `ls` via Bash for that)
- Should handle common encodings (UTF-8, UTF-16, Latin-1)

### Read-Before-Write/Edit Contract
The Read tool tracks which files have been read in the current agentic loop. The Write and Edit tools enforce that a file must be Read before it can be modified. This prevents blind overwrites and ensures the model has seen the current state of a file before changing it.

### Special File Types
- **Images** (PNG, JPG, GIF, WebP): Return as base64 in an `ImageContent` block. For vision-capable models, the image is presented visually.
- **PDFs**: Text extraction via `unpdf` (pure-ESM, zero native deps). Implementation: `packages/cortex/src/tools/shared/pdf-extractor.ts`.
  - Default: extracts the first 20 pages.
  - `pages` parameter accepts `"N"` or `"N-M"`; spec must fit the per-call 20-page cap and the document's page count.
  - Output is rendered with a `[PDF: ...]` header and `[Page N]` markers between pages, then passed through the same `cat -n` line-number formatter used for text files. Line numbers reset per call; PDFs do not participate in the `offset`/`limit` model.
  - Scanned / image-only PDFs return a structured "no extractable text; use an OCR tool" message. No automatic OCR.
  - Parse failures return a structured error rather than throwing.
  - The 10 MB absolute size ceiling still applies (enforced before extraction).
  - The 25,000-token output ceiling still applies (enforced on the rendered text); oversized extractions suggest a narrower `pages` range.

### Cross-Platform
- Accepts both forward slash and backslash paths. Normalizes internally.
- Case sensitivity follows the filesystem: macOS (HFS+) and Windows (NTFS) are case-insensitive, Linux (ext4) is case-sensitive.
- Line ending detection: Read returns content as-is (preserves `\r\n` on Windows files). The Edit tool handles normalization for matching.

### Error Handling

| Condition | Behavior |
|-----------|----------|
| File not found | Return error in `content`: "File does not exist: {path}" |
| Permission denied | Return error in `content`: "Permission denied: {path}" |
| Is a directory | Return error in `content`: "Cannot read a directory. Use `ls` via Bash." |
| Binary file (not image/PDF) | Return error in `content`: "Binary file detected. Cannot display as text." |
| PDF: `pages` out of range | Return error in `content`: "Pages spec ... exceeds document (has N pages)." Sets `rejected: true`. |
| PDF: malformed `pages` spec | Return error in `content`: "Invalid pages spec ... Use 'N' or 'N-M'." Sets `rejected: true`. |
| PDF: scanned / image-only | Return error in `content` suggesting OCR. Sets `rejected: true`. |
| PDF: unparseable bytes | Return error in `content`: "Failed to parse PDF: ..." Sets `rejected: true`. |
| PDF: extraction exceeds token budget | Return error in `content` suggesting a narrower `pages` range. Sets `rejected: true`. |
| File locked | Attempt read anyway (most OS allow concurrent reads). Error if truly locked. |

### System Prompt Guidance
The system prompt should instruct the model to use Read instead of `cat`, `head`, or `tail` via Bash. The dedicated tool provides structured output with line numbers and handles special file types.
