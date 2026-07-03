/**
 * Catastrophic-command hard floor.
 *
 * Some shell commands do irreparable, machine-wide damage: wiping the
 * filesystem root or a top-level system directory, deleting the entire home
 * directory, overwriting a raw disk, or fork-bombing the host. These must
 * NEVER run: before yolo/auto-approve modes, before any allow rule, and
 * despite explicit user approval. `findCatastrophicCommand` is the single
 * shared detector both the framework Bash tool (`safety.ts`) and downstream
 * permission systems (cortex-code `resolvePermission`) call first, with no
 * override path.
 *
 * Detection is structural, not regex-on-strings:
 *  1. The command is split into simple-commands (quote-aware, newline-aware,
 *     recursing into `$(...)`/backtick substitutions) via splitBashCommand.
 *  2. Each simple-command is tokenized with a quote-aware word tokenizer, so
 *     `\rm`, `"rm"`, `r""m` and `command rm` all resolve to the verb `rm`.
 *     Leading env assignments, control-flow words, and exec wrappers
 *     (sudo/env/nice/timeout/xargs/...) are unwrapped first.
 *  3. Destructive operations are identified per platform from a declarative
 *     verb table (recursive rm, shred, find -delete, dd onto a device, mkfs,
 *     recursive chmod/chown, Remove-Item -Recurse, Format-Volume, del /s, ...).
 *  4. Operand paths are canonicalized lexically: `~`/`$HOME`/`%USERPROFILE%`
 *     expand from ctx.home, relative paths resolve against ctx.cwd (tracking
 *     `cd` across chained commands), `.`/`..` collapse, and a trailing glob
 *     resolves to its parent directory (with glob patterns also matched
 *     against protected names, so `rm -rf /usr*` cannot slip past). Resolved
 *     absolute paths, not strings, are compared against the protected sets.
 *  5. Fail closed: a destructive operation whose operand is not statically
 *     resolvable (variables, command substitution, xargs/stdin-supplied
 *     paths, brace ranges, unknown cwd) is hard-blocked with an actionable
 *     reason instructing the agent to re-issue with a concrete path.
 *
 * The floor protects the COMPUTER's integrity, not the project: deep paths
 * inside home or the workspace (`~/project/dist`, `./build`, `node_modules`)
 * intentionally pass through to the normal permission flow.
 *
 * Purely lexical: no filesystem access, so it is deterministic and can be
 * exercised for any platform by injecting `ctx.platform`.
 */

import * as nodePath from 'node:path';
import { splitBashCommand } from './split-command.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CatastrophicCategory =
  | 'filesystem-root'
  | 'system-directory'
  | 'home-root'
  | 'block-device'
  | 'fork-bomb'
  | 'unresolved-target';

export interface CatastrophicContext {
  /** Directory relative operands resolve against (the shell's cwd). */
  cwd: string;
  /** The user's home directory (expands ~, $HOME, %USERPROFILE%). */
  home: string;
  /** Platform to evaluate under. Defaults to process.platform. */
  platform?: NodeJS.Platform | undefined;
}

export interface CatastrophicFinding {
  blocked: true;
  category: CatastrophicCategory;
  /** Agent-facing, actionable explanation of the block. */
  reason: string;
}

type ProtectedCategory = 'filesystem-root' | 'system-directory' | 'home-root' | 'block-device';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sentinel inserted where a command substitution was extracted. */
const SUBSTITUTION_MARKER = '\u0000';

const MAX_RECURSION_DEPTH = 5;

/** Invisible Unicode characters used for obfuscation (mirrors safety.ts). */
const INVISIBLE_CHARS_RE =
  /[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD\u034F\u061C\u180E\u2060-\u2069\uFFF9-\uFFFB\u{E0001}-\u{E007F}\u{FE00}-\u{FE0F}]/gu;

/** Top-level POSIX system directories whose recursive destruction is catastrophic. */
const POSIX_SYSTEM_DIRS = [
  '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/opt',
  '/proc', '/root', '/sbin', '/sys', '/usr', '/var',
];

/** macOS root-level system directories. Also applied on linux (harmless there; keeps the floor a superset). */
const DARWIN_SYSTEM_DIRS = [
  '/System', '/Library', '/Applications', '/Users', '/private', '/Network',
  '/cores', '/Volumes',
];

/** Windows well-known system directories (any drive letter), lowercased. */
const WINDOWS_SYSTEM_DIR_NAMES = [
  'windows', 'program files', 'program files (x86)', 'programdata', 'users',
];

/** Raw block-device paths (writing to these destroys a disk). */
const POSIX_BLOCK_DEVICE_RE =
  /^\/dev\/(sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|loop\d|md\d|disk\d|rdisk\d)/i;

/** Windows raw device namespaces: \\.\PhysicalDrive0, \\?\Volume{guid}. */
const WINDOWS_DEVICE_RE = /^\\\\[.?][\\/](physicaldrive\d+|volume\{)/i;

/** Windows drive root as a raw operand: C:, C:\, C:/ (any drive). */
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:[\\/]*$/;

/** Windows well-known system directory as a raw operand: C:\Windows etc. */
const WINDOWS_SYSTEM_DIR_RE =
  /^[A-Za-z]:[\\/]+(windows|program files|program files \(x86\)|programdata|users)[\\/]*$/i;

/** Wrappers that exec their remaining arguments as a command. */
const EXEC_WRAPPERS = new Set([
  'sudo', 'doas', 'pkexec', 'env', 'nice', 'nohup', 'timeout', 'time',
  'stdbuf', 'ionice', 'setsid', 'command', 'builtin', 'exec', 'xargs',
  'chronic', 'unbuffer',
]);

/** Wrapper flags that consume a separate value argument. */
const WRAPPER_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t',
    '--user', '--group', '--host', '--prompt', '--chdir', '--chroot', '--close-from',
    '--other-user', '--role', '--type']),
  doas: new Set(['-u', '-C']),
  pkexec: new Set(['--user']),
  env: new Set(['-u', '-S', '-C', '--unset', '--split-string', '--chdir']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-t', '--class', '--classdata']),
  timeout: new Set(['-k', '-s', '--kill-after', '--signal']),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  time: new Set(['-f', '-o', '--format', '--output']),
  exec: new Set(['-a']),
  xargs: new Set(['-a', '-d', '-E', '-e', '-I', '-i', '-J', '-L', '-l', '-n',
    '-P', '-R', '-S', '-s', '--arg-file', '--delimiter', '--max-args',
    '--max-chars', '--max-lines', '--max-procs', '--replace']),
};

