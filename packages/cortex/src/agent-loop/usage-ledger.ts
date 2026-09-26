/**
 * A loop's usage accounting: session-lifetime totals (unlike BudgetGuard,
 * which resets per prompt for enforcement), including forwarded child
 * turns and utility calls, plus the most recent direct completion's usage.
 */

import {
  accumulateTurn,
  accumulateUtility,
  addSessionUsage,
  cloneSessionUsage,
  zeroSessionUsage,
} from '../session-usage.js';
import type { CortexUsage, SessionUsage } from '../types.js';

export class UsageLedger {
  private session: SessionUsage = zeroSessionUsage();

  /**
   * Usage of the most recent direct/structured/utility completion; null
   * when it reported none. Reset at the start of each call so consumers
   * read per-call usage for persistence.
   */
  lastDirect: CortexUsage | null = null;

  get totalCost(): number {
    return this.session.totalCost;
  }

  recordTurn(usage: CortexUsage): void {
    accumulateTurn(this.session, usage);
  }

  /** A turn whose usage the provider did not report still counts as a turn. */
  recordUnmeteredTurn(): void {
    this.session.totalTurns += 1;
  }

  recordUtility(category: string, usage: CortexUsage): void {
    accumulateUtility(this.session, category, usage);
  }

  snapshot(): SessionUsage {
    return cloneSessionUsage(this.session);
  }

  /** Add restored usage to whatever accumulated before the restore. */
  restore(usage: SessionUsage): void {
    this.session = addSessionUsage(this.session, usage);
  }
}
