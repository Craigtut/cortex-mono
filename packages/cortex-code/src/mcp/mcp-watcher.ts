/**
 * Filesystem watcher that observes `~/.cortex/mcp.json` and
 * `{cwd}/.cortex/mcp.json` and notifies a consumer when reconciliation is
 * needed.
 *
 * The watcher itself does **not** perform reconciliation: it only debounces
 * filesystem events and forwards a "config changed" signal. The consumer
 * (typically `Session`) decides when to apply the change so it can wait for
 * the agentic loop to be between turns. See `applyReconcile` in
 * `./reconcile.ts`.
 *
 * Uses Node's built-in `fs.watch` (no `chokidar` dependency). `fs.watch` has
 * known platform quirks for individual files; we mitigate by also watching
 * the parent directory and filtering on the leaf name. Missing directories
 * are handled gracefully: a write that creates the file later still fires
 * because we re-attach when the parent directory appears.
 */

import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Reason a notification was issued. */
export type McpConfigChangeReason = 'global' | 'project' | 'manual';

/** Callback fired on a debounced config change. */
export type McpConfigChangeListener = (reason: McpConfigChangeReason) => void;

export interface McpConfigWatcherOptions {
  cwd: string;
  /** Debounce window between the last fs event and the listener call. */
  debounceMs?: number;
  /** Custom listener. Required. */
  onChange: McpConfigChangeListener;
  /** Optional logger; defaults to no-op. */
  log?: (message: string, data?: Record<string, unknown>) => void;
  /** Inject a different `watch` for tests. */
  watchFn?: typeof watch;
}

const DEFAULT_DEBOUNCE_MS = 250;

interface WatchHandle {
  watcher: FSWatcher;
  target: string;
}

/**
 * Live watcher for the two MCP config files.
 *
 * Usage:
 *
 * ```ts
 * const watcher = new McpConfigWatcher({
 *   cwd: process.cwd(),
 *   onChange: (reason) => session.scheduleMcpReload(reason),
 * });
 * await watcher.start();
 * // ... later ...
 * await watcher.stop();
 * ```
 */
export class McpConfigWatcher {
  private readonly options: McpConfigWatcherOptions;
  private readonly globalDir: string;
  private readonly projectDir: string;
  private readonly globalFile: string;
  private readonly projectFile: string;
  private readonly watchFn: typeof watch;
  private readonly debounceMs: number;
  private handles: WatchHandle[] = [];
  private pending: { timer: NodeJS.Timeout | null; reasons: Set<McpConfigChangeReason> } = {
    timer: null,
    reasons: new Set(),
  };
  private stopped = false;

  constructor(options: McpConfigWatcherOptions) {
    this.options = options;
    this.watchFn = options.watchFn ?? watch;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.globalDir = join(homedir(), '.cortex');
    this.projectDir = join(resolve(options.cwd), '.cortex');
    this.globalFile = join(this.globalDir, 'mcp.json');
    this.projectFile = join(this.projectDir, 'mcp.json');
  }

  /** Start watching. Idempotent. */
  async start(): Promise<void> {
    if (this.handles.length > 0) return;
    await this.attach(this.globalDir, this.globalFile, 'global');
    await this.attach(this.projectDir, this.projectFile, 'project');
  }

  /** Stop watching. Safe to call multiple times. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const handle of this.handles) {
      try {
        handle.watcher.close();
      } catch {
        // ignore
      }
    }
    this.handles = [];
    if (this.pending.timer) {
      clearTimeout(this.pending.timer);
      this.pending.timer = null;
    }
  }

  /**
   * Force a synchronous "changed" pulse. Used by the `/mcp-reload` slash
   * command so manual triggers go through the same debounce/queue path as
   * filesystem events.
   */
  pulse(reason: McpConfigChangeReason = 'manual'): void {
    this.scheduleNotification(reason);
  }

  /**
   * Attach a watcher to `dir`, filtering events to `targetFile`. If the
   * directory does not exist, we silently skip; if it exists but `fs.watch`
   * throws, we log and continue.
   *
   * Re-attach safety: the parent-directory watcher we use while `dir` is
   * absent fires `void this.attach(...)` again when `.cortex` appears. We
   * de-dupe via `this.handles` keyed on `target` so rapid create/destroy
   * cycles do not stack watchers, and we honor `this.stopped` at the top so
   * an in-flight attach cannot register a new handle after `stop()` ran.
   */
  private async attach(dir: string, targetFile: string, reason: McpConfigChangeReason): Promise<void> {
    if (this.stopped) return;
    let exists = false;
    try {
      const dirStat = await stat(dir);
      exists = dirStat.isDirectory();
    } catch {
      exists = false;
    }
    if (this.stopped) return;
    if (!exists) {
      const parent = dirname(dir);
      // Already watching this parent for the same dir? Don't stack.
      if (this.handles.some((handle) => handle.target === parent)) return;
      try {
        await stat(parent);
        if (this.stopped) return;
        const watcher = this.watchFn(parent, { persistent: false }, (eventType, filename) => {
          if (filename && filename.toString() === '.cortex') {
            // Cortex directory was created; close the parent-watcher we
            // installed for the create wait so we don't leak it, then
            // re-attach against the now-present dir.
            const idx = this.handles.findIndex((h) => h.target === parent);
            if (idx >= 0) {
              try { this.handles[idx]?.watcher.close(); } catch { /* ignore */ }
              this.handles.splice(idx, 1);
            }
            void this.attach(dir, targetFile, reason);
          }
        });
        this.handles.push({ watcher, target: parent });
      } catch {
        // Parent missing too; nothing to watch.
      }
      return;
    }
    // Don't double-attach a leaf watcher either (re-entrant attach after a
    // parent-watcher fire).
    if (this.handles.some((handle) => handle.target === targetFile)) return;
    try {
      const watcher = this.watchFn(dir, { persistent: false }, (_eventType, filename) => {
        if (filename && filename.toString() === 'mcp.json') {
          this.scheduleNotification(reason);
        }
      });
      this.handles.push({ watcher, target: targetFile });
    } catch (err) {
      this.options.log?.('mcp.watcher.attach_failed', {
        dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private scheduleNotification(reason: McpConfigChangeReason): void {
    if (this.stopped) return;
    this.pending.reasons.add(reason);
    if (this.pending.timer) clearTimeout(this.pending.timer);
    this.pending.timer = setTimeout(() => {
      const reasons = [...this.pending.reasons];
      this.pending.reasons.clear();
      this.pending.timer = null;
      const collapsed: McpConfigChangeReason = reasons.includes('project')
        ? 'project'
        : reasons.includes('global')
          ? 'global'
          : 'manual';
      try {
        this.options.onChange(collapsed);
      } catch (err) {
        this.options.log?.('mcp.watcher.listener_threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, this.debounceMs);
  }
}