/** Shell control-flow words to skip at command position. */
const CONTROL_WORDS = new Set([
  '{', '}', '(', ')', '!', 'if', 'then', 'else', 'elif', 'fi', 'while',
  'until', 'do', 'done', 'for', 'case', 'esac', 'coproc',
]);

/** POSIX shells (and su) whose `-c <string>` argument is a nested command. */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'su']);

/** PowerShell binaries whose -Command/-c argument is a nested command. */
const POWERSHELL_BINARIES = new Set(['pwsh', 'powershell']);

/** PowerShell Remove-Item family (active on every platform; pwsh runs everywhere). */
const WINDOWS_DELETE_VERBS = new Set(['remove-item', 'ri', 'del', 'erase', 'rd']);

/** Windows delete verbs that collide with POSIX names; only claimed on win32. */
const WINDOWS_DELETE_VERBS_WIN_ONLY = new Set(['rm', 'rmdir']);

/** Disk-destroying cmdlets/tools blocked on sight. */
const WINDOWS_DISK_VERBS = new Set(['format-volume', 'clear-disk', 'remove-partition', 'diskpart']);

/** Windows env vars we can expand statically. */
function windowsEnvValue(name: string, home: string): string | null {
  switch (name.toUpperCase()) {
    case 'USERPROFILE':
    case 'HOME':
      return home || null;
    case 'HOMEDRIVE': {
      const m = home.match(/^[A-Za-z]:/);
      return m ? m[0] : 'C:';
    }
    case 'HOMEPATH':
      return home ? (home.replace(/^[A-Za-z]:/, '') || '\\') : null;
    case 'SYSTEMDRIVE':
      return 'C:';
    case 'SYSTEMROOT':
    case 'WINDIR':
      return 'C:\\Windows';
    case 'PROGRAMFILES':
    case 'PROGRAMW6432':
      return 'C:\\Program Files';
    case 'PROGRAMFILES(X86)':
      return 'C:\\Program Files (x86)';
    case 'PROGRAMDATA':
    case 'ALLUSERSPROFILE':
      return 'C:\\ProgramData';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Fork bombs (whole-command, newline-safe)
// ---------------------------------------------------------------------------

/** `:(){ :|:& };:` and named variants; separator may be `;` OR a newline. */
const FORK_BOMB_POSIX =
  /(?:^|[\s;&|({])([A-Za-z_]\w*|:)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*[;\n]\s*\1\s*(?:$|[;&|)\s])/;

/** PowerShell self-piping function bomb. */
const FORK_BOMB_POWERSHELL =
  /function\s+([A-Za-z_]\w*)\s*\{\s*\1\s*\|\s*\1\s*&?\s*\}\s*[;\n]\s*\1/i;

/** cmd.exe batch bomb: %0|%0 */
const FORK_BOMB_BATCH = /%0\s*\|\s*%0/;

// ---------------------------------------------------------------------------
// Word tokenizer
// ---------------------------------------------------------------------------

interface ShellWord {
  /** Dequoted text with escapes processed and known expansions applied. */
  text: string;
  /** Contains an expansion we cannot statically resolve ($VAR, %VAR%, ~user, ...). */
  unresolved: boolean;
  /** Contained a command substitution ($(...), backticks). */
  substitution: boolean;
  /** Contained an unquoted `{` (possible brace expansion). */
  brace: boolean;
}

interface ParsedCommand {
  words: ShellWord[];
  /** Targets of output redirections (>, >>, N>, &>, >|). */
  writeRedirects: ShellWord[];
}

interface TokenizeOptions {
  /** PowerShell/cmd dialect: backslash is literal, backtick escapes, %VAR% expands. */
  windows: boolean;
  home: string;
}

function newWord(): ShellWord {
  return { text: '', unresolved: false, substitution: false, brace: false };
}

/**
 * Tokenize a single simple-command into words, processing quotes and escapes
 * and applying the expansions we can resolve statically.
 */
function tokenizeWords(input: string, opts: TokenizeOptions): ParsedCommand {
  const words: ShellWord[] = [];
  const writeRedirects: ShellWord[] = [];
  let cur: ShellWord | null = null;
  let curQuoted = false;
  let quote: '"' | "'" | null = null;
  let pendingRedirect: 'write' | 'read' | null = null;
  let i = 0;
  const n = input.length;

  const ensure = (): ShellWord => {
    if (!cur) cur = newWord();
    return cur;
  };

  // A pure-digit current word directly before `>` is the fd number (2>...),
  // not an operand.
  const dropPureDigitFd = (): void => {
    if (cur !== null && /^\d+$/.test(cur.text) && !curQuoted) {
      cur = null;
      curQuoted = false;
    }
  };

  const flush = (): void => {
    if (!cur) return;
    const w = cur;
    cur = null;
    const wasQuoted = curQuoted;
    curQuoted = false;
    if (w.text.includes(SUBSTITUTION_MARKER)) {
      w.substitution = true;
      w.text = w.text.replaceAll(SUBSTITUTION_MARKER, '');
    }
    // Tilde expansion. Quoted `~`/`~/...` is treated as home too: an agent
    // quoting the tilde almost always *means* home, and weakening the floor
    // on a quoting technicality is the wrong failure direction.
    if (w.text === '~' || w.text.startsWith('~/') || (opts.windows && w.text.startsWith('~\\'))) {
      if (opts.home === '') w.unresolved = true;
      else w.text = w.text === '~' ? opts.home : opts.home + w.text.slice(1);
    } else if (!wasQuoted && w.text.startsWith('~') && w.text.length > 1) {
      // ~user expansion: statically unresolvable.
      w.unresolved = true;
    }
    if (pendingRedirect === 'write') writeRedirects.push(w);
    else if (pendingRedirect === null) words.push(w);
    // pendingRedirect === 'read': input source, irrelevant to destruction.
    pendingRedirect = null;
  };

  const applyVariable = (rawName: string): void => {
    const w = ensure();
    const simple = /^([A-Za-z_][A-Za-z0-9_]*|env:[A-Za-z_][A-Za-z0-9_()]*)$/.exec(rawName);
    if (!simple) { w.unresolved = true; return; } // ${NAME:-...} and friends
    const name = simple[1]!;
    if (name.toLowerCase().startsWith('env:')) {
      const value = opts.windows ? windowsEnvValue(name.slice(4), opts.home) : null;
      if (value !== null) w.text += value;
      else w.unresolved = true;
      return;
    }
    if (name === 'HOME' || (opts.windows && name.toUpperCase() === 'HOME')) {
      if (opts.home === '') w.unresolved = true;
      else w.text += opts.home;
      return;
    }
    if (name === 'IFS') return; // pre-pass already expanded unbraced $IFS
    w.unresolved = true;
  };

  const readVariable = (): void => {
    // Cursor is at '$'. Applies in unquoted and double-quoted contexts.
    const next = input[i + 1];
    if (next === '(') {
      // Should have been extracted by the splitter; treat as substitution.
      ensure().substitution = true;
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (input[i] === '(') depth++;
        else if (input[i] === ')') depth--;
        i++;
      }
      return;
    }
    if (next === '{') {
      const close = input.indexOf('}', i + 2);
      const name = close === -1 ? input.slice(i + 2) : input.slice(i + 2, close);
      i = close === -1 ? n : close + 1;
      applyVariable(name);
      return;
    }
    if (opts.windows && input.slice(i + 1, i + 5).toLowerCase() === 'env:') {
      const em = /^[A-Za-z_][A-Za-z0-9_()]*/.exec(input.slice(i + 5));
      if (em) {
        i += 5 + em[0].length;
        applyVariable(`env:${em[0]}`);
        return;
      }
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i + 1));
    if (m) {
      i += 1 + m[0].length;
      applyVariable(m[0]);
      return;
    }
    if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
      ensure().unresolved = true;
      i += 2;
      return;
    }
    ensure().text += '$';
    i += 1;
  };

  const readPercentVariable = (): boolean => {
    const pm = /^%([A-Za-z_][A-Za-z0-9_() ]*)%/.exec(input.slice(i));
    if (!pm) return false;
    const value = windowsEnvValue(pm[1]!, opts.home);
    const w = ensure();
    if (value !== null) w.text += value;
    else w.unresolved = true;
    i += pm[0].length;
    return true;
  };

  while (i < n) {
    const c = input[i]!;

    if (quote === "'") {
      if (c === "'") { quote = null; i++; continue; }
      ensure().text += c;
      i++;
      continue;
    }

    if (quote === '"') {
      if (c === '"') { quote = null; i++; continue; }
      if (!opts.windows && c === '\\') {
        const nx = input[i + 1];
        if (nx !== undefined && '$`"\\'.includes(nx)) { ensure().text += nx; i += 2; continue; }
        ensure().text += c;
        i++;
        continue;
      }
      if (opts.windows && c === '`') {
        const nx = input[i + 1];
        if (nx !== undefined) { ensure().text += nx; i += 2; }
        else i++;
        continue;
      }
      if (c === '$') { ensure(); readVariable(); continue; }
      if (!opts.windows && c === '`') { ensure().substitution = true; i++; continue; }
      if (opts.windows && c === '%' && readPercentVariable()) continue;
      ensure().text += c;
      i++;
      continue;
    }

    // Unquoted context.
    if (/\s/.test(c)) { flush(); i++; continue; }

    if (c === "'") { quote = "'"; ensure(); curQuoted = true; i++; continue; }
    if (c === '"') { quote = '"'; ensure(); curQuoted = true; i++; continue; }

    if (!opts.windows && c === '\\') {
      const nx = input[i + 1];
      if (nx === '\n') { i += 2; continue; } // line continuation
      if (nx !== undefined) { ensure().text += nx; i += 2; continue; }
      i++;
      continue;
    }
    if (opts.windows && c === '`') {
      const nx = input[i + 1];
      if (nx !== undefined) { ensure().text += nx; i += 2; }
      else i++;
      continue;
    }

    if (c === '$') { ensure(); readVariable(); continue; }
    if (!opts.windows && c === '`') { ensure().substitution = true; i++; continue; }
    if (opts.windows && c === '%' && readPercentVariable()) continue;

    if (c === '{') { ensure().brace = true; ensure().text += c; i++; continue; }

    // Redirections.
    if (c === '>' || c === '<') {
      dropPureDigitFd();
      flush();
      if (c === '>') {
        i++;
        if (input[i] === '>') i++;
        if (input[i] === '|') i++;
        if (input[i] === '&') {
          i++;
          // >&2 / >&- fd duplication: no filename target.
          if (input[i] !== undefined && /[\d-]/.test(input[i]!)) {
            while (i < n && /\d/.test(input[i]!)) i++;
            continue;
          }
        }
        pendingRedirect = 'write';
      } else {
        i++;
        while (input[i] === '<' || input[i] === '-') i++;
        pendingRedirect = 'read';
      }
      continue;
    }

    if (c === '&') {
      if (input[i + 1] === '>') {
        flush();
        i += 2;
        if (input[i] === '>') i++;
        pendingRedirect = 'write';
        continue;
      }
      // Stray '&' fragments (fd duplication remnants): literal.
      ensure().text += c;
      i++;
      continue;
    }

    ensure().text += c;
    i++;
  }

  flush();
  return { words, writeRedirects };
}

