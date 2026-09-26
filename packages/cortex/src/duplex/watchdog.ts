/**
 * The liveness watchdog (communication.md): a working reasoner must be
 * distinguishable from a hung one. When a reasoner run stays silent past the
 * watchdog interval, the conversation gets a synthesized progress note, so
 * the talker can say something true instead of guessing.
 */

export interface WatchdogPorts {
  /** When the live reasoner run started, or null while none is running. */
  runStartedAt(): number | null;
  /** When the reasoner last produced anything bound for the conversation. */
  lastOutputAt(): number;
  /** Aliases of the delegations still described as work in progress. */
  activeAliases(): string[];
  /** Asks blocked on the user right now. */
  pendingAsks(): ReadonlyArray<{ toolName: string; requestedAt: number }>;
  /** Tell the conversation the work is still going. Never concludes anything. */
  reportProgress(text: string): void;
}

export class LivenessWatchdog {
  private readonly ports: WatchdogPorts;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval>;
  private destroyed = false;

  constructor(ports: WatchdogPorts, options: { intervalMs: number; now: () => number }) {
    this.ports = ports;
    this.intervalMs = options.intervalMs;
    this.now = options.now;
    // Checks well inside the interval so a hung run is noticed at most ~1.25
    // intervals after its last output.
    const checkEvery = Math.min(Math.max(50, Math.floor(this.intervalMs / 4)), 15_000);
    this.timer = setInterval(() => this.tick(), checkEvery);
    this.timer.unref?.();
  }

  destroy(): void {
    this.destroyed = true;
    clearInterval(this.timer);
  }

  private tick(): void {
    if (this.destroyed) return;
    const startedAt = this.ports.runStartedAt();
    if (startedAt === null) return;
    const now = this.now();
    if (now - this.ports.lastOutputAt() < this.intervalMs) return;
    const elapsedS = Math.max(1, Math.round((now - startedAt) / 1000));
    const aliases = this.ports.activeAliases();
    const subject = aliases.length > 0
      ? `Background work (${aliases.join(', ')})`
      : 'Background work';
    // A run blocked on a permission ask is silent because it is waiting on
    // the user, not because it is slow or hung. Saying "no update yet" there
    // tells the talker to reassure instead of to ask again for the answer.
    const waitingOn = this.oldestPendingAsk();
    const text = waitingOn
      ? `${subject} is paused waiting for the user's permission answer (${waitingOn.toolName}), ` +
        `about ${Math.max(1, Math.round((now - waitingOn.requestedAt) / 1000))}s so far. ` +
        'It cannot continue until the user answers.'
      : `${subject} is still running, about ${elapsedS}s so far; no update from it yet.`;
    this.ports.reportProgress(text);
  }

  private oldestPendingAsk(): { toolName: string; requestedAt: number } | null {
    let oldest: { toolName: string; requestedAt: number } | null = null;
    for (const ask of this.ports.pendingAsks()) {
      if (oldest === null || ask.requestedAt < oldest.requestedAt) oldest = ask;
    }
    return oldest;
  }
}
