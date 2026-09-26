/**
 * The brokered resolvers: the consumer's resolvePermission and
 * resolveNetworkAccess, wrapped so an `ask` decision routes through the
 * conversation broker instead of blocking a loop invisibly
 * (communication.md "Full coverage"). Installed by duplex assembly.
 */

import type { AgentLoopConfig, CortexToolPermissionResult } from '../types.js';
import type { NetworkAccessRequest, ResolveNetworkAccess } from '../sandbox/types.js';
import { BASH_ESCALATION_PERMISSION_NAME } from '../tools/bash/index.js';
import { clampRenderedRequest } from '../permission-rendering.js';
import type { PermissionBroker } from './permission-broker.js';

/** What a brokered resolver needs of the broker. */
export type AskBroker = Pick<PermissionBroker, 'requestDecision' | 'noteAutoApproved'>;

/** Synthetic permission name for network egress asks. */
export const NETWORK_ACCESS_PERMISSION_NAME = 'NetworkAccess';

/** Verbatim rendering of a network egress ask (host, port, path, URL). */
export function renderNetworkAccessRequest(req: NetworkAccessRequest): string {
  const target = req.port !== undefined ? `${req.host}:${req.port}` : req.host;
  const detail = req.via === 'webfetch' && req.url ? `${target} (${req.url})` : target;
  return clampRenderedRequest(`${NETWORK_ACCESS_PERMISSION_NAME} (${req.via}): ${detail}`);
}

type PermissionResolver = NonNullable<AgentLoopConfig['resolvePermission']>;

/**
 * Wrap the consumer's resolvePermission for duplex: allow and block pass
 * through untouched (an allowlist auto-allow must not become a voiced ask),
 * and `ask` routes through the conversation broker instead of blocking the
 * loop invisibly. isAutoApprove bypasses voicing entirely (with an audit
 * entry). The broker reference is late-bound because the loops capture this
 * closure before the facade exists; the facade binds it synchronously during
 * assembly, so an unbound broker is unreachable in normal operation, and the
 * fallback (return the consumer's `ask`, which the loop treats as block)
 * fails closed.
 */
export function buildBrokeredPermissionResolver(
  consumer: PermissionResolver,
  isAutoApprove: (() => boolean) | undefined,
  getBroker: () => AskBroker | null,
): PermissionResolver {
  return async (toolName, toolArgs, context) => {
    const raw = await consumer(toolName, toolArgs, context);
    const normalized: CortexToolPermissionResult = typeof raw === 'boolean'
      ? { decision: raw ? 'allow' : 'block' }
      : raw;
    if (normalized.decision !== 'ask') return normalized;
    const broker = getBroker();
    if (!broker) return normalized;
    if (isAutoApprove?.() === true) {
      broker.noteAutoApproved(toolName, context);
      return { decision: 'allow' };
    }
    const answer = await broker.requestDecision({
      askId: context?.askId ?? `ask-${crypto.randomUUID()}`,
      loopPath: context?.loopPath ?? 'reasoner',
      toolName,
      renderedRequest: context?.renderedRequest ?? toolName,
      kind: toolName === BASH_ESCALATION_PERMISSION_NAME ? 'escalation' : 'tool',
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    if (answer.decision === 'allow') return { decision: 'allow' };
    return {
      decision: 'block',
      ...(answer.reason !== undefined ? { reason: answer.reason } : {}),
    };
  };
}

/**
 * Wrap the consumer's resolveNetworkAccess the same way: allow and deny pass
 * through, `ask` brokers through the conversation. This one function covers
 * both egress paths: WebFetch calls it in-process, and the consumer wires
 * the SAME wrapped function (via CortexAgent.getNetworkAccessResolver())
 * into its SandboxProvider's ask callback so shell egress asks flow through
 * the identical pipeline. With no broker bound the `ask` becomes a deny:
 * fail closed, matching how ungated surfaces treat a non-allow.
 *
 * Attribution limitation, accepted: NetworkAccessRequest carries no loop
 * identity, so a network ask raised by a sub-agent is filed under the
 * reasoner's path. The ask entry marks the attribution approximate rather
 * than asserting a path the broker cannot actually know.
 *
 * `isAutoApprove` bypasses voicing exactly as it does for tool asks. A
 * consumer in an auto-approve posture asked not to be interrupted, and an
 * egress ask is an interruption like any other; without this the two ask
 * pipelines disagree about what auto-approve means. It is checked after the
 * broker lookup, matching the tool resolver, so an unbound broker still
 * fails closed rather than opening egress.
 *
 * The parameter is optional and last, unlike the tool resolver where it
 * sits second. That is deliberate: appending it keeps every existing
 * two-argument call compiling, so wiring it at the facade is a one-line
 * change instead of a coordinated one.
 */
export function buildBrokeredNetworkResolver(
  consumer: ResolveNetworkAccess,
  getBroker: () => AskBroker | null,
  isAutoApprove?: (() => boolean) | undefined,
): ResolveNetworkAccess {
  return async (req) => {
    const upstream = await consumer(req);
    if (upstream.decision !== 'ask') return upstream;
    const broker = getBroker();
    if (!broker) return { decision: 'deny' };
    if (isAutoApprove?.() === true) {
      // Same audit trail a tool ask leaves: the decision is invisible to the
      // user by design, so the log is the only record it happened.
      broker.noteAutoApproved(NETWORK_ACCESS_PERMISSION_NAME, {
        loopPath: 'reasoner',
        renderedRequest: renderNetworkAccessRequest(req),
      });
      return { decision: 'allow' };
    }
    const answer = await broker.requestDecision({
      askId: `ask-${crypto.randomUUID()}`,
      loopPath: 'reasoner',
      loopPathApproximate: true,
      toolName: NETWORK_ACCESS_PERMISSION_NAME,
      renderedRequest: renderNetworkAccessRequest(req),
      kind: 'network',
    });
    return { decision: answer.decision === 'allow' ? 'allow' : 'deny' };
  };
}