// ---------------------------------------------------------------------------
// Brace expansion (single level; ranges and nesting are unresolvable)
// ---------------------------------------------------------------------------

/** Expand one level of {a,b,c}. Ranges ({1..9}) and nesting fail (null = unresolvable). */
function expandBraces(text: string): string[] | null {
  const m = /^([^{}]*)\{([^{}]*)\}([^{}]*)$/.exec(text);
  if (!m) return null;
  const body = m[2]!;
  if (body.includes('..') || !body.includes(',')) return null;
  return body.split(',').map((part) => `${m[1]!}${part}${m[3]!}`);
}

// ---------------------------------------------------------------------------
// Target canonicalization + classification
// ---------------------------------------------------------------------------

interface EvalContext {
  home: string;
  platform: NodeJS.Platform;
  /** Effective cwd at this point in the chain; null once unknown. */
  cwd: string | null;
}

type TargetEval =
  | { status: 'ok' }
  | { status: 'unresolved'; raw: string }
  | { status: 'protected'; category: ProtectedCategory; target: string; raw: string };

function pathModFor(platform: NodeJS.Platform): nodePath.PlatformPath {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

function isDeviceText(text: string): boolean {
  return POSIX_BLOCK_DEVICE_RE.test(text) || WINDOWS_DEVICE_RE.test(text.trim());
}

function isCaseFold(platform: NodeJS.Platform): boolean {
  // Windows always; macOS filesystems are case-insensitive by default, so
  // `rm -rf /ETC` really would delete /etc there.
  return platform === 'win32' || platform === 'darwin';
}

/** Classify a canonical absolute path (no globs) against the protected sets. */
function classifyCanonical(canonical: string, ec: EvalContext): ProtectedCategory | null {
  const pm = pathModFor(ec.platform);
  const win = ec.platform === 'win32';
  const caseFold = isCaseFold(ec.platform);

  if (isDeviceText(canonical)) return 'block-device';

  let normalized = canonical;
  if (win) {
    normalized = normalized.replace(/^\\\\\?\\/, '');
    normalized = normalized.replace(/([^:\\/])[\\/]+$/, '$1');
  }

  // Filesystem root.
  if (win) {
    if (/^[A-Za-z]:[\\/]$/.test(normalized) || normalized === '\\' || normalized === '/') {
      return 'filesystem-root';
    }
  } else if (normalized === '/') {
    return 'filesystem-root';
  }

  // Home root.
  if (ec.home !== '') {
    const homeNorm = pm.resolve(ec.home);
    const a = caseFold ? normalized.toLowerCase() : normalized;
    const b = caseFold ? homeNorm.toLowerCase() : homeNorm;
    if (a === b) return 'home-root';
  }

  // System directories.
  if (win) {
    const m = /^[A-Za-z]:[\\/](.+)$/.exec(normalized);
    if (m && WINDOWS_SYSTEM_DIR_NAMES.includes(m[1]!.toLowerCase())) return 'system-directory';
  } else {
    for (const dir of [...POSIX_SYSTEM_DIRS, ...DARWIN_SYSTEM_DIRS]) {
      if (caseFold ? normalized.toLowerCase() === dir.toLowerCase() : normalized === dir) {
        return 'system-directory';
      }
    }
  }

  return null;
}

/** Convert a shell glob segment to a RegExp (escaping everything but * and ?). */
function globSegmentToRegExp(segment: string, caseFold: boolean): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, caseFold ? 'i' : '');
}

