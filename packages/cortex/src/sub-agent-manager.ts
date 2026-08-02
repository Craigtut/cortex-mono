/**
 * SubAgentManager: tracks active sub-agents, enforces concurrency limits,
 * manages lifecycle, and delivers background completion notifications.
 *
 * Each sub-agent is an independent CortexAgent instance tracked by task ID.
 * The manager does not own the CortexAgent; it tracks references and
 * coordinates lifecycle events for the consumer.
 *
 * References:
 *   - docs/cortex/tools/sub-agent.md
 *   - docs/cortex/plans/phase-4-sub-agents-and-skills.md
 */

import type { SubAgentResult, TrackedSubAgent } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubAgentManagerConfig {
  /** Maximum concurrent sub-agents. Default: 4. */
  maxConcurrent: number;
}

export interface SubAgentLifecycleHooks {
  onSpawned?: (taskId: string, instructions: string, background: boolean) => void;
  onCompleted?: (taskId: string, result: string, status: string, usage: unknown) => void;
  onFailed?: (taskId: string, error: string) => void;
}

// ---------------------------------------------------------------------------
// SubAgentManager
// ---------------------------------------------------------------------------

/** Cancelled task IDs retained for late-completion discard checks. */
const MAX_CANCELLED_TASK_IDS = 200;

export class SubAgentManager {
  private readonly agents = new Map<string, TrackedSubAgent>();
  private readonly maxConcurrent: number;
  private hooks: SubAgentLifecycleHooks = {};
  private readonly cancelledTaskIds = new Set<string>();

  constructor(config?: Partial<SubAgentManagerConfig>) {
    this.maxConcurrent = config?.maxConcurrent ?? 4;
  }

  /**
   * Set lifecycle hooks. Called by CortexAgent to wire consumer event handlers.
   */
  setHooks(hooks: SubAgentLifecycleHooks): void {
    this.hooks = hooks;
  }

  /**
   * Check if another sub-agent can be spawned within the concurrency limit.
   */
  canSpawn(): boolean {
    return this.agents.size < this.maxConcurrent;
  }

  /**
   * Get the number of currently active sub-agents.
   */
  get activeCount(): number {
    return this.agents.size;
  }

  /**
   * Get the concurrency limit.
   */
  get limit(): number {
    return this.maxConcurrent;
  }

  /**
   * Register a newly spawned sub-agent.
   * Returns false if the concurrency limit would be exceeded.
   */
  track(entry: TrackedSubAgent): boolean {
    if (this.agents.size >= this.maxConcurrent) {
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
  async cancel(taskId: string, abortFn: (agent: unknown) => Promise<void>): Promise<boolean> {
    const entry = this.agents.get(taskId);
    if (!entry) return false;

    this.agents.delete(taskId);
    this.markCancelled(taskId);

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
   * Whether a task was cancelled. Delivery paths use this to discard results
   * produced by a child that survived long enough to finish after its cancel.
   */
  isCancelled(taskId: string): boolean {
    return this.cancelledTaskIds.has(taskId);
  }

  /** Record a cancelled task ID, evicting the oldest past the cap. */
  private markCancelled(taskId: string): void {
    this.cancelledTaskIds.add(taskId);
    if (this.cancelledTaskIds.size > MAX_CANCELLED_TASK_IDS) {
      const oldest = this.cancelledTaskIds.values().next().value;
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
   * @param abortFn - Function to tear down a CortexAgent (passed to avoid circular dep)
   */
  async cancelAll(abortFn: (agent: unknown) => Promise<void>): Promise<void> {
    const entries = [...this.agents.values()];
    this.agents.clear();
    for (const entry of entries) {
      this.markCancelled(entry.taskId);
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
   */
  destroy(): void {
    this.agents.clear();
    this.cancelledTaskIds.clear();
    this.hooks = {};
  }
}
