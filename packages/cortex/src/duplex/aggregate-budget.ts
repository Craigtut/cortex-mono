/**
 * The duplex session's cost ceiling (decisions.md D19): one lifetime guard
 * over both resident loops, every sub-agent, quick lookups and utility
 * spend, which per-prompt loop guards never see, and what happens when it
 * trips.
 */

import type { BudgetGuardConfig, CortexLogger } from '../types.js';
import { BudgetGuard } from '../budget-guard.js';
import type { EventBridge } from '../event-bridge.js';
import type { LogEntryInput } from '../facade/log-recorder.js';

export interface AggregateBudgetPorts {
  append(input: LogEntryInput): void;
  /** Stop every piece of running work; resolves once the stops unwind. */
  stopAllWork(): Promise<unknown>;
  /** Nothing is in progress any more: every delegation stops being live. */
  retireAllDelegations(): void;
  /** Tell the conversation, once the stops have unwound. */
  announce(text: string): void;
  destroyed(): boolean;
  /** Loop path the breach entry is attributed to (the work surface). */
  workLoopPath: string;
  logger: CortexLogger;
}

const BREACH_REFUSAL = "the session's spending limit has been reached";

export class AggregateBudget {
  readonly guard: BudgetGuard;
  private readonly ports: AggregateBudgetPorts;
  private breachLogged = false;

  /**
   * Its cap is duplex.maxTotalCost, never the consumer's budgetGuard.maxCost:
   * that number keeps its per-prompt meaning on the reasoner, and borrowing
   * it here would silently turn "$10 per prompt" into "$10 for the whole
   * session". Turn counts are not aggregated: turns across two loops plus
   * children have no comparable composite meaning.
   *
   * No finite default is invented when maxTotalCost is unset: a
   * session-level cost ceiling that silently aborts a long session is a
   * worse failure than an uncapped one, and any number Cortex picked would
   * be wrong for somebody. What is not acceptable is picking silently, so
   * the uncapped guard is reported as a 'duplex-cost-cap-unset' resolution
   * note, read back off the guard this builds rather than from the config.
   */
  constructor(maxTotalCost: number | undefined, events: EventBridge, ports: AggregateBudgetPorts) {
    this.ports = ports;
    const config: Partial<BudgetGuardConfig> = {
      scope: 'lifetime',
      includeChildUsage: true,
      includeUtilityUsage: true,
    };
    if (maxTotalCost !== undefined) config.maxCost = maxTotalCost;
    this.guard = new BudgetGuard(config, () => this.handleBreach(), ports.logger);
    this.guard.wire(events);
  }

  /**
   * Why new work cannot be dispatched, or null when it can. After a breach
   * a spawn, steer or lookup would only start a run the guard stops at
   * once, so the talker gets a receipt it can relay instead.
   */
  workRefusal(): string | null {
    return this.guard.isBreached() ? BREACH_REFUSAL : null;
  }

  /**
   * The counters describe the replaced session's spend; without a reset a
   * lifetime breach would keep aborting the restored session forever and
   * re-log a breach against a pre-restore total.
   */
  resetForRestore(): void {
    this.guard.reset();
    this.breachLogged = false;
  }

  destroy(): void {
    this.guard.destroy();
  }

  /**
   * Log once, then stop both loops and every child. The lifetime guard
   * keeps stopping anything that starts after the breach, so later
   * dispatches cannot leak spend.
   */
  private handleBreach(): void {
    if (this.ports.destroyed()) return;
    const firstBreach = !this.breachLogged;
    if (firstBreach) {
      this.breachLogged = true;
      this.ports.append({
        type: 'lifecycle',
        loopPath: this.ports.workLoopPath,
        content: 'Aggregate budget limit breached; stopping work',
        data: {
          event: 'budget_breached',
          totalCost: this.guard.getTotalCost(),
          maxCost: this.guard.getMaxCost(),
        },
        causedBy: null,
      });
    }
    const stopped = this.ports.stopAllWork();
    if (!firstBreach) return;
    // Every piece of work is stopped, so none of it is live any more, and
    // the user has to be told why: nothing else will ever say it, and the
    // refusals that follow (workRefusal) only speak when the talker next
    // tries to delegate. Delivered once the aborts have unwound: the
    // talker's own abort would otherwise cancel the notice parked behind it.
    this.ports.retireAllDelegations();
    void stopped.then(() => {
      if (this.ports.destroyed()) return;
      this.ports.announce(
        "The session's spending limit has been reached, so all background work was " +
        'stopped and no new work can start. Tell the user plainly.',
      );
    });
  }
}
