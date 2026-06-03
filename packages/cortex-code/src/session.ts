/**
 * Session Controller: the central orchestrator bridging TUI and Cortex.
 *
 * Responsibilities:
 * - Creates and configures the CortexAgent with the active mode's settings
 * - Provides getApiKey callback (env var > credential store > OAuth refresh)
 * - Provides resolvePermission callback (rules check > inline TUI prompt)
 * - Routes Cortex events to the TUI (streaming, tool calls, errors, compaction)
 * - Manages session persistence (auto-save on loop complete and turn end)
 * - Handles user input (slash commands, agent prompts)
 * - Lifecycle: start, abort, resume, shutdown
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

import {
  CortexAgent,
  ProviderManager,
  type CortexAgentConfig,
  type CortexModel,
  type CortexEvent,
  type CortexToolPermissionDecision,
  type CortexToolPermissionResult,
  type AgentTextOutput,
  type ClassifiedError,
  type CompactionResult,
  type ThinkingLevel,
  type McpStdioConfig,
  type ToolCallEndPayload,
  type ToolCallStartPayload,
  type ToolCallUpdatePayload,
  stripWorkingTags,
} from '@animus-labs/cortex';
import { SelectList, type SelectItem } from '@earendil-works/pi-tui';
import { App, type AppCallbacks } from './tui/app.js';
import { randomThinkingLabel } from './tui/spinner.js';
import { selectListTheme } from './tui/theme.js';
import { OverlayBox } from './tui/overlay-box.js';
import { type CortexCodeConfig } from './config/config.js';
import { CredentialStore } from './config/credentials.js';
import { PermissionRuleManager } from './permissions/rules.js';
import { findDangerousCommand } from './permissions/dangerous-commands.js';
import { isPathWithinRealCwd } from './permissions/path-containment.js';
import { discoverProjectContext } from './discovery/context.js';
import { discoverSkills } from './discovery/skills.js';
import { discoverMcpServers } from './discovery/mcp.js';
import { checkProjectMcpTrust, trustProjectMcpConfig } from './discovery/mcp-trust.js';
import {
  generateSessionId,
  createDebouncedSaver,
  createToolResultPersistor,
  type SessionMeta,
} from './persistence/sessions.js';
import { getCommand, registerBuiltinCommands } from './commands/index.js';
import { dismissVersion, type UpdateInfo } from './updates/checker.js';
import { runNpmUpgrade } from './updates/upgrade.js';
import type { Mode } from './modes/types.js';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from './logger.js';
import { getOllamaHost, getOllamaContextWindow } from './providers/ollama.js';
import { FreezeDiagnostics } from './diagnostics/freeze.js';
import { buildToolDisplayArgs, summarizeToolStartArgs } from './tui/tool-display-args.js';
import { FileSessionActivityReporter, type PermissionResolution } from './activity/session-activity.js';
import { McpConfigWatcher, type McpConfigChangeReason } from './mcp/mcp-watcher.js';
import { reconcileMcpServers, type McpReconcileResult } from './mcp/reconcile.js';
import { loadHookHandlers } from './hooks/loader.js';
import { runHookHandlers } from './hooks/runner.js';
import type { HookEvent, HookHandler, PreTurnEnvelope } from './hooks/types.js';
import { TitleManager } from './terminal/title-manager.js';

const execFileAsync = promisify(execFile);

function formatEffortLabel(level: ThinkingLevel): string {
  return level === 'max'
    ? 'Max'
    : level.charAt(0).toUpperCase() + level.slice(1);
}

export interface SessionOptions {
  config: CortexCodeConfig;
  mode: Mode;
  model: CortexModel;
  provider: string;
  modelId: string;
  providerManager: ProviderManager;
  credentialStore: CredentialStore;
  cwd: string;
  yoloMode: boolean;
  initialEffort: ThinkingLevel;
  initialUtilityModelId?: string | undefined;
  resumeSessionId: string | undefined;
  compactionStrategy?: 'observational' | 'classic';
  /** Update availability resolved at startup, or null when up to date / disabled. */
  updateInfo?: UpdateInfo | null;
}

export class Session {
  private agent: CortexAgent | null = null;
  private app: App | null = null;
  private rules: PermissionRuleManager;
  private yoloMode: boolean;
  /** The user's desired effort level. Persists across model switches within a session. */
  private preferredEffort: ThinkingLevel;
  /** The actual effort level applied to the agent (may differ from preferred due to model limits). */
  private effectiveEffort: ThinkingLevel;
  private sessionId: string;
  /** True when this session was launched to resume a saved one. */
  private readonly isResume: boolean;
  private saver: ReturnType<typeof createDebouncedSaver>;
  private isRunning = false;
  private createdAt: number;
  private permissionLockPromise: Promise<void> | null = null;
  private permissionLockRelease: (() => void) | null = null;
  private subAgentActivity = new Map<string, Map<string, { name: string; status: string; summary?: string }>>();
  private readonly freezeDiagnostics: FreezeDiagnostics;
  private readonly activity: FileSessionActivityReporter;
  private mcpWatcher: McpConfigWatcher | null = null;
  private mcpReloadPending: McpConfigChangeReason | null = null;
  private mcpReloadInFlight = false;
  private hookHandlers: Record<HookEvent, HookHandler[]> | null = null;
  private titleManager: TitleManager | null = null;

  private readonly config: CortexCodeConfig;
  private readonly mode: Mode;
  private readonly model: CortexModel;
  private provider: string;
  private modelId: string;
  private readonly providerManager: ProviderManager;
  private readonly credentialStore: CredentialStore;
  private readonly cwd: string;
  private readonly initialUtilityModelId: string | undefined;
  private readonly compactionStrategy: 'observational' | 'classic';
  private updateInfo: UpdateInfo | null;
  /** Guards against stacking a second update overlay (startup + /update, or double /update). */
  private updatePromptOpen = false;

