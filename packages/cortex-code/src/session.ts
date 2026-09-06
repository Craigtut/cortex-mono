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
  BASH_ESCALATION_PERMISSION_NAME,
  INTERNAL_TAG_NAMES,
  type CortexModel,
  type CortexAgentConfig,
  type CortexAgentStateV1,
  type CortexAgentStateV2,
  type CortexEvent,
  type CortexToolPermissionResult,
  type ToolPermissionRequestContext,
  type AgentTextOutput,
  type ClassifiedError,
  type CompactionResult,
  type RetryScheduledInfo,
  type RetrySucceededInfo,
  type RetryExhaustedInfo,
  type LoopOriginContext,
  type ResolutionNote,
  type ThinkingLevel,
  type McpStdioConfig,
  type ObservationalMemoryState,
  type ToolCallEndPayload,
  type ToolCallStartPayload,
  type ToolCallUpdatePayload,
} from '@animus-labs/cortex';
import { SelectList, type SelectItem } from '@earendil-works/pi-tui';
import { App, type AppCallbacks } from './tui/app.js';
import { randomThinkingLabel } from './tui/spinner.js';
import { selectListTheme } from './tui/theme.js';
import { OverlayBox } from './tui/overlay-box.js';
import { resolveAgentMode, type CortexCodeConfig } from './config/config.js';
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
  createDebouncedStateSaver,
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
import type {
  SandboxOptions,
  SandboxState,
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

/**
 * How long shutdown waits for a fresh composite snapshot before falling back
 * to the last one the facade published. getState() resolves at a quiescence
 * window, which a session that is still working may not reach.
 */
const SHUTDOWN_SNAPSHOT_TIMEOUT_MS = 2000;

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
  /**
   * The `--duplex` / `--no-duplex` flag, or undefined when neither was passed.
   * Undefined hands the decision to the `agentMode` config key.
   */
  duplex?: boolean | undefined;
  initialEffort: ThinkingLevel;
  initialUtilityModelId?: string | undefined;
  resumeSessionId: string | undefined;
  compactionStrategy?: 'observational' | 'classic';
  /** Update availability resolved at startup, or null when up to date / disabled. */
  updateInfo?: UpdateInfo | null;
}

export class Session {
  private agent: CortexAgent | null = null;
  private sandboxOptions: SandboxOptions | undefined;
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
  private saver: ReturnType<typeof createDebouncedStateSaver>;
  /**
   * The last composite snapshot the facade handed over. Shutdown falls back
   * to it when a fresh `getState()` cannot settle in time, so a session that
   * is still busy at exit is saved slightly stale rather than not at all.
   */
  private lastCompositeState: CortexAgentStateV2 | null = null;
  /**
   * True while the agent as a whole is busy: any resident loop running, a
   * sub-agent alive, a delivery parked, an ask pending. Drives the spinner,
   * the abort gate and the MCP reload gate.
   *
   * Deliberately NOT keyed on `onLoopComplete`. That callback fans out to
   * every resident loop and carries no origin, so under duplex the talker's
   * sub-second turn would report the whole agent idle while the reasoner is
   * still working: the spinner would vanish and Ctrl+C would become a no-op
   * for the rest of a multi-minute run. It is keyed on the facade's
   * `workSettled` predicate instead, via {@link awaitWorkSettled}.
   */
  private isRunning = false;
  /**
   * True from the moment `handleInput` commits to a turn until its
   * `prompt()` settles. Conversation-scoped, unlike {@link isRunning}: it
   * covers the pre-prompt window (ephemeral context, pre_turn hooks) that
   * the facade cannot see, so a second input arriving in it still steers.
   */
  private promptInFlight = false;
  /**
   * Bumped whenever new work starts. A settlement wait that spans a bump is
   * stale (the user started something else) and re-waits instead of
   * reporting idle.
   */
  private workGeneration = 0;
  /** Guards against stacking settlement waiters; one is enough. */
  private settleWatcherActive = false;
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
  /**
   * Live background-retry state, while a transient failure is being retried,
   * stamped with the loop it belongs to.
   *
   * There is one countdown line and two loops that can retry. Without the
   * stamp, a talker retry resolving would call clearRetry() and wipe the
   * reasoner's countdown, leaving the user staring at nothing through a long
   * backoff on the work they are actually waiting for.
   */
  private retryState: { info: RetryScheduledInfo; loopPath: string } | null = null;
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
  /**
   * The Cortex facade mode this session runs, resolved once at construction so
   * the value handed to {@link buildAgentConfig} and every mode-dependent
   * routing decision in this file cannot drift apart. Resolved once and never
   * reassigned: the loops are assembled from it, so a mid-session change would
   * leave the routing describing an agent that does not exist.
   *
   * Defaults to passthrough rather than to the facade default, which is
   * duplex. A coding CLI is a typed, single-surface client that streams the
   * reasoner's tool calls live, so there is no dead air for a talker to fill,
   * and duplex puts a second model and a paraphrase layer between a precisely
   * typed instruction and the loop holding the tools. Passthrough routes
   * straight to the reasoner and matches the single loop this session drove
   * before the facade.
   *
   * Opting in (`--duplex`, or `"agentMode": "duplex"`) buys the thing that
   * default costs: a session that can answer a question or take a correction
   * while the reasoner is still working, rather than queueing it behind the
   * task. That is a real trade, so it is a choice rather than a default, and
   * a `--duplex` run is not a mistake. See `resolveAgentMode`.
   */
  private readonly agentMode: NonNullable<CortexAgentConfig['mode']>;
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
    this.agentMode = resolveAgentMode(options.duplex, options.config.agentMode);
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
    // Shorter than the saver's 500 ms default. The facade already debounces
    // onStateChanged by 500 ms, so a second full window there only delayed
    // the settled write; and this window is now the crash exposure for
    // turn-boundary checkpoints, where the whole point is bytes on disk
    // sooner. Still long enough to coalesce a burst of turns.
    this.saver = createDebouncedStateSaver(this.sessionId, 150);
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
    this.sandboxOptions = await this.initSandbox();

