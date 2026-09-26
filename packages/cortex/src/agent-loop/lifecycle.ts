/**
 * The loop's lifecycle (CREATED -> ACTIVE -> DESTROYING -> DESTROYED) and
 * the two protocols whose ORDER is the point: abort() and destroy().
 *
 * abort(): drop parked wake deliveries -> abort the run's controller and
 * pi -> wait for pi to go idle -> wait for the Cortex-side turn unwind ->
 * wait for the gate (unless background deliveries are pending) -> renew
 * the controller -> advance the abort epoch.
 *
 * destroy(): mark destroying before any await (nothing new can start) ->
 * abort the controller -> ordered cleanup raced against a force-kill
 * deadline -> destroyed.
 *
 * Reference: cortex-architecture.md "Loop gate, turn unwind, abort epoch"
 */

import type { BudgetGuard } from '../budget-guard.js';
import type { CompactionManager } from '../compaction/index.js';
import type { EventBridge } from '../event-bridge.js';
import type { PromptWatchdogDiagnostics } from '../prompt-diagnostics.js';
import type { SubAgentManager } from '../sub-agent-manager.js';
import type { ClassifiedError, CortexLifecycleState, CortexLogger, LoopOriginContext, AgentTextOutput } from '../types.js';
import type { BackgroundDelivery } from './background-delivery.js';
import type { DeadLetterStore } from './delivery-failure.js';
import type { DeliveryQueues } from './delivery-queues.js';
import type { HandlerList } from './handler-list.js';
import type { McpAttachment } from './mcp-attachment.js';
import type { PendingAskRegistry } from './permissions.js';
import type { PiAgent } from './pi-agent.js';
import type { ProcessTracker } from './process-tracker.js';
import type { AbortState, LoopGate } from './run-control.js';
import { raceTimeout } from './run-control.js';
import type { SkillBinding } from './skills.js';
import type { SubAgentSpawner } from './sub-agent-spawner.js';
import type { ToolRegistry } from './tool-registry.js';
import type { TurnRunner } from './turn-runner.js';

/** Everything abort and teardown touch, in the order they touch it. */
export interface LifecycleParts {
  agent: Pick<PiAgent, 'abort' | 'waitForIdle' | 'reset'>;
  diagnostics: Pick<PromptWatchdogDiagnostics, 'recordAbortRequested' | 'startAbortWait' | 'finishAbortWait' | 'stop'>;
  runner: Pick<TurnRunner, 'unwound' | 'isPrompting'>;
  queues: Pick<DeliveryQueues, 'dropAllWakeForAbort' | 'clearForTeardown'>;
  abortState: AbortState;
  gate: LoopGate;
  background: Pick<BackgroundDelivery, 'pending' | 'deadLetterAllPending' | 'deliveryHandlers'>;
  subAgentManager: SubAgentManager;
  subAgents: Pick<SubAgentSpawner, 'spawnedHandlers' | 'completedHandlers' | 'failedHandlers'>;
  mcp: McpAttachment;
  processes: Pick<ProcessTracker, 'killAll'>;
  skills: Pick<SkillBinding, 'destroy'>;
  budgetGuard: Pick<BudgetGuard, 'destroy'>;
  eventBridge: Pick<EventBridge, 'destroy'>;
  /** Remove the loop's own event subscriptions. */
  unsubscribeEvents(): void;
  compactionManager: Pick<CompactionManager, 'destroy'>;
  tools: Pick<ToolRegistry, 'runtime'>;
  loopComplete: HandlerList<[LoopOriginContext]>;
  errorHandlers: HandlerList<[ClassifiedError, LoopOriginContext]>;
  turnComplete: HandlerList<[AgentTextOutput, LoopOriginContext]>;
  deadLetters: Pick<DeadLetterStore, 'handlers'>;
  asks: Pick<PendingAskRegistry, 'clear'>;
  origin: LoopOriginContext;
  logger: CortexLogger;
}

export class LoopLifecycle {
  private current: CortexLifecycleState = 'created';
  // In-flight destroy(). Concurrent destroy() calls share one teardown.
  private destroyPromise: Promise<void> | null = null;

  constructor(private readonly parts: () => LifecycleParts) {}

  get state(): CortexLifecycleState {
    return this.current;
  }

  /** Whether teardown has started (no new loops may start). */
  get isShuttingDown(): boolean {
    return this.current === 'destroying' || this.current === 'destroyed';
  }

  /** Throw the consumer-facing lifecycle error when teardown has started. */
  assertNotShuttingDown(): void {
    if (this.current === 'destroying') {
      throw new Error('Agent is being destroyed');
    }
    if (this.current === 'destroyed') {
      throw new Error('Agent has been destroyed');
    }
  }