  constructor(options: SessionOptions) {
    this.config = options.config;
    this.mode = options.mode;
    this.model = options.model;
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.providerManager = options.providerManager;
    this.credentialStore = options.credentialStore;
    this.cwd = options.cwd;
    this.initialUtilityModelId = options.initialUtilityModelId;
    this.yoloMode = options.yoloMode;
    this.preferredEffort = options.initialEffort;
    this.effectiveEffort = this.preferredEffort;
    this.rules = new PermissionRuleManager(options.cwd);
    this.sessionId = options.resumeSessionId ?? generateSessionId();
    this.isResume = options.resumeSessionId !== undefined;
    this.saver = createDebouncedSaver(this.sessionId);
    this.compactionStrategy = options.compactionStrategy ?? 'observational';
    this.updateInfo = options.updateInfo ?? null;
    this.createdAt = Date.now();
    this.freezeDiagnostics = new FreezeDiagnostics(this.config.diagnostics?.freeze);
    this.activity = new FileSessionActivityReporter(this.sessionId, this.cwd, {
      onWriteError: (error) => {
        log.warn('Session activity write failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  /** Start the session: create agent, set up context, wire events, start TUI. */
  async start(): Promise<void> {
    log.info('Session starting', { provider: this.provider, model: this.modelId, cwd: this.cwd });
    await this.activity.initialize();

    // Register commands
    registerBuiltinCommands();

    // Load persisted permission rules
    await this.rules.loadPersistedRules();

    // Create TUI
    const callbacks: AppCallbacks = {
      onSubmit: (text) => this.handleInput(text),
      onAbort: () => this.abort(),
      onExit: () => this.shutdown(),
    };
    this.app = new App(callbacks, this.cwd, this.freezeDiagnostics);

    // Create agent (built-in tools are auto-registered by Cortex)
    this.agent = await CortexAgent.create({
      model: this.model,
      utilityModel: 'default',
      workingDirectory: this.cwd,
      initialBasePrompt: this.mode.systemPrompt,
      slots: this.mode.contextSlots,
      resolvePermission: (toolName, toolArgs) => this.resolvePermission(toolName, toolArgs),
      isAutoApprove: () => this.yoloMode,
      getApiKey: (provider) => this.getApiKey(provider),
      contextWindowLimit: this.config.contextWindowLimit ?? null,
      compaction: { strategy: this.compactionStrategy },
      persistResult: createToolResultPersistor(this.sessionId),
      logger: log,
      ...this.buildDiagnosticsConfig() ? { diagnostics: this.buildDiagnosticsConfig()! } : {},
    });

    if (this.initialUtilityModelId) {
      try {
        await this.applyUtilityModel(this.initialUtilityModelId, false);
      } catch (err) {
        log.warn('Failed to apply initial utility model', {
          provider: this.provider,
          model: this.initialUtilityModelId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Set up context slots
    const projectContext = await discoverProjectContext(this.cwd);
    const ctx = this.agent.getContextManager();
    ctx.setSlot('system-prompt', this.mode.systemPrompt);
    if (projectContext) {
      ctx.setSlot('project-context', projectContext);
    }

    // Set up ephemeral context
    await this.updateEphemeralContext();

    // Terminal title: name the tab after what the user is working on. Runs on
    // the utility model and is best-effort, so a failure never disrupts the
    // session. Must be created before wireEvents (onLoopComplete drives it).
    this.titleManager = new TitleManager({
      mode: this.config.terminalTitle ?? 'dynamic',
      cwd: this.cwd,
      setTitle: (title) => this.app?.terminal.setTitle(title),
      complete: async (ctx) => (this.agent ? this.agent.utilityComplete(ctx) : null),
      onError: (err) => log.debug('Terminal title generation failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    });
    this.titleManager.start();

    // Wire events
    this.wireEvents();

    // Connect MCP servers (with trust-on-first-use for project-local configs)
    await this.connectMcpServersWithTrust();

    // Watch ~/.cortex/mcp.json and {cwd}/.cortex/mcp.json for changes so we
    // can pick them up between turns without a restart.
    this.mcpWatcher = new McpConfigWatcher({
      cwd: this.cwd,
      onChange: (reason) => this.scheduleMcpReload(reason),
      log: (msg, data) => log.info(msg, data),
    });
    await this.mcpWatcher.start();

    // Load lifecycle hook handlers from ~/.cortex/hooks.json and
    // {cwd}/.cortex/hooks.json. Loading is non-fatal: a malformed config or
    // missing files yields an empty handler set rather than blocking
    // startup.
    try {
      this.hookHandlers = await loadHookHandlers(this.cwd);
    } catch (err) {
      log.warn('Hook loader failed; running without hooks', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.hookHandlers = null;
    }

    // Register skills
    const skills = await discoverSkills(this.cwd);
    for (const skill of skills) {
      this.agent.getSkillRegistry().addSkill(skill);
    }
    // Refresh autocomplete after skills are registered
    this.app.refreshCommands(this.cwd);

    // Apply initial thinking level
    const { effective: initialEffort } = await this.reconcileEffort();

    // Show banner. The split-flap settle plays only for a fresh session; a
    // resumed session opens straight to the settled logo.
    const branch = await this.getGitBranch();
    const project = this.cwd.split('/').pop() ?? '';
    this.app.transcript.addBanner(PKG_VERSION, project, branch, this.updateInfo ?? undefined, {
      animate: !this.isResume,
    });

    // Update footer
    this.app.updateStatus({
      mode: this.mode.name,
      provider: this.provider,
      model: this.modelId,
      contextTokenCount: this.getDisplayedCurrentContextTokens(),
      contextTokenLimit: this.agent.effectiveContextWindow,
      gitBranch: branch,
      yoloMode: this.yoloMode,
      effortLevel: initialEffort,
      observationalMode: this.compactionStrategy === 'observational',
    });

    // Start TUI event loop
    this.app.start();
    void this.activity.recordAwaitingInput();

    // Surface the interactive update prompt once the input loop is live, and
    // only when this version has not already been skipped. The subtle banner
    // line above remains regardless. Non-blocking so resume can proceed.
    if (this.updateInfo?.shouldPrompt) {
      void this.promptForUpdate(this.updateInfo);
    }
  }

  /**
   * Show the interactive "update available" overlay. The user can update now
   * (runs npm and exits) or skip this version (recorded so it won't prompt
   * again until a newer version ships).
   */
  async promptForUpdate(info: UpdateInfo): Promise<void> {
    // Ignore if no TUI, or an update overlay is already showing (avoids stacking
    // two overlays from startup + /update, or a double /update).
    if (!this.app || this.updatePromptOpen) return;
    this.updatePromptOpen = true;
    await new Promise<void>((resolve) => {
      const items: SelectItem[] = [
        {
          value: 'update',
          label: 'Update now',
          description: `Install ${info.packageName}@${info.latestVersion} and restart`,
        },
        {
          value: 'skip',
          label: 'Skip this version',
          description: 'Continue; remind me when a newer version ships',
        },
      ];

      const list = new SelectList(items, 2, selectListTheme);
      const overlayBox = new OverlayBox(
        list,
        `Update available: ${info.currentVersion} → ${info.latestVersion}`,
      );
      const handle = this.app!.tui.showOverlay(overlayBox, {
        anchor: 'center',
        width: '60%',
        maxHeight: 10,
      });

      // Guard against the SelectList firing onSelect/onCancel more than once
      // (e.g. a rapid double Enter) before the overlay is removed: the "update"
      // branch spawns npm and exits, so a double-fire must not run twice.
      let done = false;
      const finish = async (value: string) => {
        if (done) return;
        done = true;
        handle.hide();
        if (value === 'update') {
          await this.runUpgrade(info); // tears down the TUI and exits the process
          return; // not reached on success
        }
        await dismissVersion(info.latestVersion);
        this.updatePromptOpen = false;
        this.app!.focusEditor();
        resolve();
      };

      list.onSelect = (item) => { void finish(item.value); };
      list.onCancel = () => { void finish('skip'); };
    });
  }

  /** Tear down the TUI, run the global npm upgrade, and exit. */
  private async runUpgrade(info: UpdateInfo): Promise<void> {
    this.app?.stop();
    console.log(`\nUpdating ${info.packageName} to ${info.latestVersion}...\n`);
    const code = await runNpmUpgrade(info.packageName);
    if (code === 0) {
      await this.activity.recordDone({ code: 0, signal: null, reason: 'upgrade_completed' });
      await this.activity.flush();
      console.log(`\n✓ Updated to ${info.latestVersion}. Restart with: cortex\n`);
      process.exit(0);
    }
    await this.activity.recordError(new Error(`Upgrade failed with exit code ${code}`), true);
    await this.activity.flush();
    console.log(`\nUpdate failed. Run it manually:\n  npm i -g ${info.packageName}@latest\n`);
    process.exit(1);
  }

  /** Handle user input (slash command or agent prompt). */
  private async handleInput(text: string): Promise<void> {
    // Check for slash commands
    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/);
      const cmdName = parts[0];
      if (cmdName) {
        const cmd = getCommand(cmdName);
        if (cmd) {
          await this.activity.recordWorking();
          try {
            await cmd.handler(this);
          } finally {
            void this.activity.recordAwaitingInput();
          }
          return;
        }
      }
    }

    if (!this.agent) return;

    // If the agent is already running, steer it with the new message
    if (this.isRunning) {
      log.info('Steering agent with user message', { text: text.slice(0, 100) });
      void this.activity.recordWorking();
      this.app!.transcript.addUserMessage(text);
      this.titleManager?.recordUserPrompt(text);
      this.agent.steer(text);
      return;
    }

    log.info('User prompt', { text: text.slice(0, 100) });

    // Add user message to transcript
    this.app!.transcript.addUserMessage(text);
    this.titleManager?.recordUserPrompt(text);

    // Update ephemeral context
    await this.updateEphemeralContext();

    // Show spinner
    this.app!.showStatusSpinner(randomThinkingLabel());
    this.isRunning = true;
    this.freezeDiagnostics.setSessionRunning(true);
    await this.activity.recordWorking();

    // Run pre_turn hooks: outside processes can inject context the agent
    // should see before this turn (e.g. inter-agent message notifications).
    // Failures inside individual handlers are logged but do not block the
    // turn.
    const promptForAgent = await this.applyPreTurnHooks(text);

    try {
      await this.agent.prompt(promptForAgent);
    } catch (err) {
      log.error('Prompt error', { error: err instanceof Error ? err.message : String(err) });
      void this.activity.recordError(err instanceof Error ? err : String(err));
      // Errors are mostly handled via onError handler.
      // Catch unexpected ones and stream interruptions here.
      if (this.agent?.state !== 'destroyed') {
        const message = err instanceof Error ? err.message : String(err);
        // Check if this is a stream interruption (partial response already displayed)
        if (message.includes('stream') || message.includes('aborted') || message.includes('interrupted')) {
          this.app!.transcript.appendAssistantChunk('\n\n[response interrupted]');
          this.app!.transcript.finalizeAssistantMessage();
        } else {
          this.app!.transcript.addNotification('Error', message);
        }
      }
    } finally {
      this.isRunning = false;
      this.freezeDiagnostics.setSessionRunning(false);
      this.app!.hideStatusSpinner();
      this.app!.focusEditor();
      void this.activity.recordAwaitingInput();
    }
  }

  /**
   * Discover and connect MCP servers, applying trust-on-first-use for
   * project-local configs. Global servers (~/.cortex/mcp.json) connect
   * immediately. Project servers require user approval if the config
   * is new or has changed since last approval.
   */
  private async connectMcpServersWithTrust(): Promise<void> {
    const allServers = await discoverMcpServers(this.cwd);
    const globalServers = allServers.filter(s => s.source === 'global');
    const projectServers = allServers.filter(s => s.source === 'project');

    // Global servers are always trusted
    for (const server of globalServers) {
      await this.connectMcpServer(server);
    }

    // No project servers: nothing to trust-check
    if (projectServers.length === 0) return;

    // Check if the project MCP config is trusted
    const trust = await checkProjectMcpTrust(this.cwd);
    if (trust.trusted) {
      for (const server of projectServers) {
        await this.connectMcpServer(server);
      }
      return;
    }

    // Untrusted: prompt the user
    const serverList = projectServers.map(s => `  ${s.name}: ${s.config.command}${s.config.args ? ' ' + s.config.args.join(' ') : ''}`).join('\n');

    await new Promise<void>((resolve) => {
      const items: SelectItem[] = [
        { value: 'trust', label: 'Trust and connect', description: 'Approve these servers' },
        { value: 'skip', label: 'Skip project servers', description: 'Only use global MCP servers' },
      ];

      const list = new SelectList(items, 2, selectListTheme);
      const overlayBox = new OverlayBox(list, 'New Project MCP Servers');
      const handle = this.app!.tui.showOverlay(overlayBox, {
        anchor: 'center',
        width: '60%',
        maxHeight: 12,
      });

      this.app!.transcript.addNotification(
        'MCP Trust Check',
        `This project wants to connect MCP servers:\n${serverList}`,
      );

      list.onSelect = async (item) => {
        handle.hide();
        if (item.value === 'trust') {
          await trustProjectMcpConfig(this.cwd);
          for (const server of projectServers) {
            await this.connectMcpServer(server);
          }
          this.app!.transcript.addNotification('MCP', `Connected ${projectServers.length} project server(s).`);
        } else {
          this.app!.transcript.addNotification('MCP', 'Skipped project MCP servers.');
        }
        resolve();
      };

      list.onCancel = () => {
        handle.hide();
        this.app!.transcript.addNotification('MCP', 'Skipped project MCP servers.');
        resolve();
      };
    });
  }

  private async connectMcpServer(server: { name: string; config: McpStdioConfig }): Promise<void> {
    try {
      await this.agent!.connectMcpServer(server.name, server.config);
    } catch (err) {
      this.app!.transcript.addNotification(
        'MCP Error',
        `Failed to connect "${server.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Queue an MCP config reload. If the agentic loop is currently running, the
   * reload is deferred until `onLoopComplete`; otherwise it runs immediately.
   * Multiple queued reloads collapse into one pass.
   */
  private scheduleMcpReload(reason: McpConfigChangeReason): void {
    this.mcpReloadPending = reason;
    if (!this.isRunning) {
      void this.runQueuedMcpReload();
    }
  }

  /**
   * Public entry point for the `/mcp-reload` slash command. Force a
   * reconciliation pass; same gating rules as a watcher-driven reload.
   */
  async triggerMcpReload(): Promise<void> {
    this.scheduleMcpReload('manual');
  }

  /**
   * Execute one queued reconciliation pass. Guards against re-entrancy so
   * concurrent watcher events do not stomp on each other.
   */
  private async runQueuedMcpReload(): Promise<void> {
    if (this.mcpReloadInFlight) return;
    if (!this.agent) {
      this.mcpReloadPending = null;
      return;
    }
    this.mcpReloadInFlight = true;
    const reason = this.mcpReloadPending ?? 'manual';
    this.mcpReloadPending = null;
    try {
      const result = await reconcileMcpServers(this.agent, this.cwd, {
        resolveProjectTrust: (cwd, servers) => this.resolveProjectMcpTrust(cwd, servers.map(s => s.name)),
        log: (msg, data) => log.info(msg, data),
      });
      this.notifyMcpReloadOutcome(reason, result);
    } catch (err) {
      log.warn('MCP reload failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.app?.transcript.addNotification(
        'MCP Reload Failed',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.mcpReloadInFlight = false;
      // A change that arrived while we were running would have set
      // mcpReloadPending again; pick it up immediately if so.
      if (this.mcpReloadPending && !this.isRunning) {
        void this.runQueuedMcpReload();
      }
    }
  }

  /**
   * Prompt the user to trust a new/changed project MCP config during a
   * watcher-driven reload. Mirrors the startup overlay in
   * `connectMcpServersWithTrust`. Returns 'skip' if the user declines or
   * dismisses the overlay.
   */
  private async resolveProjectMcpTrust(cwd: string, serverNames: string[]): Promise<'trust' | 'skip'> {
    if (!this.app) return 'skip';
    void cwd;
    return await new Promise<'trust' | 'skip'>((resolve) => {
      const items: SelectItem[] = [
        { value: 'trust', label: 'Trust and connect', description: 'Approve project MCP servers' },
        { value: 'skip', label: 'Skip', description: 'Keep using global servers only' },
      ];
      const list = new SelectList(items, 2, selectListTheme);
      const overlayBox = new OverlayBox(list, 'Project MCP Servers Changed');
      const handle = this.app!.tui.showOverlay(overlayBox, {
        anchor: 'center',
        width: '60%',
        maxHeight: 12,
      });
      this.app!.transcript.addNotification(
        'MCP Trust Check',
        `Approve new/changed project MCP servers?\n${serverNames.map(n => `  ${n}`).join('\n')}`,
      );
      list.onSelect = (item) => {
        handle.hide();
        resolve(item.value === 'trust' ? 'trust' : 'skip');
      };
      list.onCancel = () => {
        handle.hide();
        resolve('skip');
      };
    });
  }

  /**
   * Invoke every registered `pre_turn` hook handler in parallel and prepend
   * their concatenated `additionalContext` (if any) to the user's prompt.
   * Returns the (possibly augmented) prompt text the agent should see.
   *
   * Hooks are external subprocesses; per-handler failures are logged and the
   * other handlers still run. If no handlers are configured or none return
   * context, the original prompt is returned unchanged.
   */
  private async applyPreTurnHooks(userText: string): Promise<string> {
    const handlers = this.hookHandlers?.pre_turn ?? [];
    if (handlers.length === 0) return userText;
    const envelope: PreTurnEnvelope = {
      event: 'pre_turn',
      sessionId: this.sessionId,
      cwd: this.cwd,
      timestamp: new Date().toISOString(),
      version: 1,
      userPrompt: userText,
    };
    const { additionalContext, results } = await runHookHandlers(handlers, envelope);
    for (const result of results) {
      if (result.error) {
        log.warn('pre_turn hook failed', {
          handler: result.handler.name,
          error: result.error,
          exitCode: result.exitCode,
          signal: result.signal,
        });
      }
    }
    if (additionalContext.length === 0) return userText;
    return `<pre-turn-context>\n${additionalContext}\n</pre-turn-context>\n\n${userText}`;
  }

  private notifyMcpReloadOutcome(reason: McpConfigChangeReason, result: McpReconcileResult): void {
    const parts: string[] = [];
    if (result.added.length > 0) parts.push(`+${result.added.length} added`);
    if (result.removed.length > 0) parts.push(`-${result.removed.length} removed`);
    if (result.updated.length > 0) parts.push(`${result.updated.length} updated`);
    if (result.skippedDueToUntrustedProject.length > 0) {
      parts.push(`${result.skippedDueToUntrustedProject.length} skipped (untrusted)`);
    }
    if (result.errors.length > 0) parts.push(`${result.errors.length} error(s)`);
    if (parts.length === 0 && reason === 'manual') {
      this.app?.transcript.addNotification('MCP', 'Already up to date.');
      return;
    }
    if (parts.length > 0) {
      this.app?.transcript.addNotification(
        reason === 'manual' ? 'MCP Reload' : 'MCP Config Changed',
        parts.join(', '),
      );
    }
  }

  /** Wire all CortexAgent events to the TUI. */
  private wireEvents(): void {
    if (!this.agent || !this.app) return;
    const bridge = this.agent.getEventBridge();
    this.wireActivityEvents(bridge);

    // Streaming response chunks
    let assistantStarted = false;
    let rawStreamText = '';
    let workingTagOpen = false;

    bridge.on('response_start', (event: CortexEvent) => {
      if (event.childTaskId) return;
      assistantStarted = false;
      rawStreamText = '';
      workingTagOpen = false;
      this.app!.removeWorkingTagSubtitle();
    });

    bridge.on('response_chunk', (event: CortexEvent) => {
      // Skip child agent streaming; only parent text goes to transcript
      if (event.childTaskId) return;

      if (!assistantStarted) {
        this.app!.transcript.startAssistantMessage();
        assistantStarted = true;
      }
      // Extract text delta from the pi-agent-core event data
      const data = event.data as Record<string, unknown> | undefined;
      const delta = this.extractTextDelta(data);
      if (delta) {
        rawStreamText += delta;
        this.updateWorkingTagDisplay(rawStreamText, workingTagOpen, (open) => { workingTagOpen = open; });
        this.app!.transcript.appendAssistantChunk(delta);
      }
    });

    // Tool call lifecycle (uses typed payloads from EventBridge)
    bridge.on('tool_call_start', (event: CortexEvent) => {
      // Child agent tool events update the parent sub-agent row instead of
      // creating separate transcript rows.
      if (event.childTaskId) {
        this.recordSubAgentToolStart(event);
        return;
      }

      const p = event.payload as ToolCallStartPayload | undefined;
      const toolName = p?.toolName ?? String((event.data as Record<string, unknown> | undefined)?.['toolName'] ?? 'unknown');

      // SubAgent tool calls are displayed via the onSubAgentSpawned lifecycle hook
      if (toolName === 'SubAgent') return;

      const toolCallId = p?.toolCallId ?? String((event.data as Record<string, unknown> | undefined)?.['toolCallId'] ?? Math.random());
      const args = p?.args ?? ((event.data as Record<string, unknown> | undefined)?.['args'] as Record<string, unknown> ?? {});
      const displayArgs = buildToolDisplayArgs(toolName, args);
      const summary = summarizeToolStartArgs(toolName, toolCallId, args);
      const traceToolStarts = this.freezeDiagnostics.isEnabled;

      if (traceToolStarts) {
        log.debug('[TUI] tool_call_start received', summary);
        this.app!.traceNextRender(`tool-start:${toolName}:${toolCallId}`);
      }

      try {
        this.app!.transcript.startToolCall(toolCallId, toolName, displayArgs);
        if (traceToolStarts) {
          log.debug('[TUI] tool_call_start queued', {
            ...summary,
            displayArgKeys: Object.keys(displayArgs),
          });
        }
      } catch (error) {
        log.error('[TUI] tool_call_start failed', {
          ...summary,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
    });

    // Streaming tool updates (bash output, etc.)
    bridge.on('tool_call_update', (event: CortexEvent) => {
      if (event.childTaskId) return;

      const p = event.payload as ToolCallUpdatePayload | undefined;
      const toolCallId = p?.toolCallId ?? String((event.data as Record<string, unknown> | undefined)?.['toolCallId'] ?? '');
      const partialResult = p?.partialResult ?? (event.data as Record<string, unknown> | undefined)?.['partialResult'];

      if (partialResult) {
        this.app!.transcript.updateToolCall(toolCallId, partialResult);
      }
    });

    bridge.on('tool_call_end', (event: CortexEvent) => {
      // Child agent tool events update the parent sub-agent row instead of
      // creating separate transcript rows.
      if (event.childTaskId) {
        this.recordSubAgentToolEnd(event);
        return;
      }

      const p = event.payload as ToolCallEndPayload | undefined;
      const toolName = p?.toolName ?? String((event.data as Record<string, unknown> | undefined)?.['toolName'] ?? 'unknown');

      // SubAgent tool_call_end is handled via onSubAgentCompleted/onSubAgentFailed
      if (toolName === 'SubAgent') return;

      const toolCallId = p?.toolCallId ?? String((event.data as Record<string, unknown> | undefined)?.['toolCallId'] ?? '');
      const durationMs = p?.durationMs ?? Number((event.data as Record<string, unknown> | undefined)?.['durationMs'] ?? 0);

      if (p?.isError && p.error) {
        this.app!.transcript.failToolCall(toolCallId, p.error, durationMs);
      } else {
        const result = p?.result ?? (event.data as Record<string, unknown> | undefined)?.['result'];
        const details = (result as Record<string, unknown> | undefined)?.['details'];
        this.app!.transcript.completeToolCall(toolCallId, result, details, durationMs);
      }
    });

    // Turn complete (finalize assistant message)
    this.agent.onTurnComplete((output: AgentTextOutput) => {
      this.app!.transcript.finalizeAssistantMessage(output.userFacing);
      assistantStarted = false;
      rawStreamText = '';
      workingTagOpen = false;
    });

    // Loop complete (auto-save, update footer, hide spinner)
    this.agent.onLoopComplete(() => {
      this.isRunning = false;
      this.triggerAutoSave();
      this.updateFooterContextUsage();
      this.app?.transcript.closeActiveToolGroups();
      this.app?.hideStatusSpinner();
      this.app?.focusEditor();
      void this.activity.recordAwaitingInput();
      // One completed user turn: advance the title cadence (regenerates every
      // N turns, idle here so it never competes with the main loop).
      this.titleManager?.onUserTurnComplete();
      // If the MCP config changed during the turn, apply it now. Doing this
      // here (vs mid-turn) avoids invalidating the tool snapshot that
      // pi-agent-core captured at prompt() entry.
      if (this.mcpReloadPending) {
        void this.runQueuedMcpReload();
      }
    });

    // Error handling with per-category display
    this.agent.onError((error: ClassifiedError) => {
      void this.activity.recordError(error, error.severity === 'fatal');
      switch (error.category) {
        case 'rate_limit':
          this.app!.transcript.addNotification(
            'Rate Limited',
            'API rate limited. Cortex will auto-retry with exponential backoff.\nSend another message after retries are exhausted.',
          );
          break;
        case 'authentication':
          this.app!.transcript.addNotification(
            'Authentication Error',
            `${error.originalMessage ?? 'Credentials expired or invalid.'}\nRun /login to reconnect.`,
          );
          break;
        case 'network':
          this.app!.transcript.addNotification(
            'Connection Error',
            `${error.originalMessage ?? 'Could not reach the API.'}\nCheck your network connection. Send another message to retry.`,
          );
          break;
        case 'context_overflow':
          this.app!.transcript.addNotification(
            'Context Limit Reached',
            'Context window is full and compaction has been exhausted.\nUse /context-window to increase the limit or /clear to start fresh.',
          );
          break;
        case 'cancelled':
          // User-initiated abort; no notification needed
          break;
        default:
          this.app!.transcript.addNotification(
            'Error',
            error.originalMessage ?? String(error),
          );
      }
    });

    // Compaction notification
    this.agent.onPostCompaction((result: CompactionResult) => {
      const beforeK = (result.tokensBefore / 1000).toFixed(1);
      const afterK = (result.tokensAfter / 1000).toFixed(1);
      this.app!.transcript.addNotification(
        'Context Compacted',
        `Reduced from ${beforeK}k to ${afterK}k tokens`,
      );
      this.updateFooterContextUsage();
    });

    // Compaction degraded (Layer 2 failed, Layer 3 used as fallback)
    this.agent.onCompactionDegraded((info) => {
      this.app!.transcript.addNotification(
        'Compaction Degraded',
        `Layer 2 summarization failed (${info.layer2Failures} attempts). Emergency truncation dropped ${info.turnsDropped} turns.`,
      );
    });

    // Compaction exhausted (all layers failed)
    this.agent.onCompactionExhausted((info) => {
      this.app!.transcript.addNotification(
        'Context Limit Reached',
        'All compaction layers have failed. Use /context-window to increase the limit or /clear to start fresh.',
      );
    });

    // Observational memory events (only fire when strategy is 'observational')
    this.agent.onObservation(() => {
      this.updateObservationalMemoryStatus();
    });
    this.agent.onReflection(() => {
      this.updateObservationalMemoryStatus();
    });

    // Sub-agent events: rendered as tool calls via the SubAgent renderer
    this.agent.onSubAgentSpawned((taskId, instructions, background) => {
      this.subAgentActivity.set(taskId, new Map());
      this.app!.transcript.startSubAgentCall(taskId, {
        instructions,
        background,
        modelId: this.agent!.getModel().modelId,
      });
    });

    this.agent.onSubAgentCompleted((taskId, result, status, usage) => {
      this.app!.transcript.completeSubAgentCall(taskId, result, status, usage);
      this.subAgentActivity.delete(taskId);
    });

    this.agent.onSubAgentFailed((taskId, error) => {
      this.app!.transcript.failSubAgentCall(taskId, error);
      this.subAgentActivity.delete(taskId);
    });

    // Background sub-agent result delivery: Cortex restarts the agentic loop
    // automatically; update TUI state so the user sees activity.
    this.agent.onBackgroundResultDelivery(() => {
      this.isRunning = true;
      this.app!.showStatusSpinner('Processing background results...');
      void this.activity.recordWorking();
    });

    // Update tokens and auto-save on turn_end (fires after each LLM turn,
    // including mid-loop turns between tool calls)
    bridge.on('turn_end', () => {
      this.updateFooterContextUsage();
      this.updateObservationalMemoryStatus();
      this.triggerAutoSave();
    });
  }

  private wireActivityEvents(bridge: ReturnType<CortexAgent['getEventBridge']>): void {
    bridge.on('turn_start', () => {
      this.activity.recordTurnStarted();
    });

    bridge.on('turn_end', () => {
      this.activity.recordTurnEnded();
    });

    bridge.on('tool_call_start', (event: CortexEvent) => {
      const p = event.payload as ToolCallStartPayload | undefined;
      const data = event.data as Record<string, unknown> | undefined;
      const toolName = p?.toolName ?? String(data?.['toolName'] ?? 'unknown');
      const toolCallId = p?.toolCallId ?? String(data?.['toolCallId'] ?? data?.['id'] ?? Math.random());
      const args = p?.args ?? (data?.['args'] as Record<string, unknown> | undefined) ?? {};
      this.activity.recordToolStarted({
        toolCallId,
        toolName,
        args,
        ...(event.childTaskId ? { childTaskId: event.childTaskId } : {}),
      });
    });

    bridge.on('tool_call_end', (event: CortexEvent) => {
      const p = event.payload as ToolCallEndPayload | undefined;
      const data = event.data as Record<string, unknown> | undefined;
      const toolName = p?.toolName ?? String(data?.['toolName'] ?? 'unknown');
      const toolCallId = p?.toolCallId ?? String(data?.['toolCallId'] ?? data?.['id'] ?? '');
      this.activity.recordToolEnded({
        toolCallId,
        toolName,
        durationMs: p?.durationMs ?? Number(data?.['durationMs'] ?? data?.['duration'] ?? 0),
        isError: p?.isError ?? Boolean(data?.['isError']),
        ...(p?.error ? { error: p.error } : {}),
        ...(event.childTaskId ? { childTaskId: event.childTaskId } : {}),
      });
    });
  }

  /**
   * Permission resolution: rules check, then serialized inline TUI prompt.
   *
   * Concurrent permission requests (from parallel tool execution) are
   * serialized so only one prompt is active at a time. After waiting,
   * rules are re-checked because a previous prompt may have created a
   * rule that now covers this request.
   */
  private async resolvePermission(
    toolName: string,
    toolArgs: unknown,
  ): Promise<boolean | CortexToolPermissionResult> {
    // Catastrophic commands (e.g. rm -rf /) are blocked unconditionally, ahead
    // of yolo mode, the read-only bypass, and any allow rule. There is no
    // override: such a command should never run, however it is reached.
    if (toolName === 'Bash') {
      const danger = findDangerousCommand(String((toolArgs as Record<string, unknown>)['command'] ?? ''));
      if (danger) {
        return { decision: 'block', reason: `Blocked catastrophic command (${danger}); this cannot be overridden.` };
      }
    }

    if (this.yoloMode) return true;

    // Auto-allow read-only tools within the project directory
    if (await this.isReadOnlyInProject(toolName, toolArgs)) return true;

    // Fast path: check rules before acquiring the lock
    const rule = this.rules.matchRule(toolName, toolArgs);
    if (rule === 'allow') return true;
    if (rule === 'deny') return { decision: 'block', reason: 'Denied by permission rule' };

    if (!this.app) return { decision: 'block', reason: 'TUI not initialized' };

    // Serialize: wait for any active permission prompt to finish
    while (this.permissionLockPromise) {
      await this.permissionLockPromise;
    }

    // Re-check rules: a previous prompt may have added an "always allow" rule
    const ruleAfterWait = this.rules.matchRule(toolName, toolArgs);
    if (ruleAfterWait === 'allow') return true;
    if (ruleAfterWait === 'deny') return { decision: 'block', reason: 'Denied by permission rule' };

    // Acquire lock and show the prompt
    this.permissionLockPromise = new Promise<void>((resolve) => {
      this.permissionLockRelease = resolve;
    });

    const permission = this.activity.recordPermissionRequested(toolName, toolArgs);
    await permission.written;
    let permissionResolution: PermissionResolution = 'denied';

    try {
      const result = await this.app.showPermissionPrompt(toolName, toolArgs);
      permissionResolution = result.decision === 'allow' ? 'allowed' : 'denied';

      if (result.scope === 'project-edits') {
        // Project-wide edit/write permission: add rules for both tools
        const cwdPattern = `${this.cwd}/*`;
        await this.rules.addRule('project', 'allow', 'Edit', cwdPattern);
        await this.rules.addRule('project', 'allow', 'Write', cwdPattern);
      } else if (result.pattern && result.scope) {
        await this.rules.addRule(result.scope, result.decision, toolName, result.pattern);
      }

      return result.decision === 'allow' ? true : { decision: 'block' };
    } catch (error) {
      permissionResolution = 'error';
      void this.activity.recordError(error instanceof Error ? error : String(error));
      throw error;
    } finally {
      await this.activity.recordPermissionResolved(permission.id, toolName, permissionResolution);
      const release = this.permissionLockRelease;
      this.permissionLockPromise = null;
      this.permissionLockRelease = null;
      release?.();
    }
  }

  /** Check if a tool call is a read-only operation within the project directory. */
  private async isReadOnlyInProject(toolName: string, toolArgs: unknown): Promise<boolean> {
    const args = toolArgs as Record<string, unknown>;
    switch (toolName) {
      case 'Read': {
        const filePath = String(args['file_path'] ?? '');
        return this.isWithinCwd(filePath);
      }
      case 'Glob':
      case 'Grep': {
        const searchPath = String(args['path'] ?? this.cwd);
        return this.isWithinCwd(searchPath);
      }
      default:
        return false;
    }
  }

  /** Check if a path resolves within the current working directory. */
  private async isWithinCwd(targetPath: string): Promise<boolean> {
    return isPathWithinRealCwd(targetPath, this.cwd);
  }

  /** Credential resolution: stored API key or OAuth refresh. */
  private async getApiKey(provider: string): Promise<string> {
    // Pi-agent-core passes the model's provider field (e.g., "custom" for
    // custom endpoints). Credentials may be stored under the session's
    // provider name (e.g., "ollama"), so fall back to that if needed.
    let entry = await this.credentialStore.getProvider(provider);
    if (!entry && provider !== this.provider) {
      entry = await this.credentialStore.getProvider(this.provider);
    }
    if (!entry) {
      // Keyless providers (e.g., Ollama) may not have a credential store
      // entry at all. Return a placeholder so the OpenAI SDK doesn't throw.
      if (provider === 'custom' || this.provider === 'ollama') {
        return 'sk-no-key-required';
      }
      throw new Error(`No credentials for provider "${provider}". Run /login to connect.`);
    }

    // API key: return directly
    if (entry.method === 'api_key' && entry.apiKey) {
      return entry.apiKey;
    }

    // OAuth: resolve via ProviderManager (handles token refresh)
    if (entry.method === 'oauth' && entry.oauthCredentials) {
      const result = await this.providerManager.resolveOAuthApiKey(
        provider,
        entry.oauthCredentials,
      );
      // Persist refreshed credentials if they changed
      if (result.changed) {
        await this.credentialStore.setProvider(provider, {
          ...entry,
          oauthCredentials: result.credentials,
          oauthMeta: result.meta,
        });
      }
      return result.apiKey;
    }

    // Custom: return stored API key, or a placeholder for keyless endpoints
    // (e.g., Ollama). The OpenAI SDK client requires a non-empty API key.
    if (entry.method === 'custom') {
      return entry.apiKey || 'sk-no-key-required';
    }

    throw new Error(`Unable to resolve API key for provider "${provider}"`);
  }

  /** Resume a previous session by loading and restoring its history. */
  async resume(sessionId: string): Promise<void> {
    const { loadSession: load, loadObservationalState } = await import('./persistence/sessions.js');
    const saved = await load(sessionId);
    if (!saved) {
      this.app?.transcript.addNotification('Resume Failed', `Session ${sessionId} not found.`);
      return;
    }

    if (!this.agent) return;

    this.agent.restoreConversationHistory(
      saved.history as Parameters<typeof this.agent.restoreConversationHistory>[0],
    );
    this.createdAt = saved.meta.createdAt;

    // Restore accumulated usage (cost, turns, tokens) from the saved session
    if (saved.meta.usage) {
      this.agent.restoreSessionUsage(saved.meta.usage);
    }

    // Restore observational memory state if the session used observational compaction
    if (this.compactionStrategy === 'observational') {
      const omState = await loadObservationalState(sessionId);
      if (omState) {
        this.agent.restoreObservationalMemoryState(
          omState as Parameters<typeof this.agent.restoreObservationalMemoryState>[0],
        );
        this.updateObservationalMemoryStatus();
      }
    }

    // Replay message history into the transcript so the user sees the
    // previous conversation. Cortex already has the history in context; this
    // is purely visual rehydration.
    if (this.app) {
      const { replayHistoryToTranscript } = await import('./utils/replay-history.js');
      this.app.transcript.addNotification(
        'Session Resumed',
        `Replaying ${saved.history.length} messages from previous session.`,
      );
      replayHistoryToTranscript(saved.history, this.app.transcript);
    }
    this.updateFooterContextUsage();
  }

  /** Abort the current agent loop without destroying. */
  async abort(): Promise<void> {
    this.freezeDiagnostics.recordAbortRequested('session.abort');
    if (this.agent && this.isRunning) {
      await this.agent.abort();
      void this.activity.recordError({
        category: 'cancelled',
        severity: 'recoverable',
        originalMessage: 'Agent loop cancelled by user',
      });
    }
    this.isRunning = false;
    this.freezeDiagnostics.setSessionRunning(false);
    this.app?.hideStatusSpinner();
    this.app?.focusEditor();
    void this.activity.recordAwaitingInput();
  }

  /** Graceful shutdown: save, destroy agent, stop TUI. */
  async shutdown(): Promise<void> {
    // Tear down MCP config watcher first so a late filesystem event cannot
    // schedule work against the agent we're about to destroy.
    if (this.mcpWatcher) {
      try {
        await this.mcpWatcher.stop();
      } catch {
        // ignore
      }
      this.mcpWatcher = null;
    }

    // Flush pending saves
    await this.saver.flush();

    // Immediate final save
    if (this.agent) {
      try {
        const history = this.agent.getConversationHistory();
        const meta = this.buildSessionMeta();
        const { saveSession, saveObservationalState } = await import('./persistence/sessions.js');
        const saves: Promise<void>[] = [saveSession(this.sessionId, history, meta)];
        if (this.compactionStrategy === 'observational') {
          const omState = this.agent.getObservationalMemoryState();
          if (omState) {
            saves.push(saveObservationalState(this.sessionId, omState));
          }
        }
        await Promise.all(saves);
      } catch {
        // Best-effort save during shutdown
      }

      await this.agent.destroy();
      this.agent = null;
    }

    // Reset the terminal title before tearing down the TUI.
    this.titleManager?.dispose();

    await this.activity.recordDone({ code: 0, signal: null, reason: 'normal_shutdown' });
    await this.activity.flush();
    this.app?.stop();
    process.exit(0);
  }

  async recordFatalActivityError(error: unknown): Promise<void> {
    await this.activity.recordError(error instanceof Error ? error : String(error), true);
    await this.activity.flush();
  }

  async recordSignalActivityError(signal: NodeJS.Signals): Promise<void> {
    await this.activity.recordError({
      category: 'cancelled',
      severity: 'recoverable',
      originalMessage: `Process terminated by ${signal}`,
    }, true);
    await this.activity.flush();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async updateEphemeralContext(): Promise<void> {
    if (!this.agent) return;

    const branch = await this.getGitBranch();
    const currentContextTokens = this.getDisplayedCurrentContextTokens();
    const lines = [
      `Current date: ${new Date().toISOString().split('T')[0]}`,
      `Current working directory: ${this.cwd}`,
      branch ? `Git branch: ${branch}` : '',
      `Model: ${this.provider}/${this.modelId}`,
      this.yoloMode ? 'YOLO mode is active: all tools auto-approved' : '',
      currentContextTokens > 0
        ? `Current context usage: ${(currentContextTokens / 1000).toFixed(1)}k / ${(this.agent.effectiveContextWindow / 1000).toFixed(0)}k`
        : '',
    ].filter(Boolean);

    this.agent.getContextManager().setEphemeral(
      `<environment>\n${lines.join('\n')}\n</environment>`,
    );
  }

  private buildDiagnosticsConfig(): import('@animus-labs/cortex').CortexDiagnosticsConfig | undefined {
    const freeze = this.config.diagnostics?.freeze;
    if (!freeze?.enabled) return undefined;
    const watchdog: import('@animus-labs/cortex').PromptWatchdogDiagnosticsConfig = { enabled: true };
    if (freeze.promptWatchdogIntervalMs !== undefined) watchdog.heartbeatIntervalMs = freeze.promptWatchdogIntervalMs;
    if (freeze.abortWaitWarningMs !== undefined) watchdog.abortWaitWarningMs = freeze.abortWaitWarningMs;
    return { promptWatchdog: watchdog };
  }

  private updateFooterContextUsage(): void {
    if (!this.agent || !this.app) return;
    this.app.updateStatus({
      contextTokenCount: this.getDisplayedCurrentContextTokens(),
      contextTokenLimit: this.agent.effectiveContextWindow,
    });
  }

  private updateObservationalMemoryStatus(): void {
    if (!this.agent || !this.app) return;
    if (this.compactionStrategy !== 'observational') return;
    const cm = this.agent.getCompactionManager();
    this.app.updateStatus({
      observationTokenCount: cm.getObservationTokenCount(),
      observerActive: cm.isObserverInFlight(),
      reflectorActive: cm.isReflectorInFlight(),
    });
  }

  private getDisplayedCurrentContextTokens(): number {
    if (!this.agent) return 0;
    return Math.max(
      this.agent.currentContextTokenCount,
      this.agent.estimateCurrentContextTokens(),
    );
  }

  private triggerAutoSave(): void {
    if (!this.agent) return;
    try {
      const history = this.agent.getConversationHistory();
      const meta = this.buildSessionMeta();
      // Bundle observational state into the same debounced write so the
      // persisted buffer watermark stays aligned with the saved history.
      const omState = this.compactionStrategy === 'observational'
        ? this.agent.getObservationalMemoryState() ?? undefined
        : undefined;
      this.saver.save(history, meta, omState);
    } catch {
      // Swallow auto-save errors silently
    }
  }

  private buildSessionMeta(): SessionMeta {
    const meta: SessionMeta = {
      id: this.sessionId,
      mode: this.mode.name,
      provider: this.provider,
      model: this.modelId,
      cwd: this.cwd,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      contextTokenCount: this.getDisplayedCurrentContextTokens(),
      compactionStrategy: this.compactionStrategy,
    };
    if (this.agent) {
      meta.usage = this.agent.getSessionUsage();
    }
    return meta;
  }

  private async getGitBranch(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
        cwd: this.cwd,
        timeout: 2000,
      });
      return stdout.trim();
    } catch {
      return '';
    }
  }

  /** Extract text delta from a pi-agent-core message_update event. */
  private extractTextDelta(data: Record<string, unknown> | undefined): string | null {
    if (!data) return null;

    // Pi-agent-core message_update events carry the streaming delta inside assistantMessageEvent
    const assistantEvent = data['assistantMessageEvent'] as Record<string, unknown> | undefined;
    if (assistantEvent && assistantEvent['type'] === 'text_delta') {
      const delta = assistantEvent['delta'];
      if (typeof delta === 'string') return delta;
    }

    // Fallback patterns for other provider shapes
    if (typeof data['text'] === 'string') return data['text'];
    if (typeof data['delta'] === 'string') return data['delta'];
    if (typeof data['content'] === 'string') return data['content'];
    const delta = data['delta'] as Record<string, unknown> | undefined;
    if (delta && typeof delta['text'] === 'string') return delta['text'];
    return null;
  }

  /**
   * Detect working tag close transitions and enqueue completed messages
   * for display at reading pace on the spinner line.
   */
  private updateWorkingTagDisplay(
    rawText: string,
    wasOpen: boolean,
    setOpen: (open: boolean) => void,
  ): void {
    const lastOpenIdx = rawText.lastIndexOf('<working>');
    const lastCloseIdx = rawText.lastIndexOf('</working>');

    if (lastOpenIdx > lastCloseIdx) {
      // Inside an unclosed working tag (streaming)
      setOpen(true);
    } else if (wasOpen && lastCloseIdx >= lastOpenIdx) {
      // Working tag just closed: extract content and enqueue for display
      const content = rawText.slice(lastOpenIdx + '<working>'.length, lastCloseIdx).trim();
      if (content) {
        this.app!.enqueueWorkingTagText(content);
      }
      setOpen(false);
    }
  }

  /** Extract readable text from a tool result (may be string, object, or content array). */
  private extractToolResultText(result: unknown): string {
    if (typeof result === 'string') return result;
    if (result === null || result === undefined) return '';

    // ToolContentDetails format: { content: [{ type: 'text', text: '...' }] }
    if (typeof result === 'object') {
      const obj = result as Record<string, unknown>;

      // Direct text field
      if (typeof obj['text'] === 'string') return obj['text'];

      // Content array
      const content = obj['content'];
      if (Array.isArray(content)) {
        return content
          .filter((c): c is { type: string; text: string } =>
            typeof c === 'object' && c !== null && 'text' in c && typeof (c as Record<string, unknown>)['text'] === 'string')
          .map(c => c.text)
          .join('\n');
      }

      // Try JSON stringification for unknown shapes, but truncate
      try {
        const json = JSON.stringify(result);
        return json.length > 500 ? json.slice(0, 500) + '...' : json;
      } catch {
        return '[result]';
      }
    }

    return String(result);
  }

  /** Create a short summary of tool args for display. */
  private summarizeToolArgs(toolName: string, args: unknown): string {
    const a = args as Record<string, unknown>;
    switch (toolName) {
      case 'Bash':
        return String(a['command'] ?? '').slice(0, 80);
      case 'Read':
        return String(a['file_path'] ?? a['path'] ?? '');
      case 'Write':
        return String(a['file_path'] ?? a['path'] ?? '');
      case 'Edit':
        return String(a['file_path'] ?? a['path'] ?? '');
      case 'Glob':
        return String(a['pattern'] ?? '');
      case 'Grep':
        return `${String(a['pattern'] ?? '')}`;
      case 'WebFetch':
        return String(a['url'] ?? '').slice(0, 80);
      case 'SubAgent': {
        const desc = String(a['description'] ?? a['instructions'] ?? '');
        return desc.slice(0, 60);
      }
      default:
        return JSON.stringify(args).slice(0, 60);
    }
  }

  private recordSubAgentToolStart(event: CortexEvent): void {
    if (!event.childTaskId || !this.app) return;

    const p = event.payload as import('@animus-labs/cortex').ToolCallStartPayload | undefined;
    const data = event.data as Record<string, unknown> | undefined;
    const toolName = p?.toolName ?? String(data?.['toolName'] ?? 'unknown');
    const toolCallId = p?.toolCallId ?? String(data?.['toolCallId'] ?? Math.random());
    const args = p?.args ?? (data?.['args'] as Record<string, unknown> | undefined) ?? {};
    const summary = this.summarizeToolArgs(toolName, args);

    this.updateSubAgentActivity(event.childTaskId, toolCallId, {
      name: toolName,
      status: 'pending',
      summary,
    });
  }

  private recordSubAgentToolEnd(event: CortexEvent): void {
    if (!event.childTaskId || !this.app) return;

    const p = event.payload as import('@animus-labs/cortex').ToolCallEndPayload | undefined;
    const data = event.data as Record<string, unknown> | undefined;
    const toolName = p?.toolName ?? String(data?.['toolName'] ?? 'unknown');
    const toolCallId = p?.toolCallId ?? String(data?.['toolCallId'] ?? Math.random());
    const existing = this.subAgentActivity.get(event.childTaskId)?.get(toolCallId);

    const isError = p?.isError ?? Boolean(data?.['isError']);

    this.updateSubAgentActivity(event.childTaskId, toolCallId, {
      name: existing?.name ?? toolName,
      status: isError ? 'error' : 'success',
      ...(existing?.summary ? { summary: existing.summary } : {}),
    });
  }

  private updateSubAgentActivity(
    taskId: string,
    toolCallId: string,
    activity: { name: string; status: string; summary?: string },
  ): void {
    let tools = this.subAgentActivity.get(taskId);
    if (!tools) {
      tools = new Map();
      this.subAgentActivity.set(taskId, tools);
    }

    tools.set(toolCallId, activity);
    this.app?.transcript.updateToolCall(taskId, {
      toolCalls: [...tools.values()],
    });
  }

  // -------------------------------------------------------------------------
  // Effort reconciliation
  // -------------------------------------------------------------------------

  /**
   * Reconcile the preferred effort with the current model's capabilities.
   * Sets the effective effort on the agent and returns whether it was clamped.
   */
  private async reconcileEffort(): Promise<{
    effective: ThinkingLevel;
    clamped: boolean;
    reason?: string;
  }> {
    if (!this.agent) {
      return { effective: this.preferredEffort, clamped: false };
    }

    const caps = await this.agent.getModelThinkingCapabilities();

    let effective = this.preferredEffort;
    let clamped = false;
    let reason: string | undefined;

    if (!caps.supportedLevels.includes(this.preferredEffort)) {
      effective = await this.agent.clampThinkingLevel(this.preferredEffort);
      clamped = effective !== this.preferredEffort;
      const preferredLabel = formatEffortLabel(this.preferredEffort);
      const effectiveLabel = formatEffortLabel(effective);
      reason = caps.supportsThinking
        ? `${this.modelId} does not support ${preferredLabel} effort. Using ${effectiveLabel}.`
        : `${this.modelId} does not support thinking. Using ${effectiveLabel}.`;
    }

    this.effectiveEffort = effective;
    this.agent.setThinkingLevel(effective);
    const result: { effective: ThinkingLevel; clamped: boolean; reason?: string } = { effective, clamped };
    if (reason) result.reason = reason;
    return result;
  }

  // -------------------------------------------------------------------------
  // Public accessors for command handlers
  // -------------------------------------------------------------------------

  getAgent(): CortexAgent | null { return this.agent; }
  getApp(): App | null { return this.app; }
  getYoloMode(): boolean { return this.yoloMode; }
  getCompactionStrategy(): 'observational' | 'classic' { return this.compactionStrategy; }
  setYoloMode(enabled: boolean): void {
    this.yoloMode = enabled;
    this.app?.updateStatus({ yoloMode: enabled });
  }
  getPreferredEffort(): ThinkingLevel { return this.preferredEffort; }
  getEffectiveEffort(): ThinkingLevel { return this.effectiveEffort; }

  /**
   * Set the user's preferred effort level.
   * Reconciles with current model capabilities and applies the effective level.
   */
  async setPreferredEffort(level: ThinkingLevel): Promise<void> {
    this.preferredEffort = level;
    const { effective, clamped, reason } = await this.reconcileEffort();
    this.app?.updateStatus({ effortLevel: effective });
    if (clamped && reason) {
      this.app?.transcript.addNotification('Effort', reason);
    }
    // Persist across sessions
    await this.credentialStore.setDefaultEffort(level);
  }

  getSessionId(): string { return this.sessionId; }
  /** Reset the terminal title on a fresh-start signal (e.g. /clear). */
  resetTitle(): void { this.titleManager?.reset(); }
  getRules(): PermissionRuleManager { return this.rules; }
  getProviderManager(): ProviderManager { return this.providerManager; }
  getCredentialStore(): CredentialStore { return this.credentialStore; }
  getProvider(): string { return this.provider; }
  getModelId(): string { return this.modelId; }
  getCwd(): string { return this.cwd; }

  /** List available models for the current provider. */
  async listModels(): Promise<Array<{ id: string; name: string; contextWindow: number }>> {
    log.info('listModels called', { provider: this.provider });
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('listModels timed out after 10s')), 10_000),
      );
      const models = await Promise.race([
        this.providerManager.listModels(this.provider),
        timeoutPromise,
      ]);
      log.info('listModels result', { count: models.length });
      return models.map(m => ({ id: m.id, name: m.name, contextWindow: m.contextWindow }));
    } catch (err) {
      log.error('listModels error', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  private async resolveProviderModel(provider: string, modelId: string): Promise<CortexModel> {
    const entry = await this.credentialStore.getProvider(provider);
    if (entry?.method === 'custom' || provider === 'ollama') {
      const baseUrl = entry?.baseUrl ?? 'http://localhost:11434/v1';
      const contextWindow = provider === 'ollama'
        ? await getOllamaContextWindow(getOllamaHost(entry?.baseUrl), modelId) ?? undefined
        : undefined;
      return this.providerManager.createCustomModel({ baseUrl, modelId, contextWindow });
    }
    return this.providerManager.resolveModel(provider, modelId);
  }

  private async applyUtilityModel(modelId: string, persist: boolean): Promise<void> {
    const utilityModel = await this.resolveProviderModel(this.provider, modelId);
    this.agent!.setUtilityModel(utilityModel);
    if (persist) {
      await this.credentialStore.setDefaultUtilityModel(this.provider, modelId);
    }
  }

  async setUtilityModel(modelId: string): Promise<void> {
    await this.applyUtilityModel(modelId, true);
  }

  async resetUtilityModel(): Promise<void> {
    this.agent!.resetUtilityModel();
    await this.credentialStore.setDefaultUtilityModel(this.provider, null);
  }

  private async applyStoredUtilityModelForProvider(provider: string): Promise<void> {
    const utilityModelId = this.config.defaultUtilityModel
      ?? await this.credentialStore.getDefaultUtilityModel(provider);
    if (!utilityModelId) {
      this.agent!.resetUtilityModel();
      return;
    }

    try {
      await this.applyUtilityModel(utilityModelId, false);
    } catch (err) {
      this.agent!.resetUtilityModel();
      log.warn('Failed to apply stored utility model', {
        provider,
        model: utilityModelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Switch the primary model. Returns the new CortexModel or throws. */
  async switchModel(modelId: string): Promise<void> {
    let newModel;
    const entry = await this.credentialStore.getProvider(this.provider);
    if (entry?.method === 'custom' || this.provider === 'ollama') {
      const baseUrl = entry?.baseUrl ?? 'http://localhost:11434/v1';
      const contextWindow = this.provider === 'ollama'
        ? await getOllamaContextWindow(getOllamaHost(entry?.baseUrl), modelId) ?? undefined
        : undefined;
      newModel = await this.providerManager.createCustomModel({ baseUrl, modelId, contextWindow });
    } else {
      newModel = await this.providerManager.resolveModel(this.provider, modelId);
    }
    this.agent!.setModel(newModel);
    this.modelId = modelId;
    // Reconcile effort with new model's capabilities
    const { clamped, reason, effective } = await this.reconcileEffort();
    this.app?.updateStatus({ model: modelId, effortLevel: effective, contextTokenLimit: this.agent!.effectiveContextWindow });
    if (clamped && reason) {
      this.app?.transcript.addNotification('Effort', reason);
    }
    await this.credentialStore.setDefaults(this.provider, modelId);
  }

  /** Switch to a different provider and model. Used by /login after adding a new provider. */
  async switchProvider(newProvider: string, newModelId: string): Promise<void> {
    log.info('Switching provider', { from: this.provider, to: newProvider, model: newModelId });

    let newModel;
    const entry = await this.credentialStore.getProvider(newProvider);
    if (entry?.method === 'custom' || newProvider === 'ollama') {
      const baseUrl = entry?.baseUrl ?? 'http://localhost:11434/v1';
      const contextWindow = newProvider === 'ollama'
        ? await getOllamaContextWindow(getOllamaHost(entry?.baseUrl), newModelId) ?? undefined
        : undefined;
      newModel = await this.providerManager.createCustomModel({ baseUrl, modelId: newModelId, contextWindow });
    } else {
      newModel = await this.providerManager.resolveModel(newProvider, newModelId);
    }

    this.agent!.setModel(newModel);
    this.provider = newProvider;
    this.modelId = newModelId;
    await this.applyStoredUtilityModelForProvider(newProvider);
    // Reconcile effort with new model's capabilities
    const { clamped, reason, effective } = await this.reconcileEffort();
    this.app?.updateStatus({ provider: newProvider, model: newModelId, effortLevel: effective, contextTokenLimit: this.agent!.effectiveContextWindow });
    if (clamped && reason) {
      this.app?.transcript.addNotification('Effort', reason);
    }
    await this.credentialStore.setDefaults(newProvider, newModelId);
  }
}
