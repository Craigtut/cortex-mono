/**
 * Unified network access decision.
 *
 * Two paths reach the network: sandboxed shell commands (through the OS egress
 * proxy, which calls the provider's ask-callback for unmatched hosts) and the
 * in-process WebFetch tool (through Cortex's resolveNetworkAccess seam). To
 * the user these are the same question ("may the agent reach example.com?"),
 * so both are answered here, by one decision tree over one allowlist:
 *
 *   1. No active policy (sandbox off)   -> allow (network is ungated)
 *   2. Denied domain                    -> deny, never prompt
 *   3. Policy mode 'full' (trusted)     -> allow
 *   4. Policy mode 'deny' (restricted)  -> deny, never prompt
 *   5. Policy allowlist (seeded registries + config extras) -> allow
 *   6. Persisted workspace grant        -> allow
 *   7. Session grant                    -> allow
 *   8. Prompt: once / session / always / deny
 *
 * Concurrent requests for the same host share one prompt (a single curl can
 * open several connections; the user answers once). A prompt failure denies:
 * without a decision we do not reach the network.
 */

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  NetworkAccessRequest,
  NetworkAccessDecision,
  SandboxNetworkPolicy,
} from '@animus-labs/cortex';
import { matchesAnyDomainPattern } from '@animus-labs/cortex-sandbox';

/** What the unified prompt returns: an allow scope, or a one-shot deny. */
export type NetworkPromptChoice = 'once' | 'session' | 'always' | 'deny';

/**
 * Lowercase and strip a single trailing dot so `Example.COM.` and
 * `example.com` are one grant, on both the proxy and WebFetch paths.
 */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

/**
 * Persisted per-workspace domain grants ("Always allow" answers). Stored under
 * the `network.allowedDomains` key of the same workspace settings file the
 * permission rules use, with the same read-modify-write pattern so each store
 * only touches its own top-level key, and the same 0600 permissions.
 */
export class NetworkGrantStore {
  private domains: string[] = [];

  constructor(private readonly settingsPath: string) {}

  async load(): Promise<void> {
    try {
      const content = await readFile(this.settingsPath, 'utf-8');
      const settings = JSON.parse(content) as { network?: { allowedDomains?: unknown } };
      const domains = settings.network?.allowedDomains;
      this.domains = Array.isArray(domains)
        ? domains.filter((d): d is string => typeof d === 'string')
        : [];
    } catch {
      this.domains = [];
    }
  }

  /**
   * Granted domain patterns. Prompt answers are exact hostnames; hand-authored
   * entries in settings.json may use the `*.example.com` wildcard form.
   */
  getDomains(): readonly string[] {
    return this.domains;
  }

  async add(domain: string): Promise<void> {
    const normalized = normalizeHost(domain);
    if (this.domains.includes(normalized)) return;
    this.domains.push(normalized);
    await this.persist();
  }

  private async persist(): Promise<void> {
    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(await readFile(this.settingsPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      settings = {};
    }
    const network =
      typeof settings['network'] === 'object' && settings['network'] !== null
        ? (settings['network'] as Record<string, unknown>)
        : {};
    network['allowedDomains'] = [...this.domains];
    settings['network'] = network;

    await mkdir(dirname(this.settingsPath), { recursive: true, mode: 0o700 });
    await writeFile(this.settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
    await chmod(this.settingsPath, 0o600);
  }
}

export interface NetworkAccessControllerOptions {
  /**
   * The active sandbox network policy, or undefined when containment is off
   * (no gating; today's ungated behavior). Read per request so a future rung
   * change applies immediately.
   */
  getPolicy: () => SandboxNetworkPolicy | undefined;
  /**
   * Show the unified prompt and return the user's choice. The caller owns
   * serialization (cortex-code routes this through the permission lock so
   * shell and WebFetch prompts never overlap).
   */
  prompt: (req: NetworkAccessRequest) => Promise<NetworkPromptChoice>;
  /** Persisted "Always allow" grants for this workspace. */
  store: NetworkGrantStore;
}

export class NetworkAccessController {
  private readonly sessionGrants = new Set<string>();
  /** In-flight prompts by host, so concurrent requests share one answer. */
  private readonly pendingPrompts = new Map<string, Promise<NetworkAccessDecision>>();

  constructor(private readonly options: NetworkAccessControllerOptions) {}

  async resolve(req: NetworkAccessRequest): Promise<NetworkAccessDecision> {
    const host = normalizeHost(req.host);
    const policy = this.options.getPolicy();

    if (!policy) return { decision: 'allow' };
    if (matchesAnyDomainPattern(host, policy.deniedDomains)) return { decision: 'deny' };
    if (policy.mode === 'full') return { decision: 'allow' };
    if (policy.mode === 'deny') return { decision: 'deny' };

    // allowlist mode
    if (matchesAnyDomainPattern(host, policy.allowedDomains)) return { decision: 'allow' };
    if (matchesAnyDomainPattern(host, this.options.store.getDomains())) {
      return { decision: 'allow', scope: 'always' };
    }
    if (this.sessionGrants.has(host)) return { decision: 'allow', scope: 'session' };

    const pending = this.pendingPrompts.get(host);
    if (pending) return pending;

    const promptPromise = this.promptAndRecord(host, req).finally(() => {
      this.pendingPrompts.delete(host);
    });
    this.pendingPrompts.set(host, promptPromise);
    return promptPromise;
  }

  /** Session-scoped grants, for transparency surfaces (/sandbox status). */
  getSessionGrants(): readonly string[] {
    return [...this.sessionGrants];
  }

  private async promptAndRecord(
    host: string,
    req: NetworkAccessRequest,
  ): Promise<NetworkAccessDecision> {
    let choice: NetworkPromptChoice;
    try {
      choice = await this.options.prompt({ ...req, host });
    } catch {
      // Fail closed: no decision means no network.
      return { decision: 'deny' };
    }

    switch (choice) {
      case 'once':
        return { decision: 'allow', scope: 'once' };
      case 'session':
        this.sessionGrants.add(host);
        return { decision: 'allow', scope: 'session' };
      case 'always':
        await this.options.store.add(host);
        return { decision: 'allow', scope: 'always' };
      case 'deny':
        return { decision: 'deny' };
    }
  }
}
