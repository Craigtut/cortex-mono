/**
 * Path allowlist for the read-surface built-in tools (Read, Glob, Grep).
 *
 * Restricted loops (duplex quick lookups, docs/cortex/duplex/sub-agents.md)
 * must not read outside their allowed roots even when the process can. The
 * restriction is enforced IN-TOOL, never by prompt: a lookup agent's answer
 * becomes spoken conversation, so an unrestricted read is a direct
 * exfiltration path and the model's cooperation cannot be the boundary.
 *
 * Checks resolve symlinks through the nearest existing ancestor on BOTH the
 * target and the roots (path-guard.ts primitives), so `<root>/link ->
 * ~/.ssh/id_rsa` is refused and a root like `/tmp` still contains targets
 * that realpath into `/private/tmp` on macOS. Refusals return a visible
 * message naming the scope, never a silent empty result.
 */

import { isPathSameOrDescendant, resolveThroughExistingAncestor } from './path-guard.js';

/** Verdict of an allowlist check. */
export interface PathAllowlistVerdict {
  allowed: boolean;
  /** Symlink-resolved absolute target that was checked. */
  resolvedPath: string;
  /** Visible refusal message; set only when not allowed. */
  refusal?: string;
}

export interface PathAllowlist {
  /** Check one path (it need not exist; ancestors are symlink-resolved). */
  check(targetPath: string): Promise<PathAllowlistVerdict>;
  /** The configured roots, as given. */
  readonly roots: readonly string[];
}

/** Human-readable scope description for refusal messages. */
function describeRoots(roots: readonly string[]): string {
  return roots.join(', ');
}

/**
 * Build an allowlist over one or more root directories. Roots are
 * symlink-resolved lazily per check (not at construction) so a root created
 * or re-linked after tool creation is still honored.
 */
export function createPathAllowlist(roots: readonly string[]): PathAllowlist {
  return {
    roots,
    async check(targetPath: string): Promise<PathAllowlistVerdict> {
      const resolvedPath = await resolveThroughExistingAncestor(targetPath);
      for (const root of roots) {
        const resolvedRoot = await resolveThroughExistingAncestor(root);
        if (isPathSameOrDescendant(resolvedPath, resolvedRoot)) {
          return { allowed: true, resolvedPath };
        }
      }
      return {
        allowed: false,
        resolvedPath,
        refusal:
          `Access denied: '${targetPath}' is outside this agent's allowed ` +
          `read scope (${describeRoots(roots)}).`,
      };
    },
  };
}
