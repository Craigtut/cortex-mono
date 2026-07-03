import * as path from 'node:path';
import {
  isPathSameOrDescendant,
  realpathIfExists,
  resolveThroughExistingAncestor,
} from '@animus-labs/cortex';

/**
 * True if targetPath resolves (through symlinks, via the nearest existing
 * ancestor) to the real cwd or a descendant of it. The path primitives are
 * the shared canonical implementations from @animus-labs/cortex.
 */
export async function isPathWithinRealCwd(targetPath: string, cwd: string): Promise<boolean> {
  if (!targetPath) return false;

  const realCwd = await realpathIfExists(cwd);
  if (!realCwd) return false;

  const resolvedTarget = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(cwd, targetPath);
  const realTarget = await resolveThroughExistingAncestor(resolvedTarget);

  return isPathSameOrDescendant(realTarget, realCwd);
}
