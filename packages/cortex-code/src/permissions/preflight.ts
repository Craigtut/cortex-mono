import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  BASH_ESCALATION_PERMISSION_NAME,
  findCatastrophicCommand,
  resolveThroughExistingAncestorSync,
} from '@animus-labs/cortex';
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
  /**
   * The active sandbox policy's filesystem deny sets, projected onto the
   * in-process file tools. The OS sandbox denies a shell these paths (rc
   * files, git hooks/config, secret stores, the Cortex config tree), but
   * Write/Edit/UndoEdit/Read run in-process on fs and bypass that boundary,
   * so the same sets block them here, above yolo. Absent when the sandbox is
   * off: Off is genuinely off.
   */
  sandboxDenyWrite?: readonly string[];
  sandboxDenyRead?: readonly string[];
  /**
   * The active sandbox policy's writableRoots (absolute paths), projected onto
   * the in-process write tools as a POSITIVE floor. The OS sandbox confines a
   * shell to write only inside these roots (an allowlist), but Write/Edit/
   * UndoEdit run in-process on fs and would auto-approve a write to any path a
   * denylist did not enumerate. This mirrors the shell's confinement: a write
   * whose resolved target lands outside every root leaves the workspace, so it
   * must not auto-approve. Present only when a policy is active; absent when the
   * sandbox is off, leaving in-process write behavior unchanged.
   */
  sandboxWritableRoots?: readonly string[];
}

const IN_PROCESS_WRITE_TOOLS = new Set(['Write', 'Edit', 'UndoEdit']);
/** Edit reads the target to apply its replacement, so it is on both lists. */
const IN_PROCESS_READ_TOOLS = new Set(['Read', 'Edit']);

