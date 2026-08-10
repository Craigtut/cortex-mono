/**
 * SubAgentManager: tracks active sub-agents, enforces concurrency limits,
 * manages lifecycle, and delivers background completion notifications.
 *
 * Each sub-agent is an independent AgentLoop instance tracked by task ID.
 * The manager does not own the AgentLoop; it tracks references and
 * coordinates lifecycle events for the consumer.
 *
 * References:
 *   - docs/cortex/tools/sub-agent.md
 *   - docs/cortex/plans/phase-4-sub-agents-and-skills.md
 */

import type { SubAgentHandle, SubAgentResult, TrackedSubAgent } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubAgentManagerConfig {
  /** Maximum concurrent sub-agents in the default (unnamed) pool. Default: 4. */
  maxConcurrent: number;
  /**
   * Independent named concurrency pools. A spawn that names a pool counts
   * only against that pool's limit; a named pool missing from this map
   * falls back to maxConcurrent while still being counted separately.
   */
  pools?: Record<string, number>;
}

export interface SubAgentLifecycleHooks {
  onSpawned?: (taskId: string, instructions: string, background: boolean) => void;
  onCompleted?: (taskId: string, result: string, status: string, usage: unknown) => void;
  onFailed?: (taskId: string, error: string) => void;
}

/**
 * Why a task was cancelled: an explicit cancel() of that task, or the
 * parent's destroy-time cancelAll() sweep. Recorded alongside the cancelled
 * ID so downstream records (the facade's lifecycle log entry, 2b's
 * delivery router) can distinguish the two.
 */
export type SubAgentCancellationReason = 'cancel' | 'shutdown';

// ---------------------------------------------------------------------------
// SubAgentManager
// ---------------------------------------------------------------------------

/** Cancelled task IDs retained for late-completion discard checks. */
const MAX_CANCELLED_TASK_IDS = 200;

export class SubAgentManager {
  private readonly agents = new Map<string, TrackedSubAgent>();
  private readonly maxConcurrent: number;
  private readonly pools: Record<string, number>;
  private hooks: SubAgentLifecycleHooks = {};
  private readonly cancelledTaskIds = new Map<string, SubAgentCancellationReason>();

  constructor(config?: Partial<SubAgentManagerConfig>) {
    this.maxConcurrent = config?.maxConcurrent ?? 4;
    this.pools = config?.pools ?? {};
  }

  /**
   * Set lifecycle hooks. Called by AgentLoop to wire consumer event handlers.
   */
  setHooks(hooks: SubAgentLifecycleHooks): void {
    this.hooks = hooks;
  }

  /**
   * Check if another sub-agent can be spawned within the concurrency limit
   * of the given pool (the default pool when omitted). Pools are counted
   * independently, so a saturated default pool never blocks a named pool.
   */
  canSpawn(pool?: string): boolean {
    return this.activeCountInPool(pool) < this.poolLimit(pool);
  }

  /**
   * Get the number of currently active sub-agents across all pools.
   */
  get activeCount(): number {
    return this.agents.size;
  }

  /**
   * Get the concurrency limit of the default pool.
   */
  get limit(): number {
    return this.maxConcurrent;
  }

  /** Number of active sub-agents in the given pool (default pool when omitted). */
  activeCountInPool(pool?: string): number {
    let count = 0;
    for (const entry of this.agents.values()) {
      if (entry.pool === pool) count += 1;
    }
    return count;
  }

  /** The configured limit of a pool (default pool when omitted). */
  poolLimit(pool?: string): number {
    if (pool === undefined) return this.maxConcurrent;
    return this.pools[pool] ?? this.maxConcurrent;
  }

  /**
   * Register a newly spawned sub-agent.
   * Returns false if its pool's concurrency limit would be exceeded.
   */
  track(entry: TrackedSubAgent): boolean {
    if (this.activeCountInPool(entry.pool) >= this.poolLimit(entry.pool)) {
      return false;
    }

    this.agents.set(entry.taskId, entry);

    // Fire lifecycle hook
    try {
      this.hooks.onSpawned?.(entry.taskId, entry.instructions, entry.background);
    } catch {
      // Swallow hook errors
    }

    return true;
  }

