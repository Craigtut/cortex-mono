/**
 * TranscriptWriter: a durable, append-only conversation log.
 *
 * `saveSession` (persistence/sessions.ts) writes `history.json` as a
 * full-rewrite compacted snapshot used to reload context. That snapshot is
 * lossy: compaction can drop or summarize turns, and `sanitizeHistoryForSave`
 * strips bulky tool `details`. This writer instead appends one JSON record per
 * line to `~/.cortex/sessions/<id>/transcript.jsonl`, never rewriting prior
 * lines, so the complete turn-by-turn history survives.
 *
 * An external reader (for example a companion app) reads this file to summarize
 * "where we left off" when a user returns to a session, so the record shape is a
 * contract. Each record
 * uses a uniform envelope (the same shape as the ActivityEvent envelope in
 * activity/session-activity.ts): `{ version, sequence, sessionId, type,
 * timestamp, payload }`. New record `type`s are additive, so a reader that
 * ignores unknown types stays compatible without a version bump.
 *
 * Design choices, matching how Codex and Claude Code persist sessions:
 *   - One unbounded append-only file per session. No rotation, so `session_meta`
 *     is always the first line and never has to be re-emitted.
 *   - Large text (tool output, big messages) is stored inline up to a cap, then
 *     spilled to a `transcript-blobs/` sidecar with a reference. Nothing is
 *     truncated to the point of data loss. Tool results that Cortex already
 *     spilled to `tool-results/` arrive pre-bookended and stay inline, so this
 *     writer mirrors exactly what the agent holds in memory.
 *   - Writes are best-effort: a transcript failure must never crash or block a
 *     session turn. Errors are swallowed (optionally surfaced via onWriteError)
 *     and appends are serialized through a promise queue so concurrent writes
 *     can't interleave. The writer never touches `history.json`.
 *
 * Resume behavior: on a resumed session whose transcript already exists and is
 * non-empty, the writer continues the file. It reads the last line's sequence
 * to resume numbering and does NOT re-emit `session_meta`. A fresh session
 * writes `session_meta` as its first record.
 */

import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const TRANSCRIPT_VERSION = 1;
const DEFAULT_SESSIONS_DIR = join(homedir(), '.cortex', 'sessions');

/**
 * Text fields up to this length are stored inline in the JSONL record. Larger
 * values spill to a sidecar file with a reference, keeping lines stream-parseable
 * while never losing data. 16 KB comfortably holds a bookended tool result
 * (head + tail preview, ~3 KB) plus its persisted-file reference, so already
 * spilled results stay inline and mirror what the agent holds in memory.
 */
const MAX_INLINE_TEXT_CHARS = 16 * 1024;
/** Inline preview kept alongside a spilled-blob reference. */
const PREVIEW_CHARS = 2 * 1024;
/** Sidecar directory (relative to the session dir) for spilled text blobs. */
const BLOB_DIR = 'transcript-blobs';

export type TranscriptRecordType =
  | 'session_meta'
  | 'user_message'
  | 'tool_call'
  | 'tool_result'
  | 'assistant_message'
  | 'error'
  | 'compaction'
  | 'sub_agent';

export type SubAgentStatus = 'spawned' | 'completed' | 'failed';

export interface TranscriptRecord {
  version: 1;
  sequence: number;
  sessionId: string;
  type: TranscriptRecordType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface TranscriptHeaderExtras {
  /** Current git branch, if the session cwd is a repo. */
  gitBranch?: string | undefined;
}

export interface TranscriptWriterOptions {
  sessionsDir?: string | undefined;
  cliVersion?: string | undefined;
  /** Provider id (e.g. "anthropic") recorded in the session header. */
  provider?: string | undefined;
  /** Model id recorded in the session header. */
  model?: string | undefined;
  /** True when resuming a saved session; continues an existing transcript. */
  resume?: boolean | undefined;
  now?: (() => Date) | undefined;
  onWriteError?: ((error: unknown) => void) | undefined;
}

interface PendingRecord {
  type: TranscriptRecordType;
  payload: Record<string, unknown>;
}

/** Stringify tool args defensively; never throw. Spill handling caps length later. */
function stringifyArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

export class TranscriptWriter {
  private readonly transcriptPath: string;
  private readonly sessionDir: string;
  private readonly blobDir: string;
  private readonly cliVersion: string;
  private readonly provider: string | undefined;
  private readonly model: string | undefined;
  private readonly resume: boolean;
  private readonly now: () => Date;
  private readonly onWriteError: ((error: unknown) => void) | undefined;

  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();
  /** True once the header has been written or its sequence picked up on resume. */
  private initialized = false;
  /** Set synchronously when the header enqueue is scheduled, so it always lands first. */
  private headerScheduled = false;
  /** Header extras captured from initialize(), applied whenever settleHeader runs. */
  private headerExtras: TranscriptHeaderExtras | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
    options: TranscriptWriterOptions = {},
  ) {
    const sessionsDir = options.sessionsDir ?? DEFAULT_SESSIONS_DIR;
    this.sessionDir = join(sessionsDir, sessionId);
    this.transcriptPath = join(this.sessionDir, 'transcript.jsonl');
    this.blobDir = join(this.sessionDir, BLOB_DIR);
    this.cliVersion = options.cliVersion ?? '';
    this.provider = options.provider;
    this.model = options.model;
    this.resume = options.resume ?? false;
    this.now = options.now ?? (() => new Date());
    this.onWriteError = options.onWriteError;
  }

