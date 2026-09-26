/**
 * The composite session usage under the baseline-plus-delta restore model.
 *
 * Loops restart their counters at zero after a restore, so the composite is
 * the restored baseline plus each producer's live delta since the restore,
 * rather than an additive merge into live counters (which would
 * double-count on repeated restores). Children are counted once: each
 * loop's own session usage already includes its forwarded child events.
 */

import type { SessionUsage } from '../types.js';
import {
  addSessionUsage,
  cloneSessionUsage,
  diffSessionUsage,
  isZeroSessionUsage,
} from '../session-usage.js';
import type { CortexAgentUsageBreakdown } from './persisted-state.js';

/**
 * Live readings from each usage producer, taken at the moment of the call.
 * Null means the producer does not exist in this mode (no talker, no lookup
 * fleet in passthrough), which is different from a producer that has spent
 * nothing: a restored artifact's side for it is then carried through as is.
 */
export interface UsageReadings {
  reasoner: SessionUsage;
  talker: SessionUsage | null;
  /** Settled quick-lookup spend (the lookup fleet's accumulator). */
  lookups: SessionUsage | null;
}

export class CompositeUsage {
  private baseline: {
    talker: SessionUsage | null;
    reasoner: SessionUsage;
    lookups: SessionUsage | null;
  } | null = null;
  /** Each producer's live reading at the moment of the last restore. */
  private atRestore: UsageReadings | null = null;

  /** Per-loop attribution plus the aggregate, as the artifact carries it. */
  breakdown(live: UsageReadings): CortexAgentUsageBreakdown {
    const reasoner = this.reasoner(live);
    const talker = this.talker(live);
    const lookups = this.lookups(live);
    return {
      total: sum(reasoner, talker, lookups),
      perLoop: {
        talker,
        reasoner,
        ...(lookups ? { lookups } : {}),
      },
    };
  }

  /** The aggregate across every producer. */
  total(live: UsageReadings): SessionUsage {
    return sum(this.reasoner(live), this.talker(live), this.lookups(live));
  }

  /**
   * Adopt a restored artifact's usage as the baseline, with the producers'
   * current readings as the zero point their future deltas are measured
   * from.
   */
  rebase(restored: CortexAgentUsageBreakdown, live: UsageReadings): void {
    this.baseline = {
      talker: restored.perLoop.talker ? cloneSessionUsage(restored.perLoop.talker) : null,
      reasoner: cloneSessionUsage(restored.perLoop.reasoner),
      lookups: restored.perLoop.lookups ? cloneSessionUsage(restored.perLoop.lookups) : null,
    };
    this.atRestore = live;
  }

  private reasoner(live: UsageReadings): SessionUsage {
    if (!this.baseline) return live.reasoner;
    const since = this.atRestore?.reasoner;
    const delta = since ? diffSessionUsage(live.reasoner, since) : live.reasoner;
    return addSessionUsage(this.baseline.reasoner, delta);
  }

  /**
   * Null only when no talker loop exists and no restored baseline carries a
   * talker side.
   */
  private talker(live: UsageReadings): SessionUsage | null {
    if (!live.talker) {
      return this.baseline?.talker ? cloneSessionUsage(this.baseline.talker) : null;
    }
    if (!this.baseline) return live.talker;
    const since = this.atRestore?.talker;
    const delta = since ? diffSessionUsage(live.talker, since) : live.talker;
    const baseline = this.baseline.talker;
    return baseline ? addSessionUsage(baseline, delta) : delta;
  }

  /**
   * Null when nothing was ever spent: the artifact omits an all-zero bucket
   * rather than growing every duplex snapshot.
   */
  private lookups(live: UsageReadings): SessionUsage | null {
    const baseline = this.baseline?.lookups ?? null;
    if (!live.lookups) {
      // Passthrough: carry a restored duplex artifact's lookup spend
      // through unchanged, like the talker side.
      return baseline ? cloneSessionUsage(baseline) : null;
    }
    const since = this.atRestore?.lookups;
    const delta = since ? diffSessionUsage(live.lookups, since) : live.lookups;
    const combined = baseline ? addSessionUsage(baseline, delta) : delta;
    return isZeroSessionUsage(combined) ? null : combined;
  }
}

function sum(
  reasoner: SessionUsage,
  talker: SessionUsage | null,
  lookups: SessionUsage | null,
): SessionUsage {
  let total = reasoner;
  if (talker) total = addSessionUsage(total, talker);
  if (lookups) total = addSessionUsage(total, lookups);
  return total;
}