  /**
   * Mark a sub-agent as completed and remove it from tracking.
   */
  complete(taskId: string, result: SubAgentResult): void {
    const entry = this.agents.get(taskId);
    if (!entry) return;

    this.agents.delete(taskId);

    // Resolve the completion promise
    entry.resolve(result);

    // Fire lifecycle hook (pass full result metadata including toolCalls)
    try {
      const usageWithToolCalls: Record<string, unknown> = { ...result.usage };
      if (result.toolCalls) {
        usageWithToolCalls['toolCalls'] = result.toolCalls;
      }
      this.hooks.onCompleted?.(
        taskId,
        result.output,
        result.status,
        usageWithToolCalls,
      );
    } catch {
      // Swallow hook errors
    }
  }

  /**
   * Mark a sub-agent as failed and remove it from tracking.
   */
  fail(taskId: string, error: string): void {
    const entry = this.agents.get(taskId);
    if (!entry) return;

    this.agents.delete(taskId);

    // Resolve the completion promise with a failed result
    entry.resolve({
      output: '',
      status: 'failed',
      usage: { turns: 0, cost: 0, durationMs: Date.now() - entry.spawnedAt, contextTokens: 0 },
    });

    // Fire lifecycle hook
    try {
      this.hooks.onFailed?.(taskId, error);
    } catch {
      // Swallow hook errors
    }
  }

  /**
   * Cancel a single running sub-agent: untrack it, mark it cancelled so its
   * late completion work is discarded, tear the child down via `abortFn`,
   * and resolve its completion promise as cancelled.
   *
   * Marking happens before the (async) teardown so a child that finishes
   * during teardown cannot slip its result through: complete()/fail() no-op
   * once the entry is untracked, and delivery paths consult isCancelled().
   *
   * @param abortFn - Aborts and tears down the child agent (passed to avoid a circular dep)
   * @returns true when the task was active and is now cancelled
   */
  async cancel(taskId: string, abortFn: (agent: SubAgentHandle) => Promise<void>): Promise<boolean> {
    const entry = this.agents.get(taskId);
    if (!entry) return false;

    this.agents.delete(taskId);
    this.markCancelled(taskId, 'cancel');

    try {
      await abortFn(entry.agent);
    } catch {
      // Best-effort abort
    }

    entry.resolve({
      output: '',
      status: 'cancelled',
      usage: { turns: 0, cost: 0, durationMs: Date.now() - entry.spawnedAt, contextTokens: 0 },
    });

    try {
      this.hooks.onFailed?.(taskId, 'Cancelled');
    } catch {
      // Swallow hook errors
    }

    return true;
  }

  /**
   * Deliver a steering message to a running sub-agent by task ID, through
   * the child's public steering queue: pi drains it at the next turn
   * boundary of the child's in-flight run. Accepted only while a run is
   * actually in flight (isPrompting), not merely while the child's gate is
   * held: the gate stays held through windows that never poll steering
   * again (the end-of-cycle drain after the child's run ended, a queued
   * non-run task), where an accepted redirect would be destroyed with the
   * child moments later while the caller was told it landed.
   *
   * The gate narrows that lie but does not close it: pi's last steering
   * poll of a run precedes its decision to stop, so a message queued
   * after the final poll (a near-run-end race this check cannot see) is
   * never polled and dies with the child even though 'steered' was
   * returned. 'steered' means queued into a live run, not consumed.
   *
   * @returns 'steered' when the redirect was queued into the child's
   *   in-flight run; null when the task is not active, no run is in
   *   flight, or the child is already tearing down.
   */
  steer(taskId: string, message: string): 'steered' | null {
    const entry = this.agents.get(taskId);
    if (!entry) return null;
    try {
      if (!entry.agent.isPrompting) return null;
      entry.agent.steer(message);
      return 'steered';
    } catch {
      // The child began destroy() between tracking and this call; the
      // steer has nowhere to land.
      return null;
    }
  }

