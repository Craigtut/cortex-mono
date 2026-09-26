/**
 * A single-holder lock over the on-screen prompt, granted in arrival order.
 *
 * A release hands the lock straight to the oldest waiter, so nothing can
 * take it in between: an ask that has to await a re-check after waking can
 * no longer lose its turn to whichever ask happens to be scheduled first,
 * which let a steady stream of network asks starve a tool ask. Each release
 * is bound to its own grant and runs once, so a late or repeated call can
 * never free a lock another ask now holds.
 */
export class PromptLock {
  private held = false;
  private readonly waiters: Array<() => void> = [];

  get isHeld(): boolean {
    return this.held;
  }

  /** Wait for this ask's turn and take the lock. */
  acquire(): Promise<() => void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve(this.releaseFor());
    }
    return new Promise((resolve) => {
      this.waiters.push(() => resolve(this.releaseFor()));
    });
  }

  private releaseFor(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      // Handed over while still held, or freed when nobody waits.
      if (next) next();
      else this.held = false;
    };
  }
}
