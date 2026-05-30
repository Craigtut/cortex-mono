/**
 * TitleManager: names the terminal tab after what the user is working on.
 *
 * Strategy (mode 'dynamic'):
 * - The first genuine user prompt generates a title immediately (snappy feel;
 *   a first agent turn can run long, so we do not wait for it to finish).
 * - Thereafter the title is re-evaluated every N completed user turns
 *   (default 5), driven by the session's onLoopComplete.
 * - The current title is fed back into the model with an instruction to keep it
 *   unless the work has clearly shifted. This hysteresis is what prevents the
 *   tab from flickering on every cadence tick: cadence controls cost, the
 *   carried-over title controls churn.
 *
 * The title input comes from the raw prompts the user typed (captured at the
 * session input boundary), NOT from the agent's conversation history: that
 * history contains role:'user' messages that are actually injected ephemeral
 * context, skill buffers, and background-task state, none of which represent
 * user intent.
 *
 * Generation runs on the cheap utility model and is entirely best-effort: any
 * failure (no agent, no API key, offline, model error) is swallowed so a
 * cosmetic feature never disrupts the session.
 */

import path from 'node:path';

export type TerminalTitleMode = 'dynamic' | 'static' | 'off';

export interface TitleCompletionContext {
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
}

export interface TitleManagerOptions {
  /** Behavior: dynamic (LLM summary), static (cwd basename once), off (no-op). */
  mode: TerminalTitleMode;
  /** Working directory; used for static mode and the exit reset. */
  cwd: string;
  /** Writes the terminal window title (OSC 0). */
  setTitle: (title: string) => void;
  /**
   * Runs a utility-model completion and returns the raw model text, or null
   * when generation is unavailable (no agent / no key / offline).
   */
  complete: (context: TitleCompletionContext) => Promise<string | null>;
  /** Optional error sink for diagnostics; never user-facing. */
  onError?: (error: unknown) => void;
  /** Completed user turns between regenerations. Default 5. */
  cadence?: number;
  /** Recent prompts (besides the first) fed to the model. Default 5. */
  recentWindow?: number;
}

const DEFAULT_CADENCE = 5;
const DEFAULT_RECENT_WINDOW = 5;
const MAX_TITLE_LENGTH = 40;
/** Cap each prompt fed to the model to keep the utility call cheap. */
const MAX_PROMPT_CHARS = 300;

/** All C0 (0x00-0x1f), DEL (0x7f), and C1 (0x80-0x9f) control characters. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');

const TITLE_SYSTEM_PROMPT = [
  'You generate a very short title for a terminal tab that summarizes what the',
  'user is working on in a coding session.',
  '',
  'Rules:',
  '- 3 to 6 words.',
  '- Use noun phrases or verb phrases. Do not use adjectives.',
  '- No punctuation, no quotes, no trailing period.',
  '- Describe the work, not the tool. Examples: "Refactor auth middleware",',
  '  "Debug websocket reconnect", "Add billing webhooks".',
  '- Output only the title text and nothing else.',
].join('\n');

/**
 * Sanitize model output before it is written into an OSC escape sequence.
 *
 * This is a security boundary: ProcessTerminal.setTitle interpolates the string
 * directly into `ESC ] 0 ; <title> BEL`, so any ESC/BEL/control byte in the
 * model output could break out of or hijack the sequence. We strip all C0/C1
 * control characters (including ESC and BEL) plus DEL, drop wrapping quotes and
 * a trailing period the model may add, collapse whitespace, and clamp length.
 */
export function sanitizeTitle(raw: string, maxLength = MAX_TITLE_LENGTH): string {
  if (!raw) return '';
  // Replace every control character with a space so nothing can terminate or
  // inject into the OSC sequence.
  let s = raw.replace(CONTROL_CHARS, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // Strip wrapping quotes/backticks the model sometimes adds.
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
  // Drop a trailing period.
  s = s.replace(/[.]+$/g, '').trim();
  if (s.length > maxLength) {
    s = s.slice(0, maxLength - 1).trimEnd() + '…';
  }
  return s;
}

function truncatePrompt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_PROMPT_CHARS) return trimmed;
  return trimmed.slice(0, MAX_PROMPT_CHARS).trimEnd() + '…';
}

export class TitleManager {
  private readonly mode: TerminalTitleMode;
  private readonly cwd: string;
  private readonly setTitleFn: (title: string) => void;
  private readonly completeFn: (context: TitleCompletionContext) => Promise<string | null>;
  private readonly onError?: (error: unknown) => void;
  private readonly cadence: number;
  private readonly recentWindow: number;

  private firstPrompt: string | null = null;
  private recentPrompts: string[] = [];
  private currentTitle: string | null = null;
  private turnsSinceGen = 0;
  private generating = false;
  private dirty = false;
  private disposed = false;
  /**
   * Bumped on reset so an in-flight generation started before the reset cannot
   * apply its (now stale) title afterward.
   */
  private epoch = 0;