  /**
   * Whether a task was cancelled. Delivery paths use this to discard results
   * produced by a child that survived long enough to finish after its cancel.
   */
  isCancelled(taskId: string): boolean {
    return this.cancelledTaskIds.has(taskId);
  }

  /**
   * Why a cancelled task was cancelled; undefined for tasks never
   * cancelled (or evicted past the cap).
   */
  cancellationReason(taskId: string): SubAgentCancellationReason | undefined {
    return this.cancelledTaskIds.get(taskId);
  }

  /** Record a cancelled task ID and reason, evicting the oldest past the cap. */
  private markCancelled(taskId: string, reason: SubAgentCancellationReason): void {
    this.cancelledTaskIds.set(taskId, reason);
    if (this.cancelledTaskIds.size > MAX_CANCELLED_TASK_IDS) {
      const oldest = this.cancelledTaskIds.keys().next().value;
      if (oldest !== undefined) this.cancelledTaskIds.delete(oldest);
    }
  }

  /**
   * Get a tracked sub-agent by task ID.
   */
  get(taskId: string): TrackedSubAgent | undefined {
    return this.agents.get(taskId);
  }

  /**
   * Update tool activity for a running sub-agent.
   * Called when child tool_call_start events are forwarded via EventBridge.
   */
  updateToolActivity(taskId: string, toolName: string, summary: string): void {
    const entry = this.agents.get(taskId);
    if (!entry) return;
    entry.toolCount++;
    entry.lastToolName = toolName;
    entry.lastToolSummary = summary;
    entry.lastToolStartedAt = Date.now();
  }

  /**
   * Get all active sub-agent task IDs.
   */
  getActiveTaskIds(): string[] {
    return [...this.agents.keys()];
  }

  /**
   * Get completion promises for all background sub-agents.
   * Used to build follow-up messages when background agents complete.
   */
  getBackgroundCompletions(): Array<{ taskId: string; completion: Promise<SubAgentResult> }> {
    const results: Array<{ taskId: string; completion: Promise<SubAgentResult> }> = [];
    for (const [taskId, entry] of this.agents) {
      if (entry.background) {
        results.push({ taskId, completion: entry.completion });
      }
    }
    return results;
  }

  /**
   * Cancel all active sub-agents. Called during parent destroy().
   * Marks each as cancelled, tears it down via `abortFn`, and removes it
   * from tracking.
   *
   * @param abortFn - Function to tear down an AgentLoop (passed to avoid circular dep)
   */
  async cancelAll(abortFn: (agent: SubAgentHandle) => Promise<void>): Promise<void> {
    const entries = [...this.agents.values()];
    this.agents.clear();
    for (const entry of entries) {
      this.markCancelled(entry.taskId, 'shutdown');
    }

    const settled = await Promise.allSettled(
      entries.map(async (entry) => {
        try {
          await abortFn(entry.agent);
        } catch {
          // Best-effort abort
        }

        // Resolve the completion promise as cancelled
        entry.resolve({
          output: '',
          status: 'cancelled',
          usage: { turns: 0, cost: 0, durationMs: Date.now() - entry.spawnedAt, contextTokens: 0 },
        });

        // Fire failure hook
        try {
          this.hooks.onFailed?.(entry.taskId, 'Parent agent destroyed');
        } catch {
          // Swallow hook errors
        }
      }),
    );

    // Log any unexpected errors (consumer should provide logging)
    for (const result of settled) {
      if (result.status === 'rejected') {
        // Swallowed: best-effort cleanup
      }
    }
  }

  /**
   * Clean up all state. Called during parent destroy().
   *
   * The cancelled-ID set deliberately survives: a cancelled child's
   * completion continuation can settle after this runs (it awaits its own
   * child destroy), and isCancelled() must still recognize that late result
   * as a purposeful discard rather than letting it dead-letter as
   * undelivered work. The set is capped, so keeping it is not a leak.
   */
  destroy(): void {
    this.agents.clear();
    this.hooks = {};
  }
}
