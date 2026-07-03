/**
 * Bash command parsing utilities for permission matching.
 *
 * Permission rules for Bash operate on a *prefix* of the command (e.g.
 * `git commit *`). A naive `startsWith` check is unsafe: the shell treats
 * `&&`, `||`, `;`, `|`, `&`, and command substitution as command boundaries,
 * so `git status && rm -rf /` would match a `git *` rule even though it runs a
 * second, unrelated command. The quote-aware splitter lives in
 * `@animus-labs/cortex` (shared with the catastrophic-command floor) and is
 * re-exported here; this module keeps the permission-specific pieces: safe env
 * var stripping and "always allow" prefix suggestion.
 */

export { splitBashCommand, isCompoundBash } from '@animus-labs/cortex';

/**
 * Second-token shape that qualifies as a "subcommand" (e.g. `commit`, `run`,
 * `compose`). Rejects flags (`-rf`), filenames (`file.txt`), paths (`/tmp`),
 * numbers (`755`), and uppercase refs (`HEAD`). Used to decide whether to
 * suggest a two-word prefix like `git commit *` instead of just `git *`.
 */
export const SUBCOMMAND_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Commands that execute arbitrary other commands. A prefix rule like
 * `Bash(bash *)` or `Bash(sudo *)` would be equivalent to allowing everything,
 * so we never *suggest* a prefix for these (the user can still write an explicit
 * rule by hand). Mirrors the interpreters/wrappers Claude Code refuses to
 * auto-suggest.
 */
export const BARE_SHELL_PREFIXES = new Set<string>([
  // Shells / interpreters reachable via -c
  'sh', 'bash', 'zsh', 'fish', 'csh', 'tcsh', 'ksh', 'dash',
  'cmd', 'powershell', 'pwsh',
  'eval', 'exec', 'source',
  // Wrappers that exec their arguments as a command
  'env', 'xargs', 'nice', 'stdbuf', 'nohup', 'timeout', 'time',
  'setsid', 'ionice', 'command', 'builtin',
  // Privilege escalation
  'sudo', 'doas', 'pkexec',
]);

/**
 * Destructive or exfiltration-capable commands for which we never suggest an
 * "always allow" prefix. A one-click `Bash(rm *)` rule combined with any
 * residual parser gap would auto-approve a wipe; forcing these through the
 * prompt every time (or through a hand-written rule) keeps the failure mode
 * contained. The catastrophic floor still hard-blocks the irreversible
 * subset regardless of rules.
 */
export const NO_SUGGEST_PREFIXES = new Set<string>([
  // POSIX destructive
  'rm', 'rmdir', 'shred', 'find', 'dd', 'chmod', 'chown', 'chgrp', 'tee',
  'wipefs', 'blkdiscard', 'mkswap',
  // Network exfiltration / arbitrary download
  'curl', 'wget', 'scp', 'rsync',
  // Windows / PowerShell destructive
  'remove-item', 'ri', 'del', 'erase', 'rd',
  'format', 'format-volume', 'clear-disk', 'remove-partition', 'diskpart',
]);

/** Git subcommands that discard or rewrite work; no one-click allow-rule. */
export const NO_SUGGEST_GIT_SUBCOMMANDS = new Set<string>([
  'clean', 'reset', 'checkout', 'restore', 'rebase', 'push', 'branch',
  'stash', 'rm', 'prune', 'gc', 'reflog', 'filter-branch', 'filter-repo',
  'update-ref', 'worktree',
]);

/**
 * Environment variables that are safe to strip from the front of a command
 * before matching, because they cannot execute code or hijack binary
 * resolution. This lets a rule like `Bash(npm run *)` match
 * `NODE_ENV=test npm run build`. Deliberately excludes PATH, LD_*, DYLD_*,
 * NODE_OPTIONS, PYTHONPATH, etc. which can change which binary runs.
 */
export const SAFE_ENV_VARS = new Set<string>([
  'NODE_ENV',
  'GOOS', 'GOARCH', 'CGO_ENABLED', 'GO111MODULE', 'GOEXPERIMENT',
  'RUST_BACKTRACE', 'RUST_LOG',
  'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE',
  'CI', 'FORCE_COLOR', 'NO_COLOR',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TZ',
]);

const ENV_ASSIGN_RE =
  /^([A-Za-z_][A-Za-z0-9_]*)=(?:'[^']*'|"[^"]*"|[^\s'"]*)[ \t]+/;
const ENV_ASSIGN_HEAD_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Strip leading `VAR=value` assignments from a command.
 *
 * @param safeOnly when true, stops at the first variable not in SAFE_ENV_VARS
 *   (used for allow-rule matching, so an unsafe var like `PATH=/evil` can't be
 *   hidden to satisfy an allow rule). When false, strips every leading
 *   assignment (used for deny matching, so `FOO=bar denied-cmd` still matches a
 *   deny rule for `denied-cmd`).
 */
export function stripLeadingAssignments(command: string, safeOnly: boolean): string {
  let s = command.trim();
  for (;;) {
    const m = s.match(ENV_ASSIGN_RE);
    if (!m) break;
    const name = m[1] ?? '';
    if (safeOnly && !SAFE_ENV_VARS.has(name)) break;
    s = s.slice(m[0].length);
  }
  return s;
}

/**
 * Suggest an "always allow" prefix pattern for a Bash command.
 *
 * Produces a two-word prefix (`git commit *`) when the second token looks like
 * a subcommand, otherwise a one-word prefix (`ls *`). Returns '' (no
 * suggestion) for bare shells/wrappers, destructive commands, destructive git
 * subcommands, and commands led by an unsafe env var, since no safe prefix
 * exists for those.
 */
export function extractBashPrefix(command: string): string {
  const stripped = stripLeadingAssignments(command.trim(), true);
  // A leftover leading assignment means an unsafe var (safe ones were stripped);
  // there's no useful prefix to suggest.
  if (ENV_ASSIGN_HEAD_RE.test(stripped)) return '';

  const tokens = stripped.split(/\s+/).filter(Boolean);
  const cmd = tokens[0];
  if (!cmd) return '';
  if (BARE_SHELL_PREFIXES.has(cmd)) return '';

  const cmdLower = cmd.toLowerCase();
  if (NO_SUGGEST_PREFIXES.has(cmdLower) || cmdLower.startsWith('mkfs')) return '';

  const second = tokens[1];
  if (cmdLower === 'git' && second && NO_SUGGEST_GIT_SUBCOMMANDS.has(second.toLowerCase())) {
    return '';
  }

  if (second && SUBCOMMAND_RE.test(second)) return `${cmd} ${second} *`;
  return `${cmd} *`;
}
