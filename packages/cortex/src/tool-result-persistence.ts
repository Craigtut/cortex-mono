/**
 * Tool result persistence: bookend-and-persist for oversized tool results.
 *
 * Sits at the tool execution boundary (refreshTools wrapper). After a tool
 * returns its result, this module checks whether the text content exceeds
 * the per-result threshold and either:
 *   - passes through unchanged (under threshold or skipped tool)
 *   - persists to disk (when `persistResult` is configured) and returns
 *     a bookend preview (head + tail) plus a file reference
 *   - returns a bookend preview only (when no `persistResult` is configured)
 *
 * This replaces ad-hoc per-tool truncation (Grep, Bash, WebFetch) with a
 * single, uniform mechanism. Reuses `applyBookend` and `getToolCategory`
 * from the existing compaction infrastructure.
 *
 * Reference: docs/cortex/tool-result-persistence.md
 */

import type { PersistResultFn, ToolCategory } from './types.js';
import { applyBookend, getToolCategory } from './compaction/microcompaction.js';
import { estimateTokens } from './token-estimator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-tool token threshold. Results larger than this trigger persistence/bookend. */
export const MAX_RESULT_TOKENS = 25_000;

/** Bookend size for the preview (head and tail each). 1,500 chars ≈ 375 tokens. */
export const BOOKEND_CHARS = 1_500;

/**
 * Tools whose results bypass the interceptor entirely.
 *
 * Either inherently bounded (Edit, Write, Glob) or content already on disk
 * where the model can use offset/limit on the original file (Read).
 */
export const SKIP_RESULT_PERSISTENCE = new Set<string>([
  'Read',
  'Edit',
  'Write',
  'Glob',
]);

/**
 * Built-in per-tool threshold overrides. Tools listed here use a different
 * token limit than `MAX_RESULT_TOKENS` (25K).
 *
 * Rationale per tool:
 * - Bash: command output is verbose with low signal density (logs, stack
 *   traces, build spam). A tighter cap reduces noise in context while still
 *   preserving full output via persistence.
 *
 * Consumers can extend or override this map via `CortexAgentConfig.toolResultThresholds`.
 */
export const DEFAULT_TOOL_THRESHOLDS: Record<string, number> = {
  Bash: 7_500,
};

/**
 * Resolve the effective threshold for a tool.
 * Order of precedence: consumer overrides > built-in defaults > MAX_RESULT_TOKENS.
 */
export function resolveThreshold(
  toolName: string,
  consumerOverrides?: Record<string, number>,
): number {
  if (consumerOverrides && toolName in consumerOverrides) return consumerOverrides[toolName]!;
  if (toolName in DEFAULT_TOOL_THRESHOLDS) return DEFAULT_TOOL_THRESHOLDS[toolName]!;
  return MAX_RESULT_TOKENS;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface ApplyPersistenceOptions {
  toolName: string;
  toolCallId: string;
  persistResult?: PersistResultFn | undefined;
  toolCategories?: Record<string, ToolCategory> | undefined;
  /** Consumer-provided per-tool threshold overrides (in tokens). */
  thresholds?: Record<string, number> | undefined;
}

/**
 * Options for processing a full tool result (with potentially multiple parts).
 * Same shape as ApplyPersistenceOptions minus the per-call identifiers.
 */
export interface ProcessResultOptions {
  toolName: string;
  toolCallId: string;
  persistResult?: PersistResultFn | undefined;
  toolCategories?: Record<string, ToolCategory> | undefined;
  thresholds?: Record<string, number> | undefined;
}

/**
 * Process a tool result text part for size limiting.
 *
 * - Under threshold or skipped tool: returns content unchanged
 * - Over threshold + `persistResult` configured: persists, returns bookend + file ref
 * - Over threshold + no `persistResult`: returns bookend only (lossy, but bounded)
 *
 * Pure async helper; never throws. Persist failures fall back to bookend-only.
 */
export async function applyResultPersistence(
  content: string,
  options: ApplyPersistenceOptions,
): Promise<string> {
  if (SKIP_RESULT_PERSISTENCE.has(options.toolName)) return content;

  const threshold = resolveThreshold(options.toolName, options.thresholds);
  const tokens = estimateTokens(content);
  if (tokens <= threshold) return content;

  const bookended = applyBookend(content, BOOKEND_CHARS, BOOKEND_CHARS, tokens);

  if (options.persistResult) {
    const category = getToolCategory(options.toolName, options.toolCategories) ?? 'ephemeral';
    try {
      const path = await options.persistResult(content, {
        toolName: options.toolName,
        toolCallId: options.toolCallId,
        category,
      });
      return [
        `[Result persisted: ${path} (${content.length.toLocaleString()} chars, ~${tokens.toLocaleString()} tokens)]`,
        '',
        bookended,
        '',
        'Use the Read tool with offset/limit to examine specific sections.',
      ].join('\n');
    } catch {
      // Persist failed; fall through to bookend-only path below.
    }
  }

  return [
    `[Result truncated: ~${tokens.toLocaleString()} tokens exceeded ${threshold.toLocaleString()} token limit]`,
    '',
    bookended,
  ].join('\n');
}

/**
 * Process a full tool result (potentially multi-part) through the
 * persistence interceptor.
 *
 * - Iterates the `content` array
 * - For each `text` part, runs `applyResultPersistence`
 * - Other part types (e.g., `image`) pass through unchanged
 * - Returns the same object reference if nothing changed (no allocation)
 *
 * Used by `CortexAgent.refreshTools()` at the tool execution boundary.
 * Exported so the wrapper logic is unit-testable.
 */
export async function processToolResult(
  result: unknown,
  options: ProcessResultOptions,
): Promise<unknown> {
  if (!result || typeof result !== 'object') return result;
  const asObj = result as Record<string, unknown>;
  const content = asObj['content'];
  if (!Array.isArray(content) || content.length === 0) return result;

  let modified = false;
  const newContent = await Promise.all(
    content.map(async (part: unknown) => {
      if (
        part &&
        typeof part === 'object' &&
        (part as Record<string, unknown>)['type'] === 'text' &&
        typeof (part as Record<string, unknown>)['text'] === 'string'
      ) {
        const text = (part as { text: string }).text;
        const processed = await applyResultPersistence(text, {
          toolName: options.toolName,
          toolCallId: options.toolCallId,
          persistResult: options.persistResult,
          toolCategories: options.toolCategories,
          thresholds: options.thresholds,
        });
        if (processed !== text) {
          modified = true;
          return { ...(part as Record<string, unknown>), text: processed };
        }
      }
      return part;
    }),
  );

  if (!modified) return result;
  return { ...asObj, content: newContent };
}
