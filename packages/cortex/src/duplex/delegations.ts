/**
 * DelegationRegistry: the work the talker has handed to the reasoner, under
 * human-friendly aliases so a fast-tier model never reproduces UUIDs
 * (communication.md). The single owner of "is this delegation still live":
 * the headline block, the watchdog and the cancel path all read it here.
 */

import type { CauseTag } from './cause-tags.js';

/** One tracked delegation (a spawn_task dispatch), keyed by alias. */
export interface DelegationSnapshot {
  alias: string;
  instructions: string;
  /** Log seq of the spawn directive. */
  seq: number;
  createdAt: number;
  cancelled: boolean;
  /**
   * When the work last reported a result, or null while it is outstanding.
   * A completed delegation stays resolvable (the reasoner is persistent and
   * a user routinely steers a task that already reported) but stops being
   * described as work in progress.
   */
  completedAt: number | null;
}

/** The registry's own record: a snapshot plus what identifies its results. */
interface TrackedDelegation extends DelegationSnapshot {
  /**
   * Every directive seq that belongs to this delegation: the spawn, plus
   * each steer or cancel aimed at it. A delivery whose cause set touches any
   * of them is a result for this delegation. Steers count because a run
   * consuming a redirect delivers under the redirect's causation, not the
   * spawn's.
   */
  directiveSeqs: Set<number>;
  /** Last spawn, steer, or result. The age-out clock, so live work is safe. */
  lastActivityAt: number;
}

/** The persisted part of the registry (DuplexRouterState). */
export interface DelegationRegistryState {
  /**
   * The next task alias number. Aliases are how the talker, the transcript
   * and the user refer to work, so they never restart at task-1 over a
   * transcript that already says task-1.
   */
  nextAliasNumber: number;
  /** Tracked delegations, including the directive seqs that identify results. */
  delegations: Array<DelegationSnapshot & { directiveSeqs: number[]; lastActivityAt: number }>;
}

const TASK_ALIAS = /^task-(\d+)$/;

/**
 * The highest `task-N` alias among the given directive aliases, or 0. The
 * floor for the alias counter after a restore, whatever the artifact
 * carried.
 */
