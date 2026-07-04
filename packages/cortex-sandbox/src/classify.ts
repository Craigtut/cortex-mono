/**
 * Denial attribution: decide whether a failed sandboxed command failed BECAUSE
 * the sandbox blocked it, so the Bash tool can append a self-explaining note
 * (and offer single-command escalation) instead of the model blindly retrying.
 *
 * Two signals, per platform reality (see docs/cortex/sandboxing.md, "Denial
 * attribution is platform-asymmetric"):
 * - macOS: sandbox-runtime tails the unified log and records real violation
 *   events per command. Precise: a match IS a denial.
 * - Linux: bubblewrap surfaces only EPERM-shaped errors, so the best available
 *   signal is a stderr heuristic, corroborated against the policy: a generic
 *   permission marker attributes only when the command visibly attempted
 *   something the policy would block. Best-effort by design: a miss just
 *   means no note, and the wording stays "may be".
 *
 * Both helpers are pure so they are testable without Seatbelt or bubblewrap.
 */
import { homedir } from 'node:os';
import { basename, join, normalize, sep } from 'node:path';
import type { SandboxCommandFailure, SandboxDenial } from '@animus-labs/cortex';

/** The slice of sandbox-runtime's SandboxViolationEvent that attribution needs. */
export interface ViolationLike {
  /** Raw unified-log line, e.g. "Sandbox: sh(123) deny(1) file-write-create /etc/x". */
  line: string;
}

/**
 * Map a Seatbelt violation operation to the policy dimension it belongs to.
 * Operations look like "file-write-create", "file-read-data", "network-outbound".
 */
function dimensionForViolationLine(line: string): SandboxDenial['dimension'] {
  if (line.includes('file-write')) return 'filesystem-write';
  if (line.includes('file-read')) return 'filesystem-read';
  if (line.includes('network')) return 'network';
  return 'unknown';
}

/**
 * Extract the denied operation and target from a violation line for a compact,
 * human- and model-readable detail. Falls back to the trimmed raw line.
 */
function detailForViolationLine(line: string): string {
  const match = /deny(?:\(\d+\))?\s+([\w-]+)(?:\s+(\S+))?/.exec(line);
  if (match) {
    return match[2] ? `${match[1]} ${match[2]}` : (match[1] ?? line.trim());
  }
  return line.trim();
}

/**
 * macOS: attribute a failure from recorded violation events for this command.
 * The caller passes violations already filtered to the command (the store
 * matches on the encoded command tag), so any entry means the sandbox denied
 * something during the run. Prefers the first violation on a recognizable
 * policy dimension: harmless startup noise (e.g. non-fatal sysctl-read denies
 * from a runtime probing the host) often precedes the denial that actually
 * failed the command.
 */
export function denialFromViolations(violations: ViolationLike[]): SandboxDenial | null {
  const first = violations[0];
  if (!first) return null;
  const recognized = violations.find(
    (v) => dimensionForViolationLine(v.line) !== 'unknown',
  );
  const chosen = recognized ?? first;
  return {
    dimension: dimensionForViolationLine(chosen.line),
    detail: detailForViolationLine(chosen.line),
    escalatable: true,
  };
}

/**
 * Stderr markers distinctive of the sandbox mechanisms themselves: bubblewrap
 * mounts the filesystem read-only outside the writable roots, and unshared
 * networking leaves no route and no DNS. These strings rarely occur on
 * unsandboxed failures, so they attribute on their own.
 */
const DISTINCTIVE_MARKERS: Array<{ pattern: RegExp; dimension: SandboxDenial['dimension'] }> = [
  { pattern: /read-only file system/i, dimension: 'filesystem-write' },
  { pattern: /network is unreachable/i, dimension: 'network' },
  { pattern: /temporary failure in name resolution/i, dimension: 'network' },
];

/**
 * Generic permission markers that also fire on plenty of non-sandbox failures
 * (missing exec bits, root-owned files, package-manager cache EACCES). Alone
 * they say nothing about the sandbox; they attribute only with corroboration
 * from the command itself.
 */
const GENERIC_MARKERS: RegExp[] = [
  /operation not permitted/i,
  /permission denied/i,
  /\bEPERM\b/,
  /\bEACCES\b/,
];

/**
 * Commands whose whole job is network egress. Package managers are
 * deliberately absent: their permission failures are usually local (cache or
 * store EACCES), exactly the false positive corroboration exists to avoid,
 * and a real egress block surfaces the distinctive DNS/unreachable markers.
 */
const NETWORK_COMMANDS = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'ping',
  'ping6',
  'dig',
  'nslookup',
  'traceroute',
]);

/** git subcommands that reach a remote. */
const GIT_NETWORK_SUBCOMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote']);

/** Wrappers skipped when finding the command word of a segment. */
const COMMAND_WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'command', 'exec', 'xargs']);

/**
 * The policy context a generic marker is corroborated against. Lexical only
 * (no filesystem access), so attribution stays pure and testable; symlink
 * games are irrelevant here because this gates a hint, not a boundary.
 */
