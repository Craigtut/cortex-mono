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
 *   signal is a stderr heuristic. Best-effort by design: a miss just means no
 *   note, and the wording stays "may be".
 *
 * Both helpers are pure so they are testable without Seatbelt or bubblewrap.
 */
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
 * Ordered stderr markers for the Linux heuristic. Each maps to the most likely
 * dimension; matching stays conservative (well-known kernel/libc denial
 * strings only) to keep false positives rare.
 */
const STDERR_MARKERS: Array<{ pattern: RegExp; dimension: SandboxDenial['dimension'] }> = [
  { pattern: /read-only file system/i, dimension: 'filesystem-write' },
  { pattern: /network is unreachable/i, dimension: 'network' },
  { pattern: /temporary failure in name resolution/i, dimension: 'network' },
  { pattern: /operation not permitted/i, dimension: 'unknown' },
  { pattern: /permission denied/i, dimension: 'unknown' },
  { pattern: /\bEPERM\b/, dimension: 'unknown' },
  { pattern: /\bEACCES\b/, dimension: 'unknown' },
];

/**
 * Linux (and general fallback): a failed command whose stderr carries a
 * permission-denied marker MAY be a sandbox denial. Heuristic only; the caller
 * must already know the sandbox was enforcing when the command ran.
 */
export function denialFromFailureHeuristic(failure: SandboxCommandFailure): SandboxDenial | null {
  if (failure.exitCode === null || failure.exitCode === 0) return null;
  for (const marker of STDERR_MARKERS) {
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
