/**
 * AgentLoop's public surface, sub-agents and background work (spawning,
 * cancel and steer, snapshots, delivery and dead-letter hooks). AgentLoop
 * implements this interface; the member docs here are AgentLoop's
 * documentation.
 */

import type { SubAgentManager } from '../../sub-agent-manager.js';
import type { DeadLetteredBackgroundResult, SubAgentSnapshot, SubAgentSpawnConfig } from '../../types.js';

export interface LoopSubAgentApi {
  /**
   * Register a handler for sub-agent spawn events.
   */
  onSubAgentSpawned(handler: (taskId: string, instructions: string, background: boolean) => void): void;

  /**
   * Register a handler for sub-agent completion events.
   */
  onSubAgentCompleted(handler: (taskId: string, result: string, status: string, usage: unknown) => void): void;

  /**
   * Register a handler for sub-agent failure events.
   */
  onSubAgentFailed(handler: (taskId: string, error: string) => void): void;

  /**
   * Register a handler that fires when background sub-agent results are about
   * to be delivered to the parent agent, restarting its agentic loop.
   * Consumers can use this to update UI state (show spinners, etc.).
   */
  onBackgroundResultDelivery(handler: (taskIds: string[]) => void): void;

  /**
   * Register a handler that fires when content is dead-lettered: a
   * background completion whose delivery gave up (attempts exhausted,
   * elapsed budget spent, or a fatal error) or that the agent shut down
   * before delivering, or a parked wake delivery dropped after its
   * carrying runs failed repeatedly (kind 'wake_delivery'). The consumer
   * can surface the content to the user or re-drive the work; Cortex will
   * not retry it.
   */
  onBackgroundResultDeadLettered(
    handler: (result: DeadLetteredBackgroundResult) => void,
  ): void;

  /**
   * Get the SubAgentManager for direct sub-agent tracking.
   */
  getSubAgentManager(): SubAgentManager;

  /**
   * Spawn a background sub-agent and return its task ID immediately.
   * Used by consumers that manage delegated work outside the SubAgent tool.
   * Throws when the concurrency limit is reached.
   */
  spawnBackgroundSubAgent(params: Omit<SubAgentSpawnConfig, 'background'>): Promise<{ taskId: string }>;

  /**
   * Cancel a running sub-agent: destroy the child agent, untrack it, resolve
   * its completion promise as cancelled, and discard any pending or late
   * result so cancelled work is never delivered to the loop.
   * Returns false when the task ID is not an active sub-agent.
   */
  cancelSubAgent(taskId: string): Promise<boolean>;

  /**
   * Deliver a steering message to a running sub-agent by task ID. The
   * redirect rides the child's public steering queue, so it lands at the
   * next turn boundary of the child's in-flight run. Returns false when
   * the task ID is not an active sub-agent, the child is tearing down, or
   * no run is in flight on the child (not started yet, settle window, or
   * the end-of-cycle drain after its run ended): a redirect accepted in
   * those windows is never polled again and dies with the child, so it is
   * reported undeliverable and the caller decides how to re-route it.
   *
   * True means queued into a live run, not consumed: pi's last steering
   * poll of a run precedes its decision to stop, so a message queued after
   * that final poll (a near-run-end race the parent cannot detect) is
   * never polled and dies with the child. The in-flight gate narrows the
   * lost window to the tail of the final turn; it does not close it. A
   * caller that cannot afford to lose the redirect should confirm the
   * child acted on it rather than treat true as delivery.
   */
  steerSubAgent(taskId: string, message: string): boolean;

  /**
   * Snapshot of all currently running sub-agents, including live cost and
   * activity. Read-only; safe to call from anywhere (e.g. budget accounting
   * or status surfaces). Returns an empty array when none are running.
   */
  getActiveSubAgents(): SubAgentSnapshot[];

  /**
   * Dead-lettered content (newest last, bounded): background completions
   * whose delivery failed repeatedly, and wake deliveries dropped after
   * their carrying runs failed repeatedly. The consumer can surface these
   * to the user or re-drive the work; Cortex will not retry them.
   */
  getDeadLetteredBackgroundResults(): DeadLetteredBackgroundResult[];
}
