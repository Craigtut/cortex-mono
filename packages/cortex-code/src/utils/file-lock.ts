/**
 * In-process async write lock, keyed by file path.
 *
 * Several stores persist to the same per-workspace settings.json (permission
 * rules, network domain grants, sandbox settings), each owning its own
 * top-level key but sharing the same read-modify-write pattern. Without
 * serialization, two concurrent persists can both read, then both write, and
 * the second write silently drops the first store's key. Every
 * read-modify-write of a shared settings file must run inside this lock.
 *
 * In-process only: it does not coordinate across cortex-code processes.
 * Simultaneous same-workspace writes from two processes remain last-writer-wins.
 */

import { resolve } from 'node:path';

/** Tail of the pending work chain per path. Entries are removed when idle. */
const chains = new Map<string, Promise<void>>();

/**
 * Run `fn` once every previously queued operation on the same file has
 * settled. Returns fn's result; a rejection propagates to this caller only
 * and never blocks or fails later queued operations.
 */
export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(filePath);
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}
