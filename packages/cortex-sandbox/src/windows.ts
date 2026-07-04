/**
 * Native Windows Tier-1 SandboxProvider (restricted-token helper).
 *
 * On Windows there is no Seatbelt/bubblewrap, and sandbox-runtime's Windows
 * support is alpha and explicitly "not a security boundary". Instead we spawn a
 * small, code-signed Rust helper exe (packages/cortex-sandbox/windows-helper)
 * in place of the shell. For each command the helper:
 *   1. builds a WRITE_RESTRICTED restricted token carrying a synthetic
 *      capability SID (writes must pass BOTH the normal token AND a restricting
 *      SID, so a write succeeds only where that cap SID has an allow ACE),
 *   2. grants the cap SID write ACEs on the workspace roots + a sandbox temp,
 *      layers deny-read ACEs over secret paths and deny-write over the agent
 *      config, then drops the token to Low integrity,
 *   3. launches the child in a kill-on-close job object with process
 *      mitigations, relays stdio, and returns the child's exit code.
 *
 * Honesty contract (see docs/cortex/sandboxing.md, "Layer 3: native Windows"):
 * Tier 1 is unelevated, so the FILESYSTEM boundary is real (`enforced`) but the
 * NETWORK boundary is NOT: proxy env vars are the only control and a command
 * that opens a socket directly ignores them. So status reports network `none`,
 * never `partial`. Hard network enforcement is the future elevated Tier 2 (WFP).
 * When the helper binary is absent we report fully UNCONTAINED `none` and pass
 * spawns through unchanged, exactly like the POSIX provider on an unsupported
 * host.
 *
 * The policy serialization and argv construction are pure functions
 * (`serializeWindowsPolicy`, `buildHelperInvocation`) so they are unit-testable
 * on any platform without the helper binary or a Windows host.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_CREDENTIAL_ENV_VARS } from './policy.js';
import type {
  SandboxProvider,
  SandboxPolicy,
  SandboxStatus,
  SandboxSpawnSpec,
  SandboxCommandFailure,
  SandboxDenial,
  WrappedSpawn,
} from '@animus-labs/cortex';

/** Bump when the helper's expected policy shape changes; the helper validates it. */
export const WINDOWS_POLICY_VERSION = 1 as const;

/**
 * The exact JSON contract the helper exe reads from its policy file (argv[1]).
 * Keep this in lockstep with `policy.rs::Policy` in the Rust helper: a field
 * rename on either side silently breaks containment, so both carry
 * WINDOWS_POLICY_VERSION and the helper rejects a mismatch.
 *
 * The shell + command are NOT in this file. They are passed as argv after `--`
 * (`helper.exe <policyFile> -- <shell> <shellArgs...> <command>`) so the command
 * never has to be shell-escaped into JSON and stays a normal argv tail.
 */
export interface WindowsHelperPolicy {
  version: typeof WINDOWS_POLICY_VERSION;
  /**
   * Stable per-install name the helper feeds to DeriveCapabilitySidsFromName to
   * derive the restricting capability SID. Deterministic: the same name yields
   * the same SID across runs, so ACEs are reused, not accumulated. Must come
   * from trusted config, never model input.
   */
  capabilitySidName: string;
  /**
   * Absolute paths the sandboxed process may write. Established from trusted
   * session config, NEVER widened by a model-controlled cwd (CVE-2025-59532).
   * Includes the sandbox temp.
   */
  writableRoots: string[];
  /** The per-session sandbox temp dir (a member of writableRoots, named so the helper can label it). */
  sandboxTemp: string;
  /** Absolute paths that must never be readable (secret stores, credential files). */
  denyReadPaths: string[];
  /** Absolute paths that must never be written (agent config, .git/hooks, .git/config). */
  denyWritePaths: string[];
  /** Drop the child token to Low integrity (default true). See the runbook for the MIC tradeoff. */
  lowIntegrity: boolean;
}

export interface WindowsRestrictedTokenProviderOptions {
  /**
   * Absolute path to the signed helper exe. Defaults to the binary bundled at
   * `<package>/vendor/win32-x64/cortex-sandbox-helper.exe`. When it is absent,
   * the provider degrades to honest UNCONTAINED `none` rather than failing.
   */
  helperPath?: string;
  /**
   * Stable, per-install-unique name used to derive the capability SID. Two
   * installs on a shared machine SHOULD pass different names so their ACEs never
   * cross-grant. Defaults to a fixed name; consumers are strongly encouraged to
   * override with a per-install identifier.
   */
  capabilitySidName?: string;
  /** Drop the child to Low integrity. Default true. */
  lowIntegrity?: boolean;
  /** Notified with the honest degradation reasons whenever enforcement is reduced. */
  onDegraded?: (degradations: string[]) => void;
  /**
   * Credential environment-variable names stripped from the sandboxed child (so
   * the seeded network path cannot exfiltrate an ambient token). Defaults to
   * DEFAULT_CREDENTIAL_ENV_VARS; pass [] to disable.
   */
  credentialEnvVars?: string[];
  /** Test seam: existence check for the helper binary. Defaults to fs.existsSync. */
  fileExists?: (path: string) => boolean;
  /** Test seam: writes the policy JSON and returns the file path. Defaults to a temp file. */
  writePolicyFile?: (json: string) => string;
  /** Test seam: removes the policy file on dispose. Defaults to fs.rmSync. */
  removePolicyFile?: (path: string) => void;
}

