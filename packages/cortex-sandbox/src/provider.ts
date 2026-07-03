/**
 * SandboxProvider implementation backed by @anthropic-ai/sandbox-runtime.
 *
 * Enforces on macOS (Seatbelt) and Linux (bubblewrap + seccomp) by translating a
 * SandboxPolicy into a SandboxRuntimeConfig and wrapping each shell spawn through
 * SandboxManager.wrapWithSandboxArgv. On unsupported platforms (Windows today) it
 * reports honest `none` status and passes spawns through unchanged.
 *
 * Note: SandboxManager is a process-global singleton, so at most one provider is
 * meaningfully active per process. Re-initialize to change policy (rung change).
 */
import {
  SandboxManager,
  type SandboxRuntimeConfig,
  type SandboxAskCallback,
} from '@anthropic-ai/sandbox-runtime';
import type {
  SandboxProvider,
  SandboxPolicy,
  SandboxStatus,
  SandboxSpawnSpec,
  SandboxBackend,
  WrappedSpawn,
} from '@animus-labs/cortex';

export interface SandboxRuntimeProviderOptions {
  /**
   * Interactive egress decision for a domain that is not already allow/denied
   * (Workspace rung). Return true to allow, false to deny. When omitted, an
   * unmatched domain is denied. Not consulted in `deny` mode (all denied) or
   * `full` mode (all auto-allowed).
   */
  onNetworkRequest?: (req: { host: string; port: number | undefined }) => Promise<boolean>;
  /** Notified with the honest degradation reasons whenever enforcement is reduced. */
  onDegraded?: (degradations: string[]) => void;
}

function backendForPlatform(): SandboxBackend {
  switch (process.platform) {
    case 'darwin':
      return 'seatbelt';
    case 'linux':
      return 'bubblewrap';
    default:
      return 'none';
  }
}

const UNCONTAINED = (reason: string): SandboxStatus => ({
  filesystem: 'none',
  network: 'none',
  backend: 'none',
  degradations: [reason],
});

export class SandboxRuntimeProvider implements SandboxProvider {
  private currentStatus: SandboxStatus = UNCONTAINED('not initialized');
  private policy: SandboxPolicy | undefined;

  constructor(private readonly options: SandboxRuntimeProviderOptions = {}) {}

  async initialize(policy: SandboxPolicy): Promise<SandboxStatus> {
    this.policy = policy;
    const backend = backendForPlatform();

    if (backend === 'none' || !SandboxManager.isSupportedPlatform()) {
      return this.setStatus(
        UNCONTAINED(`OS sandbox not available on ${process.platform}; commands run uncontained`),
      );
    }

    const degradations: string[] = [];
    if (backend === 'bubblewrap') {
      const dep = SandboxManager.checkDependencies();
      degradations.push(...dep.errors, ...dep.warnings);
    }

    try {
      await SandboxManager.initialize(
        this.toRuntimeConfig(policy),
        this.askCallbackFor(policy),
        backend === 'seatbelt', // macOS: enable the real-time violation log monitor
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.setStatus(UNCONTAINED(`sandbox initialization failed: ${msg}`));
    }

    // Init succeeded. If the dependency preflight flagged problems, enforcement
    // is reduced from the requested policy; report it rather than overclaim.
    const reduced = degradations.length > 0;
    return this.setStatus({
      filesystem: reduced ? 'partial' : 'enforced',
      network: reduced ? 'partial' : 'enforced',
      backend,
      degradations,
    });
  }

  async wrapSpawn(spec: SandboxSpawnSpec): Promise<WrappedSpawn> {
    // Not enforcing (unsupported platform or failed init): pass through so the
    // command still runs. Status already reports this as uncontained.
    if (this.currentStatus.backend === 'none') {
      return { file: spec.shell, args: [...spec.shellArgs, spec.command], env: spec.env };
    }
    const { argv } = await SandboxManager.wrapWithSandboxArgv(spec.command, spec.shell);
    const [file, ...args] = argv;
    return { file: file ?? spec.shell, args, env: spec.env };
  }

  status(): SandboxStatus {
    return this.currentStatus;
  }

  async dispose(): Promise<void> {
    if (this.currentStatus.backend !== 'none') {
      await SandboxManager.reset();
    }
    this.currentStatus = UNCONTAINED('disposed');
  }

  private setStatus(status: SandboxStatus): SandboxStatus {
    this.currentStatus = status;
    if (status.degradations.length > 0) {
      this.options.onDegraded?.(status.degradations);
    }
    return status;
  }

  private askCallbackFor(policy: SandboxPolicy): SandboxAskCallback | undefined {
    if (policy.network.mode === 'full') {
      // Open network: still routed through the proxy, but every host is allowed.
      return async () => true;
    }
    if (policy.network.mode === 'allowlist') {
      const cb = this.options.onNetworkRequest;
      return cb ? (params) => cb({ host: params.host, port: params.port }) : undefined;
    }
    // deny mode: no fallthrough, everything blocked.
    return undefined;
  }

  private toRuntimeConfig(policy: SandboxPolicy): SandboxRuntimeConfig {
    const fs = policy.filesystem;
    const net = policy.network;
    return {
      network: {
        allowedDomains: net.mode === 'deny' ? [] : net.allowedDomains,
        deniedDomains: net.deniedDomains,
        // deny mode is a hard block with no ask-callback fallthrough.
        strictAllowlist: net.mode === 'deny',
        allowLocalBinding: net.allowLocalBinding ?? true,
      },
      filesystem: {
        denyRead: fs.denyRead,
        allowWrite: fs.writableRoots,
        denyWrite: fs.denyWrite,
        ...(fs.allowRead ? { allowRead: fs.allowRead } : {}),
      },
    };
  }
}
