/**
 * Native Windows Tier-1 SandboxProvider (restricted-token helper).
 *
 * On Windows there is no Seatbelt/bubblewrap, and sandbox-runtime's Windows
 * support is alpha and explicitly "not a security boundary". Instead we spawn a
 * small Rust helper exe (packages/cortex-sandbox/windows-helper) in place of the
 * shell. (The helper runs and contains unsigned; Authenticode signing is for
 * DISTRIBUTION, to avoid antivirus false-positives on other machines, not to
 * run — see docs/cortex/windows-sandbox-build.md.) For each command the helper:
 *   1. builds a WRITE_RESTRICTED restricted token carrying a synthetic
 *      capability SID (writes must pass BOTH the normal token AND a restricting
 *      SID, so a write succeeds only where that cap SID has an allow ACE),
 *   2. grants the cap SID write ACEs on the workspace roots + a sandbox temp
 *      and layers deny-write ACEs over the agent config and the policy file's
 *      own directory; deny-read ACEs are also applied to secret paths but are
 *      INERT at Tier 1 (see the honesty contract below),
 *   3. optionally drops the token to Low integrity (off by default), launches
 *      the child in a kill-on-close job object with process mitigations, relays
 *      stdio, and returns the child's exit code.
 *
 * Honesty contract (see docs/cortex/sandboxing.md, "Layer 3: native Windows"):
 * Tier 1 is unelevated and same-user. That buys real WRITE confinement and
 * env-credential scrubbing, but NOT secret-file-read denial: a WRITE_RESTRICTED
 * token evaluates the restricting capability SID for write access only, reads
 * ride the normal (same-user) token, so a deny-read ACE keyed to the cap SID
 * never fires and secret files stay readable. Read denial needs the elevated
 * Tier-2 dedicated-user backend. The NETWORK boundary is also absent: proxy env
 * vars are the only control and a command that opens a socket directly ignores
 * them. So status reports filesystem `partial` (never `enforced`) and network
 * `none` (never `partial`). When the helper binary is absent we report fully
 * UNCONTAINED `none` and pass spawns through unchanged, exactly like the POSIX
 * provider on an unsupported host.
 *
 * The policy serialization and argv construction are pure functions
 * (`serializeWindowsPolicy`, `buildHelperInvocation`) so they are unit-testable
 * on any platform without the helper binary or a Windows host.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_CREDENTIAL_ENV_VARS } from './policy.js';
import type {
  SandboxProvider,
  SandboxPolicy,
  SandboxStatus,
  SandboxSpawnSpec,
  SandboxExecSpec,
  SandboxCommandFailure,
  SandboxDenial,
  WrappedSpawn,
} from '@animus-labs/cortex';

/** Bump when the helper's expected policy shape changes; the helper validates it. */
export const WINDOWS_POLICY_VERSION = 1 as const;

/**
 * Exit code the helper uses when containment setup fails before the child ran.
 * A cheap pre-filter only: a real child can also exit 87, so pair it with the
 * sentinel below (see `isHelperSetupFailure`).
 */
export const WINDOWS_HELPER_SETUP_FAILURE_EXIT = 87 as const;

/**
 * Stderr sentinel the helper prints ONLY on a containment-setup failure (when
 * the child never started). Kept in exact lockstep with `SETUP_FAILURE_SENTINEL`
 * in the Rust helper's main.rs. Because the child never runs on setup failure,
 * this line is the helper's alone and cannot be interleaved with child stderr,
 * so it disambiguates "the sandbox could not be established" (fail-closed, the
 * command did NOT run) from "the command ran and exited 87".
 */
export const WINDOWS_HELPER_SETUP_FAILURE_SENTINEL = 'cortex-sandbox-helper[setup-failure]:';

/**
 * True when a failed wrapped spawn is a helper containment-setup failure (the
 * command never ran) rather than a real command failure. Keys on the stderr
 * sentinel, gated by the setup-failure exit code as a cheap pre-check. Use this
 * to surface "the sandbox could not be established" distinctly from a command
 * that legitimately failed, and to know the command did NOT execute.
 */
