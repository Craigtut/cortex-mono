/**
 * Default policy construction: turn a trust rung plus workspace roots into a
 * concrete SandboxPolicy. This encodes the universal, OS-level defaults (secret
 * stores, persistence/exfiltration write targets, seeded package registries).
 * Consumer-specific paths (a product's own settings/credential files) are added
 * by the consumer via the extra* options, not hardcoded here.
 */
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxPolicy, SandboxRung } from '@animus-labs/cortex';

/**
 * Package registries pre-allowed at the Workspace rung so installs and fetches
 * work with no prompt. `*.host` patterns require at least two labels (the
 * upstream domain validator rejects bare `*` and `*.tld`).
 */
export const SEEDED_REGISTRY_DOMAINS: readonly string[] = [
  // JavaScript
  'registry.npmjs.org',
  '*.npmjs.org',
  'registry.yarnpkg.com',
  // Python
  'pypi.org',
  '*.pypi.org',
  'files.pythonhosted.org',
  // Rust
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  // Go
  'proxy.golang.org',
  'sum.golang.org',
  // Ruby
  'rubygems.org',
  '*.rubygems.org',
  // GitHub (source, releases, container registry)
  'github.com',
  '*.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'ghcr.io',
  '*.ghcr.io',
  // Linux system packages
  'deb.debian.org',
  'archive.ubuntu.com',
  'security.ubuntu.com',
];

/** Secret stores denied for reading on every contained rung. */
export function defaultSecretReadDenies(home: string): string[] {
  return [
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.azure'),
    join(home, '.kube'),
    join(home, '.gnupg'),
    join(home, '.config', 'gcloud'),
    join(home, '.docker', 'config.json'),
    join(home, '.netrc'),
  ];
}

/**
 * Persistence and exfiltration write targets denied on every contained rung:
 * shell startup files (a written .zshrc runs on the next shell), the global git
 * config, and, per workspace, the two .git internals that execute or redirect
 * (hooks and config). The rest of .git stays writable so commits work.
 */
export function defaultDangerousWriteDenies(home: string, workspaceRoots: string[]): string[] {
  const rcFiles = [
    '.bashrc',
    '.bash_profile',
    '.zshrc',
    '.zprofile',
    '.profile',
    '.gitconfig',
    '.ripgreprc',
  ].map((f) => join(home, f));
  const gitInternals = workspaceRoots.flatMap((root) => [
    join(root, '.git', 'hooks'),
    join(root, '.git', 'config'),
  ]);
  return [...rcFiles, ...gitInternals];
}

export interface DefaultPolicyOptions {
  /** Absolute workspace roots the agent may write (established from trusted config). */
  workspaceRoots: string[];
  /** Home directory. Defaults to os.homedir(). */
  home?: string;
  /** Session temp directory to allow writes to. Defaults to os.tmpdir(). */
  sessionTmpDir?: string;
  /** Extra domains to pre-allow (e.g. a consumer's registry mirror). */
  extraAllowedDomains?: string[];
  /** Extra paths the consumer wants unwritable (e.g. its own settings/config files). */
  extraDenyWrite?: string[];
  /** Extra paths the consumer wants unreadable (e.g. its own stored credentials). */
  extraDenyRead?: string[];
}

/**
 * Build a SandboxPolicy for a rung. `off` is treated as the least-restrictive
 * preset for safety, but a consumer at `off` should skip the provider entirely
 * (no containment) rather than rely on this.
 */
export function buildDefaultPolicy(rung: SandboxRung, opts: DefaultPolicyOptions): SandboxPolicy {
  const home = opts.home ?? homedir();
  const tmp = opts.sessionTmpDir ?? tmpdir();
  const roots = opts.workspaceRoots;

  const denyRead = [...defaultSecretReadDenies(home), ...(opts.extraDenyRead ?? [])];
  const denyWrite = [...defaultDangerousWriteDenies(home, roots), ...(opts.extraDenyWrite ?? [])];
  const allowedDomains = [...SEEDED_REGISTRY_DOMAINS, ...(opts.extraAllowedDomains ?? [])];

  const writableRoots = rung === 'restricted' ? [] : [...roots, tmp];

  let network: SandboxPolicy['network'];
  if (rung === 'restricted') {
    network = { mode: 'deny', allowedDomains: [], deniedDomains: [], allowLocalBinding: true };
  } else if (rung === 'workspace') {
    network = { mode: 'allowlist', allowedDomains, deniedDomains: [], allowLocalBinding: true };
  } else {
    // trusted / off
    network = { mode: 'full', allowedDomains, deniedDomains: [], allowLocalBinding: true };
  }

  return {
    rung,
    filesystem: { writableRoots, denyRead, denyWrite },
    network,
  };
}