/**
 * When a delete target's final segment is a glob, check whether the pattern
 * can match a protected name inside its parent directory (`rm -rf /usr*`,
 * `Remove-Item -Recurse C:\Win*`).
 */
function matchProtectedChild(parentDir: string, segment: string, ec: EvalContext): ProtectedCategory | null {
  const pm = pathModFor(ec.platform);
  const win = ec.platform === 'win32';
  const caseFold = isCaseFold(ec.platform);
  const re = globSegmentToRegExp(segment, caseFold);
  const parentNorm = caseFold ? parentDir.toLowerCase() : parentDir;

  if (win) {
    if (/^[A-Za-z]:[\\/]$/.test(parentDir)) {
      for (const name of WINDOWS_SYSTEM_DIR_NAMES) {
        if (re.test(name)) return 'system-directory';
      }
    }
  } else if (parentDir === '/') {
    for (const dir of [...POSIX_SYSTEM_DIRS, ...DARWIN_SYSTEM_DIRS]) {
      if (re.test(dir.slice(1))) return 'system-directory';
    }
  }

  if (ec.home !== '') {
    const homeNorm = pm.resolve(ec.home);
    const homeParent = pm.dirname(homeNorm);
    const homeParentNorm = caseFold ? homeParent.toLowerCase() : homeParent;
    if (homeParentNorm === parentNorm && re.test(pm.basename(homeNorm))) return 'home-root';
  }

  return null;
}

/** Evaluate a single operand text (already expanded/dequoted) as a destroy target. */
function evaluateTargetText(raw: string, ec: EvalContext): TargetEval {
  const text = raw.trim();
  if (text === '' || text === '-' || text === '--') return { status: 'ok' };
  const pm = pathModFor(ec.platform);
  const win = ec.platform === 'win32';

  // xargs -I placeholders and similar are stdin-supplied.
  if (text.includes('{}')) return { status: 'unresolved', raw: text };

  // Raw-text device / Windows-literal checks. Dialect-independent so a
  // PowerShell command examined on a POSIX host is still caught.
  if (isDeviceText(text)) {
    return { status: 'protected', category: 'block-device', target: text, raw: text };
  }
  if (WINDOWS_DRIVE_ROOT_RE.test(text)) {
    return { status: 'protected', category: 'filesystem-root', target: text, raw: text };
  }
  if (WINDOWS_SYSTEM_DIR_RE.test(text)) {
    return { status: 'protected', category: 'system-directory', target: text, raw: text };
  }

  let canonical: string;
  if (pm.isAbsolute(text) || (win && /^[A-Za-z]:/.test(text))) {
    canonical = ec.cwd !== null ? pm.resolve(ec.cwd, text) : pm.resolve(text);
  } else {
    if (ec.cwd === null) return { status: 'unresolved', raw: text };
    canonical = pm.resolve(ec.cwd, text);
  }

  // Peel trailing segments that are entirely glob (`/*`, `~/*`, `dir/**`) or
  // dot-glob (`.*`, which matches `..`): the target is the parent directory.
  while (true) {
    const base = pm.basename(canonical);
    if (/^\.?[*?]+$/.test(base)) {
      const parent = pm.dirname(canonical);
      if (parent === canonical) break;
      canonical = parent;
      continue;
    }
    break;
  }

  // A remaining partial glob in the final segment (`/usr*`) can still expand
  // onto a protected name; match the pattern against protected children.
  const finalSegment = pm.basename(canonical);
  if (/[*?]/.test(finalSegment)) {
    const parent = pm.dirname(canonical);
    const category = matchProtectedChild(parent, finalSegment, ec);
    if (category) return { status: 'protected', category, target: canonical, raw: text };
    return { status: 'ok' }; // bounded glob (build*, *.log): falls to normal flow
  }

  const category = classifyCanonical(canonical, ec);
  if (category) return { status: 'protected', category, target: canonical, raw: text };
  return { status: 'ok' };
}

