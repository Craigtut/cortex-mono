/**
 * Picks up MCP config changes between turns without a restart.
 *
 * Watches ~/.cortex/mcp.json and {cwd}/.cortex/mcp.json and reconciles the
 * agent's connected servers against them. A reload never runs while the agent
 * is busy: swapping tools mid-turn would invalidate the tool snapshot
 * pi-agent-core captured at prompt() entry, so a change that lands during
 * work is queued until the owner reports the work settled.
 */

import type { CortexAgent } from '@animus-labs/cortex';
import type { TranscriptManager } from '../tui/transcript.js';
import { log } from '../logger.js';
import { McpConfigWatcher, type McpConfigChangeReason } from './mcp-watcher.js';
import { reconcileMcpServers, type McpReconcileResult, type ProjectTrustResolver } from './reconcile.js';

export interface McpReloadSchedulerDeps {
  cwd: string;
  getAgent: () => CortexAgent | null;
  getApp: () => { transcript: Pick<TranscriptManager, 'addNotification'> } | null;
  /** True while the agent is working; reloads wait for it to settle. */
  isBusy: () => boolean;
  /** Asks the user about a new or changed project config. */
  resolveProjectTrust: ProjectTrustResolver;
}

export class McpReloadScheduler {
  private watcher: McpConfigWatcher | null = null;
  private pending: McpConfigChangeReason | null = null;
  private inFlight = false;

  constructor(private readonly deps: McpReloadSchedulerDeps) {}

  /** Start watching both config files. */
  async start(): Promise<void> {
    this.watcher = new McpConfigWatcher({
      cwd: this.deps.cwd,
      onChange: (reason) => this.schedule(reason),
      log: (msg, data) => log.info(msg, data),
    });
    await this.watcher.start();
  }

  /**
   * Stop watching, so a late filesystem event cannot schedule work against an
   * agent that is being destroyed.
   */
  async stop(): Promise<void> {
    if (!this.watcher) return;
    try {
      await this.watcher.stop();
    } catch {
      // ignore
    }
    this.watcher = null;
  }

  /**
   * Queue an MCP config reload. If the agent is busy, the reload is deferred
   * until {@link runIfPending}; otherwise it runs immediately. Multiple
   * queued reloads collapse into one pass.
   */
  schedule(reason: McpConfigChangeReason): void {
    this.pending = reason;
    if (!this.deps.isBusy()) {
      void this.runQueued();
    }
  }

  /** Apply a reload that was queued while the agent was busy. */
  runIfPending(): void {
    if (this.pending) {
      void this.runQueued();
    }
  }

  /**
   * Execute one queued reconciliation pass. Guards against re-entrancy so
   * concurrent watcher events do not stomp on each other.
   */
  private async runQueued(): Promise<void> {
    if (this.inFlight) return;
    const agent = this.deps.getAgent();
    if (!agent) {
      this.pending = null;
      return;
    }
    this.inFlight = true;
    const reason = this.pending ?? 'manual';
    this.pending = null;
    try {
      const result = await reconcileMcpServers(agent, this.deps.cwd, {
        resolveProjectTrust: this.deps.resolveProjectTrust,
        log: (msg, data) => log.info(msg, data),
      });
      this.notifyOutcome(reason, result);
    } catch (err) {
      log.warn('MCP reload failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.deps.getApp()?.transcript.addNotification(
        'MCP Reload Failed',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.inFlight = false;
      // A change that arrived while we were running would have set
      // pending again; pick it up immediately if so.
      if (this.pending && !this.deps.isBusy()) {
        void this.runQueued();
      }
    }
  }

  private notifyOutcome(reason: McpConfigChangeReason, result: McpReconcileResult): void {
    const parts: string[] = [];
    if (result.added.length > 0) parts.push(`+${result.added.length} added`);
    if (result.removed.length > 0) parts.push(`-${result.removed.length} removed`);
    if (result.updated.length > 0) parts.push(`${result.updated.length} updated`);
    if (result.skippedDueToUntrustedProject.length > 0) {
      parts.push(`${result.skippedDueToUntrustedProject.length} skipped (untrusted)`);
    }
    if (result.errors.length > 0) parts.push(`${result.errors.length} error(s)`);
    const transcript = this.deps.getApp()?.transcript;
    if (parts.length === 0 && reason === 'manual') {
      transcript?.addNotification('MCP', 'Already up to date.');
      return;
    }
    if (parts.length > 0) {
      transcript?.addNotification(
        reason === 'manual' ? 'MCP Reload' : 'MCP Config Changed',
        parts.join(', '),
      );
    }
  }
}
