/**
 * Catastrophic-command floor.
 *
 * Some commands are never a legitimate thing for an agent to run and would do
 * irreversible, system-wide damage: wiping the filesystem root, overwriting a
 * raw disk, a fork bomb. `findDangerousCommand` detects these so the caller can
 * hard-block them *unconditionally* — before any allow rule, before "yolo"
 * auto-approve, and with no "always allow" escape hatch.
 *
 * Detection runs against every simple-command produced by `splitBashCommand`
 * (so `git status && rm -rf /` and `echo $(rm -rf /)` are both caught) and
 * against a dequoted copy of the command (so `rm -rf "/"` and `rm -r''f /`
 * don't slip past). Leading env-var assignments and exec wrappers (`sudo`,
 * `env`, `nice`, `timeout`, ...) are stripped first so `sudo rm -rf /` is seen
 * as `rm -rf /`.
 *
 * This is a safety floor, not a comprehensive sandbox: it targets a small set
 * of unambiguously catastrophic commands and is tuned to avoid false positives
 * (relative paths and project-local targets are never flagged).
 */

import { splitBashCommand, stripLeadingAssignments } from './bash-command.js';

/** Wrappers that exec their remaining arguments as a command. */
const EXEC_WRAPPERS = new Set<string>([
  'sudo', 'doas', 'pkexec', 'env', 'nice', 'nohup', 'timeout', 'time',
  'stdbuf', 'ionice', 'setsid', 'command', 'builtin', 'exec', 'eval', 'xargs',
]);

/** Top-level system directories whose recursive deletion is catastrophic. */
const CRITICAL_DIRS = new Set<string>([
  'bin', 'boot', 'dev', 'etc', 'home', 'lib', 'lib64', 'opt', 'proc',
  'root', 'sbin', 'sys', 'usr', 'var',
  // macOS
  'System', 'Library', 'Applications', 'Users',
]);

/** Raw block-device path prefixes (writing to these destroys a disk). */
const BLOCK_DEVICE_RE = /^\/dev\/(sd|hd|vd|nvme|disk|rdisk|mmcblk|loop|xvd)/;

