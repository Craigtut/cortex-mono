/**
 * Deduplicate concurrent async work by key.
 *
 * While a call for `key` is in flight, later calls with the same key return the
 * same promise instead of starting the work again. The entry is cleared once
 * the promise settles (success or failure), so a subsequent call starts fresh
 * work and observes any state the prior call persisted.
 *
 * Used to serialize OAuth token refreshes: providers that rotate the refresh
 * token on every use invalidate the previous one, so two concurrent refreshes
 * with the same stored token make one win and the rest fail. Collapsing the
 * burst onto a single refresh rotates the token exactly once.
 */
export function singleFlight<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const task = work();
  inFlight.set(key, task);
  const clear = () => {
    if (inFlight.get(key) === task) {
      inFlight.delete(key);
    }
  };
  // Clear on both settle paths. Using then(clear, clear) (rather than finally)
  // means this internal chain swallows a rejection, so it never surfaces as an
  // unhandled rejection; the original `task` is still returned to the caller,
  // which observes the rejection.
  void task.then(clear, clear);
  return task;
}