export function highestTaskAlias(aliases: Iterable<unknown>): number {
  let highest = 0;
  for (const alias of aliases) {
    const match = typeof alias === 'string' ? TASK_ALIAS.exec(alias) : null;
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

function snapshotOf(delegation: TrackedDelegation): DelegationSnapshot {
  const { directiveSeqs: _seqs, lastActivityAt: _at, ...snapshot } = delegation;
  return snapshot;
}

export class DelegationRegistry {
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly delegations = new Map<string, TrackedDelegation>();
  private nextAliasNumber = 1;

  constructor(options: { now: () => number; maxAgeMs: number }) {
    this.now = options.now;
    this.maxAgeMs = options.maxAgeMs;
  }

  /** Take the next alias. Consumed even if the delegation never opens. */
  reserveAlias(): string {
    return `task-${this.nextAliasNumber++}`;
  }

  /** Track a delegation whose spawn directive was logged at `seq`. */
  open(alias: string, instructions: string, seq: number): void {
    const createdAt = this.now();
    this.delegations.set(alias, {
      alias,
      instructions,
      seq,
      createdAt,
      cancelled: false,
      completedAt: null,
      directiveSeqs: new Set([seq]),
      lastActivityAt: createdAt,
    });
  }

  /**
   * A steer aimed at a delegation: the redirected run delivers under the
   * STEER's causation, so its seq joins the delegation's, and a steered
   * task is outstanding again whatever it reported before.
   */
  addSteer(alias: string, seq: number): void {
    const delegation = this.delegations.get(alias);
    if (!delegation) return;
    delegation.directiveSeqs.add(seq);
    delegation.completedAt = null;
    delegation.lastActivityAt = this.now();
  }

  /**
   * A cancel: whatever the reasoner says in answer to it belongs to the
   * cancelled task too, so the cancel directive's seq joins it and its
   * results are dropped with the rest.
   */
  markCancelled(alias: string, seq: number): void {
    const delegation = this.delegations.get(alias);
    if (!delegation) return;
    delegation.cancelled = true;
    delegation.directiveSeqs.add(seq);
  }

  /** Find a delegation by alias, case-insensitively. */
  resolve(aliasName: string): Readonly<DelegationSnapshot> | undefined {
    const exact = this.delegations.get(aliasName);
    if (exact) return exact;
    const lower = aliasName.toLowerCase();
    for (const delegation of this.delegations.values()) {
      if (delegation.alias.toLowerCase() === lower) return delegation;
    }
    return undefined;
  }

  /** Stop tracking a delegation (its dispatch was never handed over). */
  remove(alias: string): void {
    this.delegations.delete(alias);
  }

  /** Snapshot of tracked delegations (copies). */
  snapshot(): DelegationSnapshot[] {
    this.prune();
    return [...this.delegations.values()].map(snapshotOf);
  }

  /** Aliases of the delegations still described as work in progress. */
  activeAliases(): string[] {
    this.prune();
    return [...this.delegations.values()]
      .filter((delegation) => !delegation.cancelled && delegation.completedAt === null)
      .map((delegation) => delegation.alias);
  }

  /**
   * Retire the delegations a run's cause set answers.
   *
   * Matching is on the FULL cause set (D16's rule about the collapsing
   * helper applies to every causation consumer, not only to consent): a run
   * that consumed a spawn and a steer parked behind it collapses to the
   * steer alone, and the spawn's delegation would never retire.
   *
   * Marked, not deleted. The reasoner is persistent and a user routinely
   * steers a task that already reported ("and make the eviction metric
   * observable"), so the alias has to stay resolvable; a steer takes it back
   * out of the completed state. What stops is describing it as live work,
   * which the headline block and the watchdog would otherwise keep doing
   * for the rest of the session.
   */
  retireFor(causeTags: readonly CauseTag[]): void {
    if (causeTags.length === 0) return;
    const now = this.now();
    for (const delegation of this.delegations.values()) {
      if (delegation.completedAt !== null) continue;
      const answered = causeTags.some(
        (tag) => tag.kind === 'directive' && delegation.directiveSeqs.has(tag.seq),
      );
      if (answered) {
        delegation.completedAt = now;
        delegation.lastActivityAt = now;
      }
    }
  }

  /**
   * All work was stopped (a work-scope abort, a breached session budget):
   * every outstanding delegation stops being live, including ones whose
   * dispatch was still parked and was dropped with the run. Marked, not
   * removed, like result-driven retirement: the aliases stay steerable.
   */
  retireAll(): void {
    const now = this.now();
    for (const delegation of this.delegations.values()) {
      if (delegation.completedAt !== null) continue;
      delegation.completedAt = now;
      delegation.lastActivityAt = now;
    }
  }

  /**
   * Whether a reasoner run's causation is entirely cancelled delegations:
   * non-empty, and every tag a directive belonging to one. A tag the
   * registry cannot place (consumer work input, an unaliased steer, an aged
   * out delegation) means the run serves something else as well.
   */
  servesOnlyCancelled(causeTags: readonly CauseTag[]): boolean {
    if (causeTags.length === 0) return false;
    return causeTags.every((tag) => {
      if (tag.kind !== 'directive') return false;
      for (const delegation of this.delegations.values()) {
        if (delegation.directiveSeqs.has(tag.seq)) return delegation.cancelled;
      }
      return false;
    });
  }

  /** Forget every delegation and restart aliases (facade restore()). */
  clear(): void {
    this.delegations.clear();
    this.nextAliasNumber = 1;
  }

  exportState(): DelegationRegistryState {
    return {
      nextAliasNumber: this.nextAliasNumber,
      delegations: [...this.delegations.values()].map((delegation) => ({
        ...delegation,
        directiveSeqs: [...delegation.directiveSeqs],
      })),
    };
  }

  /**
   * Re-apply persisted delegations after {@link clear}. Returns the ones
   * that were still outstanding: whatever run served them did not survive
   * the restore, so they are retired here rather than left listed as live,
   * and the caller decides how to tell the conversation.
   *
   * `logAliasFloor` is the highest task alias number the restored log
   * mentions: an artifact written before this state was persisted (or with
   * it stripped) still never reissues an alias its transcript already uses.
   */
  restoreState(
    state: Partial<DelegationRegistryState> | undefined,
    logAliasFloor: number,
  ): DelegationSnapshot[] {
    const persistedNext = typeof state?.nextAliasNumber === 'number' && Number.isInteger(state.nextAliasNumber)
      ? state.nextAliasNumber
      : 1;
    this.nextAliasNumber = Math.max(persistedNext, logAliasFloor + 1, 1);
    if (!state) return [];

    const now = this.now();
    const interrupted: DelegationSnapshot[] = [];
    for (const persisted of Array.isArray(state.delegations) ? state.delegations : []) {
      if (typeof persisted?.alias !== 'string' || typeof persisted.seq !== 'number') continue;
      const delegation: TrackedDelegation = {
        alias: persisted.alias,
        instructions: typeof persisted.instructions === 'string' ? persisted.instructions : '',
        seq: persisted.seq,
        createdAt: typeof persisted.createdAt === 'number' ? persisted.createdAt : now,
        cancelled: persisted.cancelled === true,
        completedAt: typeof persisted.completedAt === 'number' ? persisted.completedAt : null,
        directiveSeqs: new Set(
          (Array.isArray(persisted.directiveSeqs) ? persisted.directiveSeqs : [persisted.seq])
            .filter((seq): seq is number => typeof seq === 'number'),
        ),
        // Restarted from now: the age-out measures inactivity in this
        // session, and a restore is activity.
        lastActivityAt: now,
      };
      if (!delegation.cancelled && delegation.completedAt === null) {
        delegation.completedAt = now;
        interrupted.push(snapshotOf(delegation));
      }
      this.delegations.set(delegation.alias, delegation);
    }
    return interrupted;
  }

  /**
   * Drop delegations past the age bound, measured from their last spawn,
   * steer, or result so live work is never dropped mid-flight. The backstop
   * behind result-driven retirement: work can end without any delivery the
   * router can attribute (a run that died, a reasoner that answered in a way
   * the cause set does not connect), and an entry with no retirement path at
   * all is what makes the registry grow without limit.
   */
  private prune(): void {
    const cutoff = this.now() - this.maxAgeMs;
    for (const [alias, delegation] of this.delegations) {
      if (delegation.lastActivityAt < cutoff) this.delegations.delete(alias);
    }
  }
}
