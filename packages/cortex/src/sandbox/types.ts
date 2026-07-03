/**
 * OS-level sandbox seam for Cortex.
 *
 * Cortex core defines the policy vocabulary and the provider interface, but
 * ships no enforcement and takes no new dependency. A consumer supplies a
 * SandboxProvider (e.g. @animus-labs/cortex-sandbox) that translates a
 * SandboxPolicy into OS primitives (macOS Seatbelt, Linux bubblewrap, a
 * Windows helper) and wraps subprocess spawns. When no provider is configured,
 * behavior is unchanged.
 *
 * See docs/cortex/sandboxing.md for the design.
 */

/** Trust rungs, most contained to least. Each is a preset over both axes. */
export type SandboxRung = 'restricted' | 'workspace' | 'trusted' | 'off';

export interface SandboxFilesystemPolicy {
  /**
   * Absolute paths the sandboxed process may write. Established from trusted
   * session configuration, NEVER from model-controlled tool input (a tool's
   * cwd argument must not widen this; see CVE-2025-59532 for why this matters).
   */
  writableRoots: string[];
  /** Absolute paths that must never be readable (secrets, credential stores). */
  denyRead: string[];
  /** Absolute paths that must never be written (agent config, .git/hooks, .git/config). */
  denyWrite: string[];
  /** Absolute paths re-allowed for read within a denyRead subtree. */
  allowRead?: string[];
}

export type SandboxNetworkMode = 'deny' | 'allowlist' | 'full';

export interface SandboxNetworkPolicy {
  /** deny = no egress; allowlist = only allowedDomains; full = unrestricted. */
  mode: SandboxNetworkMode;
  /** Domain patterns allowed without prompting. Supports a leading "*." wildcard. */
  allowedDomains: string[];
  /** Domain patterns always denied; evaluated before allowedDomains. */
  deniedDomains: string[];
  /**
   * Allow connecting/binding to loopback so local MCP servers and dev servers
   * remain reachable. Defaults to true. Note that open loopback is an attack
   * surface: an injected agent can reach local services through it.
   */
  allowLocalBinding?: boolean;
}

export interface SandboxPolicy {
  rung: SandboxRung;
  filesystem: SandboxFilesystemPolicy;
  network: SandboxNetworkPolicy;
}

/** How completely a dimension is actually enforced on this machine. */
export type SandboxEnforcement = 'enforced' | 'partial' | 'none';

export type SandboxBackend =
  | 'seatbelt'
  | 'bubblewrap'
  | 'win-restricted-token'
  | 'none';

/**
 * The honesty contract. A provider reports what it ACTUALLY enforces on this
 * machine, which may be less than the requested policy (e.g. bubblewrap blocked
 * by AppArmor, or Windows before the native helper ships). It must never claim
 * more than it delivers; the consumer decides whether to warn, degrade, or refuse.
 */
export interface SandboxStatus {
  filesystem: SandboxEnforcement;
  network: SandboxEnforcement;
  backend: SandboxBackend;
  /** Human-readable reasons enforcement is reduced from the requested policy. */
  degradations: string[];
}

/** A shell command spawn the provider will wrap. */
export interface SandboxSpawnSpec {
  /** The resolved shell binary that will execute the command. */
  shell: string;
  /** Shell flags that precede the command in an unsandboxed spawn (e.g. ['-c']). */
  shellArgs: string[];
  /** The fully-composed command string, including any cwd-capture suffix. */
  command: string;
  /** Working directory for the spawn. */
  cwd: string;
  /** Environment for the child (already sanitized by buildSafeEnv). */
  env: Record<string, string>;
}

/** A wrapped spawn that launches the same command under the sandbox. */
export interface WrappedSpawn {
  file: string;
  args: string[];
  env: Record<string, string>;
}

/** Attribution of a failed tool result to a sandbox denial, for self-explaining UX. */
export interface SandboxDenial {
  dimension: 'filesystem-read' | 'filesystem-write' | 'network' | 'unknown';
  /** Human- and model-readable explanation, e.g. "network egress to example.com". */
  detail: string;
  /** Whether re-running the command uncontained can be offered as an escalation. */
  escalatable: boolean;
}

/**
 * OS-level enforcement supplied by a consumer. Core calls into this at the
 * subprocess boundary; it never implements enforcement itself. The consumer
 * constructs and initializes the provider (it owns policy computation and any
 * interactive egress prompts) before handing it to the agent.
 */
export interface SandboxProvider {
  /**
   * Establish enforcement for the given policy (start egress proxy, prepare the
   * OS profile). Called once by the consumer before use. Returns the honest
   * status of what is actually enforced.
   */
  initialize(policy: SandboxPolicy): Promise<SandboxStatus>;
  /**
   * Wrap a shell command spawn so it launches contained, returning the argv and
   * env to spawn. Async because a backend may generate an OS profile or await a
   * proxy per call. It prepares the invocation; it does not launch a process.
   */
  wrapSpawn(spec: SandboxSpawnSpec): Promise<WrappedSpawn>;
  /**
   * Optionally classify a completed tool result as a sandbox denial so the
   * caller can surface a self-explaining message and offer escalation. Returns
   * null when the result is not attributable to the sandbox. Reliable on macOS
   * (violation log), best-effort on Linux (EPERM only).
   */
  classifyFailure?(result: unknown): SandboxDenial | null;
  /** Current enforcement status (after initialize), for transparency surfaces. */
  status?(): SandboxStatus;
  /** Tear down the egress proxy and any transient OS state. */
  dispose(): Promise<void>;
}
