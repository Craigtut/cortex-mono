/**
 * Whether the agent as a whole is busy, and when it stops being busy.
 *
 * Busy means any resident loop running, a sub-agent alive, a delivery parked,
 * an ask pending. It drives the spinner, the abort gate and the MCP reload
 * gate.
 *
 * Deliberately NOT keyed on `onLoopComplete`. That callback fans out to every
 * resident loop and carries no origin, so under duplex the talker's
 * sub-second turn would report the whole agent idle while the reasoner is
 * still working: the spinner would vanish and Ctrl+C would become a no-op for
 * the rest of a multi-minute run. It is keyed on the facade's `workSettled`
 * predicate instead.
 */

import type { CortexAgent } from '@animus-labs/cortex';
import type { FreezeDiagnostics } from '../diagnostics/freeze.js';
import { log } from '../logger.js';

export type WorkAgent = Pick<CortexAgent, 'waitForWorkSettled' | 'workSettled' | 'state'>;

export interface WorkTrackerDeps {
  getAgent: () => WorkAgent | null;
  freezeDiagnostics: Pick<FreezeDiagnostics, 'setSessionRunning'>;
  /** The end-of-work UI, applied once per settled exchange. */
  onSettled: () => void;
}

export class WorkTracker {
  /** True while the agent as a whole is busy. */
  private running = false;
  /**
   * True from the moment a turn is committed until its `prompt()` settles.
   * Conversation-scoped, unlike {@link isRunning}: it covers the pre-prompt
   * window (ephemeral context, pre_turn hooks) that the facade cannot see, so
   * a second input arriving in it still steers.
   */
  private promptPending = false;
  /**
   * Bumped whenever new work starts. A settlement wait that spans a bump is
   * stale (the user started something else) and re-waits instead of
   * reporting idle.
   */
  private generation = 0;
  /** Guards against stacking settlement waiters; one is enough. */
  private watcherActive = false;

  constructor(private readonly deps: WorkTrackerDeps) {}

  get isRunning(): boolean { return this.running; }
  get promptInFlight(): boolean { return this.promptPending; }

  /** A user turn is committed: busy, and inside the pre-prompt window. */
  beginPrompt(): void {
    this.promptPending = true;
    this.begin();
  }

  /** The turn's `prompt()` settled; the agent may well still be working. */
  endPrompt(): void {
    this.promptPending = false;
  }

  /**
   * Mark the agent busy for a newly started piece of work. Bumping the
   * generation invalidates any settlement wait already in flight, so work
   * that starts while the previous wait is resolving cannot be reported as
   * idle by it.
   */
  begin(): void {
    this.generation += 1;
    this.running = true;
    this.deps.freezeDiagnostics.setSessionRunning(true);
  }

  /** Drop the busy state without waiting for settlement (abort, settle). */
  markIdle(): void {
    this.running = false;
    this.promptPending = false;
    this.deps.freezeDiagnostics.setSessionRunning(false);
  }

  /**
   * Arm (once) a wait for the whole agent to go quiet, and apply the
   * end-of-work UI when it does.
   */
  watchForSettled(): void {
    if (this.watcherActive) return;
    this.watcherActive = true;
    void this.awaitSettled()
      .then((settled) => {
        if (!settled) return;
        this.markIdle();
        this.deps.onSettled();
      })
      .catch((err: unknown) => {
        log.debug('Work settlement wait failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.watcherActive = false;
      });
  }

  /**
   * Resolve true once the agent as a whole is quiet. Resolves false when the
   * verdict no longer belongs to this session (the agent was replaced or
   * torn down), so the caller leaves the UI alone.
   */
  private async awaitSettled(): Promise<boolean> {
    const agent = this.deps.getAgent();
    if (!agent) return false;
    for (;;) {
      const generation = this.generation;
      await agent.waitForWorkSettled();
      if (this.deps.getAgent() !== agent) return false;
      // A destroyed agent is as settled as it will ever get; without this a
      // prompt() that rejected on teardown would leave the spinner up.
      if (agent.state === 'destroyed' || agent.state === 'destroying') return true;
      if (this.generation !== generation) continue;
      if (agent.workSettled) return true;
    }
  }
}
