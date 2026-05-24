import * as fs from 'node:fs/promises';
import * as path from 'node:path';

function normalizeForComparison(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSamePathOrDescendant(targetPath: string, parentPath: string): boolean {
  const relative = path.relative(
    normalizeForComparison(parentPath),
    normalizeForComparison(targetPath),
  );
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveFromCwd(cwd: string, targetPath: string): string {
  return path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(cwd, targetPath);
}

async function realpathIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.realpath(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return null;
  }
}

async function resolveThroughExistingAncestor(targetPath: string): Promise<string | null> {
  const absoluteTarget = path.resolve(targetPath);
  let current = absoluteTarget;
  const remainder: string[] = [];

  while (true) {
    const real = await realpathIfExists(current);
    if (real) return path.resolve(real, ...remainder);

    const parent = path.dirname(current);
    if (parent === current) return null;

    remainder.unshift(path.basename(current));
    current = parent;
  }
}

export async function isPathWithinRealCwd(targetPath: string, cwd: string): Promise<boolean> {
  if (!targetPath) return false;

  const realCwd = await realpathIfExists(cwd);
  if (!realCwd) return false;

  const resolvedTarget = resolveFromCwd(cwd, targetPath);
  const realTarget = await resolveThroughExistingAncestor(resolvedTarget);
  if (!realTarget) return false;

  return isSamePathOrDescendant(realTarget, realCwd);
}
