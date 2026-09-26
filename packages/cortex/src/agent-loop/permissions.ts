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
    // Spawning a sub-agent is an internal orchestration decision, not a
    // side-effecting operation. Always allow without prompting.
    if (toolCall.name === SUB_AGENT_TOOL_NAME) return undefined;
    // Cortex-internal orchestration tools (permissionExempt on the
    // registered tool) never consult the consumer's resolver: prompting
    // a user to approve Deliver or recall is asking permission to run
    // Cortex's own plumbing. The flag is read off the loop's registry,
    // never off the call, and MCP tools are refused inside the lookup.
    if (host()?.isToolPermissionExempt(toolCall.name)) {
      return undefined;
    }
    // An already-aborted run never consults the resolver: pi only checks
    // the signal AFTER this hook, and a consumer prompt for a dead run
    // would flash pointlessly.
    if (signal?.aborted) {
      return { block: true, reason: ABORTED_PERMISSION_REASON };
    }
    // A Bash call requesting to run outside the sandbox reaches the
    // resolver under a distinct synthetic name, so plain-Bash rules and
    // auto-approve paths cannot silently authorize an uncontained run and
    // the consumer can prompt the human distinctly. Only meaningful when a
    // sandbox is configured; without one the flag changes nothing.
    const escalation = sandboxConfigured && isBashEscalationRequest(toolCall.name, args);
    const permissionName = escalation ? BASH_ESCALATION_PERMISSION_NAME : toolCall.name;
    // Each ask carries a fresh nonce plus the asking loop's identity, so
    // a consumer fielding several concurrent loops can key prompt state
    // per ask and attribute it. The nonce is security-relevant (consent
    // binding keys on it): crypto-random, never reused, never derived.
    const askId = `ask-${crypto.randomUUID()}`;
    const renderedRequest = renderPermissionRequest(permissionName, args);
    const askContext: ToolPermissionRequestContext = {
      askId,
      loopPath,
      renderedRequest,
      ...(signal ? { signal } : {}),
    };
    // Track the ask in the loop's pending-ask registry for the lifetime
    // of the resolver call, so a facade can enumerate what is currently
    // blocked and voice it.
    const asks = host()?.asks;
    asks?.register({
      askId,
      loopPath,
      toolName: permissionName,
      renderedRequest,
      requestedAt: Date.now(),
      voiced: false,
    });
    // Race the consumer's decision against the run's abort signal. pi
    // awaits this hook before checking the signal, so without the race a
    // pending human approval would hang abort/destroy into the force-kill
    // path. The signal is also passed to the resolver so the consumer UI
    // can dismiss the moot prompt.
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
 * Wrap the consumer's permission resolver for a child agent: mark the
 * tracked entry as waiting for permission while the ask is pending, and
 * clear the marker however the ask ends.
 *
 * When the child run aborts while the ask is pending, the race in the
 * child's beforeToolCall proceeds with a block WITHOUT settling this
 * resolver (the consumer may never answer the dismissed prompt), so the
 * finally alone is not enough: the marker AND the mirrored registry entry
 * are also cleared on the abort signal, or the entry lingers as
 * 'waiting-for-permission' in status surfaces and getPendingAsks() keeps
 * reporting an ask Cortex already blocked.
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
      // Settle the mirrored registry entry here too: on the abort path
      // Cortex proceeds with a block WITHOUT waiting for the consumer's
      // resolver, so the finally below (which does wait) may not run for
      // a long time, or ever. Without this, getPendingAsks() keeps
      // reporting an ask the loop already blocked.
      if (askId !== undefined) asks.settle(askId);
    };
    // Mirror the child's ask into this loop's registry so one
    // getPendingAsks() query surfaces the whole subtree's blocked asks.
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
      // Forward the child run's abort signal so the consumer UI can
      // dismiss a prompt made moot by the child being cancelled.
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
