/**
 * Spawning and running sub-agents: foreground (the SubAgent tool blocks on
 * the child's result) and background (the result is delivered to the loop
 * later), plus cancel, steer, live snapshots, and the consumer's
 * onSubAgentSpawned/Completed/Failed fan-out.
 *
 * A child is its own AgentLoop, built by the host (so a test can stand in
 * for the factory) and tracked by the SubAgentManager. Its events are
 * forwarded onto this loop's EventBridge with childTaskId set, which is
 * what makes a running child visible live: tool activity for status
 * surfaces, and usage rolled into this loop's session totals.
 */

import { errorMessageOf } from '../error-classifier.js';
import type { EventBridge } from '../event-bridge.js';
import type { CortexModel } from '../model-wrapper.js';
import { assistantText, findLastAssistant, toolCallNames } from '../pi-message.js';
import type { SubAgentManager } from '../sub-agent-manager.js';
import type {
  CortexCompactionConfig,
  CortexLogger,
  SubAgentHandle,
  SubAgentResult,
  SubAgentSnapshot,
  SubAgentSpawnConfig,
  ThinkingLevel,
  TrackedSubAgent,
} from '../types.js';
import { summarizeToolActivity } from './background-task-text.js';
import type { ChildLoopParams } from './child-loop-config.js';
import { HandlerList } from './handler-list.js';

/** A spawned child loop, as the spawner drives it. */
export interface ChildLoop extends SubAgentHandle {
  prompt(input: string): Promise<unknown>;
  getConversationHistory(): unknown[];
  getEventBridge(): EventBridge;
}

/** What a spawn asks for (the SubAgent tool's and the consumer API's shape). */
export interface SubAgentSpawnParams {
  instructions: string;
  tools?: string[];
  systemPrompt?: string;
  maxTurns?: number;
  maxCost?: number;
  timeoutMs?: number;
  model?: CortexModel;
  thinkingLevel?: ThinkingLevel;
  compaction?: Partial<CortexCompactionConfig>;
  pool?: string;
}

export interface ForegroundSpawnResult {
  taskId: string;
  output: string;
  status: string;
  usage: { turns: number; cost: number; durationMs: number };
}

export interface SubAgentSpawnerPorts {
  manager: SubAgentManager;
  /** Build a child loop (the host's factory, resolved per call). */
  createChild(params: ChildLoopParams): Promise<ChildLoop>;
  eventBridge: EventBridge;
  /** A background child finished: hand its result to background delivery. */
  onBackgroundComplete(item: { kind: 'subagent'; taskId: string; result: SubAgentResult }): Promise<void>;
  /** Drop a cancelled child's result that is already queued for delivery. */
  purgePendingResult(taskId: string): void;
  logger: CortexLogger;
}

export class SubAgentSpawner {
  readonly spawnedHandlers: HandlerList<[taskId: string, instructions: string, background: boolean]>;
  readonly completedHandlers: HandlerList<[taskId: string, result: string, status: string, usage: unknown]>;
  readonly failedHandlers: HandlerList<[taskId: string, error: string]>;

