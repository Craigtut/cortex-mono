/**
 * Shared atomic-write helper for the file-mutation tools (Write, Edit,
 * UndoEdit).
 *
 * All three tools need the same "write to a temp file, then rename over the
 * target" dance so a crash never leaves a half-written file. Doing it in one
 * place also lets us close two footguns that the ad-hoc copies each had:
 *
 *  1. Mode preservation. `rename` replaces the target with a brand-new inode
 *     that carries the process umask mode. Overwriting a `0600` secret would
 *     silently make it world-readable, and a `0755` script would lose +x. We
 *     stat an existing target first and re-apply its mode to the temp file
 *     (via the owned fd, i.e. fchmod) before the rename.
 *
 *  2. Symlink safety. `writeFile` follows symlinks, so a direct-write fallback
 *     could write straight through a workspace-local symlink to, say,
 *     `/etc/passwd`. We resolve the real target (realpath of the nearest
 *     existing ancestor) up front, run the critical-path guard against the
 *     REAL destination, and perform both the rename and the fallback against
 *     that resolved path — never through the symlink.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCriticalPathOrDescendant } from '../bash/safety.js';

/**
 * Thrown when the resolved (symlink-followed) target lands on a critical
 * system path. Callers translate this into their own tool-shaped refusal
 * message so the lexical-path guard they already run is backstopped by a
 * realpath check here.
 */
export class CriticalPathWriteError extends Error {
  readonly resolvedPath: string;

  constructor(resolvedPath: string) {
    super(`Refusing to write through a symlink to a critical system path: ${resolvedPath}`);
    this.name = 'CriticalPathWriteError';
    this.resolvedPath = resolvedPath;
  }
}

/**
 * Resolve `filePath` to its real on-disk destination by realpath-ing the
 * nearest existing ancestor and re-appending the not-yet-existing tail.
 * This follows any symlinks in the path (including a symlinked final
 * component) so we operate on the true target. Falls back to the absolute
 * lexical path when nothing along the chain exists.
 */
export function resolveRealTarget(filePath: string): string {
  const absolute = path.resolve(filePath);
  let current = absolute;
  const remainder: string[] = [];

  while (true) {
    try {
      const real = fs.realpathSync(current);
      return remainder.length > 0 ? path.join(real, ...remainder) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Map a realpath'd destination back to the lexical form the critical-path
 * list uses. On macOS, `/etc`, `/var`, and `/tmp` are symlinks into
 * `/private`, so `realpath()` yields `/private/etc/...`; the critical-path
 * list is expressed as `/etc`, `/var`, etc. Stripping the `/private` prefix
 * reunites them. This stays safe for temp writes: the guard already excludes
 * `/var` as a prefix, so `/private/var/folders/...` (macOS temp) maps to
 * `/var/folders/...` and remains non-critical.
 */
function toLexicalSafetyPath(resolvedPath: string): string {
  if (process.platform === 'darwin' && resolvedPath.startsWith('/private/')) {
    return resolvedPath.slice('/private'.length);
  }
  return resolvedPath;
}

/**
 * Atomically write `content` to `filePath`.
 *
 * Preserves an existing file's permission mode and refuses to write through a
 * symlink that resolves to a critical system path. Safe to call for both the
 * create-new and overwrite cases.
 *
 * @throws {CriticalPathWriteError} when the resolved target is a critical path.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const realTarget = resolveRealTarget(filePath);
  if (
    isCriticalPathOrDescendant(realTarget) ||
    isCriticalPathOrDescendant(toLexicalSafetyPath(realTarget))
  ) {
    throw new CriticalPathWriteError(realTarget);
  }

  // Capture the existing file's mode so the rename (which installs a fresh
  // inode) doesn't drop it to the umask default.
  let existingMode: number | undefined;
  try {
    const st = await fs.promises.stat(realTarget);
    if (st.isFile()) existingMode = st.mode & 0o777;
  } catch {
    // No existing file: create-new path. Leave mode to the platform default.
  }

  const parentDir = path.dirname(realTarget);
  const tempPath = path.join(parentDir, `.atomic-${crypto.randomUUID()}.tmp`);

  try {
    // Write the temp file and, when overwriting, stamp the preserved mode
    // onto our own fd before it becomes the target.
    const handle = await fs.promises.open(tempPath, 'w', existingMode ?? 0o666);
    try {
      await handle.writeFile(content, 'utf8');
      if (existingMode !== undefined) {
        await handle.chmod(existingMode);
      }
    } finally {
      await handle.close();
    }

    try {
      await fs.promises.rename(tempPath, realTarget);
    } catch {
      // Rename can fail on Windows if the target handle is open. Fall back to
      // a direct write of the REAL target (never through the symlink), then
      // clean up the temp file.
      await fs.promises.writeFile(realTarget, content, 'utf8');
      if (existingMode !== undefined) {
        try { await fs.promises.chmod(realTarget, existingMode); } catch { /* best effort */ }
      }
      try { await fs.promises.unlink(tempPath); } catch { /* ignore cleanup errors */ }
    }
  } catch (err) {
    try { await fs.promises.unlink(tempPath); } catch { /* ignore cleanup errors */ }
    throw err;
  }
}
