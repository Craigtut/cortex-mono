/**
 * The talker's control toolset (docs/cortex/duplex/communication.md, D8):
 * spawn_task, steer_task, cancel_task, quick_lookup, answer_ask. Each is a
 * local, sub-millisecond dispatch into the facade router.
 *
 * The D17 contract is load-bearing and non-negotiable: control tools NEVER
 * throw and NEVER return isError, because pi's error results omit
 * `terminate` and the batch terminates only when EVERY result sets it, so a
 * single loud failure reopens the talker's loop (review-findings F9 traced
 * an unbounded retry cycle to exactly this, with no attacker involved).
 * Every outcome, including validation failure and unknown task, returns
 * {content, terminate: true} as a bare uniform receipt the talker can
 * voice. Bare receipts also keep imitable decision text out of the
 * transcript (D16's few-shot-precedent mitigation).
 *
 * Schemas are deliberately permissive (every field optional, nothing
 * rejected on shape): pi validates arguments BEFORE execute and produces
 * its own error result on failure, which is outside this contract's reach.
 * Argument problems are found inside execute and reported as receipts
 * instead. A catastrophically malformed call (unparseable arguments) still
 * costs one bounded recovery turn, which the talker's facade-set hard
 * maxTurns caps.
 */

import { Type } from 'typebox';
import type { CortexTool } from '../tool-contract.js';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const CONTROL_TOOL_NAMES = [
  'spawn_task',
  'steer_task',
  'cancel_task',
  'quick_lookup',
  'answer_ask',
] as const;

export type ControlToolName = (typeof CONTROL_TOOL_NAMES)[number];

const CONTROL_TOOL_NAME_SET: ReadonlySet<string> = new Set(CONTROL_TOOL_NAMES);

/** Whether a tool name is one of the talker's control tools. */
export function isControlToolName(name: string): boolean {
  return CONTROL_TOOL_NAME_SET.has(name);
}

// ---------------------------------------------------------------------------
// Dispatch target
// ---------------------------------------------------------------------------

/**
 * What the control tools dispatch into (implemented by DuplexRouter). Every
 * method returns the receipt text to voice; none may throw in normal
 * operation (the tool wrapper still guards, since a throw here would
 * surface as a pi error result without terminate).
 */
export interface ControlDispatchTarget {
  dispatchSpawn(instructions: unknown): string;
  dispatchSteer(taskAlias: unknown, message: unknown): string;
  dispatchCancel(taskAlias: unknown): string;
  dispatchLookup(question: unknown): string;
  dispatchAnswerAsk(askId: unknown, decision: unknown, reason: unknown): string;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * The uniform control-tool result: a bare voiceable receipt with
 * terminate: true. Shaped as a content ARRAY so the loop's result adapter
 * passes it through untouched; a bare string return would be re-wrapped and
 * silently lose `terminate` (communication.md result contract).
 */
export function controlReceipt(text: string): {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, never>;
  terminate: true;
} {
  return {
    content: [{ type: 'text', text }],
    details: {},
    terminate: true,
  };
}

const DISPATCH_FAILED_RECEIPT =
  'That did not go through; tell the user and try again.';

/** Wrap a dispatch so no outcome can ever throw or lose terminate. */
function safeDispatch(dispatch: () => string): ReturnType<typeof controlReceipt> {
  let text: string;
  try {
    text = dispatch();
  } catch {
    // Router bugs land here; the receipt keeps the exchange bounded and the
    // router's own lifecycle logging records what failed.
    text = DISPATCH_FAILED_RECEIPT;
  }
  return controlReceipt(text);
}

// ---------------------------------------------------------------------------
// Tool builders
// ---------------------------------------------------------------------------

/**
 * Build the talker's five control tools, dispatching into the router.
 * Registered by the facade on the talker loop only (D5: consumer tools,
 * I/O tools, and MCP tools never reach the talker; these never reach the
 * reasoner).
 */
export function buildControlTools(router: ControlDispatchTarget): CortexTool[] {
  const spawnTask: CortexTool = {
    name: 'spawn_task',
    description:
      'Hand new work to the background agent. Speak to the user first, then ' +
      'call. Keep instructions to ONE sentence naming the task; the ' +
      'conversation itself is forwarded, so do not restate details.',
    parameters: Type.Object({
      instructions: Type.Optional(Type.String({
        description: 'One sentence naming the task.',
      })),
    }),
    execute: async (params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      return safeDispatch(() => router.dispatchSpawn(p['instructions']));
    },
  };

  const steerTask: CortexTool = {
    name: 'steer_task',
    description:
      'Redirect or update background work in progress. Speak to the user ' +
      'first, then call. taskAlias picks a specific task when several run.',
    parameters: Type.Object({
      taskAlias: Type.Optional(Type.String({
        description: 'Alias of the task to redirect (omit for the current work).',
      })),
      message: Type.Optional(Type.String({
        description: 'One sentence describing the redirect.',
      })),
    }),
    execute: async (params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      return safeDispatch(() => router.dispatchSteer(p['taskAlias'], p['message']));
    },
  };

  const cancelTask: CortexTool = {
    name: 'cancel_task',
    description:
      'Stop a background task the user no longer wants. Speak to the user ' +
      'first, then call.',
    parameters: Type.Object({
      taskAlias: Type.Optional(Type.String({
        description: 'Alias of the task to cancel.',
      })),
    }),
    execute: async (params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      return safeDispatch(() => router.dispatchCancel(p['taskAlias']));
    },
  };

  const quickLookup: CortexTool = {
    name: 'quick_lookup',
    description:
      'Ask a small standalone factual question that needs no conversation ' +
      'context. Questions about the conversation or work in progress belong ' +
      'in steer_task instead.',
    parameters: Type.Object({
      question: Type.Optional(Type.String({
        description: 'The standalone question.',
      })),
    }),
    execute: async (params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      return safeDispatch(() => router.dispatchLookup(p['question']));
    },
  };

  /**
   * No `askId` parameter, deliberately (decisions.md D16, communication.md).
   * The answer binds to the voiced ask, exactly one ask is voiced at a
   * time, and the router refuses an allow for anything else, so an id could
   * never make an accepted answer possible that a bare answer would not.
   * Taking one had a real cost and no benefit: the id is the nonce fencing
   * the untrusted request text, and a parameter for it put that nonce in
   * front of the talker in a form it was invited to repeat back, which is
   * the leak the fence exists to prevent.
   *
   * Denying a specific queued ask goes with it. Nothing legitimate needed
   * that: the user can only answer a request they have heard, queued asks
   * are re-voiced as each predecessor settles, unanswered ones time out to
   * deny, and "stop everything" is `abort()`, which denies them all.
   */
  const answerAsk: CortexTool = {
    name: 'answer_ask',
    description:
      "Relay the user's decision on the permission request you read out, " +
      'after reading it to them. It applies to that request.',
    parameters: Type.Object({
      decision: Type.Optional(Type.String({
        description: "'allow' or 'deny'.",
      })),
      reason: Type.Optional(Type.String({
        description: 'Optional reason, in the user\'s words.',
      })),
    }),
    execute: async (params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      // Always undefined for the id: the binding is the broker's, not the
      // talker's, and a stray field on an off-schema call must not become
      // one. The dispatch keeps its parameter for the router's other
      // callers and for the broker's own settled/unknown-id receipts.
      return safeDispatch(() =>
        router.dispatchAnswerAsk(undefined, p['decision'], p['reason']),
      );
    },
  };

  return [spawnTask, steerTask, cancelTask, quickLookup, answerAsk];
}