export function isHelperSetupFailure(failure: {
  exitCode: number | null;
  stderr: string;
}): boolean {
  return (
    failure.exitCode === WINDOWS_HELPER_SETUP_FAILURE_EXIT &&
    failure.stderr.includes(WINDOWS_HELPER_SETUP_FAILURE_SENTINEL)
  );
}

/**
 * Stdout sentinel the helper prints on a successful `--selftest`. Kept in
 * lockstep with `SELFTEST_OK_SENTINEL` in the Rust helper's main.rs.
 */
export const WINDOWS_HELPER_SELFTEST_OK = 'cortex-sandbox-helper[selftest]: ok';

/** Result of the helper execution preflight. */
export interface HelperSelfTestResult {
  /** True only when the helper launched, created a restricted token, and exited 0. */
  ok: boolean;
  /** Human-readable reason when it did not (stderr, error code, or message). */
  detail?: string;
}

/**
 * Run the helper's `--selftest` and report whether it executed cleanly. This is
 * the execution preflight: `fileExists` proves the binary is on disk, but an
 * unsigned token-manipulating exe is a prime antivirus/EDR false-positive, so
 * "present" does not imply "runnable." The self-test exercises the AV-sensitive
 * step (building a restricted token) with no filesystem side effects; if it
 * cannot run, the provider degrades to honest `none` rather than claiming
 * containment it would then fail to deliver on every command.
 *
 * Both failure shapes are treated as "cannot run": a spawn error (ENOENT/EACCES
 * when the file is present but blocked/quarantined) and a non-zero exit (the
 * helper ran but a setup step was blocked).
 */
