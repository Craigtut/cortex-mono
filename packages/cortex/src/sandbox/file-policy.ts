import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { resolveThroughExistingAncestorSync } from '../tools/shared/path-guard.js';
import type { SandboxFilesystemPolicy } from './types.js';

function canonical(path: string): string {
  try { return realpathSync.native(path); } catch { return path; }
}
function under(path: string, root: string): boolean {
  const fold = (value: string) => process.platform === 'win32'
    ? value.toLowerCase() : value;
  const rel = relative(fold(root), fold(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'));
}
function candidates(path: string, cwd: string): string[] {
  const full = resolve(cwd, path);
  return [...new Set([full, canonical(full), resolveThroughExistingAncestorSync(full)])];
}

/** Core tool policy. Human approval cannot bypass an active sandbox's file boundary. */
export function sandboxFileDenial(
  name: string, args: unknown, cwd: string, policy: SandboxFilesystemPolicy,
): string | null {
  if (!args || typeof args !== 'object') return null;
  const input = args as Record<string, unknown>;
  const writes = ['Write', 'Edit', 'UndoEdit'].includes(name);
  const reads = ['Read', 'Edit', 'Glob'].includes(name);
  if (!writes && !reads) return null;
  let target = input['file_path'] ?? input['path'];
  if (name === 'Glob') {
    const pattern = typeof input['pattern'] === 'string' ? input['pattern'] : '';
    const base = pattern.split(/[/\\]/).filter((part, index, all) =>
      !all.slice(0, index + 1).some((segment) => /[*?[\]{}!()+@]/.test(segment)),
    ).join('/');
    target = isAbsolute(pattern) ? base || '/' : resolve(cwd, typeof target === 'string' ? target : '.', base || '.');
  }
  if (typeof target !== 'string' || !target) return null;
  if (name !== 'Glob' && !isAbsolute(target)) return 'Sandboxed file tools require an absolute path';
  const paths = candidates(target, cwd);
  const protectedBy = (roots: string[]) => paths.some((path) => roots.some((root) =>
    [resolve(cwd, root), resolveThroughExistingAncestorSync(resolve(cwd, root))].some((boundary) => under(path, boundary)),
  ));
  if (writes && protectedBy(policy.denyWrite)) return `Blocked by sandbox policy: ${target} is write-protected`;
  if (reads && protectedBy(policy.denyRead)) return `Blocked by sandbox policy: ${target} is read-protected`;
  if (writes && !paths.every((path) => policy.writableRoots.some((root) =>
    under(resolveThroughExistingAncestorSync(path), resolveThroughExistingAncestorSync(resolve(cwd, root))),
  ))) return `Blocked by sandbox policy: ${target} is outside the writable roots`;
  return null;
}