    // Create agent (built-in tools are auto-registered by Cortex)
    this.agent = await CortexAgent.create(this.buildAgentConfig());
    this.applySandboxState(this.agent.getSandboxState());

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
    this.pushInitialFooterState(branch, initialEffort);

    // Recommend (never apply) /sandbox off when already inside a container.
    void this.surfaceContainerRecommendation();

    // Put the session on disk before it can do any work. Everything after
    // this point can crash without the session becoming unlistable. A
    // resumed session already has an artifact and resume() has not read it
    // yet, so it checkpoints itself once the restore lands instead.
    if (!this.isResume) await this.writeInitialCheckpoint();

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

    // If the CONVERSATION is already mid-turn, steer it with the new
    // message. Deliberately narrower than isRunning: under duplex the
    // reasoner can be minutes into a task while the talker is free, and the
    // user's next sentence belongs to the talker as a fresh prompt, not
    // steered into a loop that is not listening for it.
    if (this.promptInFlight || !this.agent.conversationIdle) {
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
    this.promptInFlight = true;
    this.beginWork();
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
      this.promptInFlight = false;
      // The turn is NOT necessarily over: under duplex prompt() resolves
      // when the talker has spoken, with the reasoner still working. Hand
      // the "we are done" UI to the settlement watcher, which reads the
      // whole agent rather than the loop that happened to finish first.
      this.watchForWorkSettled();
    }
  }

  /**
   * Mark the agent busy for a newly started piece of work. Bumping the
   * generation invalidates any settlement wait already in flight, so work
   * that starts while the previous wait is resolving cannot be reported as
   * idle by it.
   */
  private beginWork(): void {
    this.workGeneration += 1;
    this.isRunning = true;
    this.freezeDiagnostics.setSessionRunning(true);
  }

  /**
   * Arm (once) a wait for the whole agent to go quiet, and apply the
   * end-of-work UI when it does.
   */
  private watchForWorkSettled(): void {
    if (this.settleWatcherActive) return;
    this.settleWatcherActive = true;
    void this.awaitWorkSettled()
      .then((settled) => {
        if (settled) this.applyWorkSettledUi();
      })
      .catch((err: unknown) => {
        log.debug('Work settlement wait failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.settleWatcherActive = false;
      });
  }

  /**
   * Resolve true once the agent as a whole is quiet. Resolves false when the
   * verdict no longer belongs to this session (the agent was replaced or
   * torn down), so the caller leaves the UI alone.
   */
  private async awaitWorkSettled(): Promise<boolean> {
    const agent = this.agent;
    if (!agent) return false;
    for (;;) {
      const generation = this.workGeneration;
      await agent.waitForWorkSettled();
      if (this.agent !== agent) return false;
      // A destroyed agent is as settled as it will ever get; without this a
      // prompt() that rejected on teardown would leave the spinner up.
      if (agent.state === 'destroyed' || agent.state === 'destroying') return true;
      if (this.workGeneration !== generation) continue;
      if (agent.workSettled) return true;
    }
  }

  /**
   * The end-of-work UI: everything the user reads as "the agent is done and
   * waiting for me". Fires once per settled exchange, not once per loop.
   */
  private applyWorkSettledUi(): void {
    this.isRunning = false;
    this.promptInFlight = false;
    this.freezeDiagnostics.setSessionRunning(false);
    this.app?.transcript.closeActiveToolGroups();
    this.app?.hideStatusSpinner();
    this.app?.focusEditor();
    void this.activity.recordAwaitingInput();
    // One completed exchange: advance the title cadence (regenerates every
    // N turns, idle here so it never competes with the main loop).
    this.titleManager?.onUserTurnComplete();
    // If the MCP config changed during the turn, apply it now. Doing this
    // here (vs mid-turn) avoids invalidating the tool snapshot that
    // pi-agent-core captured at prompt() entry.
    if (this.mcpReloadPending) {
      void this.runQueuedMcpReload();
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
    // Through the facade's addSkill(), not getSkillRegistry().addSkill():
    // the facade owns which loops a skill lands on, and reaching past it
    // registers on whatever loop the getter happens to return today.
    const agent = this.agent;
    const skills = await discoverSkills(this.cwd);

    const globalSkills = skills.filter((s) => !isProjectSkill(s));
    const projectSkills = skills.filter(isProjectSkill);
    for (const skill of globalSkills) agent.addSkill(skill);

    if (projectSkills.length === 0) return;

    const signature = await computeProjectSkillsSignature(skills);
    if (await checkProjectTrust(this.cwd, 'skills', signature)) {
      for (const skill of projectSkills) agent.addSkill(skill);
      return;
    }

    const decision = await this.promptProjectContentTrust(
      'New Project Skills',
      `This project defines ${projectSkills.length} skill(s) in .cortex/skills that can\n` +
        'run shell commands when loaded. Trust and register them?',
    );
    if (decision === 'trust' && signature !== null) {
      await recordProjectTrust(this.cwd, 'skills', signature);
      for (const skill of projectSkills) agent.addSkill(skill);
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

  /** The duplex talker's loop path, or null in passthrough, which has none. */
  private get talkerLoopPath(): string | null {
    return this.agentMode === 'duplex' ? 'talker' : null;
  }

  /**
   * The loop whose streamed text is the user-visible reply: the reasoner in
   * passthrough, the talker in duplex. Passthrough hands back the reasoner's
   * own bridge verbatim, so its events carry no `loopPath` at all; the duplex
   * merged bridge stamps every event with one.
   */
  private get conversationLoopPath(): string {
    return this.talkerLoopPath ?? 'reasoner';
  }

  /** True when an event came from the loop the user is actually talking to. */
  private isConversationEvent(event: CortexEvent): boolean {
    return event.loopPath === undefined || event.loopPath === this.conversationLoopPath;
  }

  /**
   * True when an event came from the talker.
   *
   * Used to keep the talker's tool calls out of the transcript. The talker's
   * toolset is fixed and is entirely control plumbing (`spawn_task`,
   * `steer_task`, `cancel_task`, `quick_lookup`, `answer_ask`): it has no
   * file, shell, MCP or sub-agent tools, by construction. A coding CLI's
   * transcript is a record of what was done to the workspace, and routing
   * chatter rendered beside Read/Edit/Bash is noise that reads like work.
   *
   * Filtered on the loop rather than on a list of tool names deliberately, so
   * a control tool added to the talker later is hidden by inheritance instead
   * of appearing in the transcript the day it ships. Sub-agent tool calls are
   * unaffected: they carry `childTaskId` and their own `reasoner/<taskId>`
   * path, and are handled by the child branches above.
   */
  private isTalkerEvent(event: CortexEvent): boolean {
    return this.talkerLoopPath !== null && event.loopPath === this.talkerLoopPath;
  }

  /**
   * Whether a fan-out callback came from the loop doing the user's work.
   *
   * Defined by excluding the talker rather than by naming the reasoner, so it
   * cannot be wrong about what the reasoner's loop path is called: passthrough
   * has no talker and every origin is work, and a sub-agent
   * (`reasoner/<taskId>`) is work too, which is what its compaction and
   * observation events should count as.
   */
  private isWorkLoop(origin: LoopOriginContext): boolean {
    return origin.loopPath !== this.talkerLoopPath;
  }

  /** Wire all agent events to the TUI. */
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
      if (!this.isConversationEvent(event)) return;
      assistantStarted = false;
      rawStreamText = '';
      workingTagOpen = false;
      this.app!.removeWorkingTagSubtitle();
    });

    bridge.on('response_chunk', (event: CortexEvent) => {
      // Skip child agent streaming; only parent text goes to transcript
      if (event.childTaskId) return;
      // Skip the work loop's streaming too. The merged duplex bridge carries
      // both resident loops and neither sets childTaskId, so without this
      // the reasoner's private working prose streams into the assistant
      // bubble and is then replaced by the talker's actual reply.
      if (!this.isConversationEvent(event)) return;

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
      // The talker's control tools are routing plumbing, not work. See
      // isTalkerEvent().
      if (this.isTalkerEvent(event)) return;

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
      if (this.isTalkerEvent(event)) return;

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
      if (this.isTalkerEvent(event)) return;

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

    // A loop finished. Not "the agent is idle": this callback is registered
    // on every resident loop and carries no origin, so under duplex the
    // talker's sub-second turn fires it while the reasoner is minutes from
    // done. Only the cheap per-loop refresh happens here; the end-of-work
    // UI waits for the facade's settlement predicate.
    this.agent.onLoopComplete(() => {
      this.updateFooterContextUsage();
      this.watchForWorkSettled();
    });

    // Persistence trigger. Debounced by the facade and fired with a
    // consistent composite snapshot (log plus both loops' histories and
    // memory), which is why autosave hangs off this rather than off
    // onLoopComplete and turn_end: those fire per loop and per turn, so one
    // exchange used to write the session out three times, each time from a
    // reasoner-only read that under duplex would silently drop the user's
    // actual dialogue.
    this.agent.onStateChanged((state) => {
      this.recordComposite(state);
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
    // Every one of these is registered on both resident loops, so each keys
    // on the origin: the line has one slot and two possible owners.
    this.agent.onRetryScheduled((info: RetryScheduledInfo, origin: LoopOriginContext) => {
      this.startRetryCountdown(info, origin.loopPath);
    });
    this.agent.onRetrySucceeded((_info: RetrySucceededInfo, origin: LoopOriginContext) => {
      this.clearRetryFor(origin.loopPath);
    });
    this.agent.onRetryExhausted((_info: RetryExhaustedInfo, origin: LoopOriginContext) => {
      // The matching fatal onError fires right after and renders the terminal
      // 'failed' line; just stop the countdown here.
      if (this.retryState?.loopPath === origin.loopPath) this.stopRetryTicker();
    });

    // Compaction notification. The reasoner's only: the footer this updates
    // reads the reasoner's context window, so a talker compaction would
    // announce numbers that do not correspond to anything the user can see,
    // about a context they do not own.
    this.agent.onPostCompaction((result: CompactionResult, origin: LoopOriginContext) => {
      if (!this.isWorkLoop(origin)) return;
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

    // The two failure notifications below deliberately fire for ANY loop,
    // unlike the informational one above. A talker whose compaction degrades
    // or runs out of layers is a conversation about to break, which the user
    // needs to know even though the remedy text is written for the reasoner's
    // context. A duplicated warning beats a swallowed one.

    // Compaction degraded (Layer 2 failed, Layer 3 used as fallback)
    this.agent.onCompactionDegraded((info) => {
      this.app!.transcript.addNotification(
        'Compaction Degraded',
        `Layer 2 summarization failed (${info.layer2Failures} attempts). Emergency truncation dropped ${info.turnsDropped} turns.`,
      );
    });

    // Compaction exhausted (all layers failed)
    this.agent.onCompactionExhausted(() => {
      this.app!.transcript.addNotification(
        'Context Limit Reached',
        'All compaction layers have failed. Use /context-window to increase the limit or /clear to start fresh.',
      );
    });

    // Observational memory events (only fire when strategy is 'observational').
    // The status they refresh is read off the reasoner's compaction manager,
    // so a talker generation would only trigger a redundant re-read of a
    // number that did not change.
    this.agent.onObservation((_event, origin: LoopOriginContext) => {
      if (!this.isWorkLoop(origin)) return;
      this.updateObservationalMemoryStatus();
    });
    this.agent.onReflection((_event, origin: LoopOriginContext) => {
      if (!this.isWorkLoop(origin)) return;
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
      this.beginWork();
      this.app!.showStatusSpinner('Processing background results...');
      void this.activity.recordWorking();
    });

    // Update tokens on turn_end (fires after each LLM turn, including
    // mid-loop turns between tool calls), and take a crash-recovery
    // checkpoint. onStateChanged is the authoritative persistence trigger,
    // but it cannot fire during a long task, so it is not on its own enough
    // to keep one on disk. A child's turn boundary says nothing about the
    // parent's history, so children are skipped.
    bridge.on('turn_end', (event: CortexEvent) => {
      this.updateFooterContextUsage();
      this.updateObservationalMemoryStatus();
      if (event.childTaskId) return;
      this.crashCheckpoint();
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
  /** Resolve product preferences; Cortex owns backend construction and policy setup. */
  private async initSandbox(): Promise<SandboxOptions | undefined> {
    if (this.config.sandbox?.enabled === false) {
      this.sandboxRung = 'off';
      return undefined;
    }
    await this.sandboxSettings.load();
    this.sandboxRung = await this.resolveInitialRung();
    const cortexHome = path.join(homedir(), '.cortex');
    return {
      rung: this.sandboxRung,
      // Keep the CLI's availability choice explicit; the framework defaults to refusal.
      requireEnforcement: this.config.sandbox?.requireEnforcement ?? false,
      denyWrite: [cortexHome, path.join(this.cwd, '.cortex')],
      denyRead: [path.join(cortexHome, 'credentials.json')],
      ...(this.config.sandbox?.allowedDomains ? { allowedDomains: this.config.sandbox.allowedDomains } : {}),
      onStatusChange: (state) => this.applySandboxState(state),
    };
  }

  private applySandboxState(state: SandboxState | undefined): void {
    this.sandboxRung = state?.rung ?? 'off';
    this.sandboxPolicy = state?.policy;
    this.sandboxStatus = state?.rung === 'off' ? undefined : state?.status;
    this.app?.updateStatus(this.sandboxIndicatorState());
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

    // An explicit consumer default is honored and remembered (folder-trust).
    const configured = this.config.sandbox?.rung;
    if (configured) {
      await this.persistInitialRung(configured);
      return configured;
    }

    // On Windows the Tier-1 helper is not yet code-signed, so it is opt-in:
    // default to 'off' (no helper is ever spawned, so nothing can be flagged by
    // antivirus). Do NOT persist that 'off' — leaving the remembered rung empty
    // means a later consumer default (sandbox.rung, e.g. once a signed helper
    // ships) or a future on-by-default flip still takes effect, while
    // `/sandbox workspace` remains the explicit, remembered opt-in. Persisting
    // it would make 'off' sticky and defeat the signed-helper rollout.
    if (process.platform === 'win32') {
      return 'off';
    }

    // Every other platform is on-by-default at Workspace, remembered per
    // workspace (the folder-trust pattern).
    await this.persistInitialRung('workspace');
    return 'workspace';
  }

  private async persistInitialRung(rung: SandboxRung): Promise<void> {
    try {
      await this.sandboxSettings.setRung(rung);
    } catch (err) {
      log.warn('Could not persist initial sandbox rung', {
        error: err instanceof Error ? err.message : String(err),
      });
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
    if (this.config.sandbox?.enabled === false || !this.agent) {
      return {
        changed: false,
        reason:
          'The sandbox is disabled by config (sandbox.enabled=false). Edit your config and restart to re-enable it.',
      };
    }
    if (rung === this.sandboxRung) {
      return { changed: false, reason: `Sandbox is already at the ${rung} rung.` };
    }

    try {
      await this.agent.setSandboxRung(rung);
      this.applySandboxState(this.agent.getSandboxState());
    } catch (error) {
      return { changed: false, reason: error instanceof Error ? error.message : String(error) };
    }

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

  /** Abnormal-exit teardown. Cortex owns its sandbox and temporary directory. */
  async disposeSandbox(): Promise<void> {
    await this.agent?.destroy();
  }

  private async resolvePermission(
    toolName: string,
    toolArgs: unknown,
    context?: ToolPermissionRequestContext,
  ): Promise<boolean | CortexToolPermissionResult> {
    const abortSignal = context?.signal;
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
      // Broad read auto-approve for Read/Grep/Glob, matching the sandboxed
      // shell's view: reads are broad by policy design, denyRead is the only
      // read-side restriction. Requires FULL filesystem enforcement, not
      // partial: Windows Tier 1 cannot deny secret-file reads to
      // subprocesses, and Grep's denyRead guarantee is the kernel containing
      // ripgrep. Network enforcement is irrelevant to reads, so this is
      // deliberately looser than sandboxBashEnforced's both-axes gate.
      sandboxReadsBroad:
        this.sandboxStatus?.filesystem === 'enforced' &&
        this.sandboxPolicy !== undefined,
      // With an active sandbox policy, WebFetch is gated per host by the same
      // network decision as shell egress; that gate replaces the per-call tool
      // prompt. Purely policy-level, so it applies even where OS enforcement
      // is degraded (the gate runs in-process).
      webFetchNetworkGated: this.sandboxPolicy !== undefined,
      // Project the policy's filesystem deny sets onto the in-process file
      // tools (Write/Edit/UndoEdit/Read/Glob), which bypass the OS boundary the
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

    // The asking run may have been aborted while this ask waited behind
    // another prompt (or before it arrived). Cortex has already stopped
    // waiting for this resolver, so never show a prompt for dead work.
    if (abortSignal?.aborted) {
      return { decision: 'block', reason: 'Run aborted before the permission prompt was shown' };
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

    const permission = this.activity.recordPermissionRequested(
      toolName,
      toolArgs,
      context?.askId !== undefined ? { askId: context.askId } : undefined,
    );
    await permission.written;
    let permissionResolution: PermissionResolution = 'denied';

    // Allow answering out-of-band (e.g. a companion app writing a decision to
    // the session's control directory) as well as from the inline TUI prompt:
    // watch for an external decision and let whichever lands first win. Aborting
    // the controller stops the watcher once the prompt resolves, however it
    // resolved.
    const externalController = new AbortController();
    const fileDecision = watchDecisionFile(
      this.activity.decisionPath(permission.id),
      externalController.signal,
    );

    // Dismiss the prompt when the asking run is aborted. Cortex races the
    // resolver against the run's abort signal and proceeds with a block, so
    // an unanswered prompt would sit on screen for dead work while holding
    // permissionLockPromise, serializing the next live ask behind it. The
    // abort settles the prompt through the same external-decision channel a
    // companion app uses, which removes it from the TUI and releases the lock.
    let abortDismissed = false;
    let onAbort: (() => void) | undefined;
    let externalDecision = fileDecision;
    if (abortSignal) {
      // The aborted pre-check above ran BEFORE recordPermissionRequested and
      // the awaited state write, and addEventListener never fires for a
      // signal that is already aborted. An abort landing inside that window
      // must settle the decision here, or the prompt sits on screen for
      // dead work holding permissionLockPromise forever, serializing every
      // later ask behind it.
      let abortDecision: Promise<'deny'>;
      if (abortSignal.aborted) {
        abortDismissed = true;
        abortDecision = Promise.resolve('deny');
      } else {
        abortDecision = new Promise<'deny'>((resolve) => {
          onAbort = () => {
            abortDismissed = true;
            resolve('deny');
          };
          abortSignal.addEventListener('abort', onAbort, { once: true });
        });
      }
      externalDecision = Promise.race([fileDecision, abortDecision]);
    }

    try {
      const result = await this.app.showPermissionPrompt(toolName, toolArgs, externalDecision);
      if (abortDismissed) {
        permissionResolution = 'cancelled';
        return {
          decision: 'block',
          reason: 'Run aborted before the permission prompt was answered',
        };
      }
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
      if (abortSignal && onAbort) {
        abortSignal.removeEventListener('abort', onAbort);
      }
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
    // Pi-agent-core passes the model's provider field. For anything built by
    // createCustomModel that is the synthetic id "custom", whose credential is
    // filed under the connection name instead (e.g. "ollama"), so a "custom"
    // request falls back to the session's provider name.
    //
    // Only "custom" does. Every other id names a real provider, and a real
    // provider's credential is filed under its own name or not stored at all:
    // borrowing a different provider's would send its token to an endpoint it
    // was not issued for. That is reachable, because a loop can outlive a
    // provider switch (a duplex talker still on the startup provider's model
    // after /model moved the session), and the honest answer there is that
    // this model has no credential.
    //
    // A borrowed entry is therefore never an OAuth one, which is what keeps
    // the OAuth branch below resolving under an id pi-ai actually knows. It
    // used to resolve the session's OAuth credential under the literal string
    // "custom", and pi-ai registers no such provider.
    let entry = await this.credentialStore.getProvider(provider);
    if (!entry && provider === 'custom' && provider !== this.provider) {
      const sessionEntry = await this.credentialStore.getProvider(this.provider);
      if (sessionEntry?.method === 'oauth') {
        log.warn('Not lending OAuth credentials to a custom-endpoint model', {
          sessionProvider: this.provider,
        });
      } else {
        entry = sessionEntry;
      }
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

  /**
   * Resume a previous session.
   *
   * Composite (v2) saves are preferred; a session written before the
   * composite format existed still loads through the v1 pair, which the
   * facade upgrades transparently. Both go in through the one all-or-nothing
   * `restore()`, which subsumes the three separate loop-level restore calls
   * (history, observational state, usage): those could each land
   * independently and mid-run, while `restore()` applies them in order and
   * refuses outright while a loop is running, so a /resume typed during a
   * turn fails loudly instead of splicing history out from under it.
   */
  async resume(sessionId: string): Promise<void> {
    if (!this.agent) return;

    const loaded = await this.loadResumableSession(sessionId);
    if (!loaded) {
      this.app?.transcript.addNotification('Resume Failed', `Session ${sessionId} not found.`);
      // There was nothing under this id, so the session start() skipped a
      // checkpoint for is effectively a fresh one. Give it the artifact it
      // would have had, or it stays invisible to listSessions().
      await this.writeInitialCheckpoint();
      return;
    }

    try {
      // Awaited: restore() reports its guards as a rejection, so an
      // unawaited call would leave a /resume typed during a turn escaping
      // this catch as an unhandled rejection.
      await this.agent.restore(loaded.artifact);
    } catch (err) {
      log.warn('Resume restore rejected', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.app?.transcript.addNotification(
        'Resume Failed',
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    this.createdAt = loaded.meta.createdAt;
    this.updateObservationalMemoryStatus();

    // Replay message history into the transcript so the user sees the
    // previous conversation. Cortex already has the history in context; this
    // is purely visual rehydration.
    if (this.app) {
      const { replayHistoryToTranscript } = await import('./utils/replay-history.js');
      this.app.transcript.addNotification(
        'Session Resumed',
        `Replaying ${loaded.dialogue.length} messages from previous session.`,
      );
      replayHistoryToTranscript(loaded.dialogue, this.app.transcript);
    }
    this.updateFooterContextUsage();
    // Re-baseline: start() checkpointed an empty agent, so without this the
    // crash checkpoint's base would still be that empty snapshot and would
    // blank the restored talker side on the first turn.
    await this.writeInitialCheckpoint();
  }

  /**
   * Load a saved session as something `restore()` accepts, plus the history
   * the transcript should replay. The replayed half is the DIALOGUE, which
   * under duplex is the talker's transcript, not the reasoner's work log.
   */
  private async loadResumableSession(sessionId: string): Promise<{
    artifact: CortexAgentStateV1 | CortexAgentStateV2;
    meta: SessionMeta;
    dialogue: unknown[];
  } | null> {
    const {
      loadSessionState,
      loadSession: load,
      loadObservationalState,
    } = await import('./persistence/sessions.js');

    const composite = await loadSessionState(sessionId);
    if (composite) {
      const { state } = composite;
      return {
        artifact: state,
        meta: composite.meta,
        dialogue: state.talkerHistory.length > 0 ? state.talkerHistory : state.reasonerHistory,
      };
    }

    const saved = await load(sessionId);
    if (!saved) return null;

    // Observational memory state, loaded before the restore because history
    // and memory now go in together (the buffer watermark indexes into the
    // history, so the facade orders them itself rather than trusting the
    // caller to).
    const omState = this.compactionStrategy === 'observational'
      ? await loadObservationalState(sessionId)
      : null;

    return {
      artifact: {
        version: 1,
        history: saved.history as CortexAgentStateV1['history'],
        memory: (omState ?? null) as ObservationalMemoryState | null,
        ...(saved.meta.usage ? { usage: saved.meta.usage } : {}),
      },
      meta: saved.meta,
      dialogue: saved.history,
    };
  }

  /**
   * Abort the current agent loop without destroying.
   *
   * Skipped once teardown has begun: the editor discards the promise this
   * returns (Ctrl+C is fire-and-forget), so anything that rejects in here
   * rejects unhandled. CortexAgent.abort() is itself a no-op after destroy,
   * but abort() during shutdown still has nothing to cancel and its activity
   * record would land after the "done" record, so skip the whole body.
   *
   * The `isRunning` gate is what makes Ctrl+C work at all, which is why that
   * flag is keyed on the facade's settlement predicate and not on any single
   * loop's completion.
   */
  async abort(): Promise<void> {
    this.freezeDiagnostics.recordAbortRequested('session.abort');
    const tearingDown = this.agent?.state === 'destroying' || this.agent?.state === 'destroyed';
    if (this.agent && this.isRunning && !tearingDown) {
      await this.agent.abort();
      void this.activity.recordError({
        category: 'cancelled',
        severity: 'recoverable',
        originalMessage: 'Agent loop cancelled by user',
      });
    }
    this.isRunning = false;
    this.promptInFlight = false;
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
        const state = await this.finalCompositeState(this.agent);
        if (state) {
          const { saveSessionState } = await import('./persistence/sessions.js');
          await saveSessionState(this.sessionId, state, this.buildSessionMeta());
        }
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

  /**
   * The config handed to CortexAgent.create(). Separate from start() so the
   * mode is assertable without standing up a TUI and a sandbox.
   *
   * `mode` is passed explicitly rather than left to the facade default, which
   * is duplex. See {@link agentMode} for why, and for the single place that
   * decision is written down.
   */
  private buildAgentConfig(): CortexAgentConfig {
    const diagnostics = this.buildDiagnosticsConfig();
    return {
      // No `duplex.maxTotalCost`, and that is a decision rather than an
      // omission. The facade's aggregate guard is uncapped without it, so a
      // duplex session runs two resident loops, sub-agents, lookups and
      // doubled observational spend with no session ceiling. Re-taken now
      // that `--duplex` makes this reachable, and the answer did not change:
      // this CLI sets no `budgetGuard.maxCost` either, so a session cap would
      // be the only cost limit in the product, and its observable behavior
      // would be a long coding session hard-stopping mid-task with no prior
      // warning. Cost limits for a coding CLI want a warning tier before a
      // stop, and that is a product decision, not a constant to pick here.
      // The framework says so instead: `duplex-cost-cap-unset` is in the
      // resolution report `/status` prints, so the ceiling's absence is
      // visible without being enforced at a number nobody chose.
      mode: this.agentMode,
      model: this.model,
      utilityModel: 'default',
      workingDirectory: this.cwd,
      initialBasePrompt: this.mode.systemPrompt,
      slots: this.mode.contextSlots,
      resolvePermission: (toolName, toolArgs, context) =>
        this.resolvePermission(toolName, toolArgs, context),
      // WebFetch's egress gate: the same decision function the sandbox egress
      // proxy consults for shell commands, so one grant covers both paths.
      resolveNetworkAccess: (req) => this.resolveNetworkAccess(req),
      isAutoApprove: () => this.yoloMode,
      ...(this.sandboxOptions ? { sandbox: this.sandboxOptions } : {}),
      getApiKey: (provider) => this.getApiKey(provider),
      contextWindowLimit: this.config.contextWindowLimit ?? null,
      compaction: { strategy: this.compactionStrategy },
      persistResult: createToolResultPersistor(this.sessionId),
      logger: log,
      ...(diagnostics ? { diagnostics } : {}),
    };
  }

  private buildDiagnosticsConfig(): import('@animus-labs/cortex').CortexDiagnosticsConfig | undefined {
    const freeze = this.config.diagnostics?.freeze;
    if (!freeze?.enabled) return undefined;
    const watchdog: import('@animus-labs/cortex').PromptWatchdogDiagnosticsConfig = { enabled: true };
    if (freeze.promptWatchdogIntervalMs !== undefined) watchdog.heartbeatIntervalMs = freeze.promptWatchdogIntervalMs;
    if (freeze.abortWaitWarningMs !== undefined) watchdog.abortWaitWarningMs = freeze.abortWaitWarningMs;
    return { promptWatchdog: watchdog };
  }

  /**
   * The footer's full opening state. Separate from start() so a test can put
   * the footer in the state a real session opens with by calling the same
   * code, rather than by assembling a state object of its own and proving
   * only that the renderer works.
   */
  private pushInitialFooterState(branch: string, effortLevel: ThinkingLevel): void {
    if (!this.agent || !this.app) return;
    this.app.updateStatus({
      mode: this.mode.name,
      modeCount: AVAILABLE_MODES.length,
      agentMode: this.agentMode,
      provider: this.provider,
      model: this.modelId,
      contextTokenCount: this.getDisplayedCurrentContextTokens(),
      contextTokenLimit: this.agent.effectiveContextWindow,
      gitBranch: branch,
      yoloMode: this.yoloMode,
      effortLevel,
      observationalMode: this.compactionStrategy === 'observational',
      ...this.sandboxIndicatorState(),
      ...this.resolutionIndicatorState(),
    });
  }

  private updateFooterContextUsage(): void {
    if (!this.agent || !this.app) return;
    this.app.updateStatus({
      contextTokenCount: this.getDisplayedCurrentContextTokens(),
      contextTokenLimit: this.agent.effectiveContextWindow,
      ...this.resolutionIndicatorState(),
    });
  }

  /**
   * The footer's degraded marker. Recomputed on every footer refresh rather
   * than set once: `network-resolver-unwired` is appended at the first
   * prompt, so a flag written only at startup would never light for it.
   *
   * `info` notes are excluded deliberately. `duplex-cost-cap-unset` is an
   * info note that fires on every default duplex session, so counting info
   * here would leave the marker permanently on and carrying no information.
   */
  private resolutionIndicatorState(): { resolutionDegraded: boolean } {
    return {
      resolutionDegraded: this.getResolutionReport()
        .some((note) => note.severity === 'degraded'),
    };
  }

  // ---------------------------------------------------------------------------
  // Background retry status (compact, in-place line)
  // ---------------------------------------------------------------------------

  /**
   * Begin (or update) the compact retry countdown. Replaces the "thinking"
   * spinner with a single line that ticks down to the next attempt; a 1s timer
   * keeps the countdown live.
   */
  private startRetryCountdown(info: RetryScheduledInfo, loopPath: string): void {
    this.retryState = { info, loopPath };
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
   * Tear down the retry UI only if the loop reporting the resolution is the
   * one whose countdown is on screen. The other loop's retry is not the one
   * the user is watching, and clearing on it would blank a live countdown.
   */
  private clearRetryFor(loopPath: string): void {
    if (this.retryState && this.retryState.loopPath !== loopPath) return;
    this.clearRetry();
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

  /**
   * Write the session out once, now, before it has done anything.
   *
   * Persistence is otherwise driven by `onStateChanged`, which the facade
   * only emits from a `getState()` taken at gate quiescence. A session that
   * starts work and never reaches quiescence therefore never wrote anything:
   * a brand-new session killed during its first task left no `meta.json`, so
   * `listSessions()` could not see it and `/resume` could not find it. Not
   * stale, invisible.
   *
   * The agent is idle at both call sites, so the snapshot is a real
   * consistent composite rather than a placeholder, and it gives
   * {@link crashCheckpoint} the talker side it needs as a base.
   *
   * Callers must not invoke this on a resumed session before `resume()` has
   * read the file: `start()` runs first, and an unconditional write there
   * would overwrite the very session the user asked to resume with an empty
   * agent.
   */
  private async writeInitialCheckpoint(): Promise<void> {
    if (!this.agent) return;
    try {
      const state = await this.agent.getState();
      this.lastCompositeState = state;
      const { saveSessionState } = await import('./persistence/sessions.js');
      await saveSessionState(this.sessionId, state, this.buildSessionMeta());
    } catch (err) {
      log.warn('Initial session checkpoint failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * A crash-recovery checkpoint taken at a turn boundary, mid-run.
   *
   * `getState()` cannot help here: it resolves only when the loop gate is
   * empty, and a ten-minute task holds the gate for its whole duration, so
   * settlement-driven persistence writes nothing until the task is over. That
   * is a crash away from losing the task.
   *
   * Passthrough only, deliberately. A turn boundary is a coherent point for
   * ONE loop (pi has appended the assistant message and every tool result of
   * the batch before `turn_end` fires), and in passthrough that one loop is
   * the whole agent, so this is a consistent snapshot rather than the mid-run
   * partial the old `triggerAutoSave` was taking. Under duplex it would not
   * be: the other loop can be mid-turn at this instant, and the consumer has
   * no way to read its history except through the `getState()` that is
   * blocked. Closing that gap needs a turn-boundary snapshot on the facade,
   * not a workaround here.
   *
   * Observational memory rides along only when neither the observer nor the
   * reflector is in flight. Its buffer watermark indexes into history, so a
   * generation landing between the two reads would persist a watermark that
   * does not match what was saved; omitting it costs observations on crash
   * recovery and keeps the artifact coherent.
   */
  private crashCheckpoint(): void {
    if (!this.agent || this.agentMode !== 'passthrough') return;
    const base = this.lastCompositeState;
    if (!base) return;

    const memorySettled = this.compactionStrategy === 'observational'
      ? !this.agent.getCompactionManager().isObserverInFlight()
        && !this.agent.getCompactionManager().isReflectorInFlight()
      : true;
    const usage = this.agent.getSessionUsage();

    this.recordComposite({
      ...base,
      log: this.agent.getLog(),
      // Passthrough: the conversation loop IS the reasoner. The talker side
      // comes from the base snapshot rather than being blanked, so a duplex
      // artifact restored into this session round-trips instead of losing a
      // half it cannot see.
      reasonerHistory: this.agent.getConversationHistory(),
      reasonerMemory: memorySettled ? this.agent.getObservationalMemoryState() : null,
      usage: { ...base.usage, total: usage, perLoop: { ...base.usage.perLoop, reasoner: usage } },
    });
  }

  /**
   * The composite snapshot to write at exit. `getState()` resolves only at a
   * quiescence window, so a session still mid-run at exit would block the
   * shutdown path; bound the wait and fall back to the last snapshot the
   * facade published, which is stale by at most one debounce rather than
   * absent.
   */
  private async finalCompositeState(agent: CortexAgent): Promise<CortexAgentStateV2 | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SHUTDOWN_SNAPSHOT_TIMEOUT_MS);
      timer.unref();
    });
    try {
      const fresh = await Promise.race([agent.getState().catch(() => null), bound]);
      return fresh ?? this.lastCompositeState;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Cache the composite snapshot and queue it for disk. The snapshot carries
   * the session log, BOTH loops' histories and observational memory, and
   * per-loop usage, so nothing that only exists on the conversation loop is
   * lost. The reasoner-only trio (`getConversationHistory()` plus
   * `getObservationalMemoryState()` plus `getSessionUsage()`) that used to
   * build a v1 artifact here reads the work transcript under duplex, and the
   * dialogue it omits was never written, so no later migration could get it
   * back.
   */
  private recordComposite(state: CortexAgentStateV2): void {
    this.lastCompositeState = state;
    try {
      this.saver.save(state, this.buildSessionMeta());
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
    // Scan every internal-tag alias (<working>, <thinking>, ...) so a model
    // that drifted to its trained scratchpad tag still feeds the spinner
    // subtitle instead of silently vanishing from it.
    let lastOpenIdx = -1;
    let openTagLen = 0;
    let lastCloseIdx = -1;
    for (const name of INTERNAL_TAG_NAMES) {
      const openTag = `<${name}>`;
      const openIdx = rawText.lastIndexOf(openTag);
      if (openIdx > lastOpenIdx) {
        lastOpenIdx = openIdx;
        openTagLen = openTag.length;
      }
      lastCloseIdx = Math.max(lastCloseIdx, rawText.lastIndexOf(`</${name}>`));
    }

    if (lastOpenIdx > lastCloseIdx) {
      // Inside an unclosed working tag (streaming)
      setOpen(true);
    } else if (wasOpen && lastCloseIdx >= lastOpenIdx) {
      // Working tag just closed: extract content and enqueue for display
      const content = rawText.slice(lastOpenIdx + openTagLen, lastCloseIdx).trim();
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

  /**
   * The session's resolution report: what the assembly actually resolved to
   * where that differs from what was configured.
   *
   * Read live rather than snapshotted at startup. Most notes are assembly
   * facts, but `network-resolver-unwired` is recorded when the check first
   * runs, which is at the first prompt, so a report captured once at startup
   * would permanently miss the one note this CLI can currently produce.
   */
  getResolutionReport(): ResolutionNote[] {
    return this.agent?.getResolutionReport() ?? [];
  }
  getYoloMode(): boolean { return this.yoloMode; }
  /** The facade mode in force, resolved at construction. See {@link agentMode}. */
  getAgentMode(): NonNullable<CortexAgentConfig['mode']> { return this.agentMode; }
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
