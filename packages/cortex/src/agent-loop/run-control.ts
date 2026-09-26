/**
 * Run control: the loop gate every agentic run starts through, the abort
 * state runs are cancelled with, and the abortable waits built on them.
 *
 * Loop gate. Every loop-owning task (consumer prompts, background drains,
 * wake sweeps, idle digestion) is serialized through one promise chain, so
 * a concurrent prompt() can never corrupt a running loop's tool runtime or
 * history boundary. Depth counts the running task plus queued ones, so
 * callers can fail fast before mutating shared loop state. The tail never
 * rejects.
 *
 * Abort epoch. abort() cancels parked wake deliveries, including ones that
 * park during its own await windows. The live controller cannot express
 * that (a drain that starts mid-abort replaces it, and abort() skips the
 * gate wait when background deliveries are pending), so parked items are
 * stamped with the epoch at park time and every take of the parked queue
 * drops items stamped before the most recent abort completed. The
 * in-progress count covers the window before the epoch advances at the
 * end of abort().
 */

export class LoopGate {
  private tail: Promise<void> = Promise.resolve();
  private depthCount = 0;

  /**
   * Serialize a task behind every previously enqueued one. At most one
   * gate task executes at a time.
   */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.depthCount += 1;
    const run = this.tail.then(task);
    const release = (): void => {
      this.depthCount -= 1;
    };
    this.tail = run.then(release, release);
    return run;
  }

  /** Running plus queued tasks. */
  get depth(): number {
    return this.depthCount;
  }

  get isActive(): boolean {
    return this.depthCount > 0;
  }

  /** Settles when every task enqueued so far has (never rejects). */
  get settled(): Promise<void> {
    return this.tail;
  }

  /**
   * Resolve once the gate is empty. Each pass awaits the current tail and
   * re-checks, so tasks enqueued by tasks extend the wait.
   */
  async waitForIdle(): Promise<void> {
    while (this.depthCount > 0) {
      await this.tail;
    }
  }
}

export class AbortState {
  private controller = new AbortController();
  private epochValue = 0;
  private inProgress = 0;

  /** The current run's signal. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Advances each time an abort() completes (see the module doc). */
  get epoch(): number {
    return this.epochValue;
  }

  set epoch(value: number) {
    this.epochValue = value;
  }

  /** True while an abort is completing or the current controller is aborted. */
  get inFlight(): boolean {
    return this.inProgress > 0 || this.controller.signal.aborted;
  }

  /** Install a fresh controller if the current one was aborted. */
  renewIfAborted(): void {
    if (this.controller.signal.aborted) {
      this.controller = new AbortController();
    }
  }

  /** Abort the current controller (teardown). */
  abortCurrent(): void {
    this.controller.abort();
  }

  /**
   * Start an abort: abort the current controller and count the abort as in
   * progress until `end()`, which advances the epoch. `renew()` installs a
   * fresh controller unless a newer run already replaced the aborted one.
   */
  begin(): { signal: AbortSignal; renew(): void; end(): void } {
    const controller = this.controller;
    this.inProgress += 1;
    controller.abort();
    return {
      signal: controller.signal,
      renew: () => {
        if (this.controller === controller) {
          this.controller = new AbortController();
        }
      },
      end: () => {
        this.inProgress -= 1;
        this.epochValue += 1;
      },
    };
  }
}

/** Marker for a race the abort signal won. */
export const ABORTED = Symbol('aborted');

/**
 * Race a promise against an abort signal: its value, or ABORTED when the
 * signal fires first. A late settlement is ignored (its rejection handled),
 * so abandoning the wait never surfaces an unhandled rejection.
 */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.resolve(ABORTED);
  }
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Wait for `promise` for at most `timeoutMs` (and, with a signal, only
 * until it aborts). A rejection before the deadline propagates; after an
 * abandon, the late settlement is ignored.
 */
export async function raceTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<'settled' | 'timeout' | 'aborted'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const outcome = await raceAbort(
      Promise.race([promise.then(() => 'settled' as const), deadline]),
      signal,
    );
    if (outcome === ABORTED) return 'aborted';
    if (outcome === 'timeout') promise.catch(() => {});
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sleep for `ms`, waking early if `signal` aborts. Resolves true when the
 * full delay elapsed, false when aborted, so a cancel during a
 * multi-minute backoff takes effect immediately.
 */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Whether pi's run state records an abort/cancel as its error. Matches
 * "abort"/"cancelled" only as a word start, not inside a larger
 * identifier: a provider error like ECONNABORTED is a network failure, and
 * misreading it as an abort would trim its failure stub and mislabel the
 * error as a cancellation.
 */
export function isAbortShapedError(agentState: Record<string, unknown>): boolean {
  const rawError = agentState['errorMessage'] ?? agentState['error'];
  if (!rawError) return false;
  const errorMsg = typeof rawError === 'string'
    ? rawError
    : rawError instanceof Error
      ? rawError.message
      : typeof (rawError as Record<string, unknown>)['message'] === 'string'
        ? (rawError as Record<string, unknown>)['message'] as string
        : '';
  return /(?<![a-z])abort/i.test(errorMsg) || /(?<![a-z])cancell?ed/i.test(errorMsg);
}
