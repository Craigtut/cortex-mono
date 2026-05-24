/**
 * Bash command parsing utilities for permission matching.
 *
 * Permission rules for Bash operate on a *prefix* of the command (e.g.
 * `git commit *`). A naive `startsWith` check is unsafe: the shell treats
 * `&&`, `||`, `;`, `|`, `&`, and command substitution as command boundaries,
 * so `git status && rm -rf /` would match a `git *` rule even though it runs a
 * second, unrelated command. These helpers split a command into its individual
 * simple-commands (quote-aware, recursing into substitutions) so each piece can
 * be evaluated against rules independently.
 *
 * This is intentionally a focused splitter, not a full bash parser. When it
 * cannot confidently parse something it fails safe: ambiguous input yields
 * segments that won't match a narrow prefix rule, which results in a permission
 * prompt rather than a silent auto-allow.
 */

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

interface Balanced {
  body: string;
  end: number;
}

/**
 * Read a balanced `open`/`close` delimited region. `start` points at the first
 * character *after* the opening delimiter. Quote- and escape-aware so closing
 * delimiters inside strings don't end the region early. On unbalanced input,
 * consumes the rest of the string (fail safe).
 */
function readBalanced(s: string, start: number, open: string, close: string): Balanced {
  let depth = 1;
  let i = start;
  let quote: '"' | "'" | null = null;
  while (i < s.length) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') { i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '\\') { i += 2; continue; }
    if (c === "'" || c === '"') { quote = c; i++; continue; }
    if (c === open) { depth++; i++; continue; }
    if (c === close) {
      depth--;
      if (depth === 0) return { body: s.slice(start, i), end: i };
      i++;
      continue;
    }
    i++;
  }
  return { body: s.slice(start), end: s.length - 1 };
}

/** Read a backtick-delimited region. `start` points just after the opening backtick. */
function readBacktick(s: string, start: number): Balanced {
  let i = start;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '`') return { body: s.slice(start, i), end: i };
    i++;
  }
  return { body: s.slice(start), end: s.length - 1 };
}

function scanInto(input: string, out: string[]): void {
  let current = '';
  const nested: string[] = [];
  let i = 0;
  const n = input.length;
  let quote: '"' | "'" | null = null;

  const flush = (): void => {
    const t = current.trim();
    if (t) out.push(t);
    current = '';
  };

  while (i < n) {
    const c = input[i]!;

    // Backslash escape (literal next char) — not inside single quotes.
    if (c === '\\' && quote !== "'") {
      current += c;
      if (i + 1 < n) { current += input[i + 1]; i += 2; } else { i += 1; }
      continue;
    }

    if (quote === "'") {
      current += c;
      if (c === "'") quote = null;
      i++;
      continue;
    }

    if (quote === '"') {
      if (c === '"') { current += c; quote = null; i++; continue; }
      // Command substitution works inside double quotes too.
      if (c === '$' && input[i + 1] === '(') {
        if (input[i + 2] === '(') { // arithmetic $(( )) — not a command
          const r = readBalanced(input, i + 1, '(', ')');
          current += input.slice(i, r.end + 1);
          i = r.end + 1;
          continue;
        }
        const r = readBalanced(input, i + 2, '(', ')');
        nested.push(r.body);
        current += ' ';
        i = r.end + 1;
        continue;
      }
      if (c === '`') {
        const r = readBacktick(input, i + 1);
        nested.push(r.body);
        current += ' ';
        i = r.end + 1;
        continue;
      }
      current += c;
      i++;
      continue;
    }

    // Not currently inside quotes.
    if (c === "'" || c === '"') { quote = c; current += c; i++; continue; }

    // Command substitution / arithmetic.
    if (c === '$' && input[i + 1] === '(') {
      if (input[i + 2] === '(') {
        const r = readBalanced(input, i + 1, '(', ')');
        current += input.slice(i, r.end + 1);
        i = r.end + 1;
        continue;
      }
      const r = readBalanced(input, i + 2, '(', ')');
      nested.push(r.body);
      current += ' ';
      i = r.end + 1;
      continue;
    }
    if (c === '`') {
      const r = readBacktick(input, i + 1);
      nested.push(r.body);
      current += ' ';
      i = r.end + 1;
      continue;
    }
    // Process substitution <( ) >( ).
    if ((c === '<' || c === '>') && input[i + 1] === '(') {
      const r = readBalanced(input, i + 2, '(', ')');
      nested.push(r.body);
      current += ' ';
      i = r.end + 1;
      continue;
    }
    // Subshell at command position.
    if (c === '(' && current.trim() === '') {
      const r = readBalanced(input, i + 1, '(', ')');
      nested.push(r.body);
      i = r.end + 1;
      continue;
    }

    // Redirections: keep operator and any &fd attached so the `&` in `2>&1`
    // and `&>` is not mistaken for a background/control operator below.
    if (c === '>' || c === '<') {
      current += c;
      i++;
      if (c === '>' && input[i] === '>') { current += '>'; i++; }
      if (input[i] === '&') {
        current += '&';
        i++;
        if (input[i] !== undefined && /\d/.test(input[i]!)) { current += input[i]; i++; }
      }
      continue;
    }

    // Control operators that separate commands.
    if (c === '&') {
      if (input[i + 1] === '>') { // &> or &>> redirect, not background
        current += '&>';
        i += 2;
        if (input[i] === '>') { current += '>'; i++; }
        continue;
      }
      flush();
      i += input[i + 1] === '&' ? 2 : 1; // && or single &
      continue;
    }
    if (c === '|') {
      flush();
      i += (input[i + 1] === '|' || input[i + 1] === '&') ? 2 : 1; // || or |& or |
      continue;
    }
    if (c === ';') { flush(); i++; continue; }
    if (c === '\n') { flush(); i++; continue; }

    current += c;
    i++;
  }
  flush();

  for (const body of nested) scanInto(body, out);
}

/**
 * Split a shell command into its individual simple-commands.
 *
 * Splits on unquoted `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines, and
 * extracts the bodies of command substitutions (`$(...)`, backticks), process
 * substitutions, and subshells as additional commands. The contents of quotes
 * are preserved on their owning command; redirections stay attached.
 *
 * Always returns at least one element (the trimmed input) so callers can rely
 * on a non-empty result.
 */
export function splitBashCommand(command: string): string[] {
  const out: string[] = [];
  scanInto(command, out);
  if (out.length > 0) return out;
  const trimmed = command.trim();
  return trimmed ? [trimmed] : [];
}

/** True if the command contains more than one simple-command. */
export function isCompoundBash(command: string): boolean {
  return splitBashCommand(command).length > 1;
}

/**
 * Suggest an "always allow" prefix pattern for a Bash command.
 *
 * Produces a two-word prefix (`git commit *`) when the second token looks like
 * a subcommand, otherwise a one-word prefix (`ls *`). Returns '' (no
 * suggestion) for bare shells/wrappers and for commands led by an unsafe env
 * var, since no safe prefix exists for those.
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

  const second = tokens[1];
  if (second && SUBCOMMAND_RE.test(second)) return `${cmd} ${second} *`;
  return `${cmd} *`;
}