export function runHelperSelfTest(helperPath: string): HelperSelfTestResult {
  try {
    const out = execFileSync(helperPath, ['--selftest'], {
      // Generous: the FIRST execution of an unsigned exe can be slow while
      // Defender real-time scan / SmartScreen inspects it. Too short a timeout
      // would false-degrade a perfectly good helper on the first session.
      timeout: 20000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    if (out.includes(WINDOWS_HELPER_SELFTEST_OK)) return { ok: true };
    return { ok: false, detail: 'self-test produced no success sentinel' };
  } catch (err) {
    const e = err as { code?: string; status?: number; stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? '');
    const detail =
      stderr.trim() ||
      (e.code ? `spawn error ${e.code}` : undefined) ||
      (typeof e.status === 'number' ? `exit ${e.status}` : undefined) ||
      e.message ||
      'self-test failed';
    return { ok: false, detail };
  }
}

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
   * Name the helper feeds to DeriveCapabilitySidsFromName to derive the
   * restricting capability SID. Derived per install AND per workspace (the base
   * name plus a stable hash of the canonical workspace roots, see
   * `deriveWorkspaceCapabilitySidName`): grant-write ACEs persist on disk, so a
   * workspace-specific SID keeps one workspace's accreted grants from
   * authorizing a token created for another workspace. Deterministic for a
   * given workspace: re-running reuses ACEs rather than accumulating. Must come
   * from trusted config, never model input.
   */
  capabilitySidName: string;
  /**
   * Absolute paths the sandboxed process may write. Established from trusted
   * session config, NEVER widened by a model-controlled cwd (CVE-2025-59532).
   * Includes the sandbox temp but never the host's real temp root (which would
   * otherwise be granted to the cap SID and, with lowIntegrity, persistently
   * Low-labeled).
   */
  writableRoots: string[];
  /** The per-session sandbox temp dir (a member of writableRoots, named so the helper can label it). */
  sandboxTemp: string;
  /**
   * Secret paths (stores, credential files) given deny-read ACEs for the
   * capability SID. INERT at Tier 1: under a same-user WRITE_RESTRICTED token,
   * reads never consult the restricting SID, so these ACEs do NOT stop the
   * child reading secrets (credential env scrubbing is Tier 1's actual
   * control). Kept in the contract because the ACEs are harmless here and a
   * Tier-2 dedicated-user token evaluates them for real.
   */
  denyReadPaths: string[];
  /**
   * Absolute paths that must never be written (agent config, .git/hooks,
   * .git/config, and the policy file's own directory so a sandboxed command
   * cannot rewrite the policy that governs the next command). Effective at
   * Tier 1: writes DO consult the restricting SID and deny ACEs are evaluated
   * first.
   */
  denyWritePaths: string[];
  /** Drop the child token to Low integrity (default false). See the runbook for the MIC tradeoff. */
  lowIntegrity: boolean;
}

export interface WindowsRestrictedTokenProviderOptions {
  /**
   * Absolute path to the helper exe (signed for distribution; an unsigned local
   * build runs and contains too). Defaults to the binary bundled at
   * `<package>/vendor/win32-x64/cortex-sandbox-helper.exe`. When it is absent,
   * the provider degrades to honest UNCONTAINED `none` rather than failing.
   */
  helperPath?: string;
  /**
   * Base name used to derive the capability SID name; the provider appends a
   * stable per-workspace hash (`deriveWorkspaceCapabilitySidName`) so grant
   * ACEs persisted on one workspace never authorize a session in another. Two
   * installs on a shared machine SHOULD still pass different base names so
   * their ACEs never cross-grant even for the same workspace path. Defaults to
   * DEFAULT_CAPABILITY_SID_NAME.
   */
  capabilitySidName?: string;
  /**
   * Drop the child to Low integrity for a third, MIC-level write gate. Default
   * FALSE, matching Codex (which ships Medium/LUA_TOKEN): Low persistently
   * Low-labels the writable roots and can block the child from editing
   * pre-existing Medium-integrity files inside the workspace. The
   * WRITE_RESTRICTED cap-SID mechanism fully confines writes without it. When
   * enabled, only the workspace roots and the dedicated sandbox temp are ever
   * labeled; the host's real temp root never is (it is excluded from
   * writableRoots).
   */
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
  /**
   * Test seam / override: the execution preflight. `initialize` runs this after
   * confirming the helper exists, and degrades to honest `none` when it reports
   * `ok: false` (the helper is present but cannot run: quarantined by antivirus,
   * corrupted, or a wrong-arch build). Defaults to spawning `<helper> --selftest`
   * via `runHelperSelfTest`. Pass `() => ({ ok: true })` to skip it.
   */
  selfTest?: (helperPath: string) => HelperSelfTestResult;
  /**
   * Test seam: creates the per-session directory that will hold the policy
   * file and returns it. The directory MUST NOT be under any writable root
   * (initialize verifies and refuses to enforce otherwise): a policy file the
   * sandboxed child could rewrite would let one command choose the next
   * command's writable roots. Defaults to a fresh dir under os.tmpdir(), which
   * is itself never a writable root (see serializeWindowsPolicy).
   */
  createPolicyDir?: () => string;
  /** Test seam: writes the policy JSON into the directory and returns the file path. Defaults to `<dir>/policy.json`, mode 0600. */
  writePolicyFile?: (dir: string, json: string) => string;
  /** Test seam: removes the policy directory on dispose/re-init. Defaults to fs.rmSync recursive. */
  removePolicyDir?: (dir: string) => void;
}

/** The default capability SID BASE name; the per-workspace hash is appended. */
export const DEFAULT_CAPABILITY_SID_NAME = 'cortex-sandbox';

const FILESYSTEM_TIER1_DEGRADATION =
  'Tier 1 confines writes and scrubs credential env vars, but does not deny ' +
  'secret file reads (a same-user restricted token cannot: WRITE_RESTRICTED ' +
  'only restricts write access); reads are broad. Read denial requires the ' +
  'elevated Tier-2 dedicated-user backend.';

const NETWORK_TIER1_DEGRADATION =
  'Network egress is not enforced on Windows Tier 1 (unelevated): only proxy ' +
  'env vars constrain it and a direct socket bypasses them. Hard network ' +
  'enforcement needs the elevated Tier 2 (WFP).';

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

/** Normalize a Windows path for comparison: one separator style, no trailing separator, case-folded. */
function normalizeWindowsPath(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function isSameWindowsPath(a: string, b: string): boolean {
  return normalizeWindowsPath(a) === normalizeWindowsPath(b);
}

/** True when `child` is strictly inside `parent` (not equal to it). */
function isWindowsPathUnder(child: string, parent: string): boolean {
  return normalizeWindowsPath(child).startsWith(normalizeWindowsPath(parent) + '\\');
}

function isUnderAnyRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => isSameWindowsPath(path, root) || isWindowsPathUnder(path, root));
}