export interface DenialCorroborationContext {
  /** The policy's read denies; a referenced path under one corroborates. */
  denyRead: readonly string[];
  /** The policy's write denies; a referenced path under one corroborates. */
  denyWrite: readonly string[];
  /** Home directory used to expand ~ tokens. Defaults to os.homedir(). */
  home?: string;
}

/** Rough word split; separators, quotes, and redirections are dropped. */
function commandTokens(command: string): string[] {
  return command.split(/[\s;|&<>()'"`=,]+/).filter(Boolean);
}

/**
 * Absolute and home-anchored paths the command references, normalized. The
 * very first word is skipped: it is the program being executed, and exec of a
 * binary outside the writable roots is allowed in-sandbox (reads are broad),
 * so a permission failure on the program itself is almost never the sandbox.
 */
function referencedPaths(command: string, home: string): string[] {
  const paths: string[] = [];
  commandTokens(command).forEach((token, index) => {
    if (index === 0) return;
    if (token.startsWith('/')) paths.push(normalize(token));
    else if (token === '~') paths.push(home);
    else if (token.startsWith('~/')) paths.push(normalize(join(home, token.slice(2))));
  });
  return paths;
}

/**
 * A network tool in command position (the first word of any pipeline/sequence
 * segment, past common wrappers and env assignments), or null. Command
 * position keeps an argument merely named "curl" or "ping" from corroborating.
 */
function referencedNetworkTool(command: string): string | null {
  const segments = command.split(/\|\||&&|\$\(|[;|&`\n]/);
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (
      i < tokens.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || COMMAND_WRAPPERS.has(basename(tokens[i]!)))
    ) {
      i++;
    }
    const word = i < tokens.length ? basename(tokens[i]!) : '';
    if (NETWORK_COMMANDS.has(word)) return word;
    if (word === 'git' && GIT_NETWORK_SUBCOMMANDS.has(tokens[i + 1] ?? '')) {
      return `git ${tokens[i + 1]}`;
    }
  }
  return null;
}

/** True when the path is at or under any of the given base paths. */
function isUnderAny(target: string, bases: readonly string[]): boolean {
  return bases.some((b) => target === b || target.startsWith(b.endsWith(sep) ? b : b + sep));
}

interface Corroboration {
  dimension: SandboxDenial['dimension'];
  detail: string;
}

/**
 * A signal from the command string that it attempted something the policy
 * would block: a referenced path under a deny set or outside every writable
 * root, or a network tool in command position. Null means no corroboration.
 */
function corroborate(command: string, ctx: DenialCorroborationContext): Corroboration | null {
  const home = ctx.home ?? homedir();
  const paths = referencedPaths(command, home);
  for (const p of paths) {
    if (isUnderAny(p, ctx.denyWrite)) {
      return { dimension: 'filesystem-write', detail: `the command references write-protected ${p}` };
    }
    if (isUnderAny(p, ctx.denyRead)) {
      return { dimension: 'filesystem-read', detail: `the command references read-protected ${p}` };
    }
  }
  const tool = referencedNetworkTool(command);
  if (tool) return { dimension: 'network', detail: `the command runs the network tool ${tool}` };
  // Deliberately no "path outside the writable roots" branch: reads out there
  // are allowed in-sandbox, so a failing read like `cat /etc/shadow` (a DAC
  // denial, never the sandbox) would falsely corroborate. The deny-path and
  // network branches above cover the real sandbox denials; a write to a
  // non-denied path outside the workspace surfaces the distinctive read-only
  // marker instead.
  return null;
}

/**
 * Linux (and general fallback): a failed command whose stderr carries a denial
 * marker MAY be a sandbox denial. Distinctive markers (read-only filesystem,
 * no route, no DNS) attribute on their own; generic permission markers
 * (EPERM/EACCES and friends) fire on many non-sandbox failures, so they
 * additionally require corroboration from the command against the active
 * policy. Heuristic only; the caller must already know the sandbox was
 * enforcing when the command ran.
 */
export function denialFromFailureHeuristic(
  failure: SandboxCommandFailure,
  context: DenialCorroborationContext,
): SandboxDenial | null {
  if (failure.exitCode === null || failure.exitCode === 0) return null;

  for (const marker of DISTINCTIVE_MARKERS) {
    const match = marker.pattern.exec(failure.stderr);
    if (match) {
      return {
        dimension: marker.dimension,
        detail: `stderr reports "${match[0]}" while the sandbox was enforcing`,
        escalatable: true,
      };
    }
  }

  for (const pattern of GENERIC_MARKERS) {
    const match = pattern.exec(failure.stderr);
    if (!match) continue;
    const corroboration = corroborate(failure.command, context);
    if (!corroboration) return null;
    return {
      dimension: corroboration.dimension,
      detail:
        `stderr reports "${match[0]}" while the sandbox was enforcing, ` +
        `and ${corroboration.detail}`,
      escalatable: true,
    };
  }
  return null;
}
