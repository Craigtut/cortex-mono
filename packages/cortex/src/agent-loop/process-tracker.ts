/**
 * Subprocess PIDs a loop spawned (shell commands, stdio MCP servers), so
 * teardown's force-kill deadline and the process-exit safety net can reap
 * them. The exit handler is process-global and installed once; it covers
 * every loop's PIDs through the shared set.
 */

const globalTrackedPids = new Set<number>();
let exitHandlerInstalled = false;

function handleProcessExit(): void {
  for (const pid of globalTrackedPids) {
    try {
      process.kill(pid);
    } catch {
      // Process may have already exited
    }
  }
  globalTrackedPids.clear();
}

export class ProcessTracker {
  private readonly trackedPids = new Set<number>();

  constructor() {
    if (!exitHandlerInstalled) {
      process.on('exit', handleProcessExit);
      exitHandlerInstalled = true;
    }
  }

  /** This loop's live PIDs (read-only view). */
  get pids(): ReadonlySet<number> {
    return this.trackedPids;
  }

  track(pid: number): void {
    this.trackedPids.add(pid);
    globalTrackedPids.add(pid);
  }

  untrack(pid: number): void {
    this.trackedPids.delete(pid);
    globalTrackedPids.delete(pid);
  }

  /** Synchronous last resort for an unclean teardown: kill every tracked PID. */
  killAll(): void {
    for (const pid of this.trackedPids) {
      try {
        process.kill(pid);
      } catch {
        // Process may have already exited
      }
      globalTrackedPids.delete(pid);
    }
    this.trackedPids.clear();
  }
}