/** Strip one surrounding pair of single or double quotes from a token. */
function unquote(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/**
 * Strip leading env assignments and exec wrappers so detection sees the real
 * command. For wrappers that take their own args (`timeout 5`, `nice -n 10`),
 * leading flags and a bare number after the wrapper are skipped.
 */
function unwrap(command: string): string {
  let s = stripLeadingAssignments(command.trim(), false);
  for (;;) {
    const before = s;
    s = stripLeadingAssignments(s, false);
    // Leading subshell/group token: `(rm -rf /` or `{ rm -rf /`.
    s = s.replace(/^[({][ \t]*/, '');
    const m = s.match(/^([A-Za-z][\w-]*)[ \t]+/);
    const word = m?.[1];
    if (m && word && EXEC_WRAPPERS.has(word)) {
      s = s.slice(m[0].length);
      // Skip this wrapper's own flags / numeric duration (e.g. `timeout -k 5 10`).
      s = s.replace(/^(?:-{1,2}[A-Za-z][\w-]*[ \t]+|-?\d+(?:\.\d+)?[smhd]?[ \t]+)*/, '');
    }
    if (s === before) break;
  }
  return s.trim();
}

function tokenize(command: string): string[] {
  return command.split(/\s+/).filter(Boolean);
}

function hasRecursiveFlag(tokens: string[]): boolean {
  return tokens.some(
    (t) => t === '--recursive' || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(t),
  );
}

/** Non-flag arguments (the operands), with surrounding quotes removed. */
function operands(tokens: string[]): string[] {
  return tokens.slice(1).filter((t) => !t.startsWith('-')).map(unquote);
}

/**
 * True if a path operand refers to the filesystem root, the home directory, or
 * an entire top-level system directory.
 *
 * Surgical on purpose: `/`, `/*`, `~`, `$HOME`, and an exact top-level system
 * dir (`/usr`, `/etc`, `/var/*`) count, but a deeper path like `/usr/local/bin`
 * does not — deleting a whole system tree is catastrophic, deleting one nested
 * file should go through the normal permission prompt.
 */
function isRootTarget(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;

  // Filesystem root and home literals.
  if (t === '/' || t === '/*' || t === '/.') return true;
  if (t === '~' || t === '~/' || t === '~/*') return true;
  if (/^\$\{?HOME\}?(?:\/\*?)?$/.test(t)) return true;

  // Exactly a top-level system directory (optionally with a trailing slash or
  // glob): /usr, /usr/, /usr/* — but not /usr/local/bin.
  const stripped = t.replace(/\/\*?$/, '');
  if (stripped === '') return true; // was "/" or "/*"
  const m = stripped.match(/^\/([A-Za-z0-9_]+)$/);
  const head = m?.[1];
  return head !== undefined && CRITICAL_DIRS.has(head);
}

function classify(unwrapped: string): string | null {
  const tokens = tokenize(unwrapped);
  const cmd = tokens[0];
  if (!cmd) return null;
  const base = cmd.replace(/^.*\//, ''); // basename, so /bin/rm == rm

  // rm -rf targeting root / home / a system directory.
  if (base === 'rm') {
    if (tokens.includes('--no-preserve-root')) {
      return 'rm with --no-preserve-root (would delete the filesystem root)';
    }
    if (hasRecursiveFlag(tokens) && operands(tokens).some(isRootTarget)) {
      return 'recursive rm targeting the filesystem root, home, or a system directory';
    }
  }

  // Recursive chmod/chown on root or a system directory.
  if ((base === 'chmod' || base === 'chown' || base === 'chgrp')
      && hasRecursiveFlag(tokens) && operands(tokens).some(isRootTarget)) {
    return `recursive ${base} targeting the filesystem root or a system directory`;
  }

  // Writing a raw disk device.
  if (base === 'dd' && tokens.some((t) => {
    const m = t.match(/^of=(.+)$/);
    return m?.[1] !== undefined && BLOCK_DEVICE_RE.test(unquote(m[1]));
  })) {
    return 'dd writing directly to a block device';
  }
  if (/^mkfs(\.[A-Za-z0-9]+)?$/.test(base)
      && operands(tokens).some((t) => BLOCK_DEVICE_RE.test(t))) {
    return 'mkfs formatting a block device';
  }

  return null;
}

/**
 * Inspect a shell command for catastrophic, irreversible operations.
 * Returns a short human-readable reason if found, or null if the command is
 * not in the catastrophic set. A non-null result must be treated as a hard
 * block that no rule or mode can override.
 */
export function findDangerousCommand(command: string): string | null {
  if (!command.trim()) return null;

  const collapsed = command.replace(/\s+/g, ' ');

  // Fork bomb: :(){ :|:& };:  (the function name is typically `:`).
  if (/(?:^|[\s;&|(])([A-Za-z_]\w*|:)\s*\(\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;\s*\1/.test(collapsed)) {
    return 'fork bomb';
  }
  // Redirecting onto a raw block device (`> /dev/sda`, `2>/dev/nvme0n1`).
  if (/(?:^|[^>])>{1,2}\s*\/dev\/(?:sd|hd|vd|nvme|disk|rdisk|mmcblk|xvd)/.test(command)) {
    return 'redirecting output onto a block device';
  }

  // Per-subcommand structural checks, on both the raw split and a dequoted
  // copy (so `rm -rf "/"` and `rm -r''f /` are normalized to `rm -rf /`).
  const candidates = new Set<string>();
  for (const sub of splitBashCommand(command)) candidates.add(sub);
  for (const sub of splitBashCommand(command.replace(/['"]/g, ''))) candidates.add(sub);

  for (const candidate of candidates) {
    const reason = classify(unwrap(candidate));
    if (reason) return reason;
  }

  return null;
}
