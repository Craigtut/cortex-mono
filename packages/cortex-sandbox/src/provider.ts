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
import { spawn } from 'node:child_process';
import {
  SandboxManager,
  type SandboxRuntimeConfig,
  type SandboxAskCallback,
} from '@anthropic-ai/sandbox-runtime';
import { DEFAULT_CREDENTIAL_ENV_VARS } from './policy.js';
import { denialFromViolations, denialFromFailureHeuristic } from './classify.js';
import type {
  SandboxProvider,
  SandboxPolicy,
  SandboxStatus,
  SandboxSpawnSpec,
  SandboxBackend,
  SandboxCommandFailure,
  SandboxDenial,
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
  /**
   * Credential environment-variable names to unset inside the sandbox (mode
   * "deny"). Defaults to DEFAULT_CREDENTIAL_ENV_VARS. Pass [] to disable, or your
   * own list to extend/replace coverage.
   */
  credentialEnvVars?: string[];
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

/**
 * Probe whether bubblewrap can actually create an unprivileged user namespace.
 * Presence of the bwrap binary is not enough: Ubuntu 23.10+/24.04 restrict
 * unprivileged user namespaces via AppArmor, so the binary exists but every
 * sandboxed command fails at run time. Returns ok:false with an actionable
 * reason so the provider can report honest `none` instead of a false `enforced`.
 */
async function probeBwrapUserns(): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { ok: boolean; reason?: string }): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    try {
      const proc = spawn(
        'bwrap',
        ['--ro-bind', '/', '/', '--unshare-user', '--unshare-net', '--', 'true'],
        { stdio: 'ignore' },
      );
      proc.on('error', (e) => done({ ok: false, reason: `bwrap probe could not run: ${e.message}` }));
      proc.on('close', (code) =>
        done(
          code === 0
            ? { ok: true }
            : {
                ok: false,
                reason:
                  `bwrap could not create a user namespace (exit ${code}). On Ubuntu 23.10+/24.04 set ` +
                  `kernel.apparmor_restrict_unprivileged_userns=0 or install an AppArmor profile for bwrap.`,
              },
        ),
      );
    } catch (e) {
      done({ ok: false, reason: `bwrap probe error: ${e instanceof Error ? e.message : String(e)}` });
    }
  });
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
  private readonly credentialEnvVars: string[];

  constructor(private readonly options: SandboxRuntimeProviderOptions = {}) {
    this.credentialEnvVars = options.credentialEnvVars ?? [...DEFAULT_CREDENTIAL_ENV_VARS];
  }

  async initialize(policy: SandboxPolicy): Promise<SandboxStatus> {
    this.policy = policy;
    const backend = backendForPlatform();

    if (backend === 'none' || !SandboxManager.isSupportedPlatform()) {
      return this.setStatus(
        UNCONTAINED(`OS sandbox not available on ${process.platform}; commands run uncontained`),
      );
    }

    // Re-initialize (e.g. a rung change): SandboxManager.initialize() early-returns
    // when already initialized, so without an explicit reset a second call is a
    // silent no-op that would report the new policy while enforcing the old one.
    if (this.currentStatus.backend !== 'none') {
      await SandboxManager.reset();
    }

    const degradations: string[] = [];
    if (backend === 'bubblewrap') {
      const dep = SandboxManager.checkDependencies();
      if (dep.errors.length > 0) {
        return this.setStatus(
          UNCONTAINED(`Linux sandbox dependencies missing: ${dep.errors.join('; ')}`),
        );
      }
      // checkDependencies() only probes bwrap/socat presence, not whether an
      // unprivileged user namespace can actually be created. Probe for real so we
      // report honest `none` instead of a false `enforced` on a restricted kernel.
      const probe = await probeBwrapUserns();
      if (!probe.ok) {
        return this.setStatus(UNCONTAINED(probe.reason ?? 'bubblewrap user namespace unavailable'));
      }
      degradations.push(...dep.warnings);
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

    // Init succeeded. Dependency warnings (e.g. seccomp unavailable) are attached
    // as degradations but do not by themselves negate the primary fs/network
    // boundary, so we report enforced with the caveats surfaced.
    return this.setStatus({
      filesystem: 'enforced',
      network: 'enforced',
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

  /**
   * Remove the credential env vars this provider scrubs inside the sandbox, so an
   * escalated (unsandboxed) command still does not inherit ambient secrets. See
   * the SandboxProvider.scrubCredentialEnv contract.
   */
  scrubCredentialEnv(env: Record<string, string>): Record<string, string> {
    if (this.credentialEnvVars.length === 0) return env;
    const scrubbed: Record<string, string> = { ...env };
    for (const name of this.credentialEnvVars) {
      delete scrubbed[name];
    }
    return scrubbed;
  }

  /**
   * Attribute a failed sandboxed command to a sandbox denial (or return null).
   * macOS is precise: sandbox-runtime's unified-log monitor records violation
   * events tagged with the command, so a match IS a denial. Linux has no
   * per-violation signal, so a conservative stderr heuristic answers instead.
   * Best-effort either way; the caller treats null as "no note", and a macOS
   * violation that has not landed in the log tail yet is simply missed.
   */
  classifyFailure(failure: SandboxCommandFailure): SandboxDenial | null {
    // Not enforcing: spawns passed through unwrapped, so no failure here can
    // be the sandbox's doing.
    if (this.currentStatus.backend === 'none') return null;
    if (failure.exitCode === null || failure.exitCode === 0) return null;

    if (this.currentStatus.backend === 'seatbelt') {
      const store = SandboxManager.getSandboxViolationStore();
      return denialFromViolations(store.getViolationsForCommand(failure.command));
    }
    // Linux heuristic: generic permission markers need corroboration against
    // the active policy (a referenced blocked path or a network tool).
    if (!this.policy) return null;
    const { writableRoots, denyRead, denyWrite } = this.policy.filesystem;
    return denialFromFailureHeuristic(failure, { writableRoots, denyRead, denyWrite });
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
    const config: SandboxRuntimeConfig = {
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
    // Scrub credential env vars from the child (filesystem deny-reads do not
    // cover secrets that live in the environment, and the seeded allowlist is a
    // ready exfil channel).
    if (this.credentialEnvVars.length > 0) {
      config.credentials = {
        envVars: this.credentialEnvVars.map((name) => ({ name, mode: 'deny' as const })),
      };
    }
    return config;
  }
}
