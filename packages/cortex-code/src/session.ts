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
  type RetryScheduledInfo,
  type RetrySucceededInfo,
  type RetryExhaustedInfo,
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
import { CredentialStore, type CredentialEntry } from './config/credentials.js';
import { singleFlight } from './utils/single-flight.js';
import { resolveStoredOAuthApiKey } from './utils/oauth-credentials.js';
import { PermissionRuleManager } from './permissions/rules.js';
import { preflightPermission, type PreflightDeps } from './permissions/preflight.js';
import { isPathWithinRealCwd } from './permissions/path-containment.js';
import { discoverProjectContext } from './discovery/context.js';
import { discoverSkills, isProjectSkill, computeProjectSkillsSignature } from './discovery/skills.js';
import { discoverMcpServers } from './discovery/mcp.js';
import { checkProjectMcpTrust, trustProjectMcpConfig } from './discovery/mcp-trust.js';
import { checkProjectTrust, recordProjectTrust } from './discovery/project-trust.js';
import {
  generateSessionId,
  createDebouncedSaver,
  createToolResultPersistor,
  type SessionMeta,
} from './persistence/sessions.js';
import { TranscriptWriter, extractToolResultText } from './persistence/transcript-writer.js';
import { getCommand, registerBuiltinCommands } from './commands/index.js';
import { dismissVersion, type UpdateInfo } from './updates/checker.js';
import { runNpmUpgrade } from './updates/upgrade.js';
import type { Mode } from './modes/types.js';
import { AVAILABLE_MODES } from './modes/index.js';
import path from 'node:path';
import { homedir } from 'node:os';
import { SandboxRuntimeProvider, buildDefaultPolicy } from '@animus-labs/cortex-sandbox';
import type {
  SandboxStatus,
  SandboxPolicy,
  SandboxRung,
  NetworkAccessRequest,
  NetworkAccessDecision,
} from '@animus-labs/cortex';
import { SandboxSettingsStore } from './config/sandbox-settings.js';
import { detectContainer } from './utils/container.js';
import {
  NetworkAccessController,
  NetworkGrantStore,
  type NetworkPromptChoice,
} from './permissions/network.js';
import { workspaceSettingsPath } from './permissions/rules.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from './logger.js';
import { getOllamaHost, getOllamaContextWindow } from './providers/ollama.js';
import { FreezeDiagnostics } from './diagnostics/freeze.js';
import { buildToolDisplayArgs, summarizeToolStartArgs } from './tui/tool-display-args.js';
import { FileSessionActivityReporter, watchDecisionFile, type PermissionResolution } from './activity/session-activity.js';
import { McpConfigWatcher, type McpConfigChangeReason } from './mcp/mcp-watcher.js';
import { reconcileMcpServers, type McpReconcileResult } from './mcp/reconcile.js';
import { loadHookHandlers, readProjectHooksContent, hasProjectHooks } from './hooks/loader.js';
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
  private sandboxProvider: SandboxRuntimeProvider | undefined;
  private sandboxStatus: SandboxStatus | undefined;
  /**
   * The policy handed to the provider. Kept even when OS enforcement is
   * degraded or failed: it still projects into in-process egress (WebFetch),
   * so the rung's network intent holds policy-only where the OS cannot.
   */
  private sandboxPolicy: SandboxPolicy | undefined;
  /**
   * The active trust rung. 'off' means no containment (user choice, config
   * kill switch, or before initSandbox has resolved it). Changed only by a
   * human through /sandbox; never exposed to the model.
   */
  private sandboxRung: SandboxRung = 'off';
  /** Per-workspace remembered rung and one-time notice flags. */
  private readonly sandboxSettings: SandboxSettingsStore;
  private readonly networkGrants: NetworkGrantStore;
  private readonly networkAccess: NetworkAccessController;
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
  /**
   * In-flight OAuth resolve/refresh promises, keyed by provider. Providers like
   * Anthropic rotate the refresh token on every use and invalidate the prior
   * one, so two concurrent refreshes with the same stored token make one win
   * and the rest fail with invalid_grant ("Failed to refresh OAuth token").
   * Deduping concurrent callers onto one read-refresh-persist rotates the token
   * exactly once and hands everyone the same fresh key.
   */
  private readonly oauthResolveInFlight = new Map<string, Promise<string>>();
  /**
   * True once the onError handler has surfaced the current turn's failure. The
   * agent framework both emits an error (via onError) and re-throws it out of
   * prompt(); without this guard the prompt() catch would render the same
   * failure a second time as a generic "Error". Reset at the start of each turn.
   */
  private lastTurnErrorHandled = false;
  /** Live background-retry state, while a transient failure is being retried. */
  private retryState: { info: RetryScheduledInfo } | null = null;
  /** 1s ticker that refreshes the retry countdown line. */
  private retryTicker: ReturnType<typeof setInterval> | null = null;
  private createdAt: number;
  private permissionLockPromise: Promise<void> | null = null;
  private permissionLockRelease: (() => void) | null = null;
  private subAgentActivity = new Map<string, Map<string, { name: string; status: string; summary?: string }>>();
  private readonly freezeDiagnostics: FreezeDiagnostics;
  private readonly activity: FileSessionActivityReporter;
  private readonly transcriptWriter: TranscriptWriter;
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
    const settingsPath = workspaceSettingsPath(options.cwd);
    this.networkGrants = new NetworkGrantStore(settingsPath);
    this.sandboxSettings = new SandboxSettingsStore(settingsPath);
    this.networkAccess = new NetworkAccessController({
      getPolicy: () => this.sandboxPolicy?.network,
      prompt: (req) => this.promptNetworkAccess(req),
      store: this.networkGrants,
    });
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
    // Durable append-only conversation log, separate from the lossy history.json
    // snapshot. Read by sibling apps to summarize where a session left off.
    this.transcriptWriter = new TranscriptWriter(this.sessionId, this.cwd, {
      cliVersion: PKG_VERSION,
      provider: this.provider,
      model: this.modelId,
      resume: this.isResume,
      onWriteError: (error) => {
        log.warn('Session transcript write failed', {
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

    // Load persisted permission rules and network domain grants
    await this.rules.loadPersistedRules();
    await this.networkGrants.load();

    // Create TUI
    const callbacks: AppCallbacks = {
      onSubmit: (text) => this.handleInput(text),
      onAbort: () => this.abort(),
      onExit: () => this.shutdown(),
    };
    this.app = new App(callbacks, this.cwd, this.freezeDiagnostics);

    // Initialize the OS sandbox (on by default at the Workspace rung) before the
    // agent so its Bash tool spawns are contained. Warn-and-continue if the host
    // cannot enforce; status is surfaced and the agent still runs.
    this.sandboxProvider = await this.initSandbox();

    // Create agent (built-in tools are auto-registered by Cortex)
    this.agent = await CortexAgent.create({
      model: this.model,
      utilityModel: 'default',
      workingDirectory: this.cwd,
      initialBasePrompt: this.mode.systemPrompt,
      slots: this.mode.contextSlots,
      resolvePermission: (toolName, toolArgs) => this.resolvePermission(toolName, toolArgs),
      // WebFetch's egress gate: the same decision function the sandbox egress
      // proxy consults for shell commands, so one grant covers both paths.
      resolveNetworkAccess: (req) => this.resolveNetworkAccess(req),
      isAutoApprove: () => this.yoloMode,
      ...(this.sandboxProvider ? { sandbox: this.sandboxProvider } : {}),
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
    // startup. Project hooks pass through the trust gate first: an untrusted
    // project's hooks are NOT loaded, so a cloned repo cannot run its
    // hooks.json on the first turn.
    try {
      this.hookHandlers = await this.loadHooksWithTrust();
    } catch (err) {
      log.warn('Hook loader failed; running without hooks', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.hookHandlers = null;
    }

    // Register skills. Global skills (~/.cortex/skills) are user-authored and
    // always registered. Project skills (.cortex/skills) run shell on load, so
    // they pass through the trust gate first: an untrusted project's skills are
    // NOT registered and are therefore not model-invocable.
    await this.registerSkillsWithTrust();
    // Refresh autocomplete after skills are registered
    this.app.refreshCommands(this.cwd);

    // Apply initial thinking level
    const { effective: initialEffort } = await this.reconcileEffort();

    // Show banner. The split-flap settle plays only for a fresh session; a
    // resumed session opens straight to the settled logo.
    const branch = await this.getGitBranch();
    // Settle the transcript header now that the git branch is known, before any
    // turn events can fire. session_meta is the first line of a fresh transcript.
    await this.transcriptWriter.initialize({ gitBranch: branch });
    const project = this.cwd.split('/').pop() ?? '';
    this.app.transcript.addBanner(PKG_VERSION, project, branch, this.updateInfo ?? undefined, {
      animate: !this.isResume,
    });

    // Update footer
    this.app.updateStatus({
      mode: this.mode.name,
      modeCount: AVAILABLE_MODES.length,
      provider: this.provider,
      model: this.modelId,
      contextTokenCount: this.getDisplayedCurrentContextTokens(),
      contextTokenLimit: this.agent.effectiveContextWindow,
      gitBranch: branch,
      yoloMode: this.yoloMode,
      effortLevel: initialEffort,
      observationalMode: this.compactionStrategy === 'observational',
      ...this.sandboxIndicatorState(),
    });

    // Recommend (never apply) /sandbox off when already inside a container.
    void this.surfaceContainerRecommendation();

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
      await this.transcriptWriter.flush();
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
            await cmd.handler(this, parts.slice(1).filter((p) => p.length > 0));
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
      this.transcriptWriter.addUserMessage(text);
      this.titleManager?.recordUserPrompt(text);
      this.agent.steer(text);
      return;
    }

    log.info('User prompt', { text: text.slice(0, 100) });

    // A fresh turn supersedes any terminal "gave up, send a message" retry line.
    this.clearRetry();

    // Add user message to transcript
    this.app!.transcript.addUserMessage(text);
    this.transcriptWriter.addUserMessage(text);
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

    this.lastTurnErrorHandled = false;
    try {
      await this.agent.prompt(promptForAgent);
    } catch (err) {
      log.error('Prompt error', { error: err instanceof Error ? err.message : String(err) });
      void this.activity.recordError(err instanceof Error ? err : String(err));
      // Classified errors are already surfaced by the onError handler, which
      // both emits and lets the error re-throw here. Only handle throws it did
      // NOT show: stream interruptions and truly-unexpected errors. Shutdown
      // (destroying/destroyed) rejects a pending prompt with a lifecycle
      // error that must not surface as an error toast.
      const agentState = this.agent?.state;
      if (
        agentState !== 'destroyed' &&
        agentState !== 'destroying' &&
        !this.lastTurnErrorHandled
      ) {
        const message = err instanceof Error ? err.message : String(err);
        // Check if this is a stream interruption (partial response already displayed)
        if (message.includes('stream') || message.includes('aborted') || message.includes('interrupted')) {
          this.app!.transcript.appendAssistantChunk('\n\n[response interrupted]');
          this.app!.transcript.finalizeAssistantMessage();
        } else {
          this.app!.transcript.addNotification('Error', message, { severity: 'error' });
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
          // Record the EXACT config we trust-checked and showed the user, not a
          // fresh read, so a file swapped between prompt and click is not trusted.
          await trustProjectMcpConfig(this.cwd, trust.configContent);
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
   * Load lifecycle hooks with the project-trust gate applied. Global hooks
   * (~/.cortex/hooks.json) are user-authored and always load. Project hooks
   * (.cortex/hooks.json) run subprocesses, so if the project's hooks are new or
   * changed and the user has not trusted them, we prompt before loading. On
   * decline, only global hooks load and the project's hooks never run.
   */
  private async loadHooksWithTrust(): Promise<Record<HookEvent, HookHandler[]>> {
    const handlers = await loadHookHandlers(this.cwd);

    // Nothing project-local to gate: return as-is (global-only or empty).
    if (!hasProjectHooks(handlers)) return handlers;

    const content = await readProjectHooksContent(this.cwd);
    if (await checkProjectTrust(this.cwd, 'hooks', content)) return handlers;

    // Untrusted project hooks: prompt before loading them.
    const decision = await this.promptProjectContentTrust(
      'New Project Hooks',
      'This project defines lifecycle hooks in .cortex/hooks.json that run\n' +
        'commands on your machine. Trust and load them?',
    );
    if (decision === 'trust' && content !== null) {
      await recordProjectTrust(this.cwd, 'hooks', content);
      this.app!.transcript.addNotification('Hooks', 'Loaded project hooks.');
      return handlers;
    }

    this.app!.transcript.addNotification('Hooks', 'Skipped project hooks (untrusted).');
    // Reload global-only so declined project hooks are absent, not just inert.
    return loadHookHandlers(this.cwd, { includeProject: false });
  }

  /**
   * Register discovered skills with the project-trust gate applied. Global
   * skills always register. Project skills (.cortex/skills) can run shell on
   * load, so if they are new or changed and untrusted, we prompt before
   * registering them. On decline, project skills are not registered and so are
   * never model-invocable.
   */
  private async registerSkillsWithTrust(): Promise<void> {
    if (!this.agent) return;
    const registry = this.agent.getSkillRegistry();
    const skills = await discoverSkills(this.cwd);

    const globalSkills = skills.filter((s) => !isProjectSkill(s));
    const projectSkills = skills.filter(isProjectSkill);
    for (const skill of globalSkills) registry.addSkill(skill);

    if (projectSkills.length === 0) return;

    const signature = await computeProjectSkillsSignature(skills);
    if (await checkProjectTrust(this.cwd, 'skills', signature)) {
      for (const skill of projectSkills) registry.addSkill(skill);
      return;
    }

    const decision = await this.promptProjectContentTrust(
      'New Project Skills',
      `This project defines ${projectSkills.length} skill(s) in .cortex/skills that can\n` +
        'run shell commands when loaded. Trust and register them?',
    );
    if (decision === 'trust' && signature !== null) {
      await recordProjectTrust(this.cwd, 'skills', signature);
      for (const skill of projectSkills) registry.addSkill(skill);
      this.app!.transcript.addNotification('Skills', `Registered ${projectSkills.length} project skill(s).`);
      return;
    }

    this.app!.transcript.addNotification('Skills', 'Skipped project skills (untrusted).');
  }

  /**
   * Show a two-option trust overlay for project-local executable content
   * (hooks or skills), mirroring the MCP trust prompt. Returns 'skip' if the
   * user declines, cancels, or the TUI is unavailable.
   */
  private async promptProjectContentTrust(
    title: string,
    message: string,
  ): Promise<'trust' | 'skip'> {
    if (!this.app) return 'skip';
    return new Promise<'trust' | 'skip'>((resolve) => {
      const items: SelectItem[] = [
        { value: 'trust', label: 'Trust and load', description: 'Approve this project content' },
        { value: 'skip', label: 'Skip', description: 'Leave it inert for this project' },
      ];
      const list = new SelectList(items, 2, selectListTheme);
      const overlayBox = new OverlayBox(list, title);
      const handle = this.app!.tui.showOverlay(overlayBox, {
        anchor: 'center',
        width: '60%',
        maxHeight: 12,
      });
      this.app!.transcript.addNotification(title, message);
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

      // Text flowing again means a pending retry reconnected.
      this.noteProgressAfterRetry();

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

      // A tool starting means the agent is making progress again.
      this.noteProgressAfterRetry();

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

    // Turn complete (finalize assistant message). onTurnComplete fires once per
    // LLM turn with the final user-facing text already assembled (working tags
    // stripped), so it is the clean source for the durable transcript's
    // assistant_message record. We record here rather than on the raw `turn_end`
    // bridge event to avoid re-accumulating streamed response_chunks.
    this.agent.onTurnComplete((output: AgentTextOutput) => {
      this.app!.transcript.finalizeAssistantMessage(output.userFacing);
      this.transcriptWriter.addAssistantMessage(output.userFacing);
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
      // The framework emits here and then re-throws out of prompt(); mark the
      // failure handled so the prompt() catch does not render it a second time.
      this.lastTurnErrorHandled = true;
      // Record the failure in the durable transcript so a turn that errored
      // before completing is visible, cause chain included. Skip user aborts.
      if (error.category !== 'cancelled') {
        const transcriptMessage = error.causeDetail
          ? `${error.originalMessage ?? String(error)} (${error.causeDetail})`
          : (error.originalMessage ?? String(error));
        this.transcriptWriter.addError(transcriptMessage, error.category);
      }
      switch (error.category) {
        // Transient categories are managed by the background retry engine. When
        // onError fires for one of these, retries are over (exhausted or
        // disabled): collapse to a compact terminal line instead of a box.
        case 'network':
        case 'server_error':
        case 'rate_limit': {
          const attempts = this.retryState?.info.attempt ?? 0;
          const maxAttempts = this.retryState?.info.maxAttempts ?? 0;
          this.stopRetryTicker();
          this.app!.transcript.setRetryStatus({
            phase: 'failed',
            attempt: attempts,
            maxAttempts,
            ...(error.causeDetail ? { detail: error.causeDetail } : {}),
          });
          break;
        }
        case 'authentication':
          // The OAuth mechanics ("Failed to refresh token") are jargon and
          // already in the durable transcript; the user just needs the fix.
          this.clearRetry();
          this.app!.transcript.addNotification('Authentication expired', '', {
            severity: 'error',
            action: 'run /login to reconnect',
          });
          break;
        case 'context_overflow':
          this.clearRetry();
          this.app!.transcript.addNotification('Context limit reached', '', {
            severity: 'error',
            action: 'use /context-window or /clear',
          });
          break;
        case 'cancelled':
          // User-initiated abort; drop any pending retry line, no notification.
          this.clearRetry();
          break;
        default:
          this.clearRetry();
          this.app!.transcript.addNotification(
            error.originalMessage ?? String(error),
            error.causeDetail ?? '',
            { severity: 'error' },
          );
      }
    });

    // Background retry lifecycle: drive the compact, in-place status line.
    this.agent.onRetryScheduled((info: RetryScheduledInfo) => {
      this.startRetryCountdown(info);
    });
    this.agent.onRetrySucceeded((_info: RetrySucceededInfo) => {
      this.clearRetry();
    });
    this.agent.onRetryExhausted((_info: RetryExhaustedInfo) => {
      // The matching fatal onError fires right after and renders the terminal
      // 'failed' line; just stop the countdown here.
      this.stopRetryTicker();
    });

    // Compaction notification
    this.agent.onPostCompaction((result: CompactionResult) => {
      const beforeK = (result.tokensBefore / 1000).toFixed(1);
      const afterK = (result.tokensAfter / 1000).toFixed(1);
      // Mark in the durable transcript where context was summarized away. The
      // full pre-compaction turns remain earlier in this transcript.
      this.transcriptWriter.addCompaction({
        beforeTokens: result.tokensBefore,
        afterTokens: result.tokensAfter,
      });
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
      this.transcriptWriter.addSubAgent(taskId, 'spawned', { summary: instructions, background });
      this.app!.transcript.startSubAgentCall(taskId, {
        instructions,
        background,
        modelId: this.agent!.getModel().modelId,
      });
    });

    this.agent.onSubAgentCompleted((taskId, result, status, usage) => {
      this.transcriptWriter.addSubAgent(taskId, 'completed', { summary: result });
      this.app!.transcript.completeSubAgentCall(taskId, result, status, usage);
      this.subAgentActivity.delete(taskId);
    });

    this.agent.onSubAgentFailed((taskId, error) => {
      this.transcriptWriter.addSubAgent(taskId, 'failed', { error });
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
      this.transcriptWriter.addToolCall(toolCallId, toolName, args);
    });

    bridge.on('tool_call_end', (event: CortexEvent) => {
      const p = event.payload as ToolCallEndPayload | undefined;
      const data = event.data as Record<string, unknown> | undefined;
      const toolName = p?.toolName ?? String(data?.['toolName'] ?? 'unknown');
      const toolCallId = p?.toolCallId ?? String(data?.['toolCallId'] ?? data?.['id'] ?? '');
      const isError = p?.isError ?? Boolean(data?.['isError']);
      this.activity.recordToolEnded({
        toolCallId,
        toolName,
        durationMs: p?.durationMs ?? Number(data?.['durationMs'] ?? data?.['duration'] ?? 0),
        isError,
        ...(p?.error ? { error: p.error } : {}),
        ...(event.childTaskId ? { childTaskId: event.childTaskId } : {}),
      });
      const output = isError && p?.error
        ? p.error
        : extractToolResultText(p?.result ?? data?.['result']);
      this.transcriptWriter.addToolResult(toolCallId, isError, output);
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
  /**
   * Construct the OS sandbox provider for this session and initialize it at the
   * workspace's remembered rung (Workspace on first open). Returns undefined
   * only when the config kill switch (sandbox.enabled=false) is set.
   *
   * The provider is constructed even when the rung is 'off': the agent captures
   * this one reference at creation (and shares it with sub-agents), so a later
   * /sandbox <rung> can only take effect by re-initializing this same object.
   * Un-initialized, it passes spawns through unchanged. On a host that cannot
   * enforce, the provider still returns (status 'none') and we warn rather than
   * fail.
   */
  private async initSandbox(): Promise<SandboxRuntimeProvider | undefined> {
    if (this.config.sandbox?.enabled === false) {
      // Hard kill switch: no provider at all. /sandbox reports this state but
      // cannot re-enable; the user edits config to turn the feature back on.
      this.sandboxRung = 'off';
      log.info('Sandbox disabled by config (sandbox.enabled=false)');
      return undefined;
    }

    await this.sandboxSettings.load();
    this.sandboxRung = await this.resolveInitialRung();

    const provider = new SandboxRuntimeProvider({
      onDegraded: (degradations) => log.warn('Sandbox enforcement reduced', { degradations }),
      // Shell egress to a host outside the allowlist asks the same unified
      // decision function WebFetch uses, so one grant covers both paths.
      onNetworkRequest: (r) =>
        this.resolveNetworkAccess({
          host: r.host,
          port: r.port,
          via: 'shell',
        }).then((d) => d.decision === 'allow'),
    });

    if (this.sandboxRung === 'off') {
      log.info('Sandbox off for this workspace; shell commands run uncontained');
      return provider;
    }

    await this.activateSandboxRung(provider, this.sandboxRung);
    return provider;
  }

  /**
   * The rung this session starts at: the workspace's remembered rung when one
   * exists, otherwise the configured default (Workspace unless config says
   * otherwise), which is then remembered so the rung is a stable per-workspace
   * fact from the first open on (the folder-trust pattern).
   */
  private async resolveInitialRung(): Promise<SandboxRung> {
    const saved = this.sandboxSettings.getRung();
    if (saved) return saved;

    const rung = this.config.sandbox?.rung ?? 'workspace';
    try {
      await this.sandboxSettings.setRung(rung);
    } catch (err) {
      log.warn('Could not persist initial sandbox rung', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return rung;
  }

  /** The rung-to-policy projection, shared by startup and /sandbox changes. */
  private buildSandboxPolicy(rung: SandboxRung): SandboxPolicy {
    const cortexHome = path.join(homedir(), '.cortex');
    return buildDefaultPolicy(rung, {
      workspaceRoots: [this.cwd],
      // A sandboxed shell must not WRITE Cortex's own config, permission rules,
      // or the project's .cortex (which now carries the sandbox policy itself),
      // and must not READ Cortex's stored API keys / OAuth tokens.
      extraDenyWrite: [cortexHome, path.join(this.cwd, '.cortex')],
      extraDenyRead: [path.join(cortexHome, 'credentials.json')],
      ...(this.config.sandbox?.allowedDomains
        ? { extraAllowedDomains: this.config.sandbox.allowedDomains }
        : {}),
    });
  }

  /**
   * Build the policy for a contained rung and (re)initialize the provider with
   * it. The provider resets-then-reinitializes, so calling this on a live
   * provider applies the new policy. Never throws: enforcement failure degrades
   * to warn-and-continue, with the recorded policy still gating in-process
   * egress (WebFetch).
   */
  private async activateSandboxRung(
    provider: SandboxRuntimeProvider,
    rung: Exclude<SandboxRung, 'off'>,
  ): Promise<void> {
    const policy = this.buildSandboxPolicy(rung);
    // Record the policy before initialize: even if OS enforcement fails, the
    // policy still gates in-process egress (WebFetch) at the app level.
    this.sandboxPolicy = policy;
    try {
      const status = await provider.initialize(policy);
      this.sandboxStatus = status;
      if (status.backend === 'none') {
        log.warn('Sandbox not enforced; shell commands run uncontained', {
          platform: process.platform,
          reason: status.degradations.join('; '),
        });
      } else {
        log.info('Sandbox active', {
          rung,
          backend: status.backend,
          filesystem: status.filesystem,
          network: status.network,
        });
      }
    } catch (err) {
      // Never let sandbox setup crash the session: some provider preflight runs
      // before its own internal try. Warn and continue uncontained.
      log.warn('Sandbox initialization threw; shell commands run uncontained', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.sandboxStatus = undefined;
    }
  }

  /**
   * Change the trust rung for this session and remember it per-workspace.
   *
   * A HUMAN action only: the sole caller is the /sandbox slash command the user
   * types. It is never registered as a tool or otherwise reachable by the
   * model, matching the design rule that an agent cannot widen its own
   * containment.
   *
   * 'off' stands the provider down (dispose) so commands run uncontained and
   * drops the policy so in-process gating (WebFetch) opens up too. Moving from
   * off back to a contained rung re-initializes the same provider object with
   * a freshly built policy, which the agent's Bash tool already references.
   */
  async setSandboxRung(rung: SandboxRung): Promise<{ changed: boolean; reason?: string }> {
    if (this.config.sandbox?.enabled === false || !this.sandboxProvider) {
      return {
        changed: false,
        reason:
          'The sandbox is disabled by config (sandbox.enabled=false). Edit your config and restart to re-enable it.',
      };
    }
    if (rung === this.sandboxRung) {
      return { changed: false, reason: `Sandbox is already at the ${rung} rung.` };
    }

    if (rung === 'off') {
      await this.sandboxProvider.dispose();
      this.sandboxPolicy = undefined;
      this.sandboxStatus = undefined;
    } else {
      await this.activateSandboxRung(this.sandboxProvider, rung);
    }
    this.sandboxRung = rung;

    try {
      await this.sandboxSettings.setRung(rung);
    } catch (err) {
      log.warn('Could not persist sandbox rung', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.app?.updateStatus(this.sandboxIndicatorState());
    // The model reads the rung from the ephemeral <environment> block; refresh
    // it now so the change is visible mid-session, not at the next user prompt.
    await this.updateEphemeralContext();
    log.info('Sandbox rung changed', { rung, enforced: this.sandboxStatus?.backend ?? 'none' });
    return { changed: true };
  }

  /** The status-bar fields for the always-visible sandbox indicator. */
  private sandboxIndicatorState(): {
    sandboxRung: string;
    sandboxEnforcement: 'enforced' | 'partial' | 'none';
  } {
    const s = this.sandboxStatus;
    const enforcement =
      !s || s.backend === 'none'
        ? 'none'
        : s.filesystem === 'enforced' && s.network === 'enforced'
          ? 'enforced'
          : 'partial';
    return { sandboxRung: this.sandboxRung, sandboxEnforcement: enforcement };
  }

  /**
   * P1 container detection: when this session already runs inside a container,
   * the OS sandbox stacks a second boundary that mostly adds friction. Surface
   * a recommendation (log line always; transcript note once per workspace) that
   * the user may prefer /sandbox off. Detection is heuristic, so this NEVER
   * changes the rung automatically.
   */
  private async surfaceContainerRecommendation(): Promise<void> {
    if (this.sandboxRung === 'off') return;
    try {
      const detection = await detectContainer();
      if (!detection.inContainer) return;
      log.info('Container detected; the OS sandbox is redundant inside an isolated environment', {
        marker: detection.marker,
      });
      if (this.sandboxSettings.isContainerNoticeShown()) return;
      this.app?.transcript.addNotification(
        'Container detected',
        `This session appears to be running inside a container (${detection.marker}).\n` +
          'The environment is already an isolation boundary, so the OS sandbox is\n' +
          'redundant here and can add friction. If that is intentional, keep it;\n' +
          'otherwise you may prefer /sandbox off for this workspace.\n' +
          'Detection is heuristic; nothing was changed automatically.',
      );
      await this.sandboxSettings.markContainerNoticeShown();
    } catch (err) {
      log.debug('Container detection failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Best-effort teardown of the OS sandbox (stops the egress proxy and the macOS
   * violation log-stream child, removes temp profiles). Idempotent and safe to
   * call outside a full shutdown, e.g. from a signal handler.
   */
  async disposeSandbox(): Promise<void> {
    await this.sandboxProvider?.dispose();
  }

  private async resolvePermission(
    toolName: string,
    toolArgs: unknown,
  ): Promise<boolean | CortexToolPermissionResult> {
    const preflightDeps: PreflightDeps = {
      yoloMode: this.yoloMode,
      cwd: this.cwd,
      matchRule: (t, a) => this.rules.matchRule(t, a),
      isReadOnlyInProject: (t, a) => this.isReadOnlyInProject(t, a),
      // Sandboxed shell commands past the catastrophic floor and any deny rule
      // auto-run inside the OS boundary instead of prompting. Gate on BOTH axes:
      // a filesystem-only backend (e.g. future Windows Tier 1, fs enforced but
      // network none) must keep prompting rather than auto-run with open egress.
      sandboxBashEnforced:
        this.sandboxStatus?.filesystem === 'enforced' &&
        this.sandboxStatus?.network === 'enforced',
      // With an active sandbox policy, WebFetch is gated per host by the same
      // network decision as shell egress; that gate replaces the per-call tool
      // prompt. Purely policy-level, so it applies even where OS enforcement
      // is degraded (the gate runs in-process).
      webFetchNetworkGated: this.sandboxPolicy !== undefined,
      // Project the policy's filesystem deny sets onto the in-process file
      // tools (Write/Edit/UndoEdit/Read), which bypass the OS boundary the
      // shell is contained by. writableRoots is the positive floor: the shell
      // may write only inside it, so an in-process write escaping it must not
      // auto-approve either. Absent when the sandbox is off.
      ...(this.sandboxPolicy
        ? {
            sandboxDenyWrite: this.sandboxPolicy.filesystem.denyWrite,
            sandboxDenyRead: this.sandboxPolicy.filesystem.denyRead,
            sandboxWritableRoots: this.sandboxPolicy.filesystem.writableRoots,
          }
        : {}),
    };

    // Fast path: deterministic decision (catastrophic floor > yolo > deny rule
    // > read-only-in-project > allow rule) before acquiring the prompt lock.
    const pre = await preflightPermission(toolName, toolArgs, preflightDeps);
    if (pre.decision === 'allow') return true;
    if (pre.decision === 'block') {
      return pre.reason ? { decision: 'block', reason: pre.reason } : { decision: 'block' };
    }

    if (!this.app) return { decision: 'block', reason: 'TUI not initialized' };

    // Serialize: wait for any active permission prompt to finish
    while (this.permissionLockPromise) {
      await this.permissionLockPromise;
    }

    // Re-check: a previous prompt may have added an "always allow"/deny rule.
    const preAfterWait = await preflightPermission(toolName, toolArgs, preflightDeps);
    if (preAfterWait.decision === 'allow') return true;
    if (preAfterWait.decision === 'block') {
      return preAfterWait.reason
        ? { decision: 'block', reason: preAfterWait.reason }
        : { decision: 'block' };
    }

    // Acquire lock and show the prompt
    this.permissionLockPromise = new Promise<void>((resolve) => {
      this.permissionLockRelease = resolve;
    });

    const permission = this.activity.recordPermissionRequested(toolName, toolArgs);
    await permission.written;
    let permissionResolution: PermissionResolution = 'denied';

    // Allow answering out-of-band (e.g. a companion app writing a decision to
    // the session's control directory) as well as from the inline TUI prompt:
    // watch for an external decision and let whichever lands first win. Aborting
    // the controller stops the watcher once the prompt resolves, however it
    // resolved.
    const externalController = new AbortController();
    const externalDecision = watchDecisionFile(
      this.activity.decisionPath(permission.id),
      externalController.signal,
    );

    try {
      const result = await this.app.showPermissionPrompt(toolName, toolArgs, externalDecision);
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
      externalController.abort();
      await this.activity.recordPermissionResolved(permission.id, toolName, permissionResolution);
      const release = this.permissionLockRelease;
      this.permissionLockPromise = null;
      this.permissionLockRelease = null;
      release?.();
    }
  }

  /**
   * The single network egress decision, shared by sandboxed shell commands
   * (the provider's ask-callback) and WebFetch (Cortex's resolveNetworkAccess
   * seam). Auto-allows the seeded registry allowlist and prior grants;
   * otherwise prompts once per host with once/session/always scope.
   */
  private resolveNetworkAccess(req: NetworkAccessRequest): Promise<NetworkAccessDecision> {
    return this.networkAccess.resolve(req);
  }

  /**
   * Show the unified network prompt, serialized with tool permission prompts
   * through the same lock so shell and WebFetch asks never overlap. Recorded
   * in the activity stream so a companion app can answer out-of-band.
   */
  private async promptNetworkAccess(req: NetworkAccessRequest): Promise<NetworkPromptChoice> {
    // Yolo mode never prompts. Allow this request only (no lasting grant);
    // deniedDomains and the restricted rung are enforced before we get here.
    if (this.yoloMode) return 'once';
    if (!this.app) return 'deny';

    // Serialize: wait for any active permission or network prompt to finish.
    while (this.permissionLockPromise) {
      await this.permissionLockPromise;
    }
    this.permissionLockPromise = new Promise<void>((resolve) => {
      this.permissionLockRelease = resolve;
    });

    const permission = this.activity.recordPermissionRequested('NetworkAccess', {
      host: req.host,
      via: req.via,
      ...(req.url ? { url: req.url } : {}),
    });
    await permission.written;
    let permissionResolution: PermissionResolution = 'denied';

    const externalController = new AbortController();
    const externalDecision = watchDecisionFile(
      this.activity.decisionPath(permission.id),
      externalController.signal,
    );

    try {
      const choice = await this.app.showNetworkPrompt(req, externalDecision);
      permissionResolution = choice === 'deny' ? 'denied' : 'allowed';
      return choice;
    } catch (error) {
      permissionResolution = 'error';
      void this.activity.recordError(error instanceof Error ? error : String(error));
      throw error;
    } finally {
      externalController.abort();
      await this.activity.recordPermissionResolved(permission.id, 'NetworkAccess', permissionResolution);
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
        // Mirror getMatchValue/matchRule's `file_path ?? path` so the read-only
        // auto-approve and the rule layer can never disagree on the target.
        const filePath = String(args['file_path'] ?? args['path'] ?? '');
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

    // OAuth: resolve via ProviderManager (handles token refresh). Single-flight
    // per provider so a burst of concurrent requests (main model + utility
    // model + subagents at session start) triggers exactly one refresh; see
    // oauthResolveInFlight for why a rotating refresh token makes a race fatal.
    if (entry.method === 'oauth' && entry.oauthCredentials) {
      return this.resolveOAuthApiKey(provider, entry);
    }

    // Custom: return stored API key, or a placeholder for keyless endpoints
    // (e.g., Ollama). The OpenAI SDK client requires a non-empty API key.
    if (entry.method === 'custom') {
      return entry.apiKey || 'sk-no-key-required';
    }

    throw new Error(`Unable to resolve API key for provider "${provider}"`);
  }

  /**
   * Resolve (and refresh if expired) an OAuth API key, deduping concurrent
   * callers per provider. The single-flight spans the whole read-refresh-persist
   * cycle so a rotating refresh token is consumed exactly once; a second caller
   * only starts a fresh resolve after the first has persisted the new token, so
   * it reads the rotated credential rather than replaying the spent one.
   */
  private resolveOAuthApiKey(provider: string, entry: CredentialEntry): Promise<string> {
    return singleFlight(this.oauthResolveInFlight, provider, () =>
      resolveStoredOAuthApiKey(this.providerManager, this.credentialStore, provider, entry),
    );
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
    // Stop the retry countdown timer so it cannot fire after teardown.
    this.stopRetryTicker();

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
    // Drain any queued transcript appends (best-effort; never throws).
    await this.transcriptWriter.flush();

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
    await this.sandboxProvider?.dispose();

    await this.activity.recordDone({ code: 0, signal: null, reason: 'normal_shutdown' });
    await this.activity.flush();
    this.app?.stop();
    process.exit(0);
  }

  /**
   * Restore the terminal out of raw mode. Called from crash/signal paths in the
   * entry point before the process exits so a fatal error never leaves the
   * user's terminal wedged. App.stop() is idempotent, so this is safe to call
   * alongside a normal shutdown().
   */
  restoreTerminal(): void {
    this.app?.stop();
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
    // The rung is stated so the model can adapt to denials instead of blindly
    // retrying; changing it stays human-only (there is no tool for it).
    const enforcementLabel = {
      enforced: 'OS-enforced',
      partial: 'partially OS-enforced',
      none: 'not OS-enforced',
    }[this.sandboxIndicatorState().sandboxEnforcement];
    const lines = [
      `Current date: ${new Date().toISOString().split('T')[0]}`,
      `Current working directory: ${this.cwd}`,
      branch ? `Git branch: ${branch}` : '',
      `Model: ${this.provider}/${this.modelId}`,
      this.yoloMode ? 'YOLO mode is active: all tools auto-approved' : '',
      this.sandboxRung !== 'off'
        ? `Sandbox: ${this.sandboxRung} rung, ${enforcementLabel}`
        : '',
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

  // ---------------------------------------------------------------------------
  // Background retry status (compact, in-place line)
  // ---------------------------------------------------------------------------

  /**
   * Begin (or update) the compact retry countdown. Replaces the "thinking"
   * spinner with a single line that ticks down to the next attempt; a 1s timer
   * keeps the countdown live.
   */
  private startRetryCountdown(info: RetryScheduledInfo): void {
    this.retryState = { info };
    // A retry wait is not "thinking"; swap the spinner for the status line.
    this.app?.hideStatusSpinner();
    this.renderRetryWaiting();
    this.stopRetryTicker();
    this.retryTicker = setInterval(() => this.renderRetryWaiting(), 1000);
  }

  /** Render the current waiting/reconnecting line from retryState. */
  private renderRetryWaiting(): void {
    if (!this.retryState || !this.app) return;
    const { info } = this.retryState;
    const secondsRemaining = Math.max(0, (info.nextAttemptAt - Date.now()) / 1000);
    this.app.transcript.setRetryStatus(
      secondsRemaining > 0
        ? {
            phase: 'waiting',
            attempt: info.attempt,
            maxAttempts: info.maxAttempts,
            secondsRemaining,
            ...(info.causeDetail ? { detail: info.causeDetail } : {}),
          }
        : { phase: 'reconnecting', attempt: info.attempt, maxAttempts: info.maxAttempts },
    );
  }

  private stopRetryTicker(): void {
    if (this.retryTicker) {
      clearInterval(this.retryTicker);
      this.retryTicker = null;
    }
  }

  /** Tear down all retry UI (ticker, line, state). */
  private clearRetry(): void {
    this.stopRetryTicker();
    this.retryState = null;
    this.app?.transcript.clearRetryStatus();
  }

  /**
   * The agent produced output (text or a tool call) after a retry was pending,
   * which means we reconnected: drop the retry line immediately rather than
   * waiting for the whole turn to resolve.
   */
  private noteProgressAfterRetry(): void {
    if (this.retryState) this.clearRetry();
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
  getSandboxRung(): SandboxRung { return this.sandboxRung; }
  getSandboxStatus(): SandboxStatus | undefined { return this.sandboxStatus; }
  getSandboxPolicy(): SandboxPolicy | undefined { return this.sandboxPolicy; }
  /** False when the config kill switch (sandbox.enabled=false) is set. */
  isSandboxConfigEnabled(): boolean { return this.config.sandbox?.enabled !== false; }
  /** Domain grants for transparency surfaces (/sandbox status). */
  getNetworkGrantInfo(): { persisted: readonly string[]; session: readonly string[] } {
    return {
      persisted: this.networkGrants.getDomains(),
      session: this.networkAccess.getSessionGrants(),
    };
  }
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