/** Evaluate a word (unresolved/substitution/brace aware) as a destroy target. */
function evaluateTargetWord(word: ShellWord, ec: EvalContext): TargetEval {
  if (word.substitution || word.unresolved) {
    return { status: 'unresolved', raw: word.text || '<dynamic>' };
  }
  if (word.brace && word.text.includes('{')) {
    const expanded = expandBraces(word.text);
    if (!expanded) return { status: 'unresolved', raw: word.text };
    for (const item of expanded) {
      const result = evaluateTargetText(item, ec);
      if (result.status !== 'ok') return result;
    }
    return { status: 'ok' };
  }
  return evaluateTargetText(word.text, ec);
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function finding(category: CatastrophicCategory, detail: string): CatastrophicFinding {
  const suffix =
    category === 'unresolved-target'
      ? ' Re-issue the command with a concrete, statically-resolvable path (no variables, command substitutions, or stdin-supplied targets).'
      : ' This is a hard block: it cannot be approved, allow-listed, or overridden. Do not re-attempt it.';
  return { blocked: true, category, reason: `${detail}${suffix}` };
}

function protectedFinding(hit: Extract<TargetEval, { status: 'protected' }>, verb: string): CatastrophicFinding {
  switch (hit.category) {
    case 'filesystem-root':
      return finding('filesystem-root',
        `Catastrophic command blocked: ${verb} targets the filesystem root ('${hit.raw}' resolves to '${hit.target}'), which would destroy the entire system.`);
    case 'system-directory':
      return finding('system-directory',
        `Catastrophic command blocked: ${verb} targets the critical system directory '${hit.target}' (from '${hit.raw}'), which would irreparably damage the operating system.`);
    case 'home-root':
      return finding('home-root',
        `Catastrophic command blocked: ${verb} targets the entire home directory ('${hit.raw}' resolves to '${hit.target}'). Target a specific subdirectory instead.`);
    case 'block-device':
      return finding('block-device',
        `Catastrophic command blocked: ${verb} writes to the raw disk device '${hit.target}', which would destroy the disk's contents.`);
  }
}

function unresolvedFinding(raw: string, verb: string): CatastrophicFinding {
  return finding('unresolved-target',
    `Destructive command blocked: the target of ${verb} ('${raw}') cannot be statically verified because it comes from a variable, command substitution, or stdin.`);
}

/**
 * Evaluate delete-style operands: block on any protected target; fail closed
 * on any unresolvable one.
 */
function evaluateDeleteTargets(
  operands: ShellWord[],
  ec: EvalContext,
  verb: string,
  options?: { viaXargs?: boolean | undefined },
): CatastrophicFinding | null {
  let firstUnresolved: string | null = null;
  for (const operand of operands) {
    const result = evaluateTargetWord(operand, ec);
    if (result.status === 'protected') return protectedFinding(result, verb);
    if (result.status === 'unresolved' && firstUnresolved === null) firstUnresolved = result.raw;
  }
  if (firstUnresolved !== null) return unresolvedFinding(firstUnresolved, verb);
  if (operands.length === 0 && options?.viaXargs) {
    return unresolvedFinding('<paths supplied via xargs stdin>', verb);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Verb helpers
// ---------------------------------------------------------------------------

function verbBaseName(word: ShellWord, platform: NodeJS.Platform): string | null {
  if (word.substitution || word.unresolved) return null;
  let text = word.text;
  if (text === '') return null;
  const parts = platform === 'win32' ? text.split(/[\\/]/) : text.split('/');
  text = parts[parts.length - 1] ?? '';
  if (platform === 'win32') text = text.replace(/\.(exe|cmd|bat|com|ps1)$/i, '');
  // Case-insensitive filesystems make `RM` execute rm.
  if (isCaseFold(platform)) text = text.toLowerCase();
  return text === '' ? null : text;
}

function isAssignmentWord(word: ShellWord): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text);
}

interface Unwrapped {
  words: ShellWord[];
  viaXargs: boolean;
}

/** Strip control-flow words, env assignments, and exec wrappers. */
function unwrapWords(words: ShellWord[], platform: NodeJS.Platform): Unwrapped {
  let i = 0;
  let viaXargs = false;

  for (;;) {
    let progressed = false;
    while (i < words.length && CONTROL_WORDS.has(words[i]!.text)) { i++; progressed = true; }
    while (i < words.length && isAssignmentWord(words[i]!)) { i++; progressed = true; }
    if (i >= words.length) break;

    const base = verbBaseName(words[i]!, platform);
    const lookup = base === null ? null : base.toLowerCase();
    if (lookup !== null && EXEC_WRAPPERS.has(lookup) && (platform !== 'linux' || base === lookup)) {
      if (lookup === 'xargs') viaXargs = true;
      i++;
      const valueFlags = WRAPPER_VALUE_FLAGS[lookup];
      while (i < words.length) {
        const t = words[i]!.text;
        if (t === '--') { i++; break; }
        if (valueFlags?.has(t)) { i += 2; continue; }
        if (t.startsWith('-') && t.length > 1) { i++; continue; }
        if (lookup === 'timeout' && /^\d+(\.\d+)?[smhd]?$/.test(t)) { i++; continue; }
        if (lookup === 'env' && isAssignmentWord(words[i]!)) { i++; continue; }
        break;
      }
      continue;
    }
    if (!progressed) break;
  }

  return { words: words.slice(i), viaXargs };
}

function isCombinedShortFlags(text: string): boolean {
  return /^-[A-Za-z]+$/.test(text);
}

// ---------------------------------------------------------------------------
// POSIX classifiers
// ---------------------------------------------------------------------------

function checkPosixRm(words: ShellWord[], ec: EvalContext, viaXargs: boolean): CatastrophicFinding | null {
  let recursive = false;
  const operands: ShellWord[] = [];
  let afterDashDash = false;

  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const t = w.text;
    if (afterDashDash) { operands.push(w); continue; }
    if (t === '--') { afterDashDash = true; continue; }
    if (t === '--no-preserve-root') {
      return finding('filesystem-root',
        'Catastrophic command blocked: rm --no-preserve-root explicitly requests deletion of the filesystem root.');
    }
    if (t === '--recursive' || (isCombinedShortFlags(t) && /[rR]/.test(t))) { recursive = true; continue; }
    if (t.startsWith('-') && t.length > 1) continue;
    operands.push(w);
  }

  if (!recursive) return null;
  return evaluateDeleteTargets(operands, ec, 'recursive rm', { viaXargs });
}

