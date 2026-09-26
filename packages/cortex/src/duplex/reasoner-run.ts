/**
 * ReasonerRunTracker: the one answer to "is the reasoner running, and since
 * when" in a duplex session, read through the reasoner loop's own run
 * lifecycle (AgentLoop.currentRun), never reconstructed here.
 *
 * Two different facts go by "run", and conflating them is how a status line
 * ends up saying "working" through a retry backoff or a watchdog stays quiet
 * while it should not:
 *
 * - the LOGICAL run: a prompt in flight on the reasoner, from the first
 *   attempt to the last, backoffs included (currentRun is non-null).
 * - an ATTEMPT: one pass of pi's agent loop. A logical run that retries
 *   spans several attempts, with backoff gaps between them where no attempt
 *   is live (currentRun.attemptStartedAt is null).
 *
 * The only thing taken from events is the moment an attempt starts and
 * ends, which is when pi emits agent_start and agent_end, so listeners run
 * exactly at those boundaries. Main-loop events only: a sub-agent's
 * loop_start is not the reasoner starting.
 */

import type { LoopEventApi, LoopRunApi } from '../agent-loop.js';
import type { CortexEvent } from '../event-bridge.js';

/** One live attempt of one logical run. */
export interface ReasonerAttempt {
  readonly runId: number;
  /** 1-based within its run. */
  readonly attempt: number;
  readonly startedAt: number;
}

export class ReasonerRunTracker {
  private readonly reasoner: LoopRunApi & LoopEventApi;
  private readonly startListeners: Array<(attempt: ReasonerAttempt) => void> = [];
  private readonly endListeners: Array<(event: CortexEvent) => void> = [];

  constructor(reasoner: LoopRunApi & LoopEventApi) {
    this.reasoner = reasoner;
    const bridge = reasoner.getEventBridge();
    bridge.on('loop_start', (event) => {
      if (event.childTaskId) return;
      const attempt = this.attempt();
      if (!attempt) return;
      for (const listener of this.startListeners) listener(attempt);
    });
    bridge.on('loop_end', (event) => {
      if (event.childTaskId) return;
      for (const listener of this.endListeners) listener(event);
    });
  }

  /** Whether a logical run is in flight (backoffs between attempts included). */
  logicalRunActive(): boolean {
    return this.reasoner.currentRun !== null;
  }

  /** The id of the logical run in flight, or null. */
  runId(): number | null {
    return this.reasoner.currentRun?.id ?? null;
  }

  /** The live attempt, or null between attempts and runs. */
  attempt(): ReasonerAttempt | null {
    const run = this.reasoner.currentRun;
    if (!run || run.attemptStartedAt === null) return null;
    return { runId: run.id, attempt: run.attempt, startedAt: run.attemptStartedAt };
  }

  /**
   * A key naming the current attempt ('3:2' is run 3, attempt 2), or
   * 'idle' between runs. Bounds on per-attempt log noise reset when it
   * changes.
   */
  attemptKey(): string {
    const run = this.reasoner.currentRun;
    return run ? `${run.id}:${run.attempt}` : 'idle';
  }

  /** When the last logical run ended, or null before any has. */
  lastEndedAt(): number | null {
    return this.reasoner.lastRunEndedAt;
  }

  /** Runs once the attempt is live, in registration order. */
  onAttemptStart(listener: (attempt: ReasonerAttempt) => void): void {
    this.startListeners.push(listener);
  }

  /** Runs as the attempt ends (its loop_end), in registration order. */
  onAttemptEnd(listener: (event: CortexEvent) => void): void {
    this.endListeners.push(listener);
  }
}