/** The default per-install cap SID name when the consumer does not supply one. */
export const DEFAULT_CAPABILITY_SID_NAME = 'cortex-sandbox';

const NETWORK_TIER1_DEGRADATION =
  'Network egress is not enforced on Windows Tier 1 (unelevated): only proxy ' +
  'env vars constrain it and a direct socket bypasses them. Filesystem is ' +
  'enforced; hard network enforcement needs the elevated Tier 2 (WFP).';

const UNCONTAINED = (reason: string): SandboxStatus => ({
  filesystem: 'none',
  network: 'none',
  backend: 'none',
  degradations: [reason],
});

/**
 * Resolve the bundled helper path relative to this module. The binary is
 * prebuilt on Windows CI and shipped under vendor/win32-x64; it is not built by
 * the JS install. Absent binary -> honest `none` (handled in initialize).
 */
export function defaultHelperPath(): string {
  // dist/windows.js -> package root is one level up from dist.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'vendor', 'win32-x64', 'cortex-sandbox-helper.exe');
}

/**
 * Project a SandboxPolicy plus per-session metadata into the helper's on-disk
 * contract. Pure: no fs, no platform checks, no clock. The sandbox temp is
 * appended to writableRoots if the caller has not already included it, so the
 * child can always write its own temp.
 */
export function serializeWindowsPolicy(
  policy: SandboxPolicy,
  meta: { sandboxTemp: string; capabilitySidName: string; lowIntegrity: boolean },
): WindowsHelperPolicy {
  const writableRoots = policy.filesystem.writableRoots.includes(meta.sandboxTemp)
    ? [...policy.filesystem.writableRoots]
    : [...policy.filesystem.writableRoots, meta.sandboxTemp];
  return {
    version: WINDOWS_POLICY_VERSION,
    capabilitySidName: meta.capabilitySidName,
    writableRoots,
    sandboxTemp: meta.sandboxTemp,
    denyReadPaths: [...policy.filesystem.denyRead],
    denyWritePaths: [...policy.filesystem.denyWrite],
    lowIntegrity: meta.lowIntegrity,
  };
}

/**
 * Build the full wrapped spawn that launches `spec` under the helper:
 *   file = helperPath
 *   args = [policyFilePath, '--', shell, ...shellArgs, command]
 * The env is passed through the provided scrubber so ambient credential env
 * vars never reach the child. Pure given its inputs.
 */
export function buildHelperInvocation(params: {
  helperPath: string;
  policyFilePath: string;
  spec: SandboxSpawnSpec;
  scrubEnv: (env: Record<string, string>) => Record<string, string>;
}): WrappedSpawn {
  const { helperPath, policyFilePath, spec, scrubEnv } = params;
  return {
    file: helperPath,
    args: [policyFilePath, '--', spec.shell, ...spec.shellArgs, spec.command],
    env: scrubEnv(spec.env),
  };
}

/** Common Windows "the OS denied this" markers, mapped to a policy dimension. */
const WINDOWS_DENIAL_MARKERS: Array<{ pattern: RegExp; dimension: SandboxDenial['dimension'] }> = [
  { pattern: /access is denied/i, dimension: 'filesystem-write' },
  { pattern: /\bERROR_ACCESS_DENIED\b/i, dimension: 'filesystem-write' },
  { pattern: /unauthorizedaccessexception/i, dimension: 'filesystem-write' },
  { pattern: /cannot access the file/i, dimension: 'filesystem-write' },
  { pattern: /permission denied/i, dimension: 'unknown' },
];

export class WindowsRestrictedTokenProvider implements SandboxProvider {
  private currentStatus: SandboxStatus = UNCONTAINED('not initialized');
  private policyFilePath: string | undefined;
  private readonly helperPath: string;
  private readonly capabilitySidName: string;
  private readonly lowIntegrity: boolean;
  private readonly credentialEnvVars: string[];
  private readonly fileExists: (path: string) => boolean;
  private readonly writePolicyFile: (json: string) => string;
  private readonly removePolicyFile: (path: string) => void;

  constructor(private readonly options: WindowsRestrictedTokenProviderOptions = {}) {
    this.helperPath = options.helperPath ?? defaultHelperPath();
    this.capabilitySidName = options.capabilitySidName ?? DEFAULT_CAPABILITY_SID_NAME;
    this.lowIntegrity = options.lowIntegrity ?? true;
    this.credentialEnvVars = options.credentialEnvVars ?? [...DEFAULT_CREDENTIAL_ENV_VARS];
    this.fileExists = options.fileExists ?? ((p) => existsSync(p));
    this.writePolicyFile = options.writePolicyFile ?? defaultWritePolicyFile;
    this.removePolicyFile = options.removePolicyFile ?? ((p) => rmSync(p, { force: true }));
  }