  /** The first run moves the loop from created to active. */
  activate(): void {
    if (this.current === 'created') this.current = 'active';
  }

  async abort(): Promise<void> {
    const p = this.parts();
    // Captured BEFORE aborting, so the wait is scoped to the cancelled turn
    // and never to a later one a background delivery starts.
    const unwound = p.runner.unwound;

    p.diagnostics.recordAbortRequested();
    p.logger.info('abort requested', { isPrompting: p.runner.isPrompting });
    p.queues.dropAllWakeForAbort();
    const abort = p.abortState.begin();
    try {
      p.agent.abort();
      p.diagnostics.startAbortWait();
      try {
        await p.agent.waitForIdle();
        // waitForIdle() only covers pi's run. Renewing the controller before
        // the Cortex-side unwind classified the abort would make the
        // cancelled turn look like a retryable failure.
        await unwound;
      } finally {
        p.diagnostics.finishAbortWait();
      }

      // Wait for the gate so a follow-up prompt() does not fail fast on a
      // stale one. Bounded: every queued task either no-ops or cancels at
      // dequeue. Pending background deliveries start a fresh loop instead,
      // so do not block on them.
      if (p.background.pending.length === 0) {
        await p.gate.settled;
      }

      // renew() leaves a controller a newer turn already installed.
      if (!this.isShuttingDown) abort.renew();
    } finally {
      abort.end();
    }
    p.logger.info('abort complete');
  }

  destroy(timeoutMs: number): Promise<void> {
    if (this.current === 'destroyed') {
      return Promise.resolve(); // Already destroyed, idempotent
    }
    if (this.destroyPromise) {
      return this.destroyPromise; // Teardown already in progress, share it
    }
    const p = this.parts();

    p.logger.info('destroy start', {
      activeSubAgents: p.subAgentManager.activeCount,
      mcpConnections: p.mcp.manager.connectionCount,
    });

    // Before any await, so nothing can start a new loop during teardown.
    this.current = 'destroying';
    // Cancels retry backoff and classifies the current unwind as cancelled.
    p.abortState.abortCurrent();

    this.destroyPromise = (async () => {
      try {
        if (await raceTimeout(this.orderedCleanup(p), timeoutMs) === 'timeout') {
          p.processes.killAll();
        }
      } finally {
        p.diagnostics.stop();
        this.current = 'destroyed';
        p.logger.info('destroy complete');
      }
    })();
    return this.destroyPromise;
  }

  private async orderedCleanup(p: LifecycleParts): Promise<void> {
    // 1. Abort any in-progress agentic loop
    p.agent.abort();

    try {
      await p.agent.waitForIdle();
    } catch {
      // Ignore errors during wait (agent may already be idle)
    }

    // 1b. Queued tasks no-op now that the lifecycle is 'destroying'.
    await p.gate.settled;

    // 1c. Completions still awaiting delivery will never be delivered;
    // dead-letter them (handlers are still registered at this point).
    p.background.deadLetterAllPending('agent shut down before delivery');

    // 2. A full child destroy(), since a pi-level abort would leave the
    // child's MCP connections, subscriptions and timers alive.
    try {
      await p.subAgentManager.cancelAll(async (agent) => {
        await agent.destroy();
      });
    } catch {
      // Best-effort sub-agent cleanup
    }

    // 3. Emit onLoopComplete for final checkpoint (best-effort: a throwing
    // handler is logged and teardown continues)
    p.loopComplete.emit(p.origin);

    // 4. Closes connections only when this loop owns the manager
    await p.mcp.detach();

    // 5. Clear skill buffer and registry
    p.skills.destroy();
    p.subAgentManager.destroy();

    // 6. Unsubscribe all event listeners
    p.budgetGuard.destroy();
    p.eventBridge.destroy();
    p.unsubscribeEvents();

    // 7. Clear agent state
    p.agent.reset();

    // 8. Clean up compaction manager
    p.compactionManager.destroy();
    p.tools.runtime.destroy();

    // 9. The dead-letter store is kept: it must still answer after destroy().
    p.loopComplete.clear();
    p.errorHandlers.clear();
    p.turnComplete.clear();
    p.subAgents.spawnedHandlers.clear();
    p.subAgents.completedHandlers.clear();
    p.subAgents.failedHandlers.clear();
    p.background.deliveryHandlers.clear();
    p.deadLetters.handlers.clear();
    p.queues.clearForTeardown();
    p.asks.clear();
  }
}
