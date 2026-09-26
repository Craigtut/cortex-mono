/**
 * A loop's attachment to an MCP client manager: its own, or a shared one
 * (config.mcpClientManager). Manager-level settings are applied, and
 * connections closed on detach, only for a manager this loop owns.
 */

import { McpClientManager } from '../mcp-client.js';
import type { AgentLoopConfig, CortexLogger, McpToolCallProgress } from '../types.js';

export interface McpAttachmentListeners {
  onSubprocessSpawned(pid: number): void;
  onSubprocessExited(pid: number): void;
  onToolsChanged(): void;
}

export class McpAttachment {
  readonly manager: McpClientManager;
  readonly owns: boolean;
  /** This loop's own manager-listener registrations, removed on detach. */
  private readonly listenerUnsubscribers: Array<() => void> = [];
  /** The consumer's single progress-handler slot (replace semantics). */
  private progressUnsubscribe: (() => void) | null = null;

  constructor(
    config: Pick<AgentLoopConfig, 'mcpClientManager' | 'envOverrides' | 'sandbox'>,
    logger: CortexLogger,
    listeners: McpAttachmentListeners,
  ) {
    this.owns = config.mcpClientManager === undefined;
    this.manager = config.mcpClientManager ?? new McpClientManager();
    if (this.owns) {
      this.manager.logger = logger;
      if (config.envOverrides) {
        this.manager.envOverrides = config.envOverrides;
      }
      // stdio servers run inside the same OS sandbox as shell commands.
      if (config.sandbox) {
        this.manager.sandbox = config.sandbox;
      }
    }
    this.listenerUnsubscribers.push(
      this.manager.addSubprocessSpawnedListener((pid) => listeners.onSubprocessSpawned(pid)),
      this.manager.addSubprocessExitedListener((pid) => listeners.onSubprocessExited(pid)),
      this.manager.addToolsChangedListener(() => listeners.onToolsChanged()),
    );
  }

  /** Replace this loop's progress handler; undefined clears it. */
  setProgressHandler(handler: ((progress: McpToolCallProgress) => void) | undefined): void {
    this.progressUnsubscribe?.();
    this.progressUnsubscribe = null;
    if (handler !== undefined) {
      this.progressUnsubscribe = this.manager.addToolCallProgressListener(handler);
    }
  }

  /** Remove this loop's registrations and close the manager if owned. */
  async detach(): Promise<void> {
    for (const unsub of this.listenerUnsubscribers.splice(0)) {
      unsub();
    }
    this.progressUnsubscribe?.();
    this.progressUnsubscribe = null;
    if (this.owns) {
      try {
        await this.manager.closeAll();
      } catch {
        // Best-effort MCP cleanup
      }
    }
  }
}
