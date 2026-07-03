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
import { atomicWrite, CriticalPathWriteError } from './shared/atomic-write.js';
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

/**
 * A single span of `normalizedContent` (LF-normalized coordinates) that the
 * edit replaces, together with the LF-normalized replacement text. Kept as
 * ranges (rather than a pre-assembled string) so line-ending restoration can
 * rewrite only the replaced regions and leave untouched bytes verbatim.
 */
interface ReplacementSegment {
  /** Start offset in normalizedContent (inclusive). */
  start: number;
  /** End offset in normalizedContent (exclusive). */
  end: number;
  /** Replacement text, LF-normalized. */
  text: string;
}

interface AppliedReplacement {
  /** Non-overlapping, left-to-right segments to substitute. */
  segments: ReplacementSegment[];
  replacementCount: number;
  tier: AppliedTier;
}

/**
 * Given a successful match (not `none` and not `ambiguous`), produce the set
 * of replacement segments along with the replacement count and the tier that
 * resolved the edit. Caller is responsible for having already rejected
 * `none`, `ambiguous`, and the tier-1 `count>1 && !replaceAll` case. Returns
 * null when `match` is one of those guarded states, which is a programming
 * error at the call site.
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
      // Collect every non-overlapping occurrence, left to right — mirrors the
      // semantics of String.split(old).join(new).
      const segments: ReplacementSegment[] = [];
      let pos = 0;
      while (true) {
        const idx = normalizedContent.indexOf(normalizedOldString, pos);
        if (idx === -1) break;
        const end = idx + normalizedOldString.length;
        segments.push({ start: idx, end, text: normalizedNewString });
        pos = end;
      }
      return { segments, replacementCount: match.count, tier: 'exact' };
    }
    return {
      segments: [{
        start: match.startIndex,
        end: match.startIndex + match.matchedLength,
        text: normalizedNewString,
      }],
      replacementCount: 1,
      tier: 'exact',
    };
  }
  if (match.kind === 'line-trimmed') {
    return {
      segments: [{
        start: match.startIndex,
        end: match.startIndex + match.matchedLength,
        text: normalizedNewString,
      }],
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
      segments: [{
        start: match.startIndex,
        end: match.startIndex + match.matchedLength,
        text: reindented,
      }],
      replacementCount: 1,
      tier: 'indentation-flexible',
    };
  }
  return null;
}

/**
 * Substitute the given segments into `normalizedContent`, yielding the new
 * LF-normalized file content.
 */
function applySegments(
  normalizedContent: string,
  segments: ReplacementSegment[],
): string {
  let result = '';
  let cursor = 0;
  for (const seg of segments) {
    result += normalizedContent.slice(cursor, seg.start) + seg.text;
    cursor = seg.end;
  }
  result += normalizedContent.slice(cursor);
  return result;
}

/**
 * Rebuild the file with line endings restored.
 *
 * The matcher works on LF-normalized content. Naively converting every `\n`
 * back to `\r\n` when the file "had CRLF" rewrites untouched bare-LF lines in
 * a mixed-ending file into a large spurious diff. Instead:
 *
 *   - pure LF (no CRLF anywhere): write the normalized result as-is.
 *   - pure CRLF (every newline is CRLF): global conversion, as before.
 *   - mixed: preserve every untouched byte (and its original ending) exactly,
 *     rewriting endings only inside the replaced regions, following the style
 *     of the text each region replaced.
 */
function restoreLineEndings(
  originalContent: string,
  normalizedContent: string,
  segments: ReplacementSegment[],
): string {
  const crlfCount = (originalContent.match(/\r\n/g) ?? []).length;
  if (crlfCount === 0) {
    return applySegments(normalizedContent, segments);
  }
  const totalLf = (originalContent.match(/\n/g) ?? []).length;
  const bareLf = totalLf - crlfCount;
  if (bareLf === 0) {
    // Every newline in the file is CRLF: safe to convert globally.
    return applySegments(normalizedContent, segments).replace(/\n/g, '\r\n');
  }
  return reconstructMixed(
    originalContent,
    normalizedContent,
    segments,
    crlfCount > bareLf,
  );
}

/**
 * Reconstruct a mixed-ending file. Untouched spans are copied verbatim from
 * `originalContent` (so their exact line endings survive); replaced spans are
 * re-rendered with CRLF or LF based on the style of the original text they
 * replaced, falling back to the file's dominant style when the replaced span
 * carried no newline of its own.
 */
function reconstructMixed(
  originalContent: string,
  normalizedContent: string,
  segments: ReplacementSegment[],
  dominantIsCRLF: boolean,
): string {
  // origAt[n] = offset in originalContent where normalized index n begins.
  // Normalization only ever collapsed a `\r\n` into a single `\n`, so each
  // normalized char maps to either 1 original char or (for such a `\n`) 2.
  const origAt = new Array<number>(normalizedContent.length + 1);
  let o = 0;
  for (let n = 0; n < normalizedContent.length; n++) {
    origAt[n] = o;
    if (
      normalizedContent[n] === '\n' &&
      originalContent[o] === '\r' &&
      originalContent[o + 1] === '\n'
    ) {
      o += 2;
    } else {
      o += 1;
    }
  }
  origAt[normalizedContent.length] = o;

  let result = '';
  let cursorNorm = 0;
  for (const seg of segments) {
    result += originalContent.slice(origAt[cursorNorm]!, origAt[seg.start]!);
    const origMatched = originalContent.slice(origAt[seg.start]!, origAt[seg.end]!);
    const useCRLF = origMatched.includes('\r\n')
      ? true
      : origMatched.includes('\n')
        ? false
        : dominantIsCRLF;
    result += useCRLF ? seg.text.replace(/\n/g, '\r\n') : seg.text;
    cursorNorm = seg.end;
  }
  result += originalContent.slice(origAt[cursorNorm]!);
  return result;
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

        // Normalize line endings for matching: \r\n -> \n. Matching runs on
        // the normalized content; the original endings are restored per-region
        // after the replacement (see restoreLineEndings) so untouched lines in
        // a mixed-ending file are never rewritten.
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
        const replacementCount = applied.replacementCount;
        const matchTier = applied.tier;

        // Restore line endings: only the replaced regions follow the original
        // style; untouched lines in a mixed-ending file are left byte-for-byte.
        const finalContent = restoreLineEndings(
          originalContent, normalizedContent, applied.segments,
        );

        // Compute diff
        const diff = computeDiff(originalContent, finalContent);

        // Atomic write: temp file + rename, preserving the target's mode and
        // refusing to write through a symlink to a critical path.
        try {
          await atomicWrite(filePath, finalContent);
        } catch (writeErr) {
          if (writeErr instanceof CriticalPathWriteError) {
            return noChange(filePath, oldString, newString, replaceAll,
              `Refusing to edit critical system path: ${writeErr.resolvedPath}`, originalContent);
          }
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