function checkChmodFamily(verb: string, words: ShellWord[], ec: EvalContext): CatastrophicFinding | null {
  let recursive = false;
  const operands: ShellWord[] = [];
  let afterDashDash = false;

  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const t = w.text;
    if (afterDashDash) { operands.push(w); continue; }
    if (t === '--') { afterDashDash = true; continue; }
    if (t === '--recursive' || (isCombinedShortFlags(t) && /[rR]/.test(t))) { recursive = true; continue; }
    if (t.startsWith('-') && t.length > 1) continue;
    operands.push(w);
  }

  if (!recursive) return null;
  // First operand is the mode/owner, not a path.
  return evaluateDeleteTargets(operands.slice(1), ec, `recursive ${verb}`);
}

function checkShred(words: ShellWord[], ec: EvalContext, viaXargs: boolean): CatastrophicFinding | null {
  const valueFlags = new Set(['-n', '-s', '--iterations', '--size', '--random-source']);
  const operands: ShellWord[] = [];
  for (let i = 1; i < words.length; i++) {
    const t = words[i]!.text;
    if (t === '--') { operands.push(...words.slice(i + 1)); break; }
    if (valueFlags.has(t)) { i++; continue; }
    if (t.startsWith('-') && t.length > 1) continue;
    operands.push(words[i]!);
  }
  return evaluateDeleteTargets(operands, ec, 'shred', { viaXargs });
}

function checkFind(words: ShellWord[], ec: EvalContext): CatastrophicFinding | null {
  let i = 1;
  const paths: ShellWord[] = [];

  // Leading options.
  while (i < words.length) {
    const t = words[i]!.text;
    if (t === '-H' || t === '-L' || t === '-P') { i++; continue; }
    if (t === '-D') { i += 2; continue; }
    if (/^-O/.test(t)) { i++; continue; }
    if (t === '-f') { // BSD: -f path
      if (i + 1 < words.length) paths.push(words[i + 1]!);
      i += 2;
      continue;
    }
    break;
  }
  // Start paths (everything before the first expression token).
  while (i < words.length) {
    const t = words[i]!.text;
    if (t.startsWith('-') || t === '(' || t === '!' || t === ',') break;
    paths.push(words[i]!);
    i++;
  }

  // Destructive expressions.
  let destructive = false;
  for (let j = i; j < words.length; j++) {
    const t = words[j]!.text;
    if (t === '-delete') { destructive = true; break; }
    if (t === '-exec' || t === '-execdir' || t === '-ok' || t === '-okdir') {
      const nextWord = words[j + 1];
      const execVerb = nextWord ? verbBaseName(nextWord, ec.platform) : null;
      if (execVerb !== null && ['rm', 'shred', 'unlink', 'rmdir'].includes(execVerb.toLowerCase())) {
        destructive = true;
        break;
      }
    }
  }
  if (!destructive) return null;

  const effectivePaths = paths.length > 0 ? paths : [{ ...newWord(), text: '.' }];
  return evaluateDeleteTargets(effectivePaths, ec, 'find with -delete/-exec rm');
}

function deviceFinding(target: string, raw: string, verb: string): CatastrophicFinding {
  return protectedFinding({ status: 'protected', category: 'block-device', target, raw }, verb);
}

function checkDd(words: ShellWord[], ec: EvalContext): CatastrophicFinding | null {
  for (const w of words.slice(1)) {
    if (!w.text.startsWith('of=')) continue;
    const targetText = w.text.slice(3);
    if (w.substitution || w.unresolved) return unresolvedFinding(targetText || '<dynamic>', 'dd of=');
    if (isDeviceText(targetText)) return deviceFinding(targetText, targetText, 'dd');
    const pm = pathModFor(ec.platform);
    if (pm.isAbsolute(targetText) && isDeviceText(pm.resolve(targetText))) {
      return deviceFinding(pm.resolve(targetText), targetText, 'dd');
    }
  }
  return null;
}

function checkDiskFormatter(verb: string, words: ShellWord[], ec: EvalContext): CatastrophicFinding | null {
  // mkfs*, wipefs, blkdiscard, mkswap: these tools exist to rewrite disks, so
  // block device targets and fail closed on unresolvable operands.
  const valueFlags = new Set(['-t', '-L', '-U', '-b', '-i', '-N', '-m', '-O', '-E', '--type', '--label']);
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const t = w.text;
    if (valueFlags.has(t)) { i++; continue; }
    if (t.startsWith('-') && t.length > 1) continue;
    if (t === '') continue;
    if (w.substitution || w.unresolved) return unresolvedFinding(t || '<dynamic>', verb);
    if (isDeviceText(t)) return deviceFinding(t, t, verb);
    const pm = pathModFor(ec.platform);
    if (pm.isAbsolute(t) && isDeviceText(pm.resolve(t))) return deviceFinding(pm.resolve(t), t, verb);
  }
  return null;
}