  constructor(private readonly ports: SubAgentSpawnerPorts) {
    const { logger } = ports;
    const byTask = (taskId: string): Record<string, unknown> => ({ taskId });
    this.spawnedHandlers = new HandlerList('onSubAgentSpawned', logger, byTask);
    this.completedHandlers = new HandlerList('onSubAgentCompleted', logger, byTask);
    this.failedHandlers = new HandlerList('onSubAgentFailed', logger, byTask);
    ports.manager.setHooks({
      onSpawned: (taskId, instructions, background) => {
        this.spawnedHandlers.emit(taskId, instructions, background);
      },
      onCompleted: (taskId, result, status, usage) => {
        this.completedHandlers.emit(taskId, result, status, usage);
      },
      onFailed: (taskId, error) => {
        this.failedHandlers.emit(taskId, error);
      },
    });

    // Track child tool activity for background state visibility.
    // Forwarded child events arrive on the parent's EventBridge with childTaskId set.
    ports.eventBridge.on('tool_call_start', (event) => {
      if (!event.childTaskId) return;
      const payload = event.payload as { toolName?: string; args?: Record<string, unknown> } | undefined;
      const toolName = payload?.toolName ?? 'unknown';
      const args = payload?.args ?? {};
      const summary = summarizeToolActivity(toolName, args);
      // childTaskId is a path when the event was re-forwarded from a deeper
      // descendant; attribute activity to this loop's direct child (the
      // first segment), which is the task ID the manager tracks.
      const directChildId = event.childTaskId.split('/')[0]!;
      ports.manager.updateToolActivity(directChildId, toolName, summary);
    });
  }

  /** Spawn a foreground sub-agent and block until it completes (the SubAgent tool). */
  async spawnForeground(params: SubAgentSpawnParams): Promise<ForegroundSpawnResult> {
    const { taskId, startTime } = this.announce(params, false);
    try {
      const childAgent = await this.createTracked(params, taskId, startTime, false);
      if (!childAgent) {
        return {
          taskId,
          output: '',
          status: 'failed',
          usage: { turns: 0, cost: 0, durationMs: 0 },
        };
      }

      // Forward child events to parent's EventBridge for real-time visibility
      const unsubForward = this.ports.eventBridge.forwardFrom(
        childAgent.getEventBridge(),
        taskId,
      );

      try {
        const result = await this.run(
          childAgent,
          params.instructions,
          taskId,
          startTime,
          params.timeoutMs,
        );

        this.ports.logger.info('subagent complete', {
          taskId,
          status: result.status,
          turns: result.usage.turns,
          cost: result.usage.cost,
          durationMs: result.usage.durationMs,
        });

        return {
          taskId,
          output: result.output,
          status: result.status,
          usage: result.usage,
        };
      } finally {
        // Always stop forwarding, whether the sub-agent succeeded or failed
        unsubForward();
      }
    } catch (err) {
      this.ports.logger.error('subagent failed', {
        taskId,
        error: errorMessageOf(err),
      });
      this.ports.manager.fail(taskId, errorMessageOf(err));
      return {
        taskId,
        output: '',
        status: 'failed',
        usage: { turns: 0, cost: 0, durationMs: Date.now() - startTime },
      };
    }
  }

  /**
   * Spawn a background sub-agent and return its task ID immediately; the
   * result is delivered to the loop when the child settles. Throws when
   * the concurrency limit rejects the child.
   */
  async spawnBackground(params: SubAgentSpawnParams): Promise<{ taskId: string }> {
    const { taskId, startTime } = this.announce(params, true);
    const childAgent = await this.createTracked(params, taskId, startTime, true);
    if (!childAgent) throw new Error('Concurrency limit reached');

    // Forward child events to the parent's EventBridge, exactly like the
    // foreground path: this is what makes background children visible live
    // (tool activity for the headline block, usage accounting) instead of
    // only via a post-completion summary.
    const unsubForward = this.ports.eventBridge.forwardFrom(
      childAgent.getEventBridge(),
      taskId,
    );

    // Run the sub-agent in the background. When it completes, deliver the
    // result back to the parent agent and restart its agentic loop.
    this.run(childAgent, params.instructions, taskId, startTime, params.timeoutMs)
      .then((result) => {
        // The child has settled (and been destroyed by run); stop
        // forwarding before delivery so listeners never leak per task.
        unsubForward();
        this.ports.logger.info('subagent complete', {
          taskId,
          background: true,
          status: result.status,
          turns: result.usage.turns,
          cost: result.usage.cost,
          durationMs: result.usage.durationMs,
        });
        return this.ports.onBackgroundComplete({ kind: 'subagent', taskId, result });
      })
      .catch((err) => {
        unsubForward();
        this.ports.logger.error('subagent failed', {
          taskId,
          background: true,
          error: errorMessageOf(err),
        });
        this.ports.manager.fail(taskId, errorMessageOf(err));
      });

    return { taskId };
  }