/**
 * Derive the per-workspace capability SID name: the trusted base name plus a
 * stable hash of the canonical workspace roots (case-folded and sorted, so
 * `C:\WS` vs `c:\ws` and root ordering do not change the identity).
 *
 * Why per-workspace: grant-write ACEs keyed to the cap SID persist on the
 * workspace directories after the session ends. With one machine-wide SID, a
 * later session in workspace B would run under a token whose cap SID still
 * matches the ACEs left on workspace A, silently keeping A writable. A
 * workspace-derived SID scopes each boundary to its own workspace while staying
 * deterministic, so re-running the same workspace reuses ACEs instead of
 * accumulating new ones.
 */
export function deriveWorkspaceCapabilitySidName(
  baseName: string,
  workspaceRoots: string[],
): string {
  const canonical = workspaceRoots.map(normalizeWindowsPath).sort().join('|');
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
  return `${baseName}-${hash}`;
}

/**
 * Project a SandboxPolicy plus per-session metadata into the helper's on-disk
 * contract. Pure: no fs, no platform checks, no clock.
 *
 *   - The sandbox temp is appended to writableRoots if not already present, so
 *     the child can always write its own temp.
 *   - `hostTempDir` (the machine's real temp root) is EXCLUDED from
 *     writableRoots: the child's TEMP/TMP point at the dedicated sandbox temp
 *     instead (see buildHelperInvocation), so the real temp root is never
 *     granted to the cap SID nor Low-labeled.
 *   - `policyFileDir` is appended to denyWritePaths so the sandbox itself
 *     denies rewriting the policy that governs subsequent commands.
 */
export function serializeWindowsPolicy(
  policy: SandboxPolicy,
  meta: {
    sandboxTemp: string;
    capabilitySidName: string;
    lowIntegrity: boolean;
    hostTempDir?: string;
    policyFileDir?: string;
  },
): WindowsHelperPolicy {
  const roots = policy.filesystem.writableRoots.filter(
    (root) => meta.hostTempDir === undefined || !isSameWindowsPath(root, meta.hostTempDir),
  );
  const writableRoots = roots.some((root) => isSameWindowsPath(root, meta.sandboxTemp))
    ? [...roots]
    : [...roots, meta.sandboxTemp];
  const denyWritePaths = [...policy.filesystem.denyWrite];
  if (
    meta.policyFileDir !== undefined &&
    !denyWritePaths.some((p) => isSameWindowsPath(p, meta.policyFileDir as string))
  ) {
    denyWritePaths.push(meta.policyFileDir);
  }
  return {
    version: WINDOWS_POLICY_VERSION,
    capabilitySidName: meta.capabilitySidName,
    writableRoots,
    sandboxTemp: meta.sandboxTemp,
    denyReadPaths: [...policy.filesystem.denyRead],
    denyWritePaths,
    lowIntegrity: meta.lowIntegrity,
  };
}

