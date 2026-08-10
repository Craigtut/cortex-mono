/**
 * QuickLookupManager: the facade's ephemeral read-only lookup fleet
 * (decisions.md D13, docs/cortex/duplex/sub-agents.md "Quick Lookups").
 *
 * The talker's `quick_lookup` control tool answers small standalone factual
 * questions without waiting on the reasoner's turn boundary. Each accepted
 * lookup spawns one ephemeral AgentLoop (fast model, Read/Grep/Glob only,
 * in-tool path allowlist rooted at the working directory, inherited sandbox,
 * broker-gated permissions) with a wall-clock timeout and a small
 * concurrency cap of its own, so a busy task fleet can never starve lookups
 * and a lookup burst can never starve tasks.
 *
 * Outcomes (including timeouts and failures, which must be visible rather
 * than silent) are reported through the `onOutcome` port; the facade routes
 * them to the router, which appends the durable `lookup_result` log entry,
 * wakes the talker, and joins the result into the reasoner's conversation
 * deltas (shared context, D13). Cancelled lookups report `cancelled` and are
 * logged but never delivered.
 */

import type { AgentLoop } from '../agent-loop.js';
import type { CortexLogger, SessionUsage } from '../types.js';
import { NOOP_LOGGER } from '../noop-logger.js';
import { stripWorkingTags } from '../working-tags.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuickLookupStatus = 'completed' | 'timed_out' | 'failed' | 'cancelled';

/** Terminal report for one lookup. */
export interface QuickLookupOutcome {
  alias: string;
  question: string;
  status: QuickLookupStatus;
  /** Final user-facing answer (working tags stripped); empty unless completed. */
  answer: string;
  /** Error detail for 'failed'. */
  error?: string;
  /** Log seq of the quick_lookup directive, for causation stamping. */
  causeSeq: number | null;
  durationMs: number;
}

/** What the manager needs from the facade. */
export interface QuickLookupPorts {
  /**
   * Build the ephemeral lookup loop. The facade owns the config (model,
   * allowlist, sandbox, brokered permissions) and any event forwarding onto
   * its merged bridge; `cleanup` runs after the lookup settles, before the
   * loop is destroyed.
   */
  createLoop(alias: string): Promise<{ loop: AgentLoop; cleanup?: () => void }>;
  /** Receive a terminal outcome. Errors are swallowed and logged. */
  onOutcome(outcome: QuickLookupOutcome): void;
  logger?: CortexLogger;
}

export interface QuickLookupOptions {
  /** Concurrent lookup cap (the separate small pool). Default: 2. */
  maxConcurrent?: number;
  /** Wall-clock timeout per lookup in ms. Default: 30000. */
  timeoutMs?: number;
}

export const QUICK_LOOKUP_DEFAULTS = {
  maxConcurrent: 2,
  timeoutMs: 30_000,
} as const;

export type QuickLookupRequestResult =
  | { accepted: true; alias: string }
  | { accepted: false; reason: string };

interface ActiveLookup {
  alias: string;
  question: string;
  causeSeq: number | null;
  startedAt: number;
  loop: AgentLoop | null;
  cancelled: boolean;
  /** Resolves when the lookup has fully settled (loop destroyed, outcome emitted). */
  completion: Promise<void>;
}

/** Text of the last assistant message in a loop's history, tags stripped. */
function extractAnswer(loop: AgentLoop): string {
  const history = loop.getConversationHistory();
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i] as unknown as { role?: string; content?: unknown };
    if (message?.role !== 'assistant') continue;
    const content = message.content;
    let raw = '';
    if (typeof content === 'string') {
      raw = content;
    } else if (Array.isArray(content)) {
      raw = content
        .filter((block): block is { type: string; text: string } =>
          (block as { type?: string } | null)?.type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string')
        .map((block) => block.text)
        .join('');
    }
    const stripped = stripWorkingTags(raw).trim();
    if (stripped.length > 0) return stripped;
  }
  return '';
}

// ---------------------------------------------------------------------------
// QuickLookupManager
// ---------------------------------------------------------------------------

export class QuickLookupManager {
  private readonly ports: QuickLookupPorts;
  private readonly logger: CortexLogger;
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;