  /**
   * Settle the header: write `session_meta` for a fresh transcript, or pick up
   * the existing sequence for a resumed one. Safe to call more than once; only
   * the first call schedules work. Always enqueued so it lands before appends.
   */
  initialize(extras?: TranscriptHeaderExtras): Promise<void> {
    // Capture extras on the instance so they apply even if a write already
    // lazily scheduled the header, as long as settleHeader has not run yet.
    if (extras) this.headerExtras = extras;
    if (this.headerScheduled) return this.queue;
    this.headerScheduled = true;
    return this.enqueue(() => this.settleHeader());
  }

  addUserMessage(text: string): void {
    this.record('user_message', async (payload) => {
      await this.embedText(payload, 'text', text);
    });
  }

  addToolCall(toolCallId: string, name: string, args: unknown): void {
    this.record('tool_call', async (payload) => {
      payload['toolCallId'] = toolCallId;
      payload['name'] = name;
      await this.embedText(payload, 'args', stringifyArgs(args));
    });
  }

  addToolResult(toolCallId: string, isError: boolean, output: string): void {
    this.record('tool_result', async (payload) => {
      payload['toolCallId'] = toolCallId;
      payload['isError'] = isError;
      await this.embedText(payload, 'output', output);
    });
  }

  addAssistantMessage(text: string): void {
    if (!text.trim()) return;
    this.record('assistant_message', async (payload) => {
      await this.embedText(payload, 'text', text);
    });
  }

  /** Record an agent loop error so a turn that failed before completing is visible. */
  addError(message: string, kind?: string): void {
    this.record('error', async (payload) => {
      if (kind) payload['kind'] = kind;
      await this.embedText(payload, 'message', message);
    });
  }

  /**
   * Record a compaction marker so a reader can see where context was summarized
   * away. The full pre-compaction turns remain earlier in this transcript.
   */
  addCompaction(info: {
    strategy?: string | undefined;
    reason?: string | undefined;
    beforeTokens?: number | undefined;
    afterTokens?: number | undefined;
  } = {}): void {
    this.record('compaction', (payload) => {
      if (info.strategy) payload['strategy'] = info.strategy;
      if (info.reason) payload['reason'] = info.reason;
      if (typeof info.beforeTokens === 'number') payload['beforeTokens'] = info.beforeTokens;
      if (typeof info.afterTokens === 'number') payload['afterTokens'] = info.afterTokens;
    });
  }

  /**
   * Record a sub-agent lifecycle event. Sub-agent work appears in the parent's
   * memory only as the SubAgent tool call/result; these markers add the task id,
   * status, and a short summary or error for richer "where we left off" context.
   */
  addSubAgent(
    taskId: string,
    status: SubAgentStatus,
    detail?: { summary?: string | undefined; error?: string | undefined; background?: boolean | undefined },
  ): void {
    this.record('sub_agent', async (payload) => {
      payload['taskId'] = taskId;
      payload['status'] = status;
      if (detail?.background !== undefined) payload['background'] = detail.background;
      if (detail?.summary) await this.embedText(payload, 'summary', detail.summary);
      if (detail?.error) await this.embedText(payload, 'error', detail.error);
    });
  }

  /** Resolve once all queued writes have drained. */
  flush(): Promise<void> {
    return this.queue;
  }

  /**
   * Enqueue a record behind the header. The header is scheduled lazily on the
   * first write if `initialize()` was never called, so `session_meta` is always
   * the first line even if a caller skips initialize.
   */
  private record(
    type: TranscriptRecordType,
    build: (payload: Record<string, unknown>) => void | Promise<void>,
  ): void {
    if (!this.headerScheduled) {
      this.headerScheduled = true;
      void this.enqueue(() => this.settleHeader());
    }
    void this.enqueue(async () => {
      const payload: Record<string, unknown> = {};
      await build(payload);
      await this.appendRecord({ type, payload });
    });
  }

  private async settleHeader(): Promise<void> {
    if (this.initialized) return;

    try {
      await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });

      const lastSequence = await this.readLastSequence();
      if (lastSequence !== null) {
        // Existing, non-empty transcript: continue it without a fresh header.
        this.sequence = lastSequence;
      } else {
        const payload: Record<string, unknown> = {
          id: this.sessionId,
          cwd: this.cwd,
          cliVersion: this.cliVersion,
        };
        if (this.provider) payload['provider'] = this.provider;
        if (this.model) payload['model'] = this.model;
        if (this.headerExtras?.gitBranch) payload['git'] = { branch: this.headerExtras.gitBranch };

        await this.appendRecord({ type: 'session_meta', payload });
      }

