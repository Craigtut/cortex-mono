/**
 * Interactive command detection for Bash.
 *
 * Catches commands that would block waiting for TTY input (editors,
 * pagers, REPLs, interactive DB clients) and rejects them with a
 * concrete non-interactive suggestion. Prevents the agent from burning
 * its entire timeout budget on a hung `vim` or `psql` invocation.
 *
 * This is a UX gate, not a security gate: it sits at the end of the
 * safety cascade after all security layers have passed. Security checks
 * always come first.
 *
 * The module is pure — no I/O, no global state — so the rule set can be
 * exhaustively unit-tested without a shell.
 */

import { splitOnShellOperators, type SafetyCheckResult } from './safety.js';

// ---------------------------------------------------------------------------
// Rule definition
// ---------------------------------------------------------------------------

interface InteractiveRule {
  /** Exact basename of the program to match (e.g. 'vim', not '/usr/bin/vim'). */
  name: string;
  /**
   * Decide whether the invocation is interactive. `args` is the token
   * list AFTER the program (flags and positional args). Return a
   * user-facing suggestion string when the invocation is interactive,
   * or `null` when a non-interactive form has been detected.
   */
  check: (args: string[]) => string | null;
}

// ---------------------------------------------------------------------------
// Rule groups
// ---------------------------------------------------------------------------

const EDITORS = ['vim', 'vi', 'nvim', 'emacs', 'emacsclient', 'nano', 'pico', 'ed', 'joe'];
const MONITORS = ['top', 'htop', 'atop', 'btop', 'watch'];
const PAGERS = ['less', 'more', 'most'];

function alwaysInteractive(name: string, suggestion: string): InteractiveRule {
  return { name, check: () => suggestion };
}

const RULES: InteractiveRule[] = [
  ...EDITORS.map((name) =>
    alwaysInteractive(
      name,
      `${name} is a terminal editor and will block waiting for input. Use the Edit or Write tools to modify files instead.`,
    ),
  ),
  ...MONITORS.map((name) =>
    alwaysInteractive(
      name,
      `${name} runs continuously and blocks the shell. Use a one-shot alternative (e.g. \`ps aux | head\`, \`uptime\`, \`df -h\`).`,
    ),
  ),
  // Pagers block even when piped — they paginate on keypress.
  ...PAGERS.map((name) =>
    alwaysInteractive(
      name,
      `${name} paginates and will block waiting for a keypress. Use \`cat\`, \`head\`, or \`tail\` instead.`,
    ),
  ),
  // Python: interactive unless given a script file or -c/-m.
  ...['python', 'python2', 'python3'].map((name): InteractiveRule => ({
    name,
    check: (args) => pythonCheck(name, args),
  })),
  { name: 'node', check: nodeCheck },
  { name: 'ruby', check: rubyCheck },
  alwaysInteractive(
    'irb',
    'irb opens an interactive Ruby shell. Use `ruby -e "..."` for one-off code.',
  ),
  { name: 'mongo', check: (args) => mongoCheck('mongo', args) },
  { name: 'mongosh', check: (args) => mongoCheck('mongosh', args) },
  { name: 'sqlite3', check: sqliteCheck },
  { name: 'psql', check: psqlCheck },
  { name: 'mysql', check: mysqlCheck },
  { name: 'mariadb', check: mysqlCheck },
];

// Fast lookup by basename.
const RULES_BY_NAME = new Map(RULES.map((r) => [r.name, r]));

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Check a full shell command for interactive invocations. Splits on
 * shell operators (`;`, `&&`, `||`, `|`) and inspects each sub-command
 * independently — `cat file | less` is rejected because the `less`
 * sub-command is interactive, even though `cat` is not.
 *
 * Returns the first interactive sub-command's rejection; if all
 * sub-commands are non-interactive, returns `{ allowed: true }`.
 */
