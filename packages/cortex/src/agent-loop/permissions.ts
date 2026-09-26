/**
 * Tool permissions: the beforeToolCall gate pi runs before every tool
 * call, the registry of asks currently blocked on the consumer's resolver
 * (a loop's own plus, mirrored, its children's), and the child-side
 * resolver wrapper that feeds that mirror.
 */

import { renderPermissionRequest } from '../permission-rendering.js';
import type { SubAgentManager } from '../sub-agent-manager.js';
import { BASH_ESCALATION_PERMISSION_NAME } from '../tools/tool-names.js';
import { isBashEscalationRequest } from '../tools/bash/index.js';
import { SUB_AGENT_TOOL_NAME } from '../tools/sub-agent.js';
import type {
  AgentLoopConfig,
  CortexToolPermissionDecision,
  CortexToolPermissionResult,
  PendingAsk,
  ToolPermissionRequestContext,
} from '../types.js';
import { DEFAULT_LOOP_PATH } from '../types.js';
import { ABORTED, raceAbort } from './run-control.js';

type PermissionResolver = NonNullable<AgentLoopConfig['resolvePermission']>;

/** Block reason for a tool call whose permission ask was cut short by abort. */
export const ABORTED_PERMISSION_REASON =
  'The run was aborted before this tool call was approved; it was not run.';

/**
 * Permission asks currently blocked on a resolver decision, keyed by their
 * per-ask nonce. Covers a loop's own asks plus (mirrored) its children's,
 * so one query surfaces the whole subtree. Entries are removed the moment
 * an ask settles, however it settles.
 */
export class PendingAskRegistry {
  private readonly pending = new Map<string, PendingAsk>();
  /** Resolvers blocked in waitForSettlement(), woken on any settlement. */
  private settlementWaiters: Array<() => void> = [];

  /** Track an ask for the lifetime of its resolver call. */
  register(ask: PendingAsk): void {
    this.pending.set(ask.askId, ask);
  }

  /** Remove an ask once its resolver call settles (any outcome). */
  settle(askId: string): void {
    this.pending.delete(askId);
    this.notifySettlement();
  }

  /** Copies of the pending asks, oldest first. */
  list(): PendingAsk[] {
    return [...this.pending.values()].map((ask) => ({ ...ask }));
  }

  /** False for an unknown or already-settled askId. */
  markVoiced(askId: string): boolean {
    const ask = this.pending.get(askId);
    if (!ask) return false;
    ask.voiced = true;
    return true;
  }

  /** Resolve when the set next shrinks (immediately when it is empty). */
  async waitForSettlement(): Promise<void> {
    if (this.pending.size === 0) return;
    return new Promise<void>((resolve) => {
      this.settlementWaiters.push(resolve);
    });
  }

  /**
   * Teardown: any ask still pending settles as a block via the abort race;
   * its entry just has not been reaped yet.
   */
  clear(): void {
    this.pending.clear();
    this.notifySettlement();
  }

