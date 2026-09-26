/**
 * AgentLoop's public surface, running turns (prompting, run state, idle
 * digestion, abort, teardown). AgentLoop implements this interface; the
 * member docs here are AgentLoop's documentation.
 */

import type { CortexLifecycleState } from '../../types.js';
import type { IdleDigestionOptions, IdleDigestionResult } from '../context-pipeline.js';
import type { DirectCompletionOptions } from '../direct-completion.js';

export interface LoopRunApi {
  /**
   * Send a prompt to the agent and run the agentic loop.
   *
   * Transitions from CREATED to ACTIVE on first call.
   * Catches errors, classifies them, and emits onError.
   *
   * Every loop start (consumer prompt() calls and background-completion
   * deliveries) is serialized through an internal gate, so a concurrent
   * prompt() can never corrupt the running loop's tool runtime or history
   * boundary. A prompt() issued while a loop is active or queued fails fast
   * BEFORE any shared state is touched; use steer() to reach a running loop.
   *
   * @param input - The prompt text
   * @returns The agent's response (opaque, from pi-agent-core)
   * @throws Error if the agent has been destroyed or is already prompting
   */
  prompt(input: string, options?: DirectCompletionOptions): Promise<unknown>;

  /**
   * True while any gate task is running or queued: a prompt cycle, a
   * background-completion drain, an idle digestion pass, or a delivery
   * sweep. While true, prompt() fails fast and deliver() steers or queues
   * instead of starting a turn.
   */
  readonly isLoopActive: boolean;

  /**
   * True while a logical turn is in flight: from runPromptOnce entry (the
   * first agent.prompt attempt) through its retry continuations until the
   * turn unwinds. Narrower than {@link isLoopActive}, which also covers
   * gate tasks that never run pi (an idle digestion pass, an empty drain,
   * the end-of-cycle drain window after a run ended). A steer() is only
   * meaningful while this is true: pi polls its steering queue at run
   * start and at turn boundaries within a run, so content queued when no
   * turn is in flight waits for whatever run starts next.
   */
  readonly isPrompting: boolean;

  /**
   * Cause tags of the run currently holding the gate: the tags of every
   * wake delivery this run consumed (its own prompt input, spliced parked
   * content, or a sweep batch). Empty while no run is live and for runs
   * that carry no tagged content (background drains, untagged prompts).
   * Set at run start in the same frame the delivery batches are taken and
   * cleared in the run's own finally, so the value is always exactly the
   * live run's; a later run can never inherit a previous run's tags. The
   * duplex facade reads this to stamp log-entry causation (D16 binds
   * consent to those stamps, docs/cortex/duplex/log-and-context.md).
   */
  readonly activeRunCauseTags: readonly unknown[];

  /**
   * Resolve once the loop gate is empty: no gate task running or queued.
   * This is the awaitable form of {@link isLoopActive}, and the primitive
   * settlement predicates build on. It deliberately keys on gate depth
   * rather than {@link isPrompting}, which reads idle while gate tasks
   * (queued drains, delivery sweeps, idle digestion) are still pending.
   *
   * Event-driven, not polled: each pass awaits the current gate tail and
   * re-checks, so tasks enqueued by tasks (a run scheduling a drain, a
   * parked delivery scheduling a sweep) extend the wait. The depth is zero
   * in the frame this resolves in, but the caller's continuation runs a
   * microtask later, and an unrelated continuation can enqueue a gate task
   * in between; a caller that needs check-then-act atomicity must therefore
   * re-check {@link isLoopActive} synchronously before acting, and wait
   * again if the gate refilled.
   */
  waitForLoopIdle(): Promise<void>;

  /**
   * Abort the current agentic loop without destroying the agent.
   * The agent remains usable for subsequent prompts.
   */
  abort(): Promise<void>;

  /**
   * Ordered cleanup of all resources.
   * Called by the consumer when the agent is no longer needed.
   *
   * Steps:
   * 1. Abort any in-progress agentic loop
   * 2. Wait for idle (with timeout)
   * 3. Cancel all sub-agents (stub, wired in Phase 4)
   * 4. Emit onLoopComplete for final checkpoint (best-effort)
   * 5. Close all MCP client connections (kills stdio subprocesses, closes HTTP)
   * 6. Clear skill buffer (stub, wired in Phase 4)
   * 7. Unsubscribe all event listeners
   * 8. Clear agent state
   * 9. Mark as destroyed
   *
   * @param timeoutMs - Maximum time to wait for cleanup (default: 8000ms)
   */
  destroy(timeoutMs?: number): Promise<void>;

  /**
   * Whether the agent is currently running an agentic loop.
   */
  readonly isRunning: boolean;

  /**
   * Get the current lifecycle state.
   */
  readonly state: CortexLifecycleState;

  /**
   * The number of messages in agent.state.messages before the current
   * prompt() call. Used by the cache breakpoint system to distinguish
   * "old history" (cacheable) from "new tick content" (ephemeral).
   */
  readonly prePromptMessageCount: number;

  /**
   * Run deferred digestion OUTSIDE a prompt: pending observation buffering
   * plus the threshold pass (observation activation, reflection, and, for
   * the classic strategy, summarization), with blocking work explicitly
   * allowed even under the non-blocking posture. This is the primitive
   * behind scheduling digestion in idle windows: without it, observation
   * only triggers on turn_end and compaction only runs inside
   * transformContext, so there is no way to do either between turns.
   *
   * Serialized through the loop gate, so it can never race a running
   * turn's history mutations; called while a turn is active, it runs after
   * that turn finishes. prompt() fails fast while digestion holds the gate
   * (deliver() parks or queues as usual). Both phases are bounded by
   * options.observerTimeoutMs (default 60s): the observer catch-up waits
   * time out inside the compaction manager, and the blocking threshold
   * pass is raced against the same deadline here, so a hung utility
   * request (observer, reflector, or summarizer) times the digestion out
   * instead of wedging the gate. A timed-out pass is invalidated, not just
   * abandoned: when its hung call eventually settles, its history rewrite
   * is discarded instead of being applied over messages a later prompt has
   * appended in the meantime.
   */
  digestIdle(options?: IdleDigestionOptions): Promise<IdleDigestionResult>;
}
