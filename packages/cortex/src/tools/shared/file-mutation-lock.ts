/**
 * Per-file async mutation lock.
 *
 * Serializes concurrent mutations (Edit, Write) that target the same file
 * while allowing mutations on different files to proceed in parallel.
 *
 * Uses promise chaining rather than OS mutexes: each `acquire()` appends
 * a new link to the per-path chain. The caller awaits the previous link
 * (serialization) and receives a `release` callback that resolves the
 * current link so the next waiter can proceed.
 */

import * as path from 'node:path';

export class FileMutationLock {
  private chains = new Map<string, Promise<void>>();

  /**
   * Acquire exclusive mutation access for a file path.
   * Returns a release function that MUST be called when done (use try/finally).
   */
  async acquire(filePath: string): Promise<() => void> {
    const key = path.resolve(filePath);
    const previous = this.chains.get(key) ?? Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    this.chains.set(key, current);

    await previous;
    return release;
  }

  /** Clear all chains. Safe to call between agentic loops. */
  clear(): void {
    this.chains.clear();
  }
}
