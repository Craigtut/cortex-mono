/**
 * Process tree termination shared by the Bash tool (timeouts) and the
 * per-agent tool runtime (destroy-time cleanup of background tasks).
 */

import * as child_process from 'node:child_process';

/**
 * Kill the entire process tree rooted at a spawned child process.
 * Unix: send SIGKILL to the process group (Bash spawns detached, so the
 * child is its own group leader and grandchildren die with it).
 * Windows: use taskkill /F /T.
 */
export function killProcessTree(proc: child_process.ChildProcess): void {
  if (!proc.pid) return;

  try {
    if (process.platform === 'win32') {
      child_process.execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
    } else {
      // Kill the entire process group
      process.kill(-proc.pid, 'SIGKILL');
    }
  } catch {
    // Process may have already exited
    try {
      proc.kill('SIGKILL');
    } catch {
      // Ignore
    }
  }
}
