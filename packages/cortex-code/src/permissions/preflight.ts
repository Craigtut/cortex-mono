import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { findCatastrophicCommand, resolveThroughExistingAncestorSync } from '@animus-labs/cortex';
import type { PermissionDecision } from './rules.js';

export type PreflightOutcome =
  | { decision: 'allow' }
  | { decision: 'block'; reason?: string }
  | { decision: 'prompt' };

export interface PreflightDeps {
  yoloMode: boolean;
  cwd: string;
  /** Resolve persisted/session rules for a call (already containment-aware). */
  matchRule: (toolName: string, toolArgs: unknown) => Promise<PermissionDecision | null>;
  /** True when the call is a read-only op contained in the workspace. */
  isReadOnlyInProject: (toolName: string, toolArgs: unknown) => Promise<boolean>;
  /** Home directory override; defaults to os.homedir(). Injectable for tests. */
  home?: string;
  /**
   * True when the OS sandbox is enforcing filesystem containment for shell
   * commands. A Bash call that clears the catastrophic floor and any deny rule
   * then auto-runs inside the boundary instead of prompting.
   */
  sandboxBashEnforced?: boolean;
  /**
   * True when the unified network policy gates WebFetch in-process (an active
   * sandbox policy projects into the tool). The per-host network decision is
   * then the control, so the per-call tool prompt would be a second ask for
   * the same question and is skipped. Deny rules still block above.
   */
  webFetchNetworkGated?: boolean;
}

const IN_PROCESS_WRITE_TOOLS = new Set(['Write', 'Edit', 'UndoEdit']);

/** Realpath a path if it exists, else return it unchanged (never throws). */
function canonSync(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * True when a file-writing tool targets Cortex's own config tree (~/.cortex or
 * the project .cortex), which holds config, permission rules, network grants,
 * and stored credentials. The OS sandbox denies a shell from writing these; the
 * in-process file tools bypass that boundary, so this closes the same hole.
 *
 * The comparison resolves symlinks: an in-workspace link file (allowed to create
 * inside the sandbox) pointing into ~/.cortex would look in-workspace lexically
 * while the real write lands in the config tree, so we check the symlink-resolved
 * target (both a fully-followed realpath and an existing-ancestor resolution, to
 * catch a symlinked leaf and a symlinked parent) against the resolved dirs.
 */
function isProtectedConfigWrite(
  toolName: string,
  toolArgs: unknown,
  home: string,
  cwd: string,
): boolean {
  if (!IN_PROCESS_WRITE_TOOLS.has(toolName)) return false;
  const args = toolArgs as Record<string, unknown> | null | undefined;
  const target = String(args?.['file_path'] ?? args?.['path'] ?? '');
  if (!target) return false;

  const lexical = resolve(cwd, target);
  const candidates = new Set([
    lexical,
    canonSync(lexical),
    resolveThroughExistingAncestorSync(lexical),
  ]);
  const protectedDirs = [join(home, '.cortex'), join(cwd, '.cortex')].flatMap((d) => [
    d,
    canonSync(d),
  ]);

  for (const c of candidates) {
    for (const d of protectedDirs) {
      if (c === d || c.startsWith(d + sep)) return true;
    }
  }
  return false;
}

/**
 * Deterministic pre-prompt permission decision, ordered by trust floor:
 *
 *   1. Catastrophic Bash command  -> block   (never overridable)
 *   1b. Write to Cortex config    -> block   (never overridable)
 *   2. Yolo mode                  -> allow
 *   3. Explicit deny rule         -> block   (beats the read-only auto-approve)
 *   3b. Sandboxed Bash            -> allow   (the OS boundary is the control)
 *   4. Read-only within project   -> allow
 *   5. Explicit allow rule        -> allow
 *   6. Otherwise                  -> prompt
 *
 * The catastrophic check is the floor: it wins over everything, including yolo.
 * The deny check precedes the read-only shortcut so a user's explicit deny of
 * an in-workspace target (e.g. a secrets directory) is honored rather than
 * silently bypassed by the read-only-in-project auto-approve.
 */
export async function preflightPermission(
  toolName: string,
  toolArgs: unknown,
  deps: PreflightDeps,
): Promise<PreflightOutcome> {
  // 1. Catastrophic Bash commands (e.g. rm -rf /) are blocked unconditionally,
  //    ahead of yolo mode, the read-only bypass, and any allow rule.
  if (toolName === 'Bash') {
    const finding = findCatastrophicCommand(
      String((toolArgs as Record<string, unknown>)['command'] ?? ''),
      { cwd: deps.cwd, home: deps.home ?? homedir() },
    );
    if (finding) return { decision: 'block', reason: finding.reason };
  }

  // 1b. Protected in-process writes: never let a file tool write Cortex's own
  //     config, permission rules, network grants, or credentials. The OS sandbox
  //     denies this for shell; the in-process tools bypass it, so a prompt-injected
  //     Write could otherwise forge a grant or disable the sandbox.
  if (isProtectedConfigWrite(toolName, toolArgs, deps.home ?? homedir(), deps.cwd)) {
    return { decision: 'block', reason: 'Writing Cortex configuration or credentials is not allowed' };
  }

  // 2. Yolo mode auto-approves everything below the catastrophic floor.
  if (deps.yoloMode) return { decision: 'allow' };

  // 3. Explicit deny wins over the read-only-in-project auto-approve.
  const rule = await deps.matchRule(toolName, toolArgs);
  if (rule === 'deny') return { decision: 'block', reason: 'Denied by permission rule' };

  // 3b. Sandbox auto-allow: when the OS boundary contains shell commands, a Bash
  //     call past the catastrophic floor and any deny rule runs without a prompt.
  //     Rules are allow/deny only today; if an "ask every time" rule type is
  //     added, reorder so this fires only when the engine did not request a prompt.
  if (deps.sandboxBashEnforced && toolName === 'Bash') return { decision: 'allow' };

  // 3c. Same shape for WebFetch: when the network policy gates each fetch by
  //     host (one decision shared with shell egress), that gate is the control
  //     and the tool call itself auto-runs.
  if (deps.webFetchNetworkGated && toolName === 'WebFetch') return { decision: 'allow' };

  // 4. Read-only tools contained in the workspace auto-approve.
  if (await deps.isReadOnlyInProject(toolName, toolArgs)) return { decision: 'allow' };

  // 5. Explicit allow rule.
  if (rule === 'allow') return { decision: 'allow' };

  // 6. No rule applied: ask.
  return { decision: 'prompt' };
}