  constructor(options: TitleManagerOptions) {
    this.mode = options.mode;
    this.cwd = options.cwd;
    this.setTitleFn = options.setTitle;
    this.completeFn = options.complete;
    this.onError = options.onError;
    this.cadence = Math.max(1, options.cadence ?? DEFAULT_CADENCE);
    this.recentWindow = Math.max(1, options.recentWindow ?? DEFAULT_RECENT_WINDOW);
  }

  /** Call once at session start. In static mode this sets the cwd-based title. */
  start(): void {
    if (this.disposed || this.mode !== 'static') return;
    this.applyTitle(sanitizeTitle(path.basename(this.cwd)));
  }

  /**
   * Record a genuine user-typed prompt. Slash commands are already filtered out
   * upstream. The first prompt triggers an immediate title generation.
   */
  recordUserPrompt(text: string): void {
    if (this.disposed || this.mode !== 'dynamic') return;
    const trimmed = text.trim();
    if (!trimmed) return;

    const isFirst = this.firstPrompt === null;
    if (isFirst) this.firstPrompt = trimmed;

    this.recentPrompts.push(trimmed);
    if (this.recentPrompts.length > this.recentWindow) {
      this.recentPrompts.shift();
    }

    if (isFirst) {
      void this.regenerate();
    }
  }

  /** Call on each completed user turn (agent.onLoopComplete). */
  onUserTurnComplete(): void {
    if (this.disposed || this.mode !== 'dynamic') return;
    this.turnsSinceGen += 1;
    if (this.turnsSinceGen >= this.cadence) {
      void this.regenerate();
    }
  }

  /**
   * Reset on a fresh-start signal (e.g. /clear). Drops the captured prompts and
   * title so the next prompt is treated as a new first message, and neutralizes
   * any in-flight generation. In dynamic mode the tab is reset to the cwd
   * basename until the next prompt names it again; currentTitle is cleared so
   * the next generation has no stale hysteresis anchor.
   */
  reset(): void {
    if (this.disposed || this.mode === 'off') return;
    this.epoch += 1;
    this.firstPrompt = null;
    this.recentPrompts = [];
    this.currentTitle = null;
    this.turnsSinceGen = 0;
    this.dirty = false;
    if (this.mode === 'dynamic') {
      try {
        this.setTitleFn(sanitizeTitle(path.basename(this.cwd)));
      } catch (err) {
        this.onError?.(err);
      }
    }
  }

  /**
   * Reset the title on exit. OSC has no portable way to read the user's
   * original title, so we reset to the cwd basename and let the shell prompt
   * reclaim the tab on its next render rather than leaving a stale title.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.mode === 'off') return;
    try {
      this.setTitleFn(sanitizeTitle(path.basename(this.cwd)));
    } catch {
      // Best-effort; never throw during shutdown.
    }
  }

  /** The title currently applied, for tests and diagnostics. */
  getCurrentTitle(): string | null {
    return this.currentTitle;
  }

  private async regenerate(): Promise<void> {
    if (this.disposed || this.mode !== 'dynamic' || this.firstPrompt === null) return;
    // Single-flight: if a request is already in flight, mark dirty and let the
    // current run kick off one more pass when it finishes.
    if (this.generating) {
      this.dirty = true;
      return;
    }
    this.generating = true;
    this.turnsSinceGen = 0;
    const epoch = this.epoch;
    try {
      const messages = this.buildMessages();
      const raw = await this.safeComplete(messages);
      // Bail if disposed, reset since this run started, or no output.
      if (this.disposed || this.epoch !== epoch || raw === null) return;
      const title = sanitizeTitle(raw);
      if (title && title !== this.currentTitle) {
        this.applyTitle(title);
      }
    } finally {
      this.generating = false;
      if (this.dirty && !this.disposed && this.epoch === epoch) {
        this.dirty = false;
        void this.regenerate();
      }
    }
  }

  private buildMessages(): Array<{ role: string; content: string }> {
    const first = this.firstPrompt!;
    const recent = this.recentPrompts.filter((p) => p !== first);

    const lines: string[] = [`First request: ${truncatePrompt(first)}`];
    if (recent.length > 0) {
      lines.push('', 'Recent messages:');
      for (const p of recent) lines.push(`- ${truncatePrompt(p)}`);
    }
    if (this.currentTitle) {
      lines.push(
        '',
        `Current tab title: "${this.currentTitle}"`,
        'If the focus is unchanged, repeat that title exactly. Only produce a new title if the work has clearly shifted.',
      );
    }
    return [{ role: 'user', content: lines.join('\n') }];
  }

  private async safeComplete(
    messages: Array<{ role: string; content: string }>,
  ): Promise<string | null> {
    try {
      return await this.completeFn({ systemPrompt: TITLE_SYSTEM_PROMPT, messages });
    } catch (err) {
      this.onError?.(err);
      return null;
    }
  }

  private applyTitle(title: string): void {
    if (!title) return;
    this.currentTitle = title;
    try {
      this.setTitleFn(title);
    } catch (err) {
      this.onError?.(err);
    }
  }
}
