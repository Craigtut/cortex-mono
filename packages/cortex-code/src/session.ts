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
  stripWorkingTags,
} from '@animus-labs/cortex';
import { SelectList, type SelectItem } from '@mariozechner/pi-tui';
import { App, type AppCallbacks } from './tui/app.js';
import { selectListTheme } from './tui/theme.js';
import { OverlayBox } from './tui/overlay-box.js';
import { type CortexCodeConfig } from './config/config.js';
import { CredentialStore } from './config/credentials.js';
import { PermissionRuleManager } from './permissions/rules.js';
import { discoverProjectContext } from './discovery/context.js';
import { discoverSkills } from './discovery/skills.js';
import { discoverMcpServers } from './discovery/mcp.js';
import { checkProjectMcpTrust, trustProjectMcpConfig } from './discovery/mcp-trust.js';
import {
  generateSessionId,
  createDebouncedSaver,
  type SessionMeta,
} from './persistence/sessions.js';
import { getCommand, registerBuiltinCommands } from './commands/index.js';
import type { Mode } from './modes/types.js';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from './logger.js';
import { getOllamaHost, getOllamaContextWindow } from './providers/ollama.js';

const execFileAsync = promisify(execFile);

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
  resumeSessionId: string | undefined;
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
  private saver: ReturnType<typeof createDebouncedSaver>;
  private isRunning = false;
  private createdAt: number;
  private permissionLockPromise: Promise<void> | null = null;
  private permissionLockRelease: (() => void) | null = null;

  private readonly config: CortexCodeConfig;
  private readonly mode: Mode;
  private readonly model: CortexModel;
  private provider: string;
  private modelId: string;
  private readonly providerManager: ProviderManager;
  private readonly credentialStore: CredentialStore;
  private readonly cwd: string;

  constructor(options: SessionOptions) {
    this.config = options.config;
    this.mode = options.mode;
    this.model = options.model;
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.providerManager = options.providerManager;
    this.credentialStore = options.credentialStore;
    this.cwd = options.cwd;
    this.yoloMode = options.yoloMode;
    this.preferredEffort = options.initialEffort;
    this.effectiveEffort = this.preferredEffort;
    this.rules = new PermissionRuleManager(options.cwd);
    this.sessionId = options.resumeSessionId ?? generateSessionId();
    this.saver = createDebouncedSaver(this.sessionId);
    this.createdAt = Date.now();
  }

  /** Start the session: create agent, set up context, wire events, start TUI. */
  async start(): Promise<void> {
    log.info('Session starting', { provider: this.provider, model: this.modelId, cwd: this.cwd });
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
    this.app = new App(callbacks, this.cwd);

    // Create agent (built-in tools are auto-registered by Cortex)
    this.agent = await CortexAgent.create({
      model: this.model,
      utilityModel: 'default',
      workingDirectory: this.cwd,
      initialBasePrompt: this.mode.systemPrompt,
      slots: this.mode.contextSlots,
      resolvePermission: (toolName, toolArgs) => this.resolvePermission(toolName, toolArgs),
      getApiKey: (provider) => this.getApiKey(provider),
      contextWindowLimit: this.config.contextWindowLimit ?? null,
      logger: log,
    });

    // Set up context slots
    const projectContext = await discoverProjectContext(this.cwd);
    const ctx = this.agent.getContextManager();
    ctx.setSlot('system-prompt', this.mode.systemPrompt);
    if (projectContext) {
      ctx.setSlot('project-context', projectContext);
    }

    // Set up ephemeral context
    await this.updateEphemeralContext();

    // Wire events
    this.wireEvents();

    // Connect MCP servers (with trust-on-first-use for project-local configs)
    await this.connectMcpServersWithTrust();

    // Register skills
    const skills = await discoverSkills(this.cwd);
    for (const skill of skills) {
      this.agent.getSkillRegistry().addSkill(skill);
    }
    // Refresh autocomplete after skills are registered
    this.app.refreshCommands(this.cwd);

    // Apply initial thinking level
    const { effective: initialEffort } = await this.reconcileEffort();

    // Show banner
    const branch = await this.getGitBranch();
    const project = this.cwd.split('/').pop() ?? '';
    this.app.transcript.addBanner('0.1.0', project, branch);

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
    });

    // Start TUI event loop
    this.app.start();
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
          await cmd.handler(this);
          return;
        }
      }
    }

    if (!this.agent) return;

    // If the agent is already running, steer it with the new message
    if (this.isRunning) {
      log.info('Steering agent with user message', { text: text.slice(0, 100) });
      this.app!.transcript.addUserMessage(text);
      this.agent.steer(text);
      return;
    }

    log.info('User prompt', { text: text.slice(0, 100) });

    // Add user message to transcript
    this.app!.transcript.addUserMessage(text);

    // Update ephemeral context
    await this.updateEphemeralContext();

    // Show spinner
    this.app!.showStatusSpinner('Thinking...');
    this.isRunning = true;

    try {
      await this.agent.prompt(text);
    } catch (err) {
      log.error('Prompt error', { error: err instanceof Error ? err.message : String(err) });
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
      this.app!.hideStatusSpinner();
      this.app!.focusEditor();
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

  /** Wire all CortexAgent events to the TUI. */
  private wireEvents(): void {
    if (!this.agent || !this.app) return;
    const bridge = this.agent.getEventBridge();

    // Streaming response chunks
    let assistantStarted = false;
    bridge.on('response_start', (event: CortexEvent) => {
      if (event.childTaskId) return;
      assistantStarted = false;
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
        this.app!.transcript.appendAssistantChunk(delta);
      }
    });

    // Tool call lifecycle (uses typed payloads from EventBridge)
    bridge.on('tool_call_start', (event: CortexEvent) => {
      // Drop child agent tool events entirely; sub-agent internals are not shown
      if (event.childTaskId) return;

      const p = event.payload as import('@animus-labs/cortex').ToolCallStartPayload | undefined;
      const toolName = p?.toolName ?? String((event.data as Record<string, unknown> | undefined)?.['toolName'] ?? 'unknown');

      // SubAgent tool calls are displayed via the onSubAgentSpawned lifecycle hook
      if (toolName === 'SubAgent') return;

      const toolCallId = p?.toolCallId ?? String((event.data as Record<string, unknown> | undefined)?.['toolCallId'] ?? Math.random());
      const args = p?.args ?? ((event.data as Record<string, unknown> | undefined)?.['args'] as Record<string, unknown> ?? {});

      this.app!.transcript.startToolCall(toolCallId, toolName, args);
    });

    // Streaming tool updates (bash output, etc.)
    bridge.on('tool_call_update', (event: CortexEvent) => {
      if (event.childTaskId) return;

      const p = event.payload as import('@animus-labs/cortex').ToolCallUpdatePayload | undefined;
      const toolCallId = p?.toolCallId ?? String((event.data as Record<string, unknown> | undefined)?.['toolCallId'] ?? '');
      const partialResult = p?.partialResult ?? (event.data as Record<string, unknown> | undefined)?.['partialResult'];

      if (partialResult) {
        this.app!.transcript.updateToolCall(toolCallId, partialResult);
      }
    });

    bridge.on('tool_call_end', (event: CortexEvent) => {
      // Drop child agent tool events entirely
      if (event.childTaskId) return;

      const p = event.payload as import('@animus-labs/cortex').ToolCallEndPayload | undefined;
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
    });

    // Loop complete (auto-save, update footer, hide spinner)
    this.agent.onLoopComplete(() => {
      this.isRunning = false;
      this.triggerAutoSave();
      this.updateFooterContextUsage();
      this.app?.hideStatusSpinner();
      this.app?.focusEditor();
    });

    // Error handling with per-category display
    this.agent.onError((error: ClassifiedError) => {
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

    // Sub-agent events: rendered as tool calls via the SubAgent renderer
    this.agent.onSubAgentSpawned((taskId, instructions, background) => {
      this.app!.transcript.startToolCall(taskId, 'SubAgent', {
        instructions,
        background,
        modelId: this.agent!.getModel().modelId,
      });
    });

    this.agent.onSubAgentCompleted((taskId, result, _status, usage) => {
      const u = typeof usage === 'object' && usage !== null
        ? usage as Record<string, unknown>
        : {};
      this.app!.transcript.completeToolCall(taskId, result, {
        background: true,
        turns: Number(u['turns'] ?? 0),
        durationMs: Number(u['durationMs'] ?? 0),
        cost: Number(u['cost'] ?? 0),
        status: _status,
        toolCalls: (u as Record<string, unknown>)['toolCalls'],
      }, Number(u['durationMs'] ?? 0));
    });

    this.agent.onSubAgentFailed((taskId, error) => {
      this.app!.transcript.failToolCall(taskId, error, 0);
    });

    // Background sub-agent result delivery: Cortex restarts the agentic loop
    // automatically; update TUI state so the user sees activity.
    this.agent.onBackgroundResultDelivery(() => {
      this.isRunning = true;
      this.app!.showStatusSpinner('Processing background results...');
    });

    // Update tokens and auto-save on turn_end (fires after each LLM turn,
    // including mid-loop turns between tool calls)
    bridge.on('turn_end', () => {
      this.updateFooterContextUsage();
      this.triggerAutoSave();
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
    if (this.yoloMode) return true;

    // Auto-allow read-only tools within the project directory
    if (this.isReadOnlyInProject(toolName, toolArgs)) return true;

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

    try {
      const result = await this.app.showPermissionPrompt(toolName, toolArgs);

      if (result.scope === 'project-edits') {
        // Project-wide edit/write permission: add rules for both tools
        const cwdPattern = `${this.cwd}/*`;
        await this.rules.addRule('project', 'allow', 'Edit', cwdPattern);
        await this.rules.addRule('project', 'allow', 'Write', cwdPattern);
      } else if (result.pattern && result.scope) {
        await this.rules.addRule(result.scope, result.decision, toolName, result.pattern);
      }

      return result.decision === 'allow' ? true : { decision: 'block' };
    } finally {
      const release = this.permissionLockRelease;
      this.permissionLockPromise = null;
      this.permissionLockRelease = null;
      release?.();
    }
  }

  /** Check if a tool call is a read-only operation within the project directory. */
  private isReadOnlyInProject(toolName: string, toolArgs: unknown): boolean {
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

  /** Check if an absolute path is within the current working directory. */
  private isWithinCwd(targetPath: string): boolean {
    if (!targetPath) return false;
    const resolved = path.resolve(targetPath);
    const cwdWithSep = this.cwd.endsWith(path.sep) ? this.cwd : this.cwd + path.sep;
    return resolved === this.cwd || resolved.startsWith(cwdWithSep);
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
    const { loadSession: load } = await import('./persistence/sessions.js');
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

    this.app?.transcript.addNotification(
      'Session Resumed',
      `Restored ${saved.history.length} messages from previous session`,
    );
    this.updateFooterContextUsage();
  }

  /** Abort the current agent loop without destroying. */
  async abort(): Promise<void> {
    if (this.agent && this.isRunning) {
      await this.agent.abort();
    }
    this.isRunning = false;
    this.app?.hideStatusSpinner();
    this.app?.focusEditor();
  }

  /** Graceful shutdown: save, destroy agent, stop TUI. */
  async shutdown(): Promise<void> {
    // Flush pending saves
    await this.saver.flush();

    // Immediate final save
    if (this.agent) {
      try {
        const history = this.agent.getConversationHistory();
        const meta = this.buildSessionMeta();
        const { saveSession } = await import('./persistence/sessions.js');
        await saveSession(this.sessionId, history, meta);
      } catch {
        // Best-effort save during shutdown
      }

      await this.agent.destroy();
      this.agent = null;
    }

    this.app?.stop();
    process.exit(0);
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

  private updateFooterContextUsage(): void {
    if (!this.agent || !this.app) return;
    this.app.updateStatus({
      contextTokenCount: this.getDisplayedCurrentContextTokens(),
      contextTokenLimit: this.agent.effectiveContextWindow,
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
      this.saver.save(history, meta);
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
    // Pi-agent-core message_update events contain text deltas in various shapes
    // depending on the provider. Try common patterns:
    if (typeof data['text'] === 'string') return data['text'];
    if (typeof data['delta'] === 'string') return data['delta'];
    if (typeof data['content'] === 'string') return data['content'];
    // Nested: data.delta.text or data.content_block_delta.delta.text
    const delta = data['delta'] as Record<string, unknown> | undefined;
    if (delta && typeof delta['text'] === 'string') return delta['text'];
    return null;
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

    let effective: ThinkingLevel;
    let clamped = false;
    let reason: string | undefined;

    if (!caps.supportsThinking) {
      effective = 'off';
      if (this.preferredEffort !== 'off') {
        clamped = true;
        reason = `${this.modelId} does not support thinking. Effort disabled.`;
      }
    } else if (this.preferredEffort === 'max' && !caps.supportsMax) {
      effective = 'high';
      clamped = true;
      reason = `${this.modelId} does not support Max effort. Using High.`;
    } else if (this.preferredEffort === 'off') {
      effective = 'off';
    } else {
      effective = this.preferredEffort;
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
    // Reconcile effort with new model's capabilities
    const { clamped, reason, effective } = await this.reconcileEffort();
    this.app?.updateStatus({ provider: newProvider, model: newModelId, effortLevel: effective, contextTokenLimit: this.agent!.effectiveContextWindow });
    if (clamped && reason) {
      this.app?.transcript.addNotification('Effort', reason);
    }
    await this.credentialStore.setDefaults(newProvider, newModelId);
  }
}
