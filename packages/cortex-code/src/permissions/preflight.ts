import { homedir } from 'node:os';
import { findCatastrophicCommand } from '@animus-labs/cortex';
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
}

/**
 * Deterministic pre-prompt permission decision, ordered by trust floor:
 *
 *   1. Catastrophic Bash command  -> block   (never overridable)
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

  // 4. Read-only tools contained in the workspace auto-approve.
  if (await deps.isReadOnlyInProject(toolName, toolArgs)) return { decision: 'allow' };

  // 5. Explicit allow rule.
  if (rule === 'allow') return { decision: 'allow' };

  // 6. No rule applied: ask.
  return { decision: 'prompt' };
}
