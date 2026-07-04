/**
 * Default policy construction: turn a trust rung plus workspace roots into a
 * concrete SandboxPolicy. This encodes the universal, OS-level defaults (secret
 * stores, persistence/exfiltration write targets, seeded package registries).
 * Consumer-specific paths (a product's own settings/credential files) are added
 * by the consumer via the extra* options, not hardcoded here.
 */
import * as fs from 'node:fs';
import { isIP } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxPolicy, SandboxRung } from '@animus-labs/cortex';

/**
 * Credential environment-variable names unset inside the sandbox by default
 * (mode "deny"). Filesystem deny-reads do not cover secrets that live in the
 * environment, and the seeded registry allowlist is a ready exfil channel, so
 * these are scrubbed from the child. Consumers can extend or replace the list.
 */
export const DEFAULT_CREDENTIAL_ENV_VARS: readonly string[] = [
  // Cloud providers
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_API_KEY',
  'AZURE_CLIENT_SECRET',
  // Source hosting and CI
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  // Package registries
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'PYPI_TOKEN',
  'TWINE_PASSWORD',
  'CARGO_REGISTRY_TOKEN',
  // AI / LLM providers
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
  // Other common tokens
  'CLOUDFLARE_API_TOKEN',
  'VERCEL_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'DIGITALOCEAN_TOKEN',
  'SLACK_TOKEN',
  'STRIPE_SECRET_KEY',
  'DOCKER_PASSWORD',
];

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

/**
 * Match a hostname against one domain pattern, with the same semantics as
 * sandbox-runtime's egress proxy (its matcher is not exported, so this mirrors
 * it; keep the two in agreement when bumping the pinned version):
 *   - `*` matches everything.
 *   - `*.example.com` matches strict subdomains only (not example.com itself).
 *     Wildcards never match IP literals, so an address cannot ride a suffix.
 *   - Anything else matches exactly, case-insensitively.
 *
 * Consumers use this to answer the shared egress decision for in-process
 * paths (WebFetch) identically to how the OS proxy answers it for shell
 * commands, so one allowlist gives one behavior on both paths.
 */
export function matchesDomainPattern(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    if (isIP(h.replace(/^\[|\]$/g, ''))) return false;
    return h.endsWith('.' + pattern.slice(2).toLowerCase());
  }
  return h === pattern.toLowerCase();
}

/** True when the hostname matches any pattern in the list. */
export function matchesAnyDomainPattern(hostname: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesDomainPattern(hostname, p));
}

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
    // Tool and CI credential files. Each has a matching seeded exfil destination
    // (npm, github, pypi, crates), so they belong in the default deny, not left
    // to consumer opt-in.
    join(home, '.npmrc'),
    join(home, '.git-credentials'),
    join(home, '.config', 'gh', 'hosts.yml'),
    join(home, '.pypirc'),
    join(home, '.cargo', 'credentials'),
    join(home, '.cargo', 'credentials.toml'),
    join(home, '.terraform.d', 'credentials.tfrc.json'),
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
  // Auto-run-on-login locations: a write here is cross-session code execution.
  // The shell is write-confined to the workspace, but the in-process file tools
  // (deny-list-only) could otherwise reach these under auto-approve, so deny them.
  const persistenceDirs = [
    join(home, 'Library', 'LaunchAgents'),
    join(home, '.config', 'autostart'),
    join(home, '.config', 'systemd', 'user'),
  ];
  return [...rcFiles, ...persistenceDirs, ...gitInternals];
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
  // Canonicalize real paths so they match what the OS backend enforces on (macOS
  // resolves /var to /private/var; a symlinked workspace root must resolve too).
  // Non-existent paths (a secret file the user does not have) pass through as-is.
  const canon = (p: string): string => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return p;
    }
  };
  const home = canon(opts.home ?? homedir());
  const tmp = canon(opts.sessionTmpDir ?? tmpdir());
  const roots = opts.workspaceRoots.map(canon);

  const denyRead = [...defaultSecretReadDenies(home), ...(opts.extraDenyRead ?? [])].map(canon);
  const denyWrite = [...defaultDangerousWriteDenies(home, roots), ...(opts.extraDenyWrite ?? [])].map(canon);
  const allowedDomains = [...SEEDED_REGISTRY_DOMAINS, ...(opts.extraAllowedDomains ?? [])];

  const writableRoots = rung === 'restricted' ? [] : [...roots, tmp];

  const filesystem: SandboxPolicy['filesystem'] = { writableRoots, denyRead, denyWrite };
  // Record the scoped session temp so providers can point the child's
  // TMPDIR/TEMP/TMP at the one writable temp. Only when the consumer scoped it
  // (vs the whole os.tmpdir() fallback) and the rung actually grants writes:
  // the restricted rung writes nowhere, so it names no session temp.
  if (opts.sessionTmpDir !== undefined && rung !== 'restricted') {
    filesystem.sessionTmpDir = tmp;
  }

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
    filesystem,
    network,
  };
}