  async initialize(policy: SandboxPolicy): Promise<SandboxStatus> {
    if (process.platform !== 'win32') {
      return this.setStatus(
        UNCONTAINED(
          `Windows restricted-token sandbox is win32-only; running on ${process.platform} uncontained`,
        ),
      );
    }
    if (!this.fileExists(this.helperPath)) {
      return this.setStatus(
        UNCONTAINED(
          `Windows sandbox helper not found at ${this.helperPath}; shell commands run uncontained. ` +
            `Build and ship the signed helper (see docs/cortex/windows-sandbox-build.md).`,
        ),
      );
    }

    // A rung change re-initializes: drop the previous policy file first.
    this.cleanupPolicyFile();

    const sandboxTemp = this.resolveSandboxTemp(policy);
    const helperPolicy = serializeWindowsPolicy(policy, {
      sandboxTemp,
      capabilitySidName: this.capabilitySidName,
      lowIntegrity: this.lowIntegrity,
    });
    try {
      this.policyFilePath = this.writePolicyFile(JSON.stringify(helperPolicy, null, 2));
    } catch (err) {
      return this.setStatus(
        UNCONTAINED(
          `Could not write the Windows sandbox policy file: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }

    // Filesystem is genuinely enforced by the helper; network is not (Tier 1).
    return this.setStatus({
      filesystem: 'enforced',
      network: 'none',
      backend: 'win-restricted-token',
      degradations: [NETWORK_TIER1_DEGRADATION],
    });
  }

  async wrapSpawn(spec: SandboxSpawnSpec): Promise<WrappedSpawn> {
    // Not enforcing (non-win32 or helper absent): pass through so the command
    // still runs. Status already reports this as uncontained.
    if (this.currentStatus.backend === 'none' || this.policyFilePath === undefined) {
      return { file: spec.shell, args: [...spec.shellArgs, spec.command], env: spec.env };
    }
    return buildHelperInvocation({
      helperPath: this.helperPath,
      policyFilePath: this.policyFilePath,
      spec,
      scrubEnv: (env) => this.scrubCredentialEnv(env),
    });
  }

  status(): SandboxStatus {
    return this.currentStatus;
  }

  /**
   * Remove the credential env vars this provider strips, so a sandboxed (or
   * escalated) command never inherits ambient secrets. Same contract as the
   * POSIX provider: filesystem deny-reads do not cover env-var secrets.
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
   * Best-effort denial attribution. Tier 1 has no violation log (unlike macOS),
   * so this is a conservative stderr heuristic like the Linux path: an
   * access-denied marker while the sandbox was enforcing MAY be a denial. A miss
   * just means no self-explaining note; the wording stays tentative.
   */
  classifyFailure(failure: SandboxCommandFailure): SandboxDenial | null {
    if (this.currentStatus.backend === 'none') return null;
    if (failure.exitCode === null || failure.exitCode === 0) return null;
    for (const marker of WINDOWS_DENIAL_MARKERS) {
      const match = marker.pattern.exec(failure.stderr);
      if (match) {
        return {
          dimension: marker.dimension,
          detail: `stderr reports "${match[0]}" while the sandbox was enforcing`,
          escalatable: true,
        };
      }
    }
    return null;
  }

  async dispose(): Promise<void> {
    this.cleanupPolicyFile();
    this.currentStatus = UNCONTAINED('disposed');
  }

  private resolveSandboxTemp(policy: SandboxPolicy): string {
    // Prefer a writable root that already looks like a per-session temp; else
    // fall back to a fresh temp dir. The helper labels this dir Low so a
    // Low-integrity child can write it (see the MIC note in the runbook).
    const provided = policy.filesystem.writableRoots.find((r) => /cortex-sbx-/i.test(r));
    if (provided) return provided;
    return mkdtempSync(join(tmpdir(), 'cortex-sbx-'));
  }

  private cleanupPolicyFile(): void {
    if (this.policyFilePath !== undefined) {
      try {
        this.removePolicyFile(this.policyFilePath);
      } catch {
        // Best-effort: a leftover policy file is inert (the helper only reads it).
      }
      this.policyFilePath = undefined;
    }
  }

  private setStatus(status: SandboxStatus): SandboxStatus {
    this.currentStatus = status;
    if (status.degradations.length > 0) {
      this.options.onDegraded?.(status.degradations);
    }
    return status;
  }
}

function defaultWritePolicyFile(json: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cortex-sbx-policy-'));
  const path = join(dir, 'policy.json');
  writeFileSync(path, json, { encoding: 'utf8', mode: 0o600 });
  return path;
}