function checkDeviceWriteDestination(verb: string, words: ShellWord[]): CatastrophicFinding | null {
  // tee <paths...>, cp/mv <src> <dst>: a raw-device destination destroys the disk.
  const operands: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const t = words[i]!.text;
    if (t === '-t' || t === '--target-directory') {
      const value = words[i + 1]?.text;
      if (value !== undefined) operands.push(value);
      i++;
      continue;
    }
    if (t.startsWith('--target-directory=')) { operands.push(t.slice('--target-directory='.length)); continue; }
    if (t.startsWith('-') && t.length > 1) continue;
    operands.push(t);
  }
  const candidates = verb === 'tee' ? operands : operands.slice(-1);
  for (const candidate of candidates) {
    if (isDeviceText(candidate)) return deviceFinding(candidate, candidate, verb);
  }
  return null;
}

function checkRsync(words: ShellWord[], ec: EvalContext): CatastrophicFinding | null {
  const hasDelete = words.some((w) => /^--delete(-|$)/.test(w.text));
  if (!hasDelete) return null;
  const operands = words.slice(1).filter((w) => w.text !== '' && !w.text.startsWith('-'));
  const dest = operands[operands.length - 1];
  if (!dest || dest.text.includes(':')) return null; // remote destination: out of scope
  const result = evaluateTargetWord(dest, ec);
  if (result.status === 'protected') return protectedFinding(result, 'rsync --delete');
  return null;
}

// ---------------------------------------------------------------------------
// Windows classifiers
// ---------------------------------------------------------------------------

const PS_RECURSE_FLAG_RE = /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i;
const PS_FORCE_FLAG_RE = /^-f(o(r(c(e)?)?)?)?$/i;
const PS_PATH_PARAM_RE = /^-(path|literalpath|lp)$/i;
const PS_VALUE_PARAM_RE = /^-(filter|include|exclude|credential|stream|erroraction|ea)$/i;
const CMD_FLAG_RE = /^\/[A-Za-z?]{1,2}(?::\S*)?$/;

function checkWindowsDelete(words: ShellWord[], ec: EvalContext): CatastrophicFinding | null {
  let recursive = false;
  const operands: ShellWord[] = [];

  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const t = w.text;
    if (t === '--') { operands.push(...words.slice(i + 1)); break; }
    if (PS_RECURSE_FLAG_RE.test(t) || /^\/s$/i.test(t)) { recursive = true; continue; }
    if (CMD_FLAG_RE.test(t)) continue; // /q /f /p /a:h ...
    if (PS_FORCE_FLAG_RE.test(t)) continue;
    if (PS_PATH_PARAM_RE.test(t)) {
      const value = words[i + 1];
      if (value) operands.push(value);
      i++;
      continue;
    }
    if (PS_VALUE_PARAM_RE.test(t)) { i++; continue; }
    if (isCombinedShortFlags(t) && /[rR]/.test(t)) { recursive = true; continue; }
    if (t.startsWith('-') && t.length > 1) continue;
    operands.push(w);
  }

  if (!recursive) return null;
  return evaluateDeleteTargets(operands, ec, 'recursive Remove-Item/del');
}