  /**
   * The consumer-API spawn: fail before building the child when the pool
   * is at its limit. track() still re-checks under the same limit, so a
   * concurrent spawn cannot slip past.
   */
  async spawnBackgroundChecked(params: Omit<SubAgentSpawnConfig, 'background'>): Promise<{ taskId: string }> {
    const { manager } = this.ports;
    if (!manager.canSpawn(params.pool)) {
      throw new Error(
        `Cannot spawn sub-agent: concurrency limit reached ` +
        `(${manager.activeCountInPool(params.pool)}/` +
        `${manager.poolLimit(params.pool)} active` +
        `${params.pool !== undefined ? ` in pool "${params.pool}"` : ''}).`,
      );
    }
    return this.spawnBackground(params);
  }

  /**
   * Cancel a running sub-agent: destroy it, untrack it, resolve its
   * completion as cancelled, and discard any pending or late result.
   */
  async cancel(taskId: string): Promise<boolean> {
    const cancelled = await this.ports.manager.cancel(taskId, async (agent) => {
      await agent.destroy();
    });
    if (cancelled) {
      // Deliberately redundant with the drain's isCancelled() check (which
      // alone keeps a cancelled result out of the loop): purging here makes
      // cancellation prompt, and keeps that check from being the only guard.
      this.ports.purgePendingResult(taskId);
      this.ports.logger.info('subagent cancelled', { taskId });
    }
    return cancelled;
  }

  /** Steer a running child's in-flight run; false when it cannot take one. */
  steer(taskId: string, message: string): boolean {
    const outcome = this.ports.manager.steer(taskId, message);
    if (outcome === null) return false;
    this.ports.logger.info('subagent steered', { taskId, outcome });
    return true;
  }

  /** Live snapshot of every running sub-agent. */
  snapshots(): SubAgentSnapshot[] {
    const { manager } = this.ports;
    const snapshots: SubAgentSnapshot[] = [];
    for (const taskId of manager.getActiveTaskIds()) {
      const entry = manager.get(taskId);
      if (!entry) continue;
      const childAgent = entry.agent;
      const budget = childAgent.getBudgetGuard();
      snapshots.push({
        taskId,
        instructions: entry.instructions,
        background: entry.background,
        spawnedAt: entry.spawnedAt,
        status: entry.pendingPermission ? 'waiting-for-permission' : 'running',
        toolCount: entry.toolCount,
        lastToolName: entry.lastToolName,
        lastToolSummary: entry.lastToolSummary,
        lastToolStartedAt: entry.lastToolStartedAt,
        liveCostUsd: budget.getTotalCost(),
        turnsUsed: budget.getTurnCount(),
      });
    }
    return snapshots;
  }