/**
 * Build the full wrapped spawn that launches `spec` under the helper:
 *   file = helperPath
 *   args = [policyFilePath, '--', shell, ...shellArgs, command]
 * The env is passed through the provided scrubber so ambient credential env
 * vars never reach the child, and TEMP/TMP are pointed at the dedicated
 * sandbox temp: the host's real temp root is not a writable root, so a child
 * writing to its default %TEMP% would otherwise fail. Pure given its inputs.
 */
export function buildHelperInvocation(params: {
  helperPath: string;
  policyFilePath: string;
  sandboxTemp: string;
  spec: SandboxSpawnSpec;
  scrubEnv: (env: Record<string, string>) => Record<string, string>;
}): WrappedSpawn {
  const { helperPath, policyFilePath, sandboxTemp, spec, scrubEnv } = params;
  return {
    file: helperPath,
    args: [policyFilePath, '--', spec.shell, ...spec.shellArgs, spec.command],
    env: { ...scrubEnv(spec.env), TEMP: sandboxTemp, TMP: sandboxTemp },
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
  private policyDir: string | undefined;
  private sandboxTemp: string | undefined;
  private readonly helperPath: string;
  private readonly capabilitySidBaseName: string;
  private readonly lowIntegrity: boolean;
  private readonly credentialEnvVars: string[];
  private readonly fileExists: (path: string) => boolean;
  private readonly selfTest: (helperPath: string) => HelperSelfTestResult;
  private readonly createPolicyDir: () => string;
  private readonly writePolicyFile: (dir: string, json: string) => string;
  private readonly removePolicyDir: (dir: string) => void;

  constructor(private readonly options: WindowsRestrictedTokenProviderOptions = {}) {
    this.helperPath = options.helperPath ?? defaultHelperPath();
    this.capabilitySidBaseName = options.capabilitySidName ?? DEFAULT_CAPABILITY_SID_NAME;
    this.lowIntegrity = options.lowIntegrity ?? false;
    this.credentialEnvVars = options.credentialEnvVars ?? [...DEFAULT_CREDENTIAL_ENV_VARS];
    this.fileExists = options.fileExists ?? ((p) => existsSync(p));
    this.selfTest = options.selfTest ?? runHelperSelfTest;
    this.createPolicyDir = options.createPolicyDir ?? defaultCreatePolicyDir;
    this.writePolicyFile = options.writePolicyFile ?? defaultWritePolicyFile;
    this.removePolicyDir =
      options.removePolicyDir ?? ((dir) => rmSync(dir, { recursive: true, force: true }));
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

    // A rung change re-initializes: drop the previous policy dir first.
    this.cleanupPolicyDir();

    // Execution preflight. `fileExists` proved the binary is on disk, but an
    // unsigned token-manipulating exe is a prime antivirus/EDR false-positive,
    // so "present" does not imply "runnable." A helper that is quarantined,
    // blocked by policy, corrupted, or wrong-arch would otherwise claim `partial`
    // and then fail every command. Detect it here and report honest `none`.
    const selfTest = this.selfTest(this.helperPath);
    if (!selfTest.ok) {
      return this.setStatus(
        UNCONTAINED(
          `The Windows sandbox helper is present but could not run, so shell commands run ` +
            `WITHOUT OS containment. This is most often antivirus or endpoint-security software ` +
            `quarantining the helper (it creates restricted tokens, which looks suspicious for an ` +
            `unsigned binary); it can also be a corrupted binary or a system security policy. ` +
            `Allow or restore cortex-sandbox-helper.exe in your security software to restore ` +
            `containment, or turn the sandbox off to dismiss this` +
            (selfTest.detail ? ` (self-test: ${selfTest.detail}).` : '.'),
        ),
      );
    }

    const hostTempDir = canonicalHostTempDir();
    const sandboxTemp = this.resolveSandboxTemp(policy);
    // The workspace identity for the cap SID: writable roots minus anything
    // temp-flavored (the host temp root, dirs under it, the sandbox temp).
    // Per-session temp dirs would otherwise churn the hash every session and
    // reintroduce the cross-session ACE accretion the hash exists to stop.
    const workspaceRoots = policy.filesystem.writableRoots.filter(
      (root) =>
        !isSameWindowsPath(root, hostTempDir) &&
        !isWindowsPathUnder(root, hostTempDir) &&
        !isSameWindowsPath(root, sandboxTemp),
    );
    const capabilitySidName = deriveWorkspaceCapabilitySidName(
      this.capabilitySidBaseName,
      workspaceRoots,
    );

    let policyDir: string;
    try {
      policyDir = this.createPolicyDir();
    } catch (err) {
      return this.setStatus(
        UNCONTAINED(
          `Could not create the Windows sandbox policy directory: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }

    const helperPolicy = serializeWindowsPolicy(policy, {
      sandboxTemp,
      capabilitySidName,
      lowIntegrity: this.lowIntegrity,
      hostTempDir,
      policyFileDir: policyDir,
    });

    // TOCTOU guard: a policy file inside a writable root could be rewritten by
    // a sandboxed command, letting one command choose the next command's
    // writable roots. Refuse to claim enforcement rather than enforce a
    // rewritable policy.
    if (isUnderAnyRoot(policyDir, helperPolicy.writableRoots)) {
      this.removePolicyDirSafe(policyDir);
      return this.setStatus(
        UNCONTAINED(
          `Windows sandbox policy directory ${policyDir} is inside a writable root; ` +
            `a sandboxed command could rewrite the policy, so the sandbox was not established.`,
        ),
      );
    }

    try {
      this.policyFilePath = this.writePolicyFile(policyDir, JSON.stringify(helperPolicy, null, 2));
      this.policyDir = policyDir;
    } catch (err) {
      this.removePolicyDirSafe(policyDir);
      return this.setStatus(
        UNCONTAINED(
          `Could not write the Windows sandbox policy file: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }
    this.sandboxTemp = sandboxTemp;

    // Honest Tier-1 status: writes confined + env creds scrubbed, but secret
    // READS are not denied (so filesystem `partial`, never `enforced`) and
    // there is no network boundary (`none`, never `partial`).
    return this.setStatus({
      filesystem: 'partial',
      network: 'none',
      backend: 'win-restricted-token',
      degradations: [FILESYSTEM_TIER1_DEGRADATION, NETWORK_TIER1_DEGRADATION],
    });
  }

  async wrapSpawn(spec: SandboxSpawnSpec): Promise<WrappedSpawn> {
    // Not enforcing (non-win32 or helper absent): pass through so the command
    // still runs. Status already reports this as uncontained.
    if (
      this.currentStatus.backend === 'none' ||
      this.policyFilePath === undefined ||
      this.sandboxTemp === undefined
    ) {
      return { file: spec.shell, args: [...spec.shellArgs, spec.command], env: spec.env };
    }
    return buildHelperInvocation({
      helperPath: this.helperPath,
      policyFilePath: this.policyFilePath,
      sandboxTemp: this.sandboxTemp,
      spec,
      scrubEnv: (env) => this.scrubCredentialEnv(env),
    });
  }

  /**
   * Wrap a bare program+args invocation (the Grep tool's ripgrep, a stdio MCP
   * server) under the same helper as wrapSpawn, so those subprocesses get the
   * same restricted-token write-confinement Bash gets. Without this they would
   * spawn uncontained even when Bash is contained. Mirrors wrapSpawn, minus the
   * shell: the helper runs `<file> <args...>` directly after the `--` separator.
   * Like the rest of the Windows path this is scaffolded and unverified on a real
   * Windows build; the mac/Linux provider is the enforced one today.
   */
  async wrapExec(spec: SandboxExecSpec): Promise<WrappedSpawn> {
    if (
      this.currentStatus.backend === 'none' ||
      this.policyFilePath === undefined ||
      this.sandboxTemp === undefined
    ) {
      return { file: spec.file, args: spec.args, env: spec.env };
    }
    return {
      file: this.helperPath,
      args: [this.policyFilePath, '--', spec.file, ...spec.args],
      env: { ...this.scrubCredentialEnv(spec.env), TEMP: this.sandboxTemp, TMP: this.sandboxTemp },
    };
  }

  status(): SandboxStatus {
    return this.currentStatus;
  }

  /**
   * Remove the credential env vars this provider strips, so a sandboxed (or
   * escalated) command never inherits ambient secrets. Same contract as the
   * POSIX provider. On Tier-1 Windows this is the PRIMARY credential control:
   * filesystem deny-reads are inert under the same-user restricted token.
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

  /**
   * The Bash tool calls this when a wrapped spawn fails to launch the helper
   * itself (spawn ENOENT/EACCES/EPERM) — the mid-session counterpart to the
   * initialize() preflight. The canonical cause is antivirus/EDR quarantining
   * the helper after it passed the preflight. Degrade to honest `none` so every
   * subsequent wrapSpawn/wrapExec passes the command through uncontained (rather
   * than failing each one), and surface the reason via onDegraded. The failed
   * command itself did not run; the Bash tool reports that to the model. Safe to
   * act on: a sandboxed child cannot forge a helper-launch failure (the helper
   * lives outside every writable root, so the child cannot make it un-launchable).
   */
  notifyWrappedSpawnFailure(error: { code?: string | undefined; message: string }): void {
    if (this.currentStatus.backend === 'none') return;
    this.cleanupPolicyDir();
    this.sandboxTemp = undefined;
    this.setStatus(
      UNCONTAINED(
        `The Windows sandbox helper failed to launch (${error.code ?? error.message}), so OS ` +
          `containment is now disabled for this session and shell commands run WITHOUT it. This ` +
          `is most often antivirus or endpoint-security software quarantining the helper after ` +
          `it started. Restore cortex-sandbox-helper.exe in your security software (or use a ` +
          `signed build), then restart the session to re-enable containment.`,
      ),
    );
  }

  async dispose(): Promise<void> {
    this.cleanupPolicyDir();
    this.sandboxTemp = undefined;
    this.currentStatus = UNCONTAINED('disposed');
  }

  private resolveSandboxTemp(policy: SandboxPolicy): string {
    // Prefer the session temp the policy names explicitly; else a writable root
    // that already looks like a per-session temp; else a fresh temp dir. When
    // lowIntegrity is on, the helper labels this dir Low so the Low child can
    // write it; only this dedicated dir is ever labeled, never the host temp
    // root itself.
    if (policy.filesystem.sessionTmpDir) return policy.filesystem.sessionTmpDir;
    const provided = policy.filesystem.writableRoots.find((r) => /cortex-sbx-/i.test(r));
    if (provided) return provided;
    return mkdtempSync(join(tmpdir(), 'cortex-sbx-'));
  }

  private cleanupPolicyDir(): void {
    if (this.policyDir !== undefined) {
      this.removePolicyDirSafe(this.policyDir);
      this.policyDir = undefined;
    }
    this.policyFilePath = undefined;
  }

  private removePolicyDirSafe(dir: string): void {
    try {
      this.removePolicyDir(dir);
    } catch {
      // Best-effort: a leftover policy file is inert (the helper only reads it).
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

/** The host's real temp root, canonicalized the same way buildDefaultPolicy does. */
function canonicalHostTempDir(): string {
  const t = tmpdir();
  try {
    return realpathSync.native(t);
  } catch {
    return t;
  }
}

function defaultCreatePolicyDir(): string {
  // Under the host temp root, which is never a writable root (the dedicated
  // sandbox temp replaces it), so the sandboxed child cannot reach this file.
  // initialize() verifies that and denyWritePaths covers it as well.
  return mkdtempSync(join(tmpdir(), 'cortex-sbx-policy-'));
}

function defaultWritePolicyFile(dir: string, json: string): string {
  const path = join(dir, 'policy.json');
  writeFileSync(path, json, { encoding: 'utf8', mode: 0o600 });
  return path;
}