function checkWindowsFormat(words: ShellWord[], ec: EvalContext): CatastrophicFinding | null {
  for (const w of words.slice(1)) {
    const t = w.text;
    if (t === '' || CMD_FLAG_RE.test(t)) continue;
    if (t.startsWith('-') && t.length > 1) continue;
    if (t.startsWith('/')) continue; // other cmd switches
    if (w.substitution || w.unresolved) return unresolvedFinding(t || '<dynamic>', 'format');
    if (WINDOWS_DRIVE_ROOT_RE.test(t) || isDeviceText(t)) return deviceFinding(t, t, 'format');
    const result = evaluateTargetText(t, ec);
    if (result.status === 'protected'
        && (result.category === 'filesystem-root' || result.category === 'block-device')) {
      return deviceFinding(result.target, result.raw, 'format');
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-simple-command inspection
// ---------------------------------------------------------------------------

interface ChainState {
  /** Effective cwd as `cd` commands are observed; null once unknown. */
  cwd: string | null;
}

function findShellCommandString(words: ShellWord[], powershell: boolean): ShellWord | null {
  for (let i = 1; i < words.length; i++) {
    const t = words[i]!.text;
    const isCommandFlag = powershell
      ? /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(t)
      : /^-[A-Za-z]*c[A-Za-z]*$/.test(t);
    if (isCommandFlag) {
      for (let j = i + 1; j < words.length; j++) {
        const candidate = words[j]!;
        if (!candidate.text.startsWith('-') || candidate.text.length <= 1) return candidate;
      }
      return null;
    }
  }
  return null;
}

function trackCd(words: ShellWord[], state: ChainState, ctx: { home: string; platform: NodeJS.Platform }): void {
  const win = ctx.platform === 'win32';
  const pm = pathModFor(ctx.platform);
  const operand = words.slice(1).find(
    (w) => w.substitution || w.unresolved || w.text === '-' || !w.text.startsWith('-'),
  );
  if (!operand) {
    state.cwd = ctx.home || null; // bare `cd` goes home
    return;
  }
  if (operand.substitution || operand.unresolved || operand.brace || operand.text === '-') {
    state.cwd = null; // dynamic destination: cwd is no longer statically known
    return;
  }
  if (operand.text === '') return; // `cd ""` errors; cwd unchanged
  if (pm.isAbsolute(operand.text) || (win && /^[A-Za-z]:/.test(operand.text))) {
    state.cwd = state.cwd !== null ? pm.resolve(state.cwd, operand.text) : pm.resolve(operand.text);
  } else if (state.cwd !== null) {
    state.cwd = pm.resolve(state.cwd, operand.text);
  } else {
    state.cwd = null;
  }
}

function inspectSimpleCommand(
  sub: string,
  ctx: { home: string; platform: NodeJS.Platform },
  state: ChainState,
  depth: number,
): CatastrophicFinding | null {
  const win = ctx.platform === 'win32';
  const parsed = tokenizeWords(sub, { windows: win, home: ctx.home });
  const ec: EvalContext = { home: ctx.home, platform: ctx.platform, cwd: state.cwd };

  // Output redirections onto raw devices (`> /dev/sda`, `2>/dev/nvme0n1`).
  for (const target of parsed.writeRedirects) {
    if (!target.substitution && !target.unresolved && isDeviceText(target.text)) {
      return deviceFinding(target.text, target.text, 'output redirection');
    }
  }

  const unwrapped = unwrapWords(parsed.words, ctx.platform);
  const words = unwrapped.words;
  const head = words[0];
  if (!head) return null;
  const verb = verbBaseName(head, ctx.platform);
  if (verb === null) return null;
  const verbLower = verb.toLowerCase();

  // Track cd/pushd so relative targets later in the chain resolve correctly.
  if (verbLower === 'cd' || verbLower === 'pushd') {
    trackCd(words, state, ctx);
    return null;
  }

  // Nested shells: recurse into the -c command string.
  if (POSIX_SHELLS.has(verbLower) || POWERSHELL_BINARIES.has(verbLower)) {
    const commandString = findShellCommandString(words, POWERSHELL_BINARIES.has(verbLower));
    if (commandString?.text) {
      return inspectCommand(commandString.text, ctx, depth + 1, state.cwd);
    }
    return null;
  }

  // eval: its arguments are re-parsed as a command.
  if (verbLower === 'eval') {
    const joined = words.slice(1).map((w) => w.text).join(' ').trim();
    if (joined) return inspectCommand(joined, ctx, depth + 1, state.cwd);
    return null;
  }

  // Windows disk destroyers: block on sight.
  if (WINDOWS_DISK_VERBS.has(verbLower)) {
    return finding('block-device',
      `Catastrophic command blocked: ${verbLower} reformats or destroys disks/partitions, which is never allowed from this agent.`);
  }

  // PowerShell Remove-Item family (all platforms; PS runs everywhere).
  const isWindowsDeleteVerb =
    WINDOWS_DELETE_VERBS.has(verbLower) || (win && WINDOWS_DELETE_VERBS_WIN_ONLY.has(verbLower));
  if (isWindowsDeleteVerb) {
    // Re-tokenize with the Windows dialect so C:\paths, %VAR% and `-escapes
    // parse correctly, then unwrap again.
    const winWords = unwrapWords(tokenizeWords(sub, { windows: true, home: ctx.home }).words, ctx.platform).words;
    const result = checkWindowsDelete(winWords.length > 0 ? winWords : words, ec);
    if (result) return result;
    // On win32 `rm`/`rmdir` may also be git-bash POSIX binaries; fall
    // through to the POSIX classifier as well.
    if (!(win && WINDOWS_DELETE_VERBS_WIN_ONLY.has(verbLower))) return null;
  }

  if (win && verbLower === 'format') {
    return checkWindowsFormat(words, ec);
  }

  // POSIX destructive verbs.
  switch (verbLower) {
    case 'rm':
      return checkPosixRm(words, ec, unwrapped.viaXargs);
    case 'chmod':
    case 'chown':
    case 'chgrp':
      return checkChmodFamily(verbLower, words, ec);
    case 'shred':
      return checkShred(words, ec, unwrapped.viaXargs);
    case 'find':
      return checkFind(words, ec);
    case 'dd':
      return checkDd(words, ec);
    case 'tee':
    case 'cp':
    case 'mv':
      return checkDeviceWriteDestination(verbLower, words);
    case 'rsync':
      return checkRsync(words, ec);
    default:
      break;
  }

  if (/^mkfs(\.[A-Za-z0-9]+)?$/.test(verbLower) || ['wipefs', 'blkdiscard', 'mkswap'].includes(verbLower)) {
    return checkDiskFormatter(verbLower, words, ec);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function inspectCommand(
  command: string,
  ctx: { home: string; platform: NodeJS.Platform },
  depth: number,
  startCwd: string | null,
): CatastrophicFinding | null {
  if (depth > MAX_RECURSION_DEPTH) return null;

  // Invisible characters cannot make a command safer; strip and analyze.
  const cleaned = command.replace(INVISIBLE_CHARS_RE, '');
  // $IFS defaults to whitespace and is a classic separator-obfuscation trick
  // (`rm$IFS-rf$IFS/`); expand it before splitting.
  const expanded = cleaned.replace(/\$\{?IFS\}?/g, ' ');

  if (FORK_BOMB_POSIX.test(expanded) || FORK_BOMB_POWERSHELL.test(expanded) || FORK_BOMB_BATCH.test(expanded)) {
    return finding('fork-bomb',
      'Catastrophic command blocked: this is a fork bomb, which would exhaust the process table and freeze the machine.');
  }

  const state: ChainState = { cwd: startCwd };
  for (const sub of splitBashCommand(expanded, { substitutionMarker: SUBSTITUTION_MARKER })) {
    const result = inspectSimpleCommand(sub, ctx, state, depth);
    if (result) return result;
  }
  return null;
}

/**
 * Inspect a shell command for catastrophic, irreversible operations.
 *
 * Returns a finding (hard block: no rule, mode, or approval may override it)
 * or null when the command is not in the catastrophic set. Commands that are
 * destructive but bounded (deleting a project subdirectory, node_modules, a
 * path deep inside home) return null: they fall through to the normal
 * permission flow.
 */
export function findCatastrophicCommand(
  command: string,
  ctx: CatastrophicContext,
): CatastrophicFinding | null {
  if (!command || !command.trim()) return null;
  const platform = ctx.platform ?? process.platform;
  const pm = pathModFor(platform);
  const cwd = ctx.cwd && ctx.cwd.trim() !== '' ? pm.resolve(ctx.cwd) : null;
  const home = ctx.home && ctx.home.trim() !== '' ? pm.resolve(ctx.home) : '';
  return inspectCommand(command, { home, platform }, 0, cwd);
}