      this.initialized = true;
    } catch (err) {
      // A transient failure (e.g. mkdir) must not latch the writer as
      // initialized. Reset so a later write retries the header, and rethrow so
      // onWriteError surfaces the failure instead of dying silently.
      this.headerScheduled = false;
      throw err;
    }
  }

  private async appendRecord(record: PendingRecord): Promise<void> {
    const sequence = this.sequence + 1;
    const transcriptRecord: TranscriptRecord = {
      version: TRANSCRIPT_VERSION,
      sequence,
      sessionId: this.sessionId,
      type: record.type,
      timestamp: this.now().toISOString(),
      payload: record.payload,
    };
    const line = JSON.stringify(transcriptRecord) + '\n';
    await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    await appendFile(this.transcriptPath, line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
    // Advance only after a successful write so a failed append leaves no gap in
    // the sequence (which the resume path relies on).
    this.sequence = sequence;
  }

  /**
   * Store a text value on `payload[field]`. Small values are stored inline.
   * Large values are spilled to a sidecar blob and replaced with a short preview
   * plus `<field>_ref` (relative path) and `<field>_bytes` (full size), so the
   * line stays small and the full content is always recoverable. If the spill
   * write fails, fall back to a marked truncation rather than throwing.
   */
  private async embedText(
    payload: Record<string, unknown>,
    field: string,
    value: string,
  ): Promise<void> {
    if (value.length <= MAX_INLINE_TEXT_CHARS) {
      payload[field] = value;
      return;
    }

    const ref = await this.spillBlob(value);
    if (ref) {
      payload[field] = value.slice(0, PREVIEW_CHARS);
      payload[`${field}_ref`] = ref;
      payload[`${field}_bytes`] = Buffer.byteLength(value, 'utf8');
      return;
    }

    // Spill failed: keep a bounded, explicitly-marked preview.
    const omitted = value.length - PREVIEW_CHARS;
    payload[field] = value.slice(0, PREVIEW_CHARS) + `... [truncated ${omitted} chars]`;
  }

  /**
   * Write a large text blob to `transcript-blobs/blob-<hash>.txt` and return its
   * path relative to the session dir. Hash-named so identical blobs dedupe.
   * Best-effort: returns null on failure.
   */
  private async spillBlob(value: string): Promise<string | null> {
    try {
      const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
      const filename = `blob-${hash}.txt`;
      await mkdir(this.blobDir, { recursive: true, mode: 0o700 });
      await writeFile(join(this.blobDir, filename), value, { encoding: 'utf8', mode: 0o600 });
      return `${BLOB_DIR}/${filename}`;
    } catch {
      return null;
    }
  }

  /**
   * Read the sequence of the last record so a resumed session continues
   * numbering. Returns null when the file is missing or empty.
   */
  private async readLastSequence(): Promise<number | null> {
    if (!this.resume) {
      // A fresh (non-resume) session starts a new transcript. If a file is
      // somehow already there, continue it rather than clobbering history.
      try {
        await stat(this.transcriptPath);
      } catch {
        return null;
      }
    }

    let raw: string;
    try {
      raw = await readFile(this.transcriptPath, 'utf8');
    } catch {
      return null;
    }
    const trimmed = raw.trimEnd();
    if (!trimmed) return null;

    // Scan backward for the last line with a parseable sequence. A crash can
    // leave a partial final line; skipping it avoids reusing a sequence.
    const lines = trimmed.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]!) as { sequence?: unknown };
        if (typeof parsed.sequence === 'number' && Number.isFinite(parsed.sequence)) {
          return parsed.sequence;
        }
      } catch {
        // Keep scanning older lines.
      }
    }
    // No line had a parseable sequence: fall back to the line count.
    return lines.length;
  }

  /**
   * Serialize tasks through a single promise chain so appends never interleave.
   * Failures are swallowed (best-effort) and reported via onWriteError, matching
   * FileSessionActivityReporter.
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task).catch((error: unknown) => {
      this.onWriteError?.(error);
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

/**
 * Flatten a tool result's content blocks to displayable text. Tool results
 * arrive as a `ToolContentDetails`-shaped object (a `content` array of text /
 * image blocks), a plain string, or an array of blocks. Image blocks are
 * dropped; only text survives. Mirrors `extractToolResultText` in
 * utils/replay-history.ts.
 */
export function extractToolResultText(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;

  const blocks = Array.isArray(result)
    ? result
    : typeof result === 'object' && Array.isArray((result as Record<string, unknown>)['content'])
      ? ((result as Record<string, unknown>)['content'] as unknown[])
      : null;

  if (!blocks) {
    // Unknown shape: stringify defensively rather than lose the result.
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

  const parts: string[] = [];
  for (const block of blocks) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as Record<string, unknown>)['type'] === 'text' &&
      typeof (block as Record<string, unknown>)['text'] === 'string'
    ) {
      parts.push((block as Record<string, unknown>)['text'] as string);
    }
  }
  return parts.join('\n');
}
