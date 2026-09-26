/**
 * ReasonerRunTracker: the one answer to "is the reasoner running, and since
 * when" in a duplex session.
 *
 * Two different facts go by "run", and conflating them is how a status line
 * ends up saying "working" through a retry backoff or a watchdog stays quiet
 * while it should not:
 *
 * - the LOGICAL run: a prompt in flight on the reasoner, from the first
 *   attempt to the last, backoffs included. Read through the loop's own
 *   `isPrompting`, never mirrored here.
 * - an ATTEMPT: one pass of pi's agent loop. pi emits agent_start and
 *   agent_end once per attempt, so a logical run that retries spans several
 *   attempts, with backoff gaps between them where no attempt is live.
 *
 * Main-loop events only: a sub-agent's loop_start is not the reasoner
 * starting.
 */

import type { AgentLoop } from '../agent-loop.js';
import type { CortexEvent } from '../event-bridge.js';

/** One live attempt. `id` increases by one per attempt, session-wide. */
export interface ReasonerAttempt {
  readonly id: number;
  readonly startedAt: number;
}

export class ReasonerRunTracker {
  private readonly reasoner: AgentLoop;
  private readonly now: () => number;
  private current: ReasonerAttempt | null = null;
  private endedAt: number | null = null;
  private attempts = 0;
  private readonly startListeners: Array<(attempt: ReasonerAttempt) => void> = [];
  private readonly endListeners: Array<(event: CortexEvent) => void> = [];

  constructor(reasoner: AgentLoop, now: () => number = Date.now) {
    this.reasoner = reasoner;
    this.now = now;
    const bridge = reasoner.getEventBridge();
    bridge.on('loop_start', (event) => {
      if (event.childTaskId) return;
      this.attempts += 1;
      const attempt = { id: this.attempts, startedAt: this.now() };
      this.current = attempt;
      for (const listener of this.startListeners) listener(attempt);
    });
    bridge.on('loop_end', (event) => {
      if (event.childTaskId) return;
      this.current = null;
      this.endedAt = this.now();
      for (const listener of this.endListeners) listener(event);
    });
  }

  /** Whether a logical run is in flight (backoffs between attempts included). */
  logicalRunActive(): boolean {
    return this.reasoner.isPrompting;
  }

  /** The live attempt, or null between attempts and runs. */
  attempt(): ReasonerAttempt | null {
    return this.current;
  }

  /** Id of the latest attempt to start (0 before the first). */
  get latestAttemptId(): number {
    return this.attempts;
  }

  /** When the last attempt ended, or null before any has. */
  lastEndedAt(): number | null {
    return this.endedAt;
  }

  /** Runs after the attempt is recorded, in registration order. */
  onAttemptStart(listener: (attempt: ReasonerAttempt) => void): void {
    this.startListeners.push(listener);
  }

  /** Runs after the attempt is closed, in registration order. */
  onAttemptEnd(listener: (event: CortexEvent) => void): void {
    this.endListeners.push(listener);
  }
}
