/**
 * Idle digestion: deferred digestion (pending observation buffers,
 * threshold compaction) for both resident loops at a quiet moment. The
 * talker runs a non-blocking compaction posture, so this is where its
 * blocking work happens; the reasoner benefits opportunistically.
 *
 * A digestion pass holds a loop's gate, so any input bound for either loop
 * preempts it rather than waiting behind background compaction.
 */

import type { AgentLoop } from '../agent-loop.js';
import type { CortexLogger } from '../types.js';
import { errorMessageOf } from '../error-classifier.js';

export interface IdleDigestionPorts {
  talker: AgentLoop;
  reasoner: AgentLoop;
  /** Whether the session is genuinely quiet (conversation idle, nothing held). */
  quiet(): boolean;
  destroyed(): boolean;
  logger: CortexLogger;
}

export class IdleDigestion {
  private readonly ports: IdleDigestionPorts;
  private readonly delayMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Preempts the pass in flight, if any. */
  private preemption: AbortController | null = null;

  constructor(ports: IdleDigestionPorts, delayMs: number) {
    this.ports = ports;
    this.delayMs = delayMs;
  }

  /** (Re)arm the quiet-moment timer; called when a run completes. */
  schedule(): void {
    if (this.ports.destroyed()) return;
    if (this.timer !== null) clearTimeout(this.timer);
    const timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.delayMs);
    timer.unref?.();
    this.timer = timer;
  }

  /**
   * Input is arriving for a loop: stop any idle digestion pass holding a
   * gate. Called on every path that hands wake content to either loop, so
   * nothing a user or the other loop is waiting on sits behind background
   * compaction. The next quiet moment reschedules digestion.
   */
  preempt(): void {
    if (!this.preemption) return;
    this.preemption.abort();
    this.preemption = null;
  }

  destroy(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async run(): Promise<void> {
    const { talker, reasoner, logger } = this.ports;
    if (this.ports.destroyed()) return;
    // Only when genuinely quiet; a digestion pass holds the loop gate, so a
    // busy moment skips and the next run completion reschedules.
    if (!this.ports.quiet()) return;
    // The quiet moment can end at any time. Input arriving mid-pass aborts
    // this, and the pass releases the gate at once instead of making the
    // user's next words wait out observer catch-up and forced compaction
    // (up to two full utility timeouts per loop).
    const preemption = new AbortController();
    this.preemption = preemption;
    try {
      try {
        if (!talker.isLoopActive) await talker.digestIdle({ signal: preemption.signal });
      } catch (err) {
        logger.warn('talker idle digestion failed', {
          error: errorMessageOf(err),
        });
      }
      if (this.ports.destroyed() || preemption.signal.aborted) return;
      try {
        if (!reasoner.isLoopActive && reasoner.getSubAgentManager().activeCount === 0) {
          await reasoner.digestIdle({ signal: preemption.signal });
        }
      } catch (err) {
        logger.warn('reasoner idle digestion failed', {
          error: errorMessageOf(err),
        });
      }
    } finally {
      if (this.preemption === preemption) this.preemption = null;
    }
  }
}
