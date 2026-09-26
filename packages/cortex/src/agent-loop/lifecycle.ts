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
    // Capture the current turn's unwind promise BEFORE aborting, so the
    // wait below is scoped to the turn being cancelled and never to a later
    // turn started by a background delivery.
    const unwound = p.runner.unwound;

    p.diagnostics.recordAbortRequested();
    p.logger.info('abort requested', { isPrompting: p.runner.isPrompting });
    p.queues.dropAllWakeForAbort();
    // A delivery can also park DURING the await windows below; the abort
    // epoch cancels it the same way (run-control.ts).
    const abort = p.abortState.begin();
    try {
      p.agent.abort();
      p.diagnostics.startAbortWait();
      try {
        await p.agent.waitForIdle();
        // waitForIdle() only covers pi-agent-core's run promise (it resolves,
        // never rejects). The Cortex-side unwind (retry classification, the
        // prompt finally block) may not have observed the abort yet, so wait
        // for it too: renewing the controller before that classification
        // ran would reclassify the cancelled turn as a retryable failure.
        await unwound;
      } finally {
        p.diagnostics.finishAbortWait();
      }

      // When no background delivery is pending, also wait for the gate to
      // release the aborted cycle so a follow-up prompt() cannot spuriously
      // fail fast on a stale gate. This is bounded: a queued task is either
      // the just-unwound running turn (its finally drain is an empty no-op
      // before release), a same-frame prompt() that has not started yet
      // (it sees the aborted controller at dequeue and cancels without ever
      // reaching pi), or a wake sweep that finds the parked list dropped
      // above (one parked during this window is dropped by the epoch gate)
      // and never starts a run. When deliveries ARE pending they start a
      // fresh (non-aborted) loop, so return rather than block on it.
      if (p.background.pending.length === 0) {
        await p.gate.settled;
      }

      // Reset so the agent is reusable, unless teardown owns the controller
      // now or a newer turn (e.g. a background delivery that started during
      // the wait) already installed its own controller.
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

    // Transition BEFORE any await so nothing can start a new loop while
    // teardown runs: prompt() rejects, queued gate tasks no-op, background
    // completions are dropped, and the end-of-cycle drain is skipped.
    this.current = 'destroying';
    // Cancel Cortex-side waits immediately: a pending retry-backoff timer is
    // cleared by its abort listener, and the current turn's unwind is
    // classified as cancelled instead of scheduling further retries.
    p.abortState.abortCurrent();

    this.destroyPromise = (async () => {
      try {
        // Race the cleanup against a force-kill deadline.
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

    // 1b. Wait for the loop gate to drain: the aborted cycle's Cortex-side
    // unwind plus any queued delivery tasks (which no-op now that the
    // lifecycle is 'destroying'). Bounded by destroy()'s force-kill race.
    await p.gate.settled;

    // 1c. Completions still awaiting delivery will never be delivered;
    // dead-letter them (handlers are still registered at this point).
    p.background.deadLetterAllPending('agent shut down before delivery');

    // 2. Cancel all sub-agents with a full child destroy(), not just a
    // pi-level abort, which would leave the child's MCP connections, event
    // subscriptions, and compaction timers alive. Bounded by this
    // destroy()'s own force-kill deadline.
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

    // 4. Detach from the MCP manager; close connections only when owned (a
    // shared manager's connections belong to its owner and outlive this loop)
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

    // 9. Clear all handler lists and the loop-owned queues. The dead-letter
    // store itself is deliberately kept: it must still answer after
    // destroy() (which itself dead-letters anything pending).
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