  private announce(params: SubAgentSpawnParams, background: boolean): { taskId: string; startTime: number } {
    const taskId = crypto.randomUUID();
    this.ports.logger.info('subagent spawned', {
      taskId,
      background,
      instructionsLength: params.instructions.length,
      tools: params.tools,
      maxTurns: params.maxTurns,
      ...(params.pool !== undefined ? { pool: params.pool } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    });
    return { taskId, startTime: Date.now() };
  }

  /**
   * Build the child and track it. Null when the concurrency limit rejects
   * it, in which case the fully constructed child is torn down (it would
   * otherwise leak event subscriptions, compaction timers, tool runtime).
   */
  private async createTracked(
    params: SubAgentSpawnParams,
    taskId: string,
    startTime: number,
    background: boolean,
  ): Promise<ChildLoop | null> {
    let resolveCompletion!: (result: SubAgentResult) => void;
    const completion = new Promise<SubAgentResult>((resolve) => {
      resolveCompletion = resolve;
    });

    const childAgent = await this.ports.createChild({ ...params, taskId, background });

    const tracked: TrackedSubAgent = {
      taskId,
      agent: childAgent,
      instructions: params.instructions,
      background,
      spawnedAt: startTime,
      completion,
      resolve: resolveCompletion,
      toolCount: 0,
      lastToolName: null,
      lastToolSummary: null,
      lastToolStartedAt: null,
      pendingPermission: null,
      ...(params.pool !== undefined ? { pool: params.pool } : {}),
    };

    if (!this.ports.manager.track(tracked)) {
      this.ports.logger.warn('subagent rejected', {
        taskId,
        active: this.ports.manager.activeCountInPool(params.pool),
        limit: this.ports.manager.poolLimit(params.pool),
      });
      try {
        await childAgent.destroy();
      } catch {
        // Best-effort cleanup
      }
      return null;
    }
    return childAgent;
  }

  /**
   * Run a child to completion and report the outcome to the manager; the
   * child is destroyed however the run ends.
   *
   * When `timeoutMs` is set, a wall-clock timer aborts the child on expiry
   * and the result reports status 'timed_out' (with whatever partial output
   * the child's transcript holds), whether the aborted run settles by
   * resolving or by rejecting.
   */
  private async run(
    childAgent: ChildLoop,
    instructions: string,
    taskId: string,
    startTime: number,
    timeoutMs?: number,
  ): Promise<SubAgentResult> {
    const { manager, logger } = this.ports;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        logger.warn('subagent wall-clock timeout', { taskId, timeoutMs });
        // Abort (not destroy) so the child unwinds cleanly; both settle
        // paths below destroy it once the run ends.
        void childAgent.abort().catch(() => {});
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    const usageOf = (): SubAgentResult['usage'] => ({
      turns: childAgent.getBudgetGuard().getTurnCount(),
      cost: childAgent.getBudgetGuard().getTotalCost(),
      durationMs: Date.now() - startTime,
      contextTokens: childAgent.currentContextTokenCount,
    });

    try {
      let result: SubAgentResult;
      try {
        await childAgent.prompt(instructions);
        const history = childAgent.getConversationHistory();
        result = {
          output: assistantText(findLastAssistant(history)),
          // An aborted run can settle by resolving (stopReason 'aborted'), so
          // the timeout flag decides, not the settle path.
          status: timedOut ? 'timed_out' : 'completed',
          usage: usageOf(),
          toolCalls: history.flatMap((msg) => toolCallNames(msg).map((name) => ({ name, durationMs: 0 }))),
        };
        manager.complete(taskId, result);
      } catch (err) {
        // A cancel destroys the child mid-run, which surfaces here as an
        // abort-shaped prompt failure. The cancel already resolved the
        // tracked completion as cancelled and fired its hooks; report the
        // same status instead of overriding it with 'failed' (the foreground
        // path returns this result directly to the SubAgent tool).
        const cancelled = manager.isCancelled(taskId);
        result = {
          // A timed-out run rejects with an abort-shaped failure; salvage the
          // partial output so the spawner sees what the child got done.
          output: timedOut && !cancelled
            ? assistantText(findLastAssistant(childAgent.getConversationHistory()))
            : '',
          status: cancelled ? 'cancelled' : timedOut ? 'timed_out' : 'failed',
          usage: usageOf(),
        };
        if (!cancelled) {
          if (timedOut) {
            // Timeout is a terminal outcome with a result, not an error:
            // resolve the tracked completion with timed_out so the status
            // reaches hooks and the background delivery path.
            manager.complete(taskId, result);
          } else {
            manager.fail(taskId, errorMessageOf(err));
          }
        }
      }
      try {
        await childAgent.destroy();
      } catch {
        // Best-effort cleanup
      }
      return result;
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    }
  }
}
