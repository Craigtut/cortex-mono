/**
 * Settlement: the facade's composite "is the agent quiet" predicates and
 * their awaitable forms (docs/cortex/duplex/facade-api.md).
 *
 * A single loop's gate is not "the agent is idle" once a session spans
 * several loops, a router and a broker, so settlement is composed from
 * terms, each owned by whatever holds the fact it reports. A wait visits
 * the terms in order and blocks on the first one still pending, using that
 * owner's own signal where it has one. Order matters only for efficiency:
 * every wait restarts from the top, so the verdict is always read across
 * all terms at once.
 */

import type { AgentLoop } from '../agent-loop.js';

/** One condition settlement waits out. */
export interface SettlementTerm {
  /** For diagnostics and ordering tests. */
  readonly name: string;
  pending(): boolean;
  /**
   * Resolves when the owner's state may have changed. Null means the owner
   * has no signal: the wait yields one macrotask and re-checks.
   */
  settled(): Promise<void> | null;
}

/** One macrotask yield: lets pending microtask cascades finish. */
export function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A loop's gate: a run or any gate work in flight. */
export function gateTerm(loop: AgentLoop): SettlementTerm {
  return {
    name: `${loop.loopPath}-gate`,
    pending: () => loop.isLoopActive,
    settled: () => loop.waitForLoopIdle(),
  };
}

/**
 * Parked wake deliveries have no settle signal of their own; they start a
 * run when they land, which the gate terms then wait out.
 */
export function parkedWakesTerm(loop: AgentLoop): SettlementTerm {
  return {
    name: `${loop.loopPath}-parked-wakes`,
    pending: () => loop.pendingWakeDeliveryCount > 0,
    settled: () => null,
  };
}

/** A loop's running sub-agents, waited out on their completion promises. */
export function subAgentsTerm(loop: AgentLoop): SettlementTerm {
  const manager = loop.getSubAgentManager();
  return {
    name: `${loop.loopPath}-sub-agents`,
    pending: () => manager.activeCount > 0,
    settled: async () => {
      const completions = manager.getActiveTaskIds()
        .map((taskId) => manager.get(taskId)?.completion)
        .filter((completion) => completion !== undefined);
      await Promise.all(completions);
      await yieldMacrotask();
    },
  };
}

/** Asks in a loop's own registry (its own and its sub-agents'). */
export function loopAsksTerm(loop: AgentLoop): SettlementTerm {
  return {
    name: `${loop.loopPath}-asks`,
    pending: () => loop.getPendingAsks().length > 0,
    settled: () => loop.waitForAskSettlement(),
  };
}

/** Facade prompts accepted but not yet settled (chain-queued or running). */
export class PromptTracker {
  private count = 0;
  /** Waiters released whenever the count returns to zero. */
  private settlers: Array<() => void> = [];

  get pending(): boolean {
    return this.count > 0;
  }

  begin(): void {
    this.count += 1;
  }

  end(): void {
    this.count -= 1;
    if (this.count > 0 || this.settlers.length === 0) return;
    const waiters = this.settlers.splice(0);
    for (const resolve of waiters) resolve();
  }

  /** Resolves once no facade prompt is queued or running. */
  waitIdle(): Promise<void> {
    if (this.count === 0) return Promise.resolve();
    return new Promise((resolve) => this.settlers.push(resolve));
  }

  /** The prompt term every settlement starts with. */
  term(): SettlementTerm {
    return {
      name: 'facade-prompts',
      pending: () => this.pending,
      settled: () => this.waitIdle(),
    };
  }
}

export class Settlement {
  private readonly conversation: readonly SettlementTerm[];
  private readonly work: readonly SettlementTerm[];

  /**
   * `conversation`: what must hold for the conversation surface to be
   * quiet. `work`: everything that must hold for all work to be settled,
   * in wait order; the conversation terms are part of the verdict whether
   * or not the list repeats them.
   */
  constructor(terms: { conversation: SettlementTerm[]; work: SettlementTerm[] }) {
    this.conversation = terms.conversation;
    this.work = terms.work;
  }

  get conversationIdle(): boolean {
    return !this.conversation.some((term) => term.pending());
  }

  get workSettled(): boolean {
    return this.conversationIdle && !this.work.some((term) => term.pending());
  }

  async waitForConversationIdle(): Promise<void> {
    for (;;) {
      if (!(await this.waitOnFirstPending(this.conversation))) return;
    }
  }

  /**
   * Event-driven where a signal exists; a single macrotask yield between
   * checks otherwise. The final verdict is confirmed across one macrotask:
   * a cascade between microtasks (a finished child scheduling its delivery
   * drain) may still be about to enqueue gate work.
   */
  async waitForWorkSettled(): Promise<void> {
    const terms = [...this.work, ...this.conversation];
    for (;;) {
      if (await this.waitOnFirstPending(terms)) continue;
      await yieldMacrotask();
      if (this.workSettled) return;
    }
  }

  /** Wait on the first pending term; false when none is pending. */
  private async waitOnFirstPending(terms: readonly SettlementTerm[]): Promise<boolean> {
    for (const term of terms) {
      if (!term.pending()) continue;
      await (term.settled() ?? yieldMacrotask());
      return true;
    }
    return false;
  }
}