export function checkInteractive(command: string): SafetyCheckResult {
  const subs = splitOnShellOperators(command);
  for (const sub of subs) {
    const tokens = tokenize(sub);
    const program = findProgram(tokens);
    if (!program) continue;
    const rule = RULES_BY_NAME.get(program.name);
    if (!rule) continue;
    const suggestion = rule.check(program.args);
    if (suggestion !== null) {
      return {
        allowed: false,
        reason: `Interactive command detected. ${suggestion}`,
      };
    }
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Minimal shell-aware tokenizer: splits on unquoted whitespace, keeps
 * single/double-quoted regions intact (quotes themselves are stripped),
 * and honors backslash escapes. Sufficient for identifying the program
 * token and distinguishing flags from positional args; not a complete
 * POSIX shell parser.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (!inSingle && ch === '\\' && i + 1 < command.length) {
      current += command[i + 1]!;
      i++;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/u.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Find the effective program name and argument list, accounting for:
 *   1. Leading `KEY=VALUE` env var prefixes (`FOO=bar vim file`)
 *   2. The `env` wrapper (`env FOO=bar vim file` or `env -u BAR vim`)
 *
 * Returns the program's basename (last path segment) and the remaining
 * arg tokens, or `null` if no program token is present.
 */
export function findProgram(
  tokens: string[],
): { name: string; args: string[] } | null {
  let i = 0;
  while (i < tokens.length && isEnvAssignment(tokens[i]!)) i++;

  if (i < tokens.length && tokens[i] === 'env') {
    i++;
    // `env`'s flags that take a subsequent argument. We need to skip
    // both the flag and its value so a value that doesn't look like a
    // flag (e.g. `env -u OLD vim`) isn't mistaken for the program.
    const ARG_FLAGS_SHORT = new Set(['-u', '-C', '-S']);
    const ARG_FLAGS_LONG = new Set(['--unset', '--chdir', '--split-string']);
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (isEnvAssignment(t)) {
        i++;
        continue;
      }
      if (!t.startsWith('-')) break;
      if (ARG_FLAGS_SHORT.has(t) || ARG_FLAGS_LONG.has(t)) {
        i += 2; // consume flag + value
        continue;
      }
      // --long=value form or flags with no arg (-i, -0, --verbose, etc.)
      i++;
    }
  }

  if (i >= tokens.length) return null;
  const prog = tokens[i]!;
  const basename = prog.split('/').pop() ?? prog;
  return { name: basename, args: tokens.slice(i + 1) };
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token);
}

// ---------------------------------------------------------------------------
// Per-program predicates
// ---------------------------------------------------------------------------

function pythonCheck(name: string, args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    // -c / -m consume the next arg but the presence alone is enough.
    if (arg === '-c' || arg === '-m') return null;
    if (arg === '-V' || arg === '--version') return null;
    if (arg === '-h' || arg === '--help') return null;
    // Script file.
    if (/\.py[ocw]?$/u.test(arg) && !arg.startsWith('-')) return null;
    // Any positional arg is treated as a script (matches how Python's argv
    // parser works).
    if (!arg.startsWith('-')) return null;
  }
  return `${name} without a script or \`-c\`/\`-m\` starts an interactive REPL and will block. Provide a script file or use \`${name} -c "..."\`.`;
}

function nodeCheck(args: string[]): string | null {
  for (const arg of args) {
    if (
      arg === '-e' ||
      arg === '--eval' ||
      arg === '-p' ||
      arg === '--print' ||
      arg === '-v' ||
      arg === '--version' ||
      arg === '-h' ||
      arg === '--help'
    ) {
      return null;
    }
    if (!arg.startsWith('-')) return null; // script file or --file
  }
  return 'node without a script or `-e` starts an interactive REPL and will block. Provide a script file or use `node -e "..."`.';
}

function rubyCheck(args: string[]): string | null {
  for (const arg of args) {
    if (arg === '-e' || arg === '-v' || arg === '--version' || arg === '-h' || arg === '--help') {
      return null;
    }
    if (!arg.startsWith('-')) return null;
  }
  return 'ruby without a script or `-e` reads from stdin and will block. Provide a `.rb` file or use `ruby -e "..."`.';
}

function mongoCheck(name: string, args: string[]): string | null {
  if (args.includes('--eval') || args.includes('-e') || args.includes('--version') || args.includes('--help')) {
    return null;
  }
  // Executing a script file is also non-interactive.
  if (args.some((a) => /\.js$/u.test(a) && !a.startsWith('-'))) return null;
  return `${name} without \`--eval\` or a script file opens an interactive shell. Use \`${name} --eval "..."\`.`;
}

function sqliteCheck(args: string[]): string | null {
  if (args.includes('-cmd') || args.includes('-batch') || args.includes('-version') || args.includes('--help')) {
    return null;
  }
  // sqlite3 <db> "<sql>" — two or more non-flag args means the second is a query.
  const nonFlag = args.filter((a) => !a.startsWith('-'));
  if (nonFlag.length >= 2) return null;
  return 'sqlite3 without a SQL argument opens an interactive prompt. Use `sqlite3 <db> "<sql>"` or pass `-cmd "..."`.';
}

function psqlCheck(args: string[]): string | null {
  // -c / --command: inline SQL. -f / --file: script file. -l / --list: list DBs.
  // --version / -V: version. All are single-shot, non-interactive.
  // NOTE: -h means "host" in psql, NOT help. We do not treat it as safe.
  const safeFlags = new Set([
    '-c', '--command', '-f', '--file', '-l', '--list', '--version', '-V', '--help',
  ]);
  for (const arg of args) {
    if (safeFlags.has(arg)) return null;
    // Flags written as --command=VALUE.
    if (arg.startsWith('--command=') || arg.startsWith('--file=')) return null;
  }
  return 'psql without `-c` or `-f` opens an interactive prompt. Use `psql -c "SELECT ..."` or `psql -f script.sql`.';
}

function mysqlCheck(args: string[]): string | null {
  const safeFlags = new Set(['-e', '--execute', '--version', '-V', '--help', '-?']);
  for (const arg of args) {
    if (safeFlags.has(arg)) return null;
    if (arg.startsWith('--execute=')) return null;
  }
  return 'mysql without `-e` opens an interactive prompt. Use `mysql -e "SELECT ..."`.';
}
