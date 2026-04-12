import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function resolveReal(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Walk up from `cwd` looking for a `.git` entry (directory or file — git
 * worktrees use a `.git` file). Returns the resolved real path of the first
 * ancestor that contains one, or the resolved `cwd` if no `.git` is found.
 *
 * Sessions use this to group by project so `/resume` can filter to sessions
 * that were created somewhere inside the current project, even when the user
 * resumes from a different subdirectory.
 */
export function findProjectRoot(cwd: string): string {
  let current: string;
  try {
    current = resolveReal(cwd);
  } catch {
    return resolve(cwd);
  }

  const start = current;
  while (true) {
    const gitPath = resolve(current, '.git');
    if (existsSync(gitPath)) {
      try {
        statSync(gitPath);
        return current;
      } catch {
        // fall through
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
}

/** Two paths share a project root if findProjectRoot returns the same value. */
export function sameProject(a: string, b: string): boolean {
  return findProjectRoot(a) === findProjectRoot(b);
}
