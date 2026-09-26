/**
 * LogRecorder: the facade's session log and the producers that write it
 * (docs/cortex/duplex/log-and-context.md).
 *
 * The log is the durable, ordered record of a composite session: every
 * utterance, reply, directive, delivery and lifecycle fact. Producers are
 * additive handlers on the loops (a loop keeps handler arrays), so consumer
 * handlers and their signatures are untouched and passthrough parity holds.
 */

import type { AgentLoop } from '../agent-loop.js';
import type {
  AgentTextOutput,
  ClassifiedError,
  CortexLogger,
  DeadLetteredBackgroundResult,
  LoopOriginContext,
  PersistResultFn,
  RetryScheduledInfo,
} from '../types.js';
import { SessionLog } from '../session-log.js';
import type { SessionLogEntry, WakeClass } from '../session-log.js';
import { errorMessageOf } from '../error-classifier.js';
import { latestCauseSeq } from '../duplex/cause-tags.js';
import type { CausationSource } from '../duplex/cause-tags.js';
import type { CortexSessionLogConfig } from './config.js';

/** One entry as a producer hands it over; causation is optional. */
export interface LogEntryInput {
  type: SessionLogEntry['type'];
  loopPath: string;
  content: string;
  /**
   * The causing entry's seq. Omitted: stamped from the live run of the
   * producing surface. Null: deliberately unstamped (nobody's turn caused
   * it, and the fallback would attach it to whatever run happened to be
   * live).
   */
  causedBy?: number | null;
  wake?: WakeClass;
  data?: Record<string, unknown>;
}

export interface LogRecorderOptions {
  /** Retention and subscriber buffering (the consumer's sessionLog config). */
  sessionLog?: CortexSessionLogConfig | undefined;
  /** The session's causation, for stamping entries that bring none. */
  causation: CausationSource;
  /**
   * Entries from this loop path belong to the conversation surface; every
   * other producer's (the work loop, its sub-agents, lookups) to the work
   * surface.
   */
  conversationLoopPath: string;
  /** Spill sink for retention-evicted entries (the consumer's persistResult). */
  persistResult?: PersistResultFn | undefined;
  /** Loop path the spill is attributed to. */
  spillLoopPath: string;
  logger: CortexLogger;
}

export class LogRecorder {
  readonly log: SessionLog;
  private readonly options: LogRecorderOptions;
  /** Spawn lifecycle seq per live task, for completion causation. */
  private readonly spawnSeqByTaskId = new Map<string, number>();
  private readonly appendListeners: Array<(entry: SessionLogEntry) => void> = [];

  constructor(options: LogRecorderOptions) {
    this.options = options;
    const { maxEntries, maxSubscriberBuffer } = options.sessionLog ?? {};
    this.log = new SessionLog({
      ...(maxEntries !== undefined ? { maxEntries } : {}),
      ...(maxSubscriberBuffer !== undefined ? { maxSubscriberBuffer } : {}),
      logger: options.logger,
      onEvict: (evicted) => this.spillEvictedEntries(evicted),
    });
  }

