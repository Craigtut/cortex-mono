import { matchesAnyDomainPattern } from './policy.js';
import type { NetworkAccessDecision, ResolveNetworkAccess, SandboxNetworkPolicy } from './types.js';

/** One policy gate for proxy requests and in-process WebFetch requests. */
export function createSandboxNetworkResolver(
  policy: () => SandboxNetworkPolicy | undefined,
  decide?: ResolveNetworkAccess,
): ResolveNetworkAccess {
  const grants = new Set<string>();
  return async (request): Promise<NetworkAccessDecision> => {
    const active = policy();
    if (!active) return decide ? decide(request).catch(() => ({ decision: 'deny' as const })) : { decision: 'allow' };
    const host = request.host.toLowerCase().replace(/\.$/, '');
    if (matchesAnyDomainPattern(host, active.deniedDomains) || active.mode === 'deny') {
      return { decision: 'deny' };
    }
    if (active.mode === 'full' || matchesAnyDomainPattern(host, active.allowedDomains.filter((p) => p !== '*'))) {
      return { decision: 'allow' };
    }
    if (grants.has(host)) return { decision: 'allow', scope: 'session' };
    if (!decide) return { decision: 'deny' };
    const answer: NetworkAccessDecision = await decide({ ...request, host }).catch(() => ({ decision: 'deny' as const }));
    if (answer.decision === 'allow' && (answer.scope === 'session' || answer.scope === 'always')) grants.add(host);
    return answer;
  };
}
