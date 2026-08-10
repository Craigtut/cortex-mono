/**
 * The reasoner's duplex tools: Deliver (the up-channel producer,
 * review-findings F1) and SteerSubAgent (parent-to-child steering, D12).
 *
 * These are ordinary tools, not control tools: they do not set terminate
 * (the reasoner keeps working after a delivery), and validation errors may
 * surface normally (the reasoner is a full-tier loop with normal error
 * recovery, not a presence loop that must stay bounded).
 */

import { Type } from 'typebox';
import type { CortexTool } from '../tool-contract.js';
import type { WakeClass } from '../session-log.js';
import type { SubAgentSnapshot } from '../types.js';

// ---------------------------------------------------------------------------
// Deliver
// ---------------------------------------------------------------------------

/** Result of handing a delivery to the router. */
export interface DeliveryIntakeResult {
  delivered: boolean;
  /** The wake class the router actually applied (it may demote, D19). */
  wake?: WakeClass;
  /** Why the delivery was absorbed, when it was. */
  reason?: string;
}

/** What the Deliver tool dispatches into (implemented by DuplexRouter). */
export interface DeliveryTarget {
  deliverFromReasoner(
    content: string,
    wake: WakeClass | undefined,
    meta?: { implicit?: boolean; synthetic?: boolean; terminal?: boolean },
  ): DeliveryIntakeResult;
}

const WAKE_VALUES: ReadonlySet<string> = new Set(['interrupt', 'when_idle', 'silent']);

/** Build the reasoner's Deliver tool ({content, wake}, communication.md). */
export function buildDeliverTool(router: DeliveryTarget): CortexTool {
  return {
    name: 'Deliver',
    description:
      'Deliver content to the user through the conversation surface. wake: ' +
      "'interrupt' only for things the user must hear now, 'when_idle' for " +
      "finished results (default), 'silent' for milestones and progress " +
      'notes. The conversation surface rephrases; deliver substance, not ' +
      'presentation.',
    parameters: Type.Object({
      content: Type.String({ description: 'What to deliver.' }),
      wake: Type.Optional(Type.Union([
        Type.Literal('interrupt'),
        Type.Literal('when_idle'),
        Type.Literal('silent'),
      ], { description: "Wake class. Default: 'when_idle'." })),
    }),
    execute: async (params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const content = typeof p['content'] === 'string' ? p['content'].trim() : '';
      if (content.length === 0) {
        return 'Nothing delivered: content was empty.';
      }
      const rawWake = p['wake'];
      const wake = typeof rawWake === 'string' && WAKE_VALUES.has(rawWake)
        ? (rawWake as WakeClass)
        : undefined;
      const result = router.deliverFromReasoner(content, wake);
      if (!result.delivered) {
        return `Not delivered (${result.reason ?? 'absorbed'}).`;
      }
      return `Delivered (${result.wake ?? 'when_idle'}).`;
    },
  };
}

// ---------------------------------------------------------------------------
// SteerSubAgent
// ---------------------------------------------------------------------------

/** What SteerSubAgent needs from the owning loop. */
export interface SubAgentSteerTarget {
  steerSubAgent(taskId: string, message: string): boolean;
  getActiveSubAgents(): SubAgentSnapshot[];
}

/**
 * Build the reasoner's SteerSubAgent tool: redirect a running sub-agent
 * without killing it (D12). Steers always come through the reasoner; there
 * is no facade fast-path to a named child (D20).
 */
export function buildSteerSubAgentTool(loop: SubAgentSteerTarget): CortexTool {
  return {
    name: 'SteerSubAgent',
    description:
      'Redirect a running sub-agent without cancelling it. The message is ' +
      "queued into the sub-agent's run and lands at its next turn boundary. " +
      'Prefer this over cancel-and-respawn for changes of direction.',
    parameters: Type.Object({
      taskId: Type.String({ description: 'The sub-agent task id.' }),
      message: Type.String({ description: 'The redirect, as one clear instruction.' }),
    }),
    execute: async (params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const taskId = typeof p['taskId'] === 'string' ? p['taskId'] : '';
      const message = typeof p['message'] === 'string' ? p['message'].trim() : '';
      if (taskId.length === 0 || message.length === 0) {
        return 'Steer failed: taskId and message are both required.';
      }
      const queued = loop.steerSubAgent(taskId, message);
      if (queued) {
        return `Redirect queued into ${taskId}; it lands at the sub-agent's next turn boundary.`;
      }
      const active = loop.getActiveSubAgents().map((snapshot) => snapshot.taskId);
      return active.length > 0
        ? `Could not steer ${taskId}: no live run for that task right now. Active sub-agents: ${active.join(', ')}. ` +
          'Re-check the id, or wait for its run to start.'
        : `Could not steer ${taskId}: no sub-agents are running.`;
    },
  };
}