  /**
   * Append a log entry, stamping causation from the live run of the
   * producing surface unless the caller supplies (or suppresses, with null)
   * its own.
   */
  append(input: LogEntryInput): SessionLogEntry {
    const surface = input.loopPath === this.options.conversationLoopPath ? 'conversation' : 'work';
    const fallback = latestCauseSeq(this.options.causation.tags(surface));
    const causedBy = input.causedBy === null
      ? undefined
      : input.causedBy ?? fallback ?? undefined;
    const entry = this.log.append({
      type: input.type,
      loopPath: input.loopPath,
      content: input.content,
      ...(causedBy !== undefined ? { causedBy } : {}),
      ...(input.wake !== undefined ? { wake: input.wake } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    });
    for (const listener of this.appendListeners) listener(entry);
    return entry;
  }

  /**
   * Append an entry whose producer states its own causation (the router,
   * the broker): an absent cause means none, never the live run's guess.
   * Returns the entry's seq.
   */
  appendAttributed(input: Omit<LogEntryInput, 'causedBy'> & { causedBy?: number | undefined }): number {
    return this.append({ ...input, causedBy: input.causedBy ?? null }).seq;
  }

  /** Run after every append, in registration order. */
  onAppend(listener: (entry: SessionLogEntry) => void): void {
    this.appendListeners.push(listener);
  }

  /**
   * `reply` entries from a loop's completed turns: the conversation
   * surface. `afterReply` runs once the entry is written, with the raw
   * user-facing text.
   */
  wireConversation(loop: AgentLoop, afterReply?: (text: string) => void): void {
    loop.onTurnComplete((output: AgentTextOutput, origin: LoopOriginContext) => {
      if (output.userFacing.trim().length === 0) return;
      this.append({
        type: 'reply',
        loopPath: origin.loopPath,
        content: output.userFacing,
      });
      afterReply?.(output.userFacing);
    });
  }

  /** Error and retry entries for one loop (both loops in duplex). */
  wireErrors(loop: AgentLoop): void {
    loop.onError((error: ClassifiedError, origin: LoopOriginContext) => {
      this.append({
        type: 'error',
        loopPath: origin.loopPath,
        content: error.originalMessage,
        data: {
          category: error.category,
          severity: error.severity,
          ...(error.causeDetail !== undefined ? { causeDetail: error.causeDetail } : {}),
        },
      });
    });

    loop.onRetryScheduled((info: RetryScheduledInfo) => {
      this.append({
        type: 'retrying',
        loopPath: loop.loopPath,
        content: info.originalMessage,
        data: {
          category: info.category,
          attempt: info.attempt,
          maxAttempts: info.maxAttempts,
          delayMs: info.delayMs,
          nextAttemptAt: info.nextAttemptAt,
        },
      });
    });
  }

  /** Sub-agent lifecycle and dead-letter entries (the work surface). */
  wireWork(loop: AgentLoop): void {
    loop.onSubAgentSpawned((taskId, instructions, background) => {
      const entry = this.append({
        type: 'lifecycle',
        loopPath: loop.loopPath,
        content: `Sub-agent ${taskId} spawned`,
        data: {
          event: 'sub_agent_spawned',
          taskId,
          background,
          instructions,
        },
      });
      this.spawnSeqByTaskId.set(taskId, entry.seq);
    });

    loop.onSubAgentCompleted((taskId, _result, status) => {
      const spawnSeq = this.spawnSeqByTaskId.get(taskId);
      this.spawnSeqByTaskId.delete(taskId);
      this.append({
        type: 'lifecycle',
        loopPath: loop.loopPath,
        content: `Sub-agent ${taskId} ${status}`,
        data: { event: 'sub_agent_completed', taskId, status },
        ...(spawnSeq !== undefined ? { causedBy: spawnSeq } : {}),
      });
    });

    loop.onSubAgentFailed((taskId, error) => {
      const spawnSeq = this.spawnSeqByTaskId.get(taskId);
      this.spawnSeqByTaskId.delete(taskId);
      // SubAgentManager.cancel fires the loop's onSubAgentFailed hook with
      // 'Cancelled' (the consumer callback contract keeps that shape), but
      // the log is the durable record the duplex router reads, and
      // log-and-context.md lists cancellations as their own milestone, not
      // failures. The manager marks the ID cancelled before any hook fires,
      // so this discriminator is reliable, unlike matching the error text.
      const manager = loop.getSubAgentManager();
      if (manager.isCancelled(taskId)) {
        this.append({
          type: 'lifecycle',
          loopPath: loop.loopPath,
          content: `Sub-agent ${taskId} cancelled`,
          // reason distinguishes an explicit cancel from a shutdown
          // teardown; the delivery router keys on it.
          data: {
            event: 'sub_agent_cancelled',
            taskId,
            reason: manager.cancellationReason(taskId),
          },
          ...(spawnSeq !== undefined ? { causedBy: spawnSeq } : {}),
        });
        return;
      }
      this.append({
        type: 'lifecycle',
        loopPath: loop.loopPath,
        content: `Sub-agent ${taskId} failed: ${error}`,
        data: { event: 'sub_agent_failed', taskId, error },
        ...(spawnSeq !== undefined ? { causedBy: spawnSeq } : {}),
      });
    });

    this.wireDeadLetters(loop);
  }

  /**
   * Dead-letter entries for one loop. Background-completion drops come
   * from the reasoner; wake-delivery drops can come from either resident
   * loop (duplex wires the talker too), and without a lifecycle entry for
   * those the session log would show a user utterance with no reply and
   * nothing saying why. `afterEntry` runs once the entry is written.
   */
  wireDeadLetters(
    loop: AgentLoop,
    afterEntry?: (result: DeadLetteredBackgroundResult) => void,
  ): void {
    loop.onBackgroundResultDeadLettered((result: DeadLetteredBackgroundResult) => {
      this.append({
        type: 'lifecycle',
        loopPath: loop.loopPath,
        content: result.kind === 'wake_delivery'
          ? (result.attempts > 0
              ? `Wake delivery dropped after ${result.attempts} failed carrying runs`
              : `Wake delivery dropped: ${result.lastError}`)
          : result.kind === 'silent_delivery'
            ? `Silent delivery dropped: ${result.lastError}`
            : `Background ${result.kind} ${result.taskId} delivery dead-lettered after ${result.attempts} attempts`,
        data: {
          event: 'delivery_dead_lettered',
          kind: result.kind,
          taskId: result.taskId,
          attempts: result.attempts,
          lastError: result.lastError,
          // The FULL destroyed content, not a preview: in duplex the router
          // owns delivery and the session log is the durable record of
          // undelivered content, so a truncated copy here would make the
          // in-memory dead-letter store (which does not survive the
          // process) the only complete record.
          ...(result.kind === 'wake_delivery' || result.kind === 'silent_delivery'
            ? { message: result.message }
            : {}),
        },
      });
      afterEntry?.(result);
    });
  }

  /**
   * Record loop-queued content (silent deliveries, parked wake content, in
   * queue order as clearAllQueues returns it) destroyed by a facade abort
   * or restore. Without this the dropped content is unrecoverable AND
   * unrecorded: clearAllQueues returns it for re-routing and the facade is
   * the only caller in a position to preserve it (the loop-level abort
   * dead-letter path never sees content the facade already cleared).
   */
  recordDroppedQueue(loop: AgentLoop, reason: 'abort' | 'restore', dropped: string[]): void {
    if (dropped.length === 0) return;
    this.append({
      type: 'lifecycle',
      loopPath: loop.loopPath,
      content: `${dropped.length} queued item(s) dropped by ${reason}`,
      data: { event: 'queued_content_dropped', reason, items: dropped },
      causedBy: null,
    });
  }

  /** Forget per-session producer state (the log itself restores separately). */
  resetForRestore(): void {
    this.spawnSeqByTaskId.clear();
  }

  /** Teardown: drop the log's subscribers. */
  destroy(): void {
    this.log.clearSubscribers();
  }

  /** Spill retention-evicted entries through persistResult when configured. */
  private spillEvictedEntries(evicted: SessionLogEntry[]): void {
    const persist = this.options.persistResult;
    if (!persist) return;
    const payload = evicted.map((entry) => JSON.stringify(entry)).join('\n');
    void persist(payload, {
      toolName: '_session_log',
      category: 'non-reproducible',
      loopPath: this.options.spillLoopPath,
    }).catch((err: unknown) => {
      this.options.logger.warn('session log spill failed', {
        error: errorMessageOf(err),
        entries: evicted.length,
      });
    });
  }
}