  private notifySettlement(): void {
    const waiters = this.settlementWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}

/** What the gate needs of the loop it guards. */
export interface PermissionHost {
  isToolPermissionExempt(toolName: string): boolean;
  asks: PendingAskRegistry;
}

/** pi's beforeToolCall hook result: block with a reason, or proceed. */
export type ToolCallGate = { block: true; reason: string } | undefined;

/**
 * pi's beforeToolCall hook for a loop: the sandbox's static check, then the
 * consumer's resolvePermission (skipped for Cortex's own orchestration
 * tools), raced against the run's abort. Undefined when the config has
 * neither, so pi runs without a gate.
 */
export function createBeforeToolCall(
  cortexConfig: AgentLoopConfig,
  host: () => PermissionHost | null,
): ((ctx: unknown, signal?: AbortSignal) => Promise<ToolCallGate>) | undefined {
  if (!cortexConfig.resolvePermission && !cortexConfig.sandbox?.checkToolCall) return undefined;
  const resolver = cortexConfig.resolvePermission;
  const sandboxConfigured = cortexConfig.sandbox !== undefined;
  const loopPath = cortexConfig.loopPath ?? DEFAULT_LOOP_PATH;
  return async (ctx: unknown, signal?: AbortSignal) => {
    const { toolCall, args } = ctx as { toolCall: { name: string }; args: unknown };
    const sandboxDenial = cortexConfig.sandbox?.checkToolCall?.(toolCall.name, args, cortexConfig.workingDirectory);
    if (sandboxDenial) return { block: true, reason: sandboxDenial };
    if (!resolver) return undefined;
    // Orchestration tools (SubAgent, and permissionExempt tools like
    // Deliver) are Cortex's own plumbing, not side effects to approve.
    if (toolCall.name === SUB_AGENT_TOOL_NAME) return undefined;
    if (host()?.isToolPermissionExempt(toolCall.name)) {
      return undefined;
    }
    // pi checks the signal only after this hook; don't prompt for a dead run.
    if (signal?.aborted) {
      return { block: true, reason: ABORTED_PERMISSION_REASON };
    }
    // Sandbox escalation asks under a distinct name, so plain-Bash rules
    // and auto-approve paths cannot silently authorize an uncontained run.
    const escalation = sandboxConfigured && isBashEscalationRequest(toolCall.name, args);
    const permissionName = escalation ? BASH_ESCALATION_PERMISSION_NAME : toolCall.name;
    // Consent binding keys on this nonce: crypto-random, never reused or derived.
    const askId = `ask-${crypto.randomUUID()}`;
    const renderedRequest = renderPermissionRequest(permissionName, args);
    const askContext: ToolPermissionRequestContext = {
      askId,
      loopPath,
      renderedRequest,
      ...(signal ? { signal } : {}),
    };
    const asks = host()?.asks;
    asks?.register({
      askId,
      loopPath,
      toolName: permissionName,
      renderedRequest,
      requestedAt: Date.now(),
      voiced: false,
    });
    // Without the race a pending human approval would hang abort and
    // destroy into the force-kill path.
    let resolution: boolean | CortexToolPermissionResult | typeof ABORTED;
    try {
      resolution = await raceAbort(
        resolver(permissionName, args, askContext),
        signal,
      );
    } finally {
      asks?.settle(askId);
    }
    if (resolution === ABORTED) {
      return { block: true, reason: ABORTED_PERMISSION_REASON };
    }
    const decision = normalizePermissionDecision(resolution);
    if (decision.decision !== 'allow') {
      return {
        block: true,
        reason: decision.reason ?? (escalation
          ? 'Escalation outside the sandbox was denied for this command; it was not run. Re-run without escalateOutsideSandbox to execute inside the sandbox.'
          : buildPermissionReason(permissionName, decision.decision)),
      };
    }
    return undefined;
  };
}

/**
 * Wrap the consumer's resolver for a child agent: mark the tracked entry as
 * waiting for permission and mirror the ask into this loop's registry while
 * it is pending. Both are also cleared on abort, because the child's gate
 * blocks without waiting for a resolver the consumer may never answer.
 */
export function mirrorChildPermissionResolver(
  parentResolver: PermissionResolver,
  child: {
    asks: PendingAskRegistry;
    subAgents: Pick<SubAgentManager, 'get'>;
    childTaskId: string;
    childLoopPath: string;
  },
): PermissionResolver {
  const { asks, childTaskId } = child;
  const subAgentMgr = child.subAgents;
  return async (toolName, toolArgs, context) => {
    const entry = subAgentMgr.get(childTaskId);
    if (entry) entry.pendingPermission = { toolName, args: toolArgs };
    const askId = context?.askId;
    const clearPending = (): void => {
      const e = subAgentMgr.get(childTaskId);
      if (e) e.pendingPermission = null;
      if (askId !== undefined) asks.settle(askId);
    };
    if (askId !== undefined) {
      asks.register({
        askId,
        loopPath: context?.loopPath ?? child.childLoopPath,
        toolName,
        renderedRequest: context?.renderedRequest
          ?? renderPermissionRequest(toolName, toolArgs),
        requestedAt: Date.now(),
        voiced: false,
      });
    }
    const signal = context?.signal;
    signal?.addEventListener('abort', clearPending, { once: true });
    try {
      return await parentResolver(toolName, toolArgs, context);
    } finally {
      signal?.removeEventListener('abort', clearPending);
      clearPending();
    }
  };
}

export function normalizePermissionDecision(
  resolution: boolean | CortexToolPermissionResult,
): CortexToolPermissionResult {
  if (typeof resolution === 'boolean') {
    return { decision: resolution ? 'allow' : 'block' };
  }
  return resolution;
}

export function buildPermissionReason(
  toolName: string,
  decision: CortexToolPermissionDecision,
): string {
  if (decision === 'ask') {
    return `Tool "${toolName}" requires approval before it can run.`;
  }
  return `Tool "${toolName}" is blocked or disabled.`;
}