/** Realpath a path if it exists, else return it unchanged (never throws). */
function canonSync(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** The path a file tool call targets, or '' when the call carries none. */
function fileToolTarget(toolArgs: unknown): string {
  const args = toolArgs as Record<string, unknown> | null | undefined;
  return String(args?.['file_path'] ?? args?.['path'] ?? '');
}

/**
 * Symlink-resolved forms of a tool's target path: the lexical resolution plus
 * a fully-followed realpath and an existing-ancestor resolution, to catch a
 * symlinked leaf and a symlinked parent. An in-workspace link file (allowed to
 * create inside the sandbox) pointing at a protected path would look clean
 * lexically while the real access lands on the protected target.
 */
function resolvedTargetCandidates(target: string, cwd: string): string[] {
  const lexical = resolve(cwd, target);
  return [
    ...new Set([lexical, canonSync(lexical), resolveThroughExistingAncestorSync(lexical)]),
  ];
}

// macOS (APFS) and Windows default to case-insensitive filesystems, so a write
// to a case-variant of a not-yet-existing protected path (~/.ZPROFILE for
// ~/.zprofile) would fold onto the real file while a case-sensitive compare
// missed it. Fold both sides there so the floor cannot be dodged by spelling.
// Existing targets are already case-normalized by realpath; this covers the
// not-yet-created leaf.
const FS_CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
function foldPathCase(p: string): string {
  return FS_CASE_INSENSITIVE ? p.toLowerCase() : p;
}

/** True when any candidate form of the target is at or under any protected path. */
function targetsProtectedPath(candidates: string[], protectedPaths: readonly string[]): boolean {
  const resolved = protectedPaths.flatMap((p) => [p, canonSync(p)]).map(foldPathCase);
  for (const c of candidates) {
    const cf = foldPathCase(c);
    for (const p of resolved) {
      if (cf === p || cf.startsWith(p + sep)) return true;
    }
  }
  return false;
}

/**
 * True only when EVERY symlink-resolved form of the target sits at or under some
 * writable root. Mirrors targetsProtectedPath's walk (at-or-under with the path
 * separator, case-folded on case-insensitive filesystems) but with "within"
 * semantics: if any candidate escapes every root, the write leaves the workspace.
 * That is what catches a workspace symlink whose real target is outside, the
 * lexical form looks contained while the realpath candidate does not. Roots are
 * canonicalized too, so a symlinked workspace root (/workspace -> /private/...)
 * still contains its own files.
 */
function isWithinWritableRoots(candidates: string[], roots: readonly string[]): boolean {
  const resolvedRoots = roots.flatMap((r) => [r, canonSync(r)]).map(foldPathCase);
  for (const c of candidates) {
    const cf = foldPathCase(c);
    const within = resolvedRoots.some((r) => cf === r || cf.startsWith(r + sep));
    if (!within) return false;
  }
  return true;
}

/**
 * True when a file-writing tool targets Cortex's own config tree (~/.cortex or
 * the project .cortex), which holds config, permission rules, network grants,
 * and stored credentials. The OS sandbox denies a shell from writing these; the
 * in-process file tools bypass that boundary, so this closes the same hole.
 * Unconditional: it holds even when the sandbox is off.
 */
function isProtectedConfigWrite(
  toolName: string,
  toolArgs: unknown,
  home: string,
  cwd: string,
): boolean {
  if (!IN_PROCESS_WRITE_TOOLS.has(toolName)) return false;
  const target = fileToolTarget(toolArgs);
  if (!target) return false;
  return targetsProtectedPath(resolvedTargetCandidates(target, cwd), [
    join(home, '.cortex'),
    join(cwd, '.cortex'),
  ]);
}

/**
 * Project the active sandbox policy's denyWrite/denyRead onto the in-process
 * file tools, so a prompt-injected Write cannot land on ~/.zshrc or .git/hooks
 * just because it skipped the shell. Returns the self-explaining block reason,
 * or null when the call is not denied by the policy.
 */
function sandboxPolicyFileDenial(
  toolName: string,
  toolArgs: unknown,
  deps: PreflightDeps,
): string | null {
  const denyWrite = deps.sandboxDenyWrite ?? [];
  const denyRead = deps.sandboxDenyRead ?? [];
  const checksWrite = denyWrite.length > 0 && IN_PROCESS_WRITE_TOOLS.has(toolName);
  const checksRead = denyRead.length > 0 && IN_PROCESS_READ_TOOLS.has(toolName);
  if (!checksWrite && !checksRead) return null;

  const target = fileToolTarget(toolArgs);
  if (!target) return null;

  const candidates = resolvedTargetCandidates(target, deps.cwd);
  if (checksWrite && targetsProtectedPath(candidates, denyWrite)) {
    return `Blocked by sandbox policy: ${target} is write-protected`;
  }
  if (checksRead && targetsProtectedPath(candidates, denyRead)) {
    return `Blocked by sandbox policy: ${target} is read-protected`;
  }
  return null;
}

/**
 * Deterministic pre-prompt permission decision, ordered by trust floor:
 *
 *   1. Catastrophic Bash command  -> block   (never overridable; covers escalation too)
 *   1b. Write to Cortex config    -> block   (never overridable)
 *   1c. Sandbox policy deny path  -> block   (in-process file tool on a denyWrite/denyRead path)
 *   1c-bis. Write outside roots   -> rule|prompt (in-process write leaving the writable roots)
 *   1d. Sandbox escalation        -> prompt  (Bash deny rules still block; nothing auto-approves)
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
  //    ahead of yolo mode, the read-only bypass, and any allow rule. Applies
  //    equally to escalation requests: a catastrophic command can never leave
  //    the sandbox, whoever asks.
  if (toolName === 'Bash' || toolName === BASH_ESCALATION_PERMISSION_NAME) {
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

  // 1c. Sandbox policy projection: the OS boundary denies a shell the policy's
  //     denyWrite/denyRead paths; the in-process file tools bypass it, so the
  //     same sets block them here, above yolo, like the config floor. Symlinks
  //     are resolved, so a workspace link into ~/.zshrc does not slip through.
  const policyDenial = sandboxPolicyFileDenial(toolName, toolArgs, deps);
  if (policyDenial) return { decision: 'block', reason: policyDenial };

  // 1c-bis. Positive write floor: the sandboxed shell may write ONLY inside the
  //     policy's writableRoots (an allowlist), but the in-process write tools run
  //     on fs and a denylist (1c) cannot enumerate every dangerous target outside
  //     the workspace (~/.local/bin on PATH, ~/.claude hooks, cron dirs). So a
  //     write whose resolved target escapes every writable root is treated like
  //     the shell could never make it: it must NOT ride yolo (2) or the read-only
  //     shortcut (4). It still yields to the deny/config/catastrophic floors above.
  //     Require a real decision: an explicit deny blocks, an explicit allow rule
  //     for that path is honored, otherwise prompt. Symlinks are resolved first,
  //     so a workspace link whose real target is outside counts as outside.
  //     No-op when the sandbox is off (no writableRoots) and for in-workspace
  //     writes, which fall through to the normal flow (yolo may still allow them).
  const writableRoots = deps.sandboxWritableRoots ?? [];
  if (writableRoots.length > 0 && IN_PROCESS_WRITE_TOOLS.has(toolName)) {
    const target = fileToolTarget(toolArgs);
    if (target) {
      const candidates = resolvedTargetCandidates(target, deps.cwd);
      if (!isWithinWritableRoots(candidates, writableRoots)) {
        const rule = await deps.matchRule(toolName, toolArgs);
        if (rule === 'deny') return { decision: 'block', reason: 'Denied by permission rule' };
        if (rule === 'allow') return { decision: 'allow' };
        return { decision: 'prompt' };
      }
    }
  }

  // 1d. Sandbox escalation: the model asking to run ONE command outside the OS
  //     boundary. A deliberate exit from containment, so it is always a fresh
  //     human decision: yolo, the sandbox auto-run, allow rules, and the
  //     read-only shortcut never auto-approve it. Deny rules written for plain
  //     Bash still apply (escalating must not turn a hard deny into a prompt).
  if (toolName === BASH_ESCALATION_PERMISSION_NAME) {
    const bashRule = await deps.matchRule('Bash', toolArgs);
    if (bashRule === 'deny') return { decision: 'block', reason: 'Denied by permission rule' };
    return { decision: 'prompt' };
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
