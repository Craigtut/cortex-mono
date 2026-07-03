/**
 * Shared path-containment primitives.
 *
 * These are the canonical implementations of "resolve a path through its
 * nearest existing ancestor's realpath" and "is target the same as or inside
 * parent". They exist in one place because both the framework Bash safety
 * layer and downstream permission systems need the exact same semantics; two
 * diverging copies of this logic is how containment bypasses are born.
 *
 * All functions are lexical-first: when nothing on disk exists for a path,
 * they fall back to plain path resolution rather than failing, so callers can
 * still reason about not-yet-created paths.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Return the realpath of a path, or null if it does not exist. */
export async function realpathIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(filePath);
  } catch {
    return null;
  }
}

/**
 * Resolve a path, following symlinks through the nearest existing ancestor.
 * For a path that does not exist yet, the deepest existing ancestor is
 * resolved via realpath and the non-existent remainder is re-appended.
 * Falls back to path.resolve() when nothing along the path exists.
 */
export async function resolveThroughExistingAncestor(targetPath: string): Promise<string> {
  const absoluteTarget = path.resolve(targetPath);
  let current = absoluteTarget;
  const remainder: string[] = [];

  while (true) {
    const real = await realpathIfExists(current);
    if (real) return path.resolve(real, ...remainder);

    const parent = path.dirname(current);
    if (parent === current) return absoluteTarget;

    remainder.unshift(path.basename(current));
    current = parent;
  }
}

/** Synchronous variant of resolveThroughExistingAncestor. */
export function resolveThroughExistingAncestorSync(targetPath: string): string {
  const absoluteTarget = path.resolve(targetPath);
  let current = absoluteTarget;
  const remainder: string[] = [];

  while (true) {
    try {
      return path.resolve(fs.realpathSync(current), ...remainder);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absoluteTarget;
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * True if targetPath is parentPath itself or a descendant of it.
 * Comparison is lexical (both inputs are resolved first); resolve symlinks
 * with resolveThroughExistingAncestor before calling when that matters.
 * Case-insensitive on Windows by default.
 */
export function isPathSameOrDescendant(
  targetPath: string,
  parentPath: string,
  options?: { caseInsensitive?: boolean | undefined },
): boolean {
  const caseInsensitive = options?.caseInsensitive ?? process.platform === 'win32';
  let target = path.resolve(targetPath);
  let parent = path.resolve(parentPath);
  if (caseInsensitive) {
    target = target.toLowerCase();
    parent = parent.toLowerCase();
  }
  const relative = path.relative(parent, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