  private readonly active = new Map<string, ActiveLookup>();
  private nextAliasNumber = 1;
  private idleWaiters: Array<() => void> = [];
  /** Accumulated spend of settled lookups (live loops report via events). */
  private settledUsage: SessionUsage = {
    totalCost: 0,
    totalTurns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  private destroyed = false;

  constructor(ports: QuickLookupPorts, options?: QuickLookupOptions) {
    this.ports = ports;
    this.logger = ports.logger ?? NOOP_LOGGER;
    this.maxConcurrent = options?.maxConcurrent ?? QUICK_LOOKUP_DEFAULTS.maxConcurrent;
    this.timeoutMs = options?.timeoutMs ?? QUICK_LOOKUP_DEFAULTS.timeoutMs;
  }

  /** Number of lookups not yet settled. */
  get activeCount(): number {
    return this.active.size;
  }

  /** Total spend of lookups that have settled (facade usage aggregate). */
  getSettledUsage(): SessionUsage {
    return {
      totalCost: this.settledUsage.totalCost,
      totalTurns: this.settledUsage.totalTurns,
      tokens: { ...this.settledUsage.tokens },
    };
  }

  /**
   * Start a lookup. Synchronous verdict: the cap refusal must reach the
   * talker's receipt in the same dispatch, never as a later surprise.
   */
  request(question: string, causeSeq: number | null): QuickLookupRequestResult {
    if (this.destroyed) {
      return { accepted: false, reason: 'shutting down' };
    }
    if (this.active.size >= this.maxConcurrent) {
      return {
        accepted: false,
        reason: `lookup limit reached (${this.active.size}/${this.maxConcurrent} running)`,
      };
    }
    const alias = `lk-${this.nextAliasNumber++}`;
    const entry: ActiveLookup = {
      alias,
      question,
      causeSeq,
      startedAt: Date.now(),
      loop: null,
      cancelled: false,
      completion: Promise.resolve(),
    };
    this.active.set(alias, entry);
    entry.completion = this.run(entry).catch((err) => {
      // run() reports every outcome itself; this catch only guards the
      // bookkeeping so a bug cannot strand the entry as forever-active.
      this.logger.error('quick lookup run threw past its own handling', {
        alias,
        error: err instanceof Error ? err.message : String(err),
      });
    }).finally(() => {
      this.active.delete(alias);
      this.notifyIfIdle();
    });
    return { accepted: true, alias };
  }

  /**
   * Cancel every active lookup (facade abort scope 'conversation'/'all',
   * restore, teardown). Resolves when all cancelled lookups have settled.
   */
  async cancelAll(): Promise<void> {
    const entries = [...this.active.values()];
    for (const entry of entries) {
      entry.cancelled = true;
      if (entry.loop) {
        void entry.loop.abort().catch(() => {});
      }
    }
    await Promise.all(entries.map((entry) => entry.completion));
  }

  /** Resolves once no lookup is active. */
  waitForIdle(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Cancel everything and refuse new lookups. Idempotent. */
  async destroy(): Promise<void> {
    if (this.destroyed) {
      await this.waitForIdle();
      return;
    }
    this.destroyed = true;
    await this.cancelAll();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async run(entry: ActiveLookup): Promise<void> {
    let loop: AgentLoop;
    let cleanup: (() => void) | undefined;
    try {
      const created = await this.ports.createLoop(entry.alias);
      loop = created.loop;
      cleanup = created.cleanup;
    } catch (err) {
      this.emitOutcome(entry, 'failed', '', err);
      return;
    }
    entry.loop = loop;

    // A cancelAll that raced loop creation: tear down without running.
    if (entry.cancelled) {
      cleanup?.();
      await loop.destroy().catch(() => {});
      this.emitOutcome(entry, 'cancelled', '');
      return;
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.logger.warn('quick lookup wall-clock timeout', {
        alias: entry.alias,
        timeoutMs: this.timeoutMs,
      });
      void loop.abort().catch(() => {});
    }, this.timeoutMs);
    timer.unref?.();

    let answer = '';
    let failure: unknown = null;
    try {
      await loop.prompt(entry.question);
      answer = extractAnswer(loop);
    } catch (err) {
      failure = err;
    } finally {
      clearTimeout(timer);
      cleanup?.();
      this.accumulateUsage(loop);
      await loop.destroy().catch(() => {});
    }

    if (entry.cancelled) {
      this.emitOutcome(entry, 'cancelled', '');
    } else if (timedOut) {
      // An aborted run can settle by resolving or rejecting; the timeout
      // flag decides, not the settle path (mirroring runSubAgent).
      this.emitOutcome(entry, 'timed_out', answer);
    } else if (failure !== null) {
      this.emitOutcome(entry, 'failed', '', failure);
    } else {
      this.emitOutcome(entry, 'completed', answer);
    }
  }

  private accumulateUsage(loop: AgentLoop): void {
    try {
      const usage = loop.getSessionUsage();
      this.settledUsage.totalCost += usage.totalCost;
      this.settledUsage.totalTurns += usage.totalTurns;
      this.settledUsage.tokens.input += usage.tokens.input;
      this.settledUsage.tokens.output += usage.tokens.output;
      this.settledUsage.tokens.cacheRead += usage.tokens.cacheRead;
      this.settledUsage.tokens.cacheWrite += usage.tokens.cacheWrite;
    } catch {
      // A loop torn down mid-read loses its (small) spend from the
      // aggregate; never from the budget guard, which saw the live events.
    }
  }

  private emitOutcome(
    entry: ActiveLookup,
    status: QuickLookupStatus,
    answer: string,
    error?: unknown,
  ): void {
    const outcome: QuickLookupOutcome = {
      alias: entry.alias,
      question: entry.question,
      status,
      answer,
      causeSeq: entry.causeSeq,
      durationMs: Date.now() - entry.startedAt,
      ...(error !== undefined && error !== null
        ? { error: error instanceof Error ? error.message : String(error) }
        : {}),
    };
    try {
      this.ports.onOutcome(outcome);
    } catch (err) {
      this.logger.error('quick lookup outcome handler threw', {
        alias: entry.alias,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private notifyIfIdle(): void {
    if (this.active.size > 0 || this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
