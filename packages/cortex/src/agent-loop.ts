/**
 * AgentLoop: production-grade wrapper for pi-agent-core's Agent.
 *
 * Composes ContextManager, EventBridge, BudgetGuard, system prompt assembly,
 * and lifecycle management into a single orchestrator class.
 *
 * This is the primary public API of the @animus-labs/cortex package.
 *
 * Lifecycle: CREATED -> ACTIVE -> DESTROYED
 *   - CREATED: After construction. Slots can be set, but no loops have run.
 *   - ACTIVE: After first prompt(). The agent is running or idle between prompts.
 *   - DESTROYED: After destroy(). All resources released. prompt() throws.
 *
 * References:
 *   - cortex-architecture.md
 *   - system-prompt.md
 *   - model-tiers.md
 *   - cross-platform-considerations.md
 */

import { ContextManager } from './context-manager.js';
import type { AgentContext, AgentMessage } from './context-manager.js';
import { computeCacheBreakpointIndices } from './cache-breakpoints.js';
import type { CacheBreakpointIndices, DirectCompletionContext } from './cache-breakpoints.js';
import { EventBridge } from './event-bridge.js';
import { BudgetGuard } from './budget-guard.js';
import { classifyError, errorMessageOf, toError } from './error-classifier.js';
import {
  resolveRetryPolicy,
  backoffForAttempt,
  shouldRetry,
  isRetryableCategory,
} from './retry-policy.js';
import { withPlaceholderContent } from './pi-message.js';
import type { McpClientManager } from './mcp-client.js';
import { CompactionManager, buildCompactionConfig } from './compaction/index.js';
import { isContextOverflow } from './compaction/failsafe.js';
import type { ObservationalMemoryState, ObservationEvent, ReflectionEvent } from './compaction/observational/types.js';
import { DEFAULT_IDLE_DIGESTION_OBSERVER_TIMEOUT_MS } from './compaction/observational/index.js';
import { createRecallTool } from './compaction/observational/recall-tool.js';
import { SubAgentManager } from './sub-agent-manager.js';
import type { SkillRegistry } from './skill-registry.js';
import { createSubAgentTool } from './tools/sub-agent.js';
import type { CortexModel } from './model-wrapper.js';
import { SystemPromptState } from './agent-loop/system-prompt.js';
import { HandlerList } from './agent-loop/handler-list.js';
import { ProcessTracker } from './agent-loop/process-tracker.js';
import { UsageLedger } from './agent-loop/usage-ledger.js';
import { wireLoopEvents } from './agent-loop/event-wiring.js';
import { DirectCompletions } from './agent-loop/direct-completion.js';
import { ModelSettings } from './agent-loop/model-settings.js';
import { SkillBinding } from './agent-loop/skills.js';
import { createBuiltinTools } from './agent-loop/builtin-tools.js';
import { ToolRegistry } from './agent-loop/tool-registry.js';
import { McpAttachment } from './agent-loop/mcp-attachment.js';
import { DeliveryQueues } from './agent-loop/delivery-queues.js';
import { BackgroundDelivery } from './agent-loop/background-delivery.js';
import type { PendingBackgroundCompletion } from './agent-loop/background-delivery.js';
import type {
  DeliverOptions,
  DeliverResult,
  QueuedDelivery,
} from './agent-loop/delivery-queues.js';
import {
  ABORTED,
  AbortState,
  isAbortShapedError,
  LoopGate,
  raceAbort,
  raceTimeout,
  sleepUnlessAborted,
} from './agent-loop/run-control.js';
import { CHILD_SEED_CONTEXT_SLOT, prepareChildLoop } from './agent-loop/child-loop-config.js';
import type { ChildLoopParams } from './agent-loop/child-loop-config.js';
import { SubAgentSpawner } from './agent-loop/sub-agent-spawner.js';
import type { ForegroundSpawnResult, SubAgentSpawnParams } from './agent-loop/sub-agent-spawner.js';
import { mirrorChildPermissionResolver, PendingAskRegistry } from './agent-loop/permissions.js';
import {
  buildPiAgentConfig,
  loadAgentClass,
  ToolResultFinalizer,
  wirePiTransformContext,
} from './agent-loop/pi-hooks.js';
import type { PiHookHost, ToolResultInterceptor } from './agent-loop/pi-hooks.js';
import { DeadLetterStore } from './agent-loop/delivery-failure.js';
import { buildBackgroundTaskState } from './agent-loop/background-task-text.js';
import type { DirectCompletionOptions } from './agent-loop/direct-completion.js';
import { estimateTokens } from './token-estimator.js';
import type { CortexToolRuntime } from './tools/runtime.js';
import { NOOP_LOGGER } from './noop-logger.js';
import { PromptWatchdogDiagnostics } from './prompt-diagnostics.js';
import type { CortexTool } from './tool-contract.js';
import type {
  CortexLogger,
  AgentLoopConfig,
  CortexLifecycleState,
  CortexUsage,
  SessionUsage,
  ClassifiedError,
  RetryPolicy,
  RetryScheduledInfo,
  RetrySucceededInfo,
  RetryExhaustedInfo,
  AgentTextOutput,
  CompactionResult,
  CompactionTarget,
  CompactionDegradedInfo,
  CompactionExhaustedInfo,
  McpTransportConfig,
  McpConnectionState,
  McpToolCallProgress,
  LoadedSkill,
  SubAgentSpawnConfig,
  DeadLetteredBackgroundResult,
  SubAgentSnapshot,
  TrackedSubAgent,
  BudgetScope,
  PendingAsk,
  LoopOriginContext,
  ThinkingLevel,
  ModelThinkingCapabilities,
} from './types.js';
import { DEFAULT_LOOP_PATH } from './types.js';
import {
  isResumableAfterTrim,
  trimTrailingFailures,
} from './agent-loop/transcript-repair.js';
import {
  clampToSupported,
  fromPiThinkingLevel,
  modelThinkingCapabilities,
  toPiThinkingLevel,
} from './agent-loop/pi-agent.js';
import type {
  AgentLoopConstructorOptions,
  CacheRetention,
  PiAgent,
  QueueDrainMode,
  RegisteredTool,
} from './agent-loop/pi-agent.js';

export type { PiAgent, PiModel, QueueDrainMode } from './agent-loop/pi-agent.js';
export type { DirectCompletionOptions } from './agent-loop/direct-completion.js';
export type { DeliverOptions, DeliverOutcome, DeliverResult } from './agent-loop/delivery-queues.js';
export { TOOL_RESULT_WORKING_TAGS_REMINDER } from './agent-loop/pi-hooks.js';
export type {
  ToolResultInterceptor,
  ToolResultInterceptorInfo,
  ToolResultInterceptorResult,
} from './agent-loop/pi-hooks.js';

/**
 * Default hard token cap for the consumer-fed headline block. Injected
 * user-role content is never trimmed by microcompaction, so an unbounded
 * block would inflate utilization (triggering early source compaction)
 * without itself shrinking; the cap is enforced here, not downstream.
 */
const DEFAULT_HEADLINE_MAX_TOKENS = 2_000;

/** Marker appended when a headline block is cut at its token cap. */
const HEADLINE_TRUNCATION_MARKER = '\n[headline block truncated]';

/**
 * Legacy fallback for unknown capacity. Explicit budgets have no minimum floor.
 */
export { MINIMUM_CONTEXT_WINDOW } from './context-budget.js';

/** Options for {@link AgentLoop.digestIdle}. */
export interface IdleDigestionOptions {
  /**
   * Wall-clock budget applied to EACH bounded phase of the digestion
   * (default 60s): the observer catch-up waits, and then the blocking
   * threshold pass (activation, reflection, classic summarization). Idle
   * digestion holds the loop gate, so a hung utility request in either
   * phase must time the digestion out (the hung call left in flight)
   * rather than wedge the gate: while the gate is wedged, prompt() fails
   * fast and parked wake deliveries wait on the sweep behind it. The
   * timed-out pass is invalidated: if the hung call settles later, its
   * history mutations are discarded rather than applied over live state.
   */
  observerTimeoutMs?: number;
  /**
   * Preempts the digestion: when it aborts, the pass stops waiting exactly
   * as a timeout would (the in-flight call is left to settle and its
   * mutations are discarded) and releases the gate at once. An owner that
   * digests in idle windows aborts it when input arrives, so a user's next
   * words never wait behind background compaction.
   */
  signal?: AbortSignal;
}

/** Result of {@link AgentLoop.digestIdle}. */
export interface IdleDigestionResult {
  /**
   * Whether an observer call ran to completion to buffer unobserved
   * history. False also covers a wait abandoned at observerTimeoutMs.
   */
  observerRan: boolean;
  /**
   * Whether the threshold pass changed the durable history (observation
   * activation trimmed it, or summarization rewrote it).
   */
  historyCompacted: boolean;
  /** Whether the pass was cut short by {@link IdleDigestionOptions.signal}. */
  preempted?: boolean;
}

/**
 * Wrap a logger so every message carries the loop's identity prefix. All
 * components logging through the loop's logger (the loop itself, the prompt
 * watchdog, the event bridge, budget guard, compaction, MCP) inherit it, so
 * concurrent loops stay distinguishable in shared log output.
 */
function prefixLoggerWithLoopPath(logger: CortexLogger, loopPath: string): CortexLogger {
  const prefix = `[AgentLoop:${loopPath}]`;
  return {
    debug: (message, data) => logger.debug(`${prefix} ${message}`, data),
    info: (message, data) => logger.info(`${prefix} ${message}`, data),
    warn: (message, data) => logger.warn(`${prefix} ${message}`, data),
    error: (message, data) => logger.error(`${prefix} ${message}`, data),
  };
}

// ---------------------------------------------------------------------------
// AgentLoop
// ---------------------------------------------------------------------------

export class AgentLoop {
  private readonly agent: PiAgent;
  private readonly contextManager: ContextManager;
  private readonly eventBridge: EventBridge;
  private readonly budgetGuard: BudgetGuard;
  private readonly config: AgentLoopConfig;
  private readonly retryPolicy: RetryPolicy;
  private readonly logger: CortexLogger;
  /**
   * Path identity of this loop (config `loopPath`, default 'main'). Threaded
   * through permission asks, callback origin context, persistResult metadata,
   * and log prefixes; sub-agents extend it with '/<taskId>'.
   */
  readonly loopPath: string;

  /**
   * This loop's identity as the trailing argument of every fan-out callback.
   *
   * A composite agent registers one consumer handler on several loops, so
   * without this a duplex consumer receives two of everything with no way to
   * tell them apart: two retry countdowns for one provider hiccup, two
   * compaction notifications, two observation events. The fan-out itself is
   * correct (both loops really did do the thing); what was missing was the
   * label saying which.
   */
  private get originContext(): LoopOriginContext {
    return { loopPath: this.loopPath };
  }

  private readonly promptDiagnostics: PromptWatchdogDiagnostics;
  private workingTagsEnabled: boolean;
  private readonly workingDirectory: string;
  private readonly envOverrides: Record<string, string> | undefined;

  private lifecycleState: CortexLifecycleState = 'created';
  private readonly systemPrompt: SystemPromptState;

  private _activePromptCacheRetention: CacheRetention | null = null;

  // Primary and utility models, context window limit, cache retention, session key.
  private readonly models: ModelSettings;

  // Registered and MCP tools, their pi adaptation, runtime, and result persistence
  private readonly tools: ToolRegistry;

  // Compaction Manager
  private readonly compactionManager: CompactionManager;


  // Event handlers (consumer-registered callbacks)
  private readonly loopCompleteHandlers: HandlerList<[LoopOriginContext]>;
  private readonly errorHandlers: HandlerList<[ClassifiedError, LoopOriginContext]>;
  private readonly retryScheduledHandlers: HandlerList<[RetryScheduledInfo, LoopOriginContext]>;
  private readonly retrySucceededHandlers: HandlerList<[RetrySucceededInfo, LoopOriginContext]>;
  private readonly retryExhaustedHandlers: HandlerList<[RetryExhaustedInfo, LoopOriginContext]>;
  private readonly turnCompleteHandlers: HandlerList<[AgentTextOutput, LoopOriginContext]>;
  // Finished background work waiting to be delivered to the loop
  private readonly background: BackgroundDelivery;
  // Content the loop gave up delivering (bounded; survives destroy)
  private readonly deadLetters: DeadLetterStore;

  // Loop-owned silent and parked-wake delivery queues
  private readonly queues: DeliveryQueues;

  // Permission asks blocked on a resolver decision (this loop's and its children's)
  private readonly asks = new PendingAskRegistry();

  // Consumer-fed headline block: rebuilt from the provider on every LLM
  // call, view-injected after the BP3 cache boundary (never in the cached
  // prefix, never in the transcript), hard token-capped.
  private headlineProvider: (() => string | null) | null = null;
  /** Tool-result interceptor and working-tags reminder (pi's afterToolCall). */
  private readonly finalizer: ToolResultFinalizer;
  private headlineMaxTokens = DEFAULT_HEADLINE_MAX_TOKENS;

  // Set while digestIdle() runs the transform pipeline, so the compaction
  // manager runs its blocking work (sync observer, summarization) even
  // under the non-blocking posture: the idle window is exactly where that
  // work is supposed to happen.
  private _forceBlockingCompaction = false;

  // Generation token for transform/digestion passes (mirrors the buffering
  // engine's activationEpoch). A timed-out digestIdle() threshold pass is
  // abandoned, not cancelled: its hung utility call can settle minutes
  // later, after the gate released and a real prompt appended messages.
  // Advancing the generation at abandonment makes that late continuation
  // discard itself: it must neither rewrite history from its stale
  // snapshot nor lower _forceBlockingCompaction under a later pass.
  private _digestionGeneration = 0;

  // Event bridge unsubscribers (for cleanup)
  private eventUnsubscribers: Array<() => void> = [];

  // The current run's abort controller and the abort epoch (run-control.ts)
  private readonly abortState = new AbortState();

  // Whether a prompt() call is currently in progress
  private _isPrompting = false;

  // Cause tags of the run currently holding the gate (see
  // DeliverOptions.causeTag): computed in the same synchronous frame that
  // takes the delivery batches at run start, assigned as the first statement
  // of the try owning the clearing finally, so the set and the clear are
  // paired by construction and a reader can never observe a dead or previous
  // run's tags from a later run.
  private _activeRunCauseTags: readonly unknown[] = [];
  // Tag handoff for the deliver() prompted branch: deliver() sets it
  // immediately before calling prompt() with the gate empty, so the very
  // next run task (that prompt's own) is the one that consumes it.
  private pendingPromptCauseTag: unknown = undefined;

  // Serializes every loop-owning task (run-control.ts)
  private readonly gate = new LoopGate();

  // Resolves when the current turn's unwind (catch/finally of runPromptOnce)
  // has completed. abort() awaits this so its controller reset can never land
  // before the cancelled turn's error classification observes the abort.
  private turnUnwound: Promise<void> = Promise.resolve();
  private resolveTurnUnwound: (() => void) | null = null;

  // In-flight destroy(). Concurrent destroy() calls share one teardown.
  private destroyPromise: Promise<void> | null = null;

  // Tracked subprocess PIDs for synchronous exit cleanup (Level 3 safety net)
  private readonly processes = new ProcessTracker();

  // The MCP client manager this loop is attached to (owned or shared).
  private readonly mcp: McpAttachment;

  // Sub-Agent Manager for tracking active sub-agents
  private readonly subAgentManager: SubAgentManager;
  private readonly subAgents: SubAgentSpawner;

  // Skill registry, the load_skill tool, and the loaded-skill buffer
  private readonly skills: SkillBinding;

  // Cache breakpoint optimization: boundary tracking and API index state.
  // _prePromptMessageCount records agent.state.messages.length BEFORE each
  // prompt() call, marking the boundary between "old history" (stable,
  // cacheable) and "new tick content" (varies per tick). This enables
  // cross-tick prefix caching of conversation history.
  private _prePromptMessageCount: number = 0;

  // Shared state between getTransformContextHook() and the onPayload hook.
  // Computed in transformContext (which has the transformed message array),
  // consumed in onPayload (which has the final Anthropic API params).
  // Stores the API-level message indices where cache_control breakpoints
  // should be injected (BP2 = after last slot, BP3 = old history boundary).
  private _cacheBreakpointIndices: CacheBreakpointIndices | null = null;

  // Session-lifetime usage plus the last direct completion's usage.
  private readonly usage = new UsageLedger();
  private readonly completions: DirectCompletions;

  /**
   * Create an AgentLoop. Prefer AgentLoop.create().
   *
   * @param agent - A pi-agent-core Agent instance
   * @param config - AgentLoop configuration
   * @throws Error if the utility model violates the same-provider constraint
   */
  private constructor(
    agent: PiAgent,
    config: AgentLoopConfig,
    tools?: RegisteredTool[],
    options?: AgentLoopConstructorOptions,
  ) {
    this.agent = agent;
    this.config = config;
    this.retryPolicy = resolveRetryPolicy(config.retryPolicy);
    this.loopPath = config.loopPath ?? DEFAULT_LOOP_PATH;
    this.logger = prefixLoggerWithLoopPath(config.logger ?? NOOP_LOGGER, this.loopPath);
    this.loopCompleteHandlers = new HandlerList('onLoopComplete', this.logger);
    this.errorHandlers = new HandlerList('onError', this.logger);
    this.retryScheduledHandlers = new HandlerList('onRetryScheduled', this.logger);
    this.retrySucceededHandlers = new HandlerList('onRetrySucceeded', this.logger);
    this.retryExhaustedHandlers = new HandlerList('onRetryExhausted', this.logger);
    this.turnCompleteHandlers = new HandlerList('onTurnComplete', this.logger);
    this.deadLetters = new DeadLetterStore(this.logger);
    this.queues = new DeliveryQueues({
      gate: this.gate,
      abort: this.abortState,
      isAborted: () => this.isAborted(),
      isShuttingDown: () => this.isShuttingDown(),
      assertNotShuttingDown: () => this.assertNotShuttingDown(),
      hasSystemPrompt: () => this.systemPrompt.isConfigured(),
      isPrompting: () => this._isPrompting,
      budgetBreached: () => this.budgetGuard.isBreached(),
      startPrompt: (content, options, causeTag) => {
        this.pendingPromptCauseTag = causeTag;
        return this.prompt(content, options);
      },
      runDeliveryTurn: (message, retryPolicy, causeTags) =>
        this.runPromptOnce(message, undefined, true, retryPolicy, causeTags),
      appendActiveCauseTags: (tags) => {
        this._activeRunCauseTags = [...this._activeRunCauseTags, ...tags];
      },
      transcript: {
        messages: () => this.agent.state.messages,
        boundary: () => this._prePromptMessageCount,
        notifyTailTrimmed: () => this.notifySourceHistoryTailTrimmed(),
      },
      piQueues: this.agent,
      deadLetters: this.deadLetters,
      retryPolicy: this.retryPolicy,
      emitError: (error) => this.emitError(error),
      logger: this.logger,
    });
    this.background = new BackgroundDelivery({
      gate: this.gate,
      abort: this.abortState,
      isAborted: () => this.isAborted(),
      isShuttingDown: () => this.isShuttingDown(),
      isCancelled: (taskId) => this.subAgentManager.isCancelled(taskId),
      runDeliveryTurn: (message, retryPolicy) =>
        this.runPromptOnce(message, undefined, true, retryPolicy),
      unwindFailedDelivery: (preDeliveryCount, runAbortEpoch) =>
        this.unwindFailedDelivery(preDeliveryCount, runAbortEpoch),
      messages: () => this.agent.state.messages,
      backgroundTasks: {
        get: (taskId) => this.tools.runtime.backgroundTasks.get(taskId),
      },
      deadLetters: this.deadLetters,
      retryPolicy: this.retryPolicy,
      emitError: (error) => this.emitError(error),
      logger: this.logger,
    });
    this.promptDiagnostics = new PromptWatchdogDiagnostics(
      config.diagnostics?.promptWatchdog,
      this.logger,
      {
        isPrompting: () => this._isPrompting,
        isAbortRequested: () => this.isAborted(),
      },
      this.loopPath,
    );
    this.workingTagsEnabled = config.workingTags?.enabled ?? true;
    this.workingDirectory = config.workingDirectory;
    this.envOverrides = config.envOverrides;
    this.tools = new ToolRegistry(config, {
      mcpTools: () => this.mcp.manager.getTools(),
      writeAgentTools: (tools) => {
        (this.agent.state as Record<string, unknown>)['tools'] = tools;
      },
      onToolsChanged: () => this.systemPrompt.refresh(),
      refreshTools: () => this.refreshTools(),
      slots: {
        getSlot: (name) => this.contextManager.getSlot(name),
        setSlot: (name, content) => this.contextManager.setSlot(name, content),
      },
      logger: this.logger,
      loopPath: this.loopPath,
    });
    this.finalizer = new ToolResultFinalizer({
      workingTagsEnabled: () => this.workingTagsEnabled,
      logger: this.logger,
    });
    this.systemPrompt = new SystemPromptState({
      agentState: () => this.agent.state,
      hasTool: (name) => this.tools.has(name),
      workingTagsEnabled: () => this.workingTagsEnabled,
      workingDirectory: this.workingDirectory,
    });

    // Resolve models
    if (!config.model) {
      throw new Error('AgentLoopConfig.model is required but was undefined. Pass a CortexModel.');
    }
    this.models = new ModelSettings(config, {
      writeAgentModel: (model) => {
        (this.agent.state as Record<string, unknown>)['model'] = model;
      },
      // Undefined until built below; the settings sync it once it exists.
      compaction: () => this.compactionManager ?? null,
      onModelChanged: () => this.skills.rebuildDescription(),
      logger: this.logger,
    });
    this.completions = new DirectCompletions({
      models: () => ({
        primary: this.models.primary,
        primaryPi: this.models.primaryPi,
        utility: this.models.utility,
        utilityPi: this.models.utilityPi,
      }),
      getApiKey: config.getApiKey,
      cacheRetention: () => this.models.cacheRetention,
      sessionId: () => this.models.sessionId,
      isAborted: () => this.isAborted(),
      emitError: (error, wasAborted) => this.emitError(error, wasAborted),
      emitUtilityUsage: (category, usage) => this.eventBridge.emitUtilityUsage(category, usage),
      ledger: this.usage,
      logger: this.logger,
    });

    // Auto-register built-in tools, filtered by disableTools config
    const disabledSet = new Set(config.disableTools ?? []);
    const builtinTools = createBuiltinTools({
      workingDirectory: this.workingDirectory,
      runtime: this.tools.runtime,
      config,
      utilityComplete: (context, usageCategory) => this.utilityComplete(context, { usageCategory }),
      processes: this.processes,
      onBackgroundTaskComplete: (taskId) => {
        void this.deliverOrQueueBackgroundCompletion({ kind: 'bash', taskId });
      },
      ...(this.tools.deferredEnabled
        ? {
            deferred: {
              registry: this.tools.deferredRegistry,
              onAfterDiscovery: () => this.refreshTools(),
            },
          }
        : {}),
    }, disabledSet);
    this.tools.register([...builtinTools, ...(tools ?? [])]);
    this.models.applyToAgent();

    // Build the slot list. When using observational memory, append the
    // internal observation slot so it occupies the last slot position.
    const compactionConfig = buildCompactionConfig(config.compaction);
    this.tools.bindPersistence(config, compactionConfig.microcompaction);

    const compactionStrategy = compactionConfig.strategy ?? 'observational';
    // Slot ordering by stability (most stable first):
    //   1. `_available_tools` (changes only on MCP server connect/disconnect)
    //   2. consumer slots (consumer decides their own ordering)
    //   3. `_observations`   (changes potentially every turn)
    const slots: string[] = [];
    if (this.tools.deferredEnabled) {
      slots.push('_available_tools');
    }
    slots.push(...(config.slots ?? []));
    if (compactionStrategy === 'observational') {
      slots.push('_observations');
    }

    // Set up ContextManager
    this.contextManager = new ContextManager(agent, {
      slots,
    });

    // Set up EventBridge
    this.eventBridge = new EventBridge(this.workingTagsEnabled, this.logger);
    this.eventBridge.wire(agent);

    // Wire internal event handlers
    this.eventUnsubscribers.push(wireLoopEvents(this.eventBridge, {
      logger: this.logger,
      diagnostics: this.promptDiagnostics,
      ledger: this.usage,
      agentState: () => this.agent.state as unknown as { messages: AgentMessage[]; errorMessage?: unknown },
      slotCount: () => this.contextManager.slotCount,
      compaction: () => this.compactionManager,
      effectiveContextWindow: () => this.effectiveContextWindow,
      budgetSummary: () => ({
        turns: this.budgetGuard.getTurnCount(),
        totalCost: this.budgetGuard.getTotalCost(),
      }),
      onLoopEnd: () => this.skills.clear(),
      loopComplete: this.loopCompleteHandlers,
      turnComplete: this.turnCompleteHandlers,
      origin: this.originContext,
    }));

    // Set up BudgetGuard
    const budgetGuardConfig: {
      maxTurns?: number;
      maxCost?: number;
      scope?: BudgetScope;
      includeChildUsage?: boolean;
      includeUtilityUsage?: boolean;
    } = {};
    if (config.budgetGuard?.maxTurns !== undefined) {
      budgetGuardConfig.maxTurns = config.budgetGuard.maxTurns;
    }
    if (config.budgetGuard?.maxCost !== undefined) {
      budgetGuardConfig.maxCost = config.budgetGuard.maxCost;
    }
    if (config.budgetGuard?.scope !== undefined) {
      budgetGuardConfig.scope = config.budgetGuard.scope;
    }
    if (config.budgetGuard?.includeChildUsage !== undefined) {
      budgetGuardConfig.includeChildUsage = config.budgetGuard.includeChildUsage;
    }
    if (config.budgetGuard?.includeUtilityUsage !== undefined) {
      budgetGuardConfig.includeUtilityUsage = config.budgetGuard.includeUtilityUsage;
    }
    this.budgetGuard = new BudgetGuard(
      budgetGuardConfig,
      () => this.agent.abort(),
      this.logger,
    );
    this.budgetGuard.wire(this.eventBridge);
    // After the budget guard, so a turn that breaches the budget is seen as
    // breached here and does not have content steered into a run that is
    // about to be aborted.
    this.eventUnsubscribers.push(
      this.eventBridge.on('turn_end', (event) => {
        if (event.childTaskId) return;
        this.queues.steerTurnBoundary(event);
      }),
    );

    // Attach to the MCP client manager (private, or a shared external one).
    this.mcp = new McpAttachment(config, this.logger, {
      onSubprocessSpawned: (pid) => this.processes.track(pid),
      onSubprocessExited: (pid) => this.processes.untrack(pid),
      onToolsChanged: () => this.refreshTools(),
    });

    // Set up Sub-Agent Manager (must be before the spawner)
    this.subAgentManager = new SubAgentManager({
      maxConcurrent: config.maxConcurrentSubAgents ?? 4,
      ...(config.subAgentPools ? { pools: config.subAgentPools } : {}),
    });

    // Set up Skill Registry with auto-rebuild callback
    this.skills = new SkillBinding({
      contextWindow: () => this.compactionManager?.contextWindow ?? Math.min(
        this.models.primary.contextWindow,
        this.models.contextWindowLimit ?? this.models.primary.contextWindow,
      ),
      refreshTools: () => this.refreshTools(),
      logger: this.logger,
    });

    // Sub-agent spawning; wires the manager's hooks to the consumer fan-out.
    this.subAgents = new SubAgentSpawner({
      manager: this.subAgentManager,
      createChild: (params) => this.createChildAgent(params),
      eventBridge: this.eventBridge,
      onBackgroundComplete: (item) => this.deliverOrQueueBackgroundCompletion(item),
      purgePendingResult: (taskId) => this.background.purgeSubAgent(taskId),
      logger: this.logger,
    });

    // Create and register the SubAgent tool.
    // Must be after the spawner exists.
    if (options?.enableSubAgentTool !== false) {
      const subAgentTool = createSubAgentTool({
        spawnSubAgent: (params) => this.spawnForegroundSubAgentInternal(params),
        spawnBackgroundSubAgent: (params) => this.spawnBackgroundSubAgentInternal(params),
        // Tool spawns count against the default pool.
        canSpawn: () => this.subAgentManager.canSpawn(),
        checkConsumerSpawn: () => {
          const verdict = this.config.canSpawnSubAgent?.();
          if (verdict === undefined) return { allowed: true };
          if (typeof verdict === 'boolean') return { allowed: verdict };
          return verdict;
        },
        getConcurrencyInfo: () => ({
          active: this.subAgentManager.activeCount,
          limit: this.subAgentManager.limit,
        }),
        getModelId: () => this.models.primary.modelId,
      });
      this.tools.registerInternal(subAgentTool as RegisteredTool);
    }

    // Create and register the load_skill tool.
    // Must be after the skill binding exists.
    if (options?.enableLoadSkillTool !== false) {
      this.tools.registerInternal(this.skills.createLoadSkillTool());
    }

    // Adapt the normalized Cortex tool set to pi-agent-core's raw execute
    // signature and sync the result to the underlying agent.
    this.refreshTools();

    // Set up CompactionManager (reuse compactionConfig from slot registration above)
    this.compactionManager = new CompactionManager(
      compactionConfig,
      slots.length,
    );
    this.compactionManager.setLogger(this.logger);
    // Context windows and cache TTL follow the model settings from here on.
    this.models.syncCompaction();

    if (typeof config.initialBasePrompt === 'string') {
      this.setBasePrompt(config.initialBasePrompt);
    }

    // Wire compaction completion function (uses directComplete). Tagged so
    // L2 summarization spend lands in session usage under its own bucket.
    this.compactionManager.setCompleteFn(async (context) => {
      return this.directComplete(context, { usageCategory: 'summarization' });
    });

    // Wire utility model completion for observer/reflector. The purpose the
    // engine passes per call becomes the usage category, so observer and
    // reflector spend are separable in accounting.
    this.compactionManager.setObservationalCompleteFn(async (context, options) => {
      return this.utilityComplete(
        {
          systemPrompt: context.systemPrompt,
          messages: context.messages as Array<{ role: string; content: string }>,
        },
        { usageCategory: options?.purpose ?? 'observation' },
      );
    });

    // Wire compaction result -> onPostCompaction handlers on the manager.
    // The CompactionManager also calls postCompactionHandlers registered
    // directly via onPostCompaction(); the onCompactionResult handler here
    // is the bridge for results that come through the manager's internal
    // checkAndRunCompaction() path (which already calls its own handlers).
    // No additional bridging needed; consumers register via onPostCompaction().

    // Register recall tool if observational memory has one configured
    if (this.compactionManager.hasRecallTool()) {
      const recallConfig = this.compactionManager.getRecallConfig();
      if (recallConfig) {
        const recallTool = createRecallTool(recallConfig);
        this.tools.registerInternal(recallTool as RegisteredTool);
        this.refreshTools();
      }
    }
  }

  // -----------------------------------------------------------------------
  // Prompt
  // -----------------------------------------------------------------------

  /**
   * Send a prompt to the agent and run the agentic loop.
   *
   * Transitions from CREATED to ACTIVE on first call.
   * Catches errors, classifies them, and emits onError.
   *
   * Every loop start (consumer prompt() calls and background-completion
   * deliveries) is serialized through an internal gate, so a concurrent
   * prompt() can never corrupt the running loop's tool runtime or history
   * boundary. A prompt() issued while a loop is active or queued fails fast
   * BEFORE any shared state is touched; use steer() to reach a running loop.
   *
   * @param input - The prompt text
   * @returns The agent's response (opaque, from pi-agent-core)
   * @throws Error if the agent has been destroyed or is already prompting
   */
  async prompt(input: string, options?: DirectCompletionOptions): Promise<unknown> {
    this.assertNotShuttingDown();
    if (!this.systemPrompt.isConfigured()) {
      throw new Error(
        'AgentLoop prompt is not configured. Call setBasePrompt() before prompt(), ' +
        'or provide initialBasePrompt during creation.',
      );
    }
    if (this.gate.isActive) {
      // Spurious-fail-fast note: re-prompting synchronously inside the .then
      // of a just-resolved prompt() can land here while a no-op
      // background-drain task is still queued (depth briefly > 0). It clears
      // after one macrotask, so a caller that wants to chain a follow-up
      // prompt should await a macrotask (or the delivery handler) first
      // rather than calling prompt() from directly within the resolution.
      throw new Error(
        'Agent is already processing a prompt. Use steer() to inject input into ' +
        'the running loop, or wait for the current turn to complete.',
      );
    }

    // Install a fresh controller SYNCHRONOUSLY when the current one is
    // already aborted. The empty-gate guard above guarantees no
    // loop currently owns it, so this is safe. It makes a same-frame abort()
    // (called after this prompt() but before the queued cycle dequeues) land
    // on THIS turn's controller, so the cycle sees the abort at dequeue and
    // cancels promptly instead of replacing a stale-aborted controller and
    // running to completion un-aborted.
    this.abortState.renewIfAborted();

    return this.enqueueLoopTask(() => this.runPromptCycle(input, options));
  }

  /** Whether teardown has started (no new loops may start). */
  private isShuttingDown(): boolean {
    return this.lifecycleState === 'destroying' || this.lifecycleState === 'destroyed';
  }

  /** Throw the consumer-facing lifecycle error when teardown has started. */
  private assertNotShuttingDown(): void {
    if (this.lifecycleState === 'destroying') {
      throw new Error('Agent is being destroyed');
    }
    if (this.lifecycleState === 'destroyed') {
      throw new Error('Agent has been destroyed');
    }
  }

  /**
   * Serialize a loop-owning task behind every previously enqueued one.
   *
   * This is the single gate through which every agentic loop starts:
   * consumer prompt() calls and background-completion drains. Retry
   * continuations run inside runTurnWithRetry under the same gate
   * acquisition. At most one gate task executes at a time; the depth
   * counter covers running plus queued tasks.
   */
  private enqueueLoopTask<T>(task: () => Promise<T>): Promise<T> {
    return this.gate.enqueue(task);
  }

  /**
   * True while any gate task is running or queued: a prompt cycle, a
   * background-completion drain, an idle digestion pass, or a delivery
   * sweep. While true, prompt() fails fast and deliver() steers or queues
   * instead of starting a turn.
   */
  get isLoopActive(): boolean {
    return this.gate.isActive;
  }

  /**
   * True while a logical turn is in flight: from runPromptOnce entry (the
   * first agent.prompt attempt) through its retry continuations until the
   * turn unwinds. Narrower than {@link isLoopActive}, which also covers
   * gate tasks that never run pi (an idle digestion pass, an empty drain,
   * the end-of-cycle drain window after a run ended). A steer() is only
   * meaningful while this is true: pi polls its steering queue at run
   * start and at turn boundaries within a run, so content queued when no
   * turn is in flight waits for whatever run starts next.
   */
  get isPrompting(): boolean {
    return this._isPrompting;
  }

  /**
   * Cause tags of the run currently holding the gate: the tags of every
   * wake delivery this run consumed (its own prompt input, spliced parked
   * content, or a sweep batch). Empty while no run is live and for runs
   * that carry no tagged content (background drains, untagged prompts).
   * Set at run start in the same frame the delivery batches are taken and
   * cleared in the run's own finally, so the value is always exactly the
   * live run's; a later run can never inherit a previous run's tags. The
   * duplex facade reads this to stamp log-entry causation (D16 binds
   * consent to those stamps, docs/cortex/duplex/log-and-context.md).
   */
  get activeRunCauseTags(): readonly unknown[] {
    return this._activeRunCauseTags;
  }

  /**
   * Resolve once the loop gate is empty: no gate task running or queued.
   * This is the awaitable form of {@link isLoopActive}, and the primitive
   * settlement predicates build on. It deliberately keys on gate depth
   * rather than {@link isPrompting}, which reads idle while gate tasks
   * (queued drains, delivery sweeps, idle digestion) are still pending.
   *
   * Event-driven, not polled: each pass awaits the current gate tail and
   * re-checks, so tasks enqueued by tasks (a run scheduling a drain, a
   * parked delivery scheduling a sweep) extend the wait. The depth is zero
   * in the frame this resolves in, but the caller's continuation runs a
   * microtask later, and an unrelated continuation can enqueue a gate task
   * in between; a caller that needs check-then-act atomicity must therefore
   * re-check {@link isLoopActive} synchronously before acting, and wait
   * again if the gate refilled.
   */
  async waitForLoopIdle(): Promise<void> {
    return this.gate.waitForIdle();
  }

  /**
   * One gate-owned loop cycle: run the logical turn, then deliver any
   * background completions that arrived while it ran. Lifecycle is
   * re-checked here (at dequeue time) so a destroy() that lands between
   * enqueue and dequeue can never start a new loop.
   */
  private async runPromptCycle(input: string, options?: DirectCompletionOptions): Promise<unknown> {
    this.assertNotShuttingDown();
    try {
      return await this.runPromptOnce(input, options);
    } finally {
      // Deliver background results that arrived while prompting. This runs
      // before the consumer's await resolves, keeping its UI state
      // consistent, and still under the same gate acquisition. A terminal
      // delivery failure is a background concern: it surfaces through
      // onError (once, at this chain root), never by rejecting a consumer
      // turn that already succeeded or replacing that turn's own error.
      try {
        await this.background.drain();
      } catch (err) {
        this.emitError(toError(err));
      }
    }
  }

  /**
   * Run one logical prompt turn (first attempt plus transparent background
   * retries). Must be called while holding the loop gate; all mutation of
   * shared loop state (tool runtime, history boundary, prompting flag)
   * happens here, after the gate has been acquired.
   *
   * @param fromDrain - True for the background-completion delivery path,
   *   which deliberately starts a fresh loop after an abort. The consumer
   *   path (false) instead cancels a turn whose controller was aborted
   *   before it dequeued (e.g. a same-frame prompt()+abort()).
   * @param retryPolicyOverride - Per-run retry policy. The drain passes a
   *   policy whose elapsed ceiling is its remaining delivery budget, so a
   *   re-queued delivery cannot re-enter the full retry ladder.
   * @param causeTags - Cause tags for content a drain-started run carries
   *   itself (the sweep passes its batch's tags; the non-drain path derives
   *   tags from the spliced wake batch and the pending prompt tag instead).
   */
  private async runPromptOnce(
    input: string,
    options?: DirectCompletionOptions,
    fromDrain = false,
    retryPolicyOverride?: RetryPolicy,
    causeTags?: unknown[],
  ): Promise<unknown> {
    // Transition to ACTIVE on first loop
    if (this.lifecycleState === 'created') {
      this.lifecycleState = 'active';
    }

    // Consume the deliver()-prompted cause tag first thing, even on paths
    // that cancel before the run starts: the tag belongs to THIS cycle, and
    // leaving it pending would mislabel a later, unrelated run.
    let directCauseTag: unknown;
    if (!fromDrain) {
      directCauseTag = this.pendingPromptCauseTag;
      this.pendingPromptCauseTag = undefined;
    }

    // Abort visibility at dequeue. prompt() installs a fresh (non-aborted)
    // controller synchronously, so if THIS controller is aborted here an
    // abort() must have landed between enqueue and dequeue.
    if (this.abortState.signal.aborted) {
      if (fromDrain) {
        // A scheduled drain delivers background results by starting a fresh
        // loop even after an abort, so replace the aborted controller and
        // proceed.
        this.abortState.renewIfAborted();
      } else {
        // A consumer turn cancelled before it ever reached pi. Surface it
        // like any other cancellation and never start the run.
        const abortErr = new Error('Prompt aborted before it started');
        abortErr.name = 'AbortError';
        this.emitError(abortErr, true);
        throw abortErr;
      }
    }

    const effectiveRetention = options?.cacheRetention ?? this.models.cacheRetention;
    this._activePromptCacheRetention = effectiveRetention ?? null;

    // Flush queued silent deliveries into this prompt's message batch. Only
    // real prompts flush (never drain-started delivery runs): the queue's
    // contract is "available in context at the next real prompt", and the
    // drain's failure unwind counts messages from its own pre-delivery
    // boundary, which flushed extras would corrupt. Taken AFTER the abort
    // check above so a turn cancelled before it started leaves the queue
    // intact for the next prompt.
    const silentBatch = fromDrain ? [] : this.queues.takeSilent();
    // Parked wake deliveries ride ahead of the prompt in the same batch,
    // taken in this same synchronous frame (before pi pushes the batch at
    // run start) so a sweep task that fires later finds nothing and cannot
    // re-deliver content this run consumed. Items an abort cancelled are
    // dropped by the take, not spliced into a post-abort prompt. If the
    // run fails terminally without progressing past the batch, the catch
    // below unwinds the wake portion and re-parks it: content the caller
    // was told was 'parked' must end in a run that answers it, never
    // silently demote to inert transcript context.
    const wakeBatch = fromDrain ? [] : this.queues.takeDeliverableWake();

    // Compute this run's cause tags in the same synchronous frame the
    // batches were taken: caller-supplied tags (sweep runs), tags riding the
    // spliced wake batch, and the deliver()-prompted input's own tag. The
    // ASSIGNMENT happens as the first statement of the try below, so the
    // clearing finally is paired with the set by construction: a throwing
    // consumer logger (or diagnostics sink) between here and the try leaves
    // the tags untouched instead of live for a run that never happened,
    // where the next error entry would read the dead run's stamp (the fault
    // class the interceptor site fixed the same way). Nothing between the
    // batch take and the try awaits, so the same-frame property holds.
    const runCauseTags: readonly unknown[] = [
      ...(causeTags ?? []),
      ...wakeBatch.map((item) => item.causeTag).filter((tag) => tag !== undefined),
      ...(directCauseTag !== undefined ? [directCauseTag] : []),
    ];

    // Long-lived mode keeps workspace state (cwd, read-before-edit registry,
    // undo history) across prompts; transient state resets regardless.
    this.tools.runtime.resetForLoop(
      this.config.persistentRuntime ? { preserveWorkspaceState: true } : undefined,
    );
    // Budget limits cover the whole logical turn: reset here (once per
    // prompt) instead of on loop_start, which pi-agent-core emits again for
    // every background-retry continuation. Under a lifetime budget scope the
    // guard is never reset, so limits bound the loop's whole life.
    if ((this.config.budgetGuard?.scope ?? 'prompt') === 'prompt') {
      this.budgetGuard.reset();
    }
    this._isPrompting = true;
    const loopStartMs = Date.now();

    // Record the message count before this prompt so the transformContext
    // hook knows where "old history" ends and "new tick content" begins.
    // This enables cache breakpoint optimization: old history is stable
    // across ticks and can be cached, while new content changes each tick.
    this._prePromptMessageCount = this.agent.state.messages.length;

    this.logger.debug('loop start', {
      messageCount: this._prePromptMessageCount,
      inputLength: input.length,
    });

    this.promptDiagnostics.startPrompt({
      inputLength: input.length,
      messageCount: this._prePromptMessageCount,
      provider: this.models.primary.provider,
      modelId: this.models.primary.modelId,
    });

    // Created immediately before the try so every code path that leaves a
    // pending turnUnwound is guaranteed to hit the finally that resolves it
    // (abort() awaits this promise and must never hang).
    this.turnUnwound = new Promise<void>((resolve) => {
      this.resolveTurnUnwound = resolve;
    });

    let promptStatus: 'resolved' | 'rejected' | 'cancelled' = 'resolved';
    try {
      this._activeRunCauseTags = runCauseTags;
      return await this.runTurnWithRetry(
        input, fromDrain, retryPolicyOverride, silentBatch, wakeBatch,
      );
    } catch (err) {
      const error = toError(err);
      promptStatus = this.isAborted() ? 'cancelled' : 'rejected';
      // A wake delivery spliced into a failed consumer prompt would
      // otherwise sit in the transcript with no run ever answering it.
      // Unwind and re-park it so a sweep re-delivers it with a run of its
      // own. An aborted turn instead cancels its spliced deliveries, the
      // same way abort() cancels parked ones.
      if (promptStatus !== 'cancelled') {
        this.queues.reparkAfterFailedPrompt(wakeBatch, silentBatch.length, error.message);
      }
      // Classification, overflow handling, retry orchestration, and the onError
      // emission all happen inside runTurnWithRetry. Here we only record status
      // for diagnostics and re-throw to the consumer.
      throw error;
    } finally {
      this._activePromptCacheRetention = null;
      this._isPrompting = false;
      this._activeRunCauseTags = [];

      this.logger.debug('loop complete', {
        durationMs: Date.now() - loopStartMs,
        turns: this.budgetGuard.getTurnCount(),
        totalCost: this.budgetGuard.getTotalCost(),
        currentContextTokens: this.compactionManager.currentContextTokenCount,
      });

      this.promptDiagnostics.finishPrompt({
        status: promptStatus,
        durationMs: Date.now() - loopStartMs,
        turns: this.budgetGuard.getTurnCount(),
        totalCost: this.budgetGuard.getTotalCost(),
        currentContextTokens: this.compactionManager.currentContextTokenCount,
        pendingBackgroundResults: this.background.pending.length,
      });

      // Signal that this turn has fully unwound (status classified, flags
      // cleared). abort() waits on this before resetting the controller.
      this.resolveTurnUnwound?.();
      this.resolveTurnUnwound = null;
    }
  }

  // -----------------------------------------------------------------------
  // Background retry
  // -----------------------------------------------------------------------

  /**
   * Run one user turn, transparently retrying transient failures in the
   * background per the configured RetryPolicy.
   *
   * The first attempt uses `agent.prompt(input)`. Each retry resumes the failed
   * turn with `agent.continue()` after trimming pi-agent-core's synthetic
   * failure message, so completed tool calls do not re-run and the user message
   * is never duplicated. The returned promise stays pending across the whole
   * backoff window; an abort during a backoff wait cancels it.
   *
   * On a non-retryable failure (auth, a 404 classified as unknown, context
   * overflow, abort) or once retries are exhausted, it emits onError and throws
   * exactly as the non-retrying path did, so the consumer's existing handling
   * is unchanged for those cases.
   *
   * @param fromDrain - True for background-completion deliveries. The drain
   *   chain re-queues a failed delivery and re-attempts it, so per-attempt
   *   onError emission is deferred to the chain root: a later attempt that
   *   succeeds surfaces no error at all, and a terminal failure surfaces
   *   exactly once (mirroring how an in-run retry that recovers reports
   *   onRetrySucceeded rather than onError).
   */
  private async runTurnWithRetry(
    input: string,
    fromDrain = false,
    retryPolicyOverride?: RetryPolicy,
    silentBatch: QueuedDelivery[] = [],
    wakeBatch: QueuedDelivery[] = [],
  ): Promise<unknown> {
    const policy = retryPolicyOverride ?? this.retryPolicy;
    let retryIndex = 0;
    let firstFailureAt: number | undefined;

    // Parked wake deliveries and queued silent deliveries ride ahead of the
    // prompt in one message batch; pi pushes every batch message into the
    // transcript at run start, so after the first attempt they are durable
    // history and retries (continue()) see them without re-sending. Both
    // queues are spliced by runPromptOnce in the same synchronous frame as
    // this call, so a sweep task that fires later finds nothing and cannot
    // re-deliver content this run consumed. Drain-started runs splice
    // neither queue: their failure unwind counts messages from the
    // pre-delivery boundary, which flushed extras would corrupt, and the
    // sweep delivers parked wake content with a run of its own.
    const leadingBatch = [...wakeBatch, ...silentBatch];
    const promptInput: string | AgentMessage[] = leadingBatch.length > 0
      ? [
          ...leadingBatch.map((item): AgentMessage => ({
            role: 'user',
            content: item.content,
            timestamp: item.timestamp,
          })),
          { role: 'user', content: input, timestamp: Date.now() },
        ]
      : input;

    // Resolves to the turn result, or throws after onError has been emitted.
    for (;;) {
      try {
        const result =
          retryIndex === 0 ? await this.agent.prompt(promptInput) : await this.agent.continue();

        // Pi-agent-core catches streaming/provider errors internally and stores
        // them in state.errorMessage without re-throwing. Surface these so
        // Cortex's error classification and consumer handlers can process them.
        const agentState = this.agent.state as Record<string, unknown>;
        const stateError = agentState['errorMessage'] ?? agentState['error'];
        if (stateError) {
          throw new Error(String(stateError));
        }

        // An abort can end the run cleanly: the stream returns a message with
        // stopReason 'aborted' (no error state) and prompt() resolves. Trim
        // the aborted assistant stub so it does not linger in history and get
        // rewritten to "(no output)" on a later turn. No-op when the last
        // message is a normal assistant turn.
        if (this.isAborted()) {
          this.trimTrailingFailureMessages();
        }

        if (retryIndex > 0) {
          this.fireRetrySucceeded({ attempts: retryIndex });
        }
        return result;
      } catch (err) {
        const error = toError(err);
        const aborted = this.isAborted();
        const classified = classifyError(error, { wasAborted: aborted });

        // Reactive overflow detection: emergency truncation, then surface (not
        // retried by default; context_overflow is not a retryable category).
        if (isContextOverflow(error)) {
          this.compactionManager.handleOverflowError(
            () => this.getConversationHistory(),
            (history) => this.restoreConversationHistory(history),
          );
        }

        if (firstFailureAt === undefined) firstFailureAt = Date.now();
        const elapsedMs = Date.now() - firstFailureAt;

        // Only retry when the policy allows AND the transcript can actually be
        // resumed (last message after trimming is a user/tool-result, never a
        // dangling assistant turn that continue() would reject).
        const policyAllowsRetry = shouldRetry(
          classified,
          { retryIndex, elapsedMs, aborted },
          policy,
        );
        const willRetry = policyAllowsRetry && this.peekResumableAfterTrim();

        if (!willRetry) {
          // Signal "gave up" only when the retry budget was genuinely exhausted
          // (not when the transcript simply could not be resumed), and only if
          // we had actually been retrying a transient failure. Never for a
          // drain delivery: its ladder ending is not terminal (the batch is
          // re-queued and the next attempt may succeed), so like onError the
          // give-up signal is the chain root's to make (dead-letter).
          if (
            !fromDrain &&
            retryIndex > 0 &&
            !aborted &&
            !policyAllowsRetry &&
            isRetryableCategory(classified.category, policy)
          ) {
            this.fireRetryExhausted({ attempts: retryIndex, category: classified.category });
          }
          // A user abort is a cancellation, not a failure to keep: remove the
          // aborted assistant stub pi appended, exactly as the retry path
          // does, so it cannot linger in history and later be rewritten to
          // "(no output)". Non-abort failures keep their stub (unchanged).
          if (aborted) {
            this.trimTrailingFailureMessages();
          }
          if (!fromDrain) {
            this.emitError(error, aborted);
          }
          throw error;
        }

        const delayMs = backoffForAttempt(policy, retryIndex);
        const attemptNumber = retryIndex + 1;
        const scheduled: RetryScheduledInfo = {
          category: classified.category,
          attempt: attemptNumber,
          maxAttempts: policy.maxAttempts,
          delayMs,
          nextAttemptAt: Date.now() + delayMs,
          originalMessage: classified.originalMessage,
        };
        if (classified.causeDetail !== undefined) {
          scheduled.causeDetail = classified.causeDetail;
        }
        this.fireRetryScheduled(scheduled);
        this.logger.warn('scheduling background retry', {
          category: classified.category,
          attempt: attemptNumber,
          maxAttempts: policy.maxAttempts,
          delayMs,
        });

        const completed = await sleepUnlessAborted(delayMs, this.abortState.signal);
        if (!completed) {
          // Aborted during the wait: surface as cancelled, do not retry. Throw a
          // fresh AbortError rather than the original transient failure so the
          // consumer's catch sees a cancellation (matching the in-run abort
          // path) instead of a stale network/rate-limit message. The synthetic
          // failure stub that was awaiting this retry is trimmed like any
          // other aborted turn.
          this.trimTrailingFailureMessages();
          if (!fromDrain) {
            this.emitError(error, true);
          }
          const abortErr = new Error('Prompt aborted during retry backoff');
          abortErr.name = 'AbortError';
          throw abortErr;
        }

        // Remove pi-agent-core's synthetic failure message so continue() sees a
        // user/tool-result as the last message and resumes cleanly.
        this.trimTrailingFailureMessages();
        retryIndex += 1;
      }
    }
  }

  /** Whether trimming the failure stubs leaves a transcript continue() can resume. */
  private peekResumableAfterTrim(): boolean {
    return isResumableAfterTrim(this.agent.state.messages, this.contextManager.slotCount);
  }

  /** Remove trailing synthetic failure messages so continue() can resume. */
  private trimTrailingFailureMessages(): void {
    if (trimTrailingFailures(this.agent.state.messages)) {
      this.notifySourceHistoryTailTrimmed();
    }
  }

  /**
   * Tell the compaction manager the tail of the post-slot source history was
   * trimmed, so the observational buffer watermark (and any in-flight
   * observer end index) can be clamped to the surviving length. pi emits
   * turn_end for trimmed messages before Cortex removes them, so without
   * this the watermark can end up counting messages that no longer exist and
   * the next activation would slice away unobserved ones.
   */
  private notifySourceHistoryTailTrimmed(): void {
    const postSlotLength = Math.max(
      0,
      this.agent.state.messages.length - this.contextManager.slotCount,
    );
    this.compactionManager.onSourceHistoryTailTrimmed(postSlotLength);
  }



  private fireRetryScheduled(info: RetryScheduledInfo): void {
    this.retryScheduledHandlers.emit(info, this.originContext);
  }

  private fireRetrySucceeded(info: RetrySucceededInfo): void {
    this.retrySucceededHandlers.emit(info, this.originContext);
  }

  private fireRetryExhausted(info: RetryExhaustedInfo): void {
    this.retryExhaustedHandlers.emit(info, this.originContext);
  }

  // -----------------------------------------------------------------------
  // Steering
  // -----------------------------------------------------------------------

  /**
   * Inject a steering message into the running agentic loop.
   * Queues the message for pi-agent-core to inject after the current
   * assistant turn and any current tool batch finish.
   * Only effective while a prompt() call is in progress or queued.
   *
   * No-op if the agent is not currently prompting.
   *
   * @param message - The message content to inject
   */
  steer(message: string): void {
    this.queues.steer(message);
  }

  /**
   * Deliver a message to this loop regardless of its run state. The delivery
   * primitive behind facade routing (docs/cortex/duplex/log-and-context.md):
   * a state machine over (loop-gate depth, pi run state, abort state) with
   * three actions:
   *
   * - `wake: false` (silent class), in EVERY run state: queue on the
   *   AgentLoop itself, flushed into the next real prompt's message batch.
   *   Never pi's steering queue: during a live run pi polls steering after
   *   every tool batch (including terminated ones) and continues the loop if
   *   anything is queued, and while idle a queued steer drains into whatever
   *   run starts next (including a background-completion delivery). Either
   *   way silent content would surface as an unprompted response.
   * - Wake wanted, gate held (a turn is running, queued, in retry backoff,
   *   or in the end-of-cycle drain window): park on the loop-owned wake
   *   queue and enqueue a sweep task behind every gate task present now.
   *   The content opens the NEXT run, not the one in flight: either as
   *   leading batch messages of a prompt that dequeues ahead of the sweep,
   *   or through the sweep's own run once the tasks ahead of it finish.
   *   Cortex owns wake parking end to end; the content never enters pi's
   *   steering queue (that queue belongs to the public steer() API alone,
   *   and it cannot be inspected or selectively drained, so reconciling a
   *   steered delivery after the fact either duplicated content a run had
   *   already drained or destroyed steer() content). The cost is a bounded
   *   one-run delay for a delivery that lands during a live run; the gain
   *   is that delivery is exact rather than probabilistic.
   * - Wake wanted, idle: start a turn with this content as the prompt; the
   *   returned `turn` promise settles with it.
   *
   * The branch decision and its action happen in one synchronous frame, so
   * there is no time-of-check race against prompt() (which throws whenever
   * the gate is held): nothing can acquire the gate between the depth check
   * and the action taken here.
   *
   * Queued silent deliveries are dropped on destroy(); a facade that needs
   * them durable should drain them into its own state before teardown (see
   * {@link clearQueuedDeliveries}). Parked wake deliveries share that
   * contract (see {@link clearAllQueues}) and are additionally dropped by
   * abort(): a parked delivery is cancelled like the turn it was waiting
   * behind, never delivered by a run that starts after the user stopped
   * the agent. That includes a delivery that parks while an abort is
   * completing (the parked queue is gated on an abort epoch, so neither a
   * mid-abort drain replacing the controller nor the skipped gate wait
   * lets it through to a post-abort run).
   *
   * @param content - Non-whitespace message content (user role)
   * @param options - Wake behavior; default wakes an idle loop
   */
  deliver(content: string, options?: DeliverOptions): DeliverResult {
    return this.queues.deliver(content, options);
  }

  /**
   * Queue a follow-up message on pi's follow-up queue. Unlike steer(), which
   * lands at the next turn boundary inside the current run, a follow-up
   * drains only at a would-stop point: after the model has produced what
   * would otherwise be the run's final answer, the loop continues with the
   * queued message instead of stopping. Queued while idle, it drains at the
   * end of the next run.
   */
  followUp(message: string): void {
    this.queues.followUp(message);
  }

  /** Set how pi drains queued steering messages. */
  setSteeringQueueMode(mode: QueueDrainMode): void {
    this.queues.setSteeringQueueMode(mode);
  }

  /** Set how pi drains queued follow-up messages. */
  setFollowUpQueueMode(mode: QueueDrainMode): void {
    this.queues.setFollowUpQueueMode(mode);
  }

  /**
   * Remove all queued steering messages from pi's steering queue (public
   * steer() content). Parked wake deliveries are loop-owned and are not
   * affected; drop those via {@link clearAllQueues}.
   */
  clearSteeringQueue(): void {
    this.queues.clearSteeringQueue();
  }

  /** Remove all queued follow-up messages from pi's follow-up queue. */
  clearFollowUpQueue(): void {
    this.queues.clearFollowUpQueue();
  }

  /**
   * Remove every queued message: pi's steering and follow-up queues plus
   * this loop's silent delivery queue and parked wake deliveries. Returns
   * the dropped loop-owned content (silent first, then parked wake, each
   * in queue order) so a caller can re-route or persist it. A pending
   * sweep task finds nothing and no-ops.
   */
  clearAllQueues(): string[] {
    return this.queues.clearAll();
  }

  /** Number of silent deliveries waiting for the next real prompt. */
  get queuedDeliveryCount(): number {
    return this.queues.silentCount;
  }

  /** Number of parked wake deliveries waiting for the next run. */
  get pendingWakeDeliveryCount(): number {
    return this.queues.wakeCount;
  }

  /**
   * Drop all queued silent deliveries, returning their content in queue
   * order so the caller can re-route or persist them.
   */
  clearQueuedDeliveries(): string[] {
    return this.queues.clearSilent();
  }

  /**
   * Retract parked wake deliveries whose content matches `predicate`,
   * returning the dropped content in queue order. Silent deliveries and pi's
   * queues are untouched.
   *
   * The narrow form exists because the broad one destroys information. An
   * owner that needs to retract ONE class of parked content (a facade
   * dropping permission voicings whose ask has already been settled, so a
   * dead request is never read out) would otherwise have to call
   * {@link clearAllQueues} and re-deliver the survivors, which loses their
   * cause tags: a parked user utterance re-delivered without its tag can no
   * longer satisfy a permission ask, so retracting one delivery would
   * silently revoke the consent value of another.
   *
   * Nothing is dead-lettered here. The drop is the caller's deliberate
   * decision about content it produced, not a delivery failure, and the
   * caller is the one holding the context to record it.
   */
  dropPendingWakeDeliveries(predicate: (content: string) => boolean): string[] {
    return this.queues.dropWake(predicate);
  }

  // -----------------------------------------------------------------------
  // Pending permission asks
  // -----------------------------------------------------------------------

  /**
   * Snapshot of permission asks currently blocked on a resolver decision,
   * for this loop and (mirrored) its spawned children, oldest first. Each
   * entry's askId matches the ToolPermissionRequestContext.askId the
   * resolver received, so a broker can correlate what it queries here with
   * the resolver call it is answering. Entries vanish when an ask settles,
   * however it settles (answered, blocked, or aborted).
   */
  getPendingAsks(): PendingAsk[] {
    return this.asks.list();
  }

  /**
   * Mark a pending ask as voiced (presented to the human). Consent binding
   * accepts an allow only for the most recently voiced ask, so a broker
   * calls this at the moment it actually surfaces the request. Returns
   * false for an unknown or already-settled askId.
   */
  markAskVoiced(askId: string): boolean {
    return this.asks.markVoiced(askId);
  }

  /**
   * Resolve once the pending-ask set next shrinks: an ask settled (however
   * it settled: answered, blocked, or aborted) or teardown cleared the
   * registry. Resolves immediately when no ask is pending. This is the
   * event-driven form settlement predicates wait on instead of polling
   * getPendingAsks(), which can otherwise spin for as long as an ask
   * outlives the work that raised it.
   */
  async waitForAskSettlement(): Promise<void> {
    return this.asks.waitForSettlement();
  }

  // -----------------------------------------------------------------------
  // Headline feed
  // -----------------------------------------------------------------------

  /**
   * Feed a consumer-built headline block (live task status, activity lines)
   * into this loop's context. The provider is called on EVERY LLM call and
   * its result is view-injected after the built-in background-task state,
   * OUTSIDE the BP3 cache boundary: it churns per tick, so it must never
   * extend the cached prefix, never enter the transcript, and is absent on
   * compaction turns by design (like all view injections).
   *
   * The block is hard token-capped (default 2000 tokens; override via
   * options.maxTokens): injected user-role content is never trimmed by
   * microcompaction, so an unbounded block would inflate utilization and
   * trigger early source compaction without itself shrinking.
   *
   * Pass null to stop injecting. A provider that throws or returns
   * null/whitespace injects nothing for that call.
   */
  setHeadlineProvider(
    provider: (() => string | null) | null,
    options?: { maxTokens?: number },
  ): void {
    this.headlineProvider = provider;
    if (options?.maxTokens !== undefined) {
      if (!Number.isFinite(options.maxTokens) || options.maxTokens <= 0) {
        throw new Error('setHeadlineProvider maxTokens must be a positive finite number');
      }
      this.headlineMaxTokens = options.maxTokens;
    }
  }

  /**
   * Install a hook over finalized tool results. Runs inside pi's
   * afterToolCall for every executed call (errors included); the return
   * value can replace the result content, override the terminate flag, or
   * suppress the working-tags reminder appendix. One interceptor at a time;
   * pass null to remove. General-purpose by design; the duplex facade uses
   * it for the control-tool terminate guards (empty-spoken-text suppression
   * and bare receipts, docs/cortex/duplex/decisions.md D17). An interceptor
   * that throws is logged and ignored so it can never fail the tool result
   * path, which for control tools would reopen the very loop D17 closes.
   */
  setToolResultInterceptor(interceptor: ToolResultInterceptor | null): void {
    this.finalizer.setInterceptor(interceptor);
  }

  /**
   * Build the capped headline injection for the current LLM call, or null
   * when no provider is set or it produced nothing.
   */
  private buildHeadlineInjection(): string | null {
    if (!this.headlineProvider) return null;
    let content: string | null;
    try {
      content = this.headlineProvider();
    } catch (err) {
      this.logger.warn('headline provider threw', {
        error: errorMessageOf(err),
      });
      return null;
    }
    if (!content || content.trim().length === 0) return null;
    if (estimateTokens(content) <= this.headlineMaxTokens) return content;
    // Hard cap: cut at the estimator's character budget, marker included.
    const budgetChars = Math.max(
      0,
      this.headlineMaxTokens * 4 - HEADLINE_TRUNCATION_MARKER.length,
    );
    return content.slice(0, budgetChars) + HEADLINE_TRUNCATION_MARKER;
  }

  /**
   * Classify an error and dispatch it to all registered onError handlers.
   *
   * Shared by the agentic loop (prompt) and the direct completion paths
   * (directComplete / structuredComplete / utilityComplete) so every LLM
   * call failure surfaces to consumers through the same onError channel,
   * regardless of which phase produced it.
   *
   * @param error - The error to classify and surface
   * @param wasAborted - Override for abort detection (defaults to this.isAborted())
   * @returns The classified error (so callers can branch on category if needed)
   */
  private emitError(error: Error, wasAborted?: boolean): ClassifiedError {
    const classified = classifyError(error, {
      wasAborted: wasAborted ?? this.isAborted(),
    });

    this.logger.warn('error', {
      category: classified.category,
      severity: classified.severity,
      message: classified.originalMessage,
      ...(classified.causeDetail ? { cause: classified.causeDetail } : {}),
    });

    this.errorHandlers.emit(classified, { loopPath: this.loopPath });

    return classified;
  }

  // -----------------------------------------------------------------------
  // Direct Completion (non-agentic)
  // -----------------------------------------------------------------------

  /**
   * Make a direct LLM completion call using the primary model.
   * NOT an agentic tool-use loop. Used for structured output phases
   * like THOUGHT and REFLECT where a single LLM response is needed
   * without tool execution.
   *
   * Accepts either a raw context ({ systemPrompt, messages }) passed to
   * pi-ai verbatim, or a structured context ({ systemPrompt, slots?,
   * history?, ephemeral?, prompt }) that Cortex assembles with the same
   * cache breakpoint strategy the agentic loop uses. See
   * StructuredCompletionContext for the caching contract.
   *
   * Dynamically imports pi-ai's complete() function. If pi-ai is not
   * installed, throws a clear error.
   *
   * @param context - Raw or structured completion context
   * @returns The response text from the LLM
   * @throws Error if pi-ai is not installed or the call fails
   */
  async directComplete(context: DirectCompletionContext, options?: DirectCompletionOptions): Promise<string> {
    return this.completions.direct(context, options);
  }


  /**
   * Make a structured output LLM call using the tool-call-as-structured-output pattern.
   *
   * Defines a tool whose input_schema matches the desired output structure,
   * passes it via pi-ai's complete() with tools, and extracts the tool call
   * arguments as the structured result. This works across all providers that
   * support tool use (Anthropic, OpenAI, Google, Mistral, etc.) without
   * needing provider-specific structured output parameters.
   *
   * Accepts the same raw or structured contexts as directComplete(). Note
   * for cached structured contexts: tool definitions precede the system
   * prompt in Anthropic's cacheable prefix, so keep the schema byte-stable
   * across calls or the whole prefix misses.
   *
   * @param context - Raw or structured completion context
   * @param schema - Tool schema defining the structured output shape (TypeBox or JSON Schema)
   * @param toolName - Name for the virtual tool (default: 'structured_output')
   * @param toolDescription - Description for the virtual tool
   * @returns The parsed tool call arguments, or null if the model didn't call the tool
   */
  async structuredComplete(context: DirectCompletionContext, schema: unknown, toolName: string = 'structured_output', toolDescription: string = 'Produce structured output', options?: DirectCompletionOptions): Promise<Record<string, unknown> | null> {
    return this.completions.structured(context, schema, toolName, toolDescription, options);
  }


  // -----------------------------------------------------------------------
  // Static Factory
  // -----------------------------------------------------------------------

  private static buildPiAgentConfig(params: {
    cortexConfig: AgentLoopConfig;
    initialSystemPrompt?: string;
    cacheBreakpointState: { agentLoop: AgentLoop | null };
  }): Record<string, unknown> {
    const { cacheBreakpointState } = params;
    return buildPiAgentConfig({
      cortexConfig: params.cortexConfig,
      ...(params.initialSystemPrompt !== undefined ? { initialSystemPrompt: params.initialSystemPrompt } : {}),
      host: () => cacheBreakpointState.agentLoop?.piHookHost() ?? null,
    });
  }

  /** The loop as pi's hooks see it (see pi-hooks.ts). */
  private piHookHost(): PiHookHost {
    return {
      isToolPermissionExempt: (toolName) => this.isToolPermissionExempt(toolName),
      asks: this.asks,
      streamOptions: () => ({
        retention: this._activePromptCacheRetention ?? this.models.cacheRetention ?? null,
        sessionId: this.models.sessionId ?? null,
      }),
      syncActiveLoopTools: (ctx) => this.tools.syncActiveLoopTools(ctx),
      finalizer: this.finalizer,
      cacheBreakpointIndices: () => this._cacheBreakpointIndices,
    };
  }

  private static wireManagedPiAgent(agentLoop: AgentLoop, piAgent: PiAgent): void {
    wirePiTransformContext(piAgent, agentLoop.getTransformContextHook());
  }

  private static async createManagedAgent(params: {
    cortexConfig: AgentLoopConfig;
    tools?: RegisteredTool[];
    initialBasePrompt?: string;
    initialSystemPrompt?: string;
    constructorOptions?: AgentLoopConstructorOptions;
    missingDependencyMessage: string;
  }): Promise<AgentLoop> {
    const {
      cortexConfig,
      tools = [],
      initialBasePrompt,
      initialSystemPrompt,
      constructorOptions,
      missingDependencyMessage,
    } = params;

    const AgentClass = await loadAgentClass(missingDependencyMessage);
    const cacheBreakpointState = { agentLoop: null as AgentLoop | null };
    const agentConfigParams: {
      cortexConfig: AgentLoopConfig;
      initialSystemPrompt?: string;
      cacheBreakpointState: { agentLoop: AgentLoop | null };
    } = {
      cortexConfig,
      cacheBreakpointState,
    };
    if (initialSystemPrompt !== undefined) {
      agentConfigParams.initialSystemPrompt = initialSystemPrompt;
    }
    const agentConfig = AgentLoop.buildPiAgentConfig(agentConfigParams);

    const piAgent = new AgentClass(agentConfig);
    const agentLoop = new AgentLoop(
      piAgent,
      cortexConfig,
      tools,
      constructorOptions,
    );

    cacheBreakpointState.agentLoop = agentLoop;
    AgentLoop.wireManagedPiAgent(agentLoop, piAgent);

    if (typeof initialBasePrompt === 'string') {
      agentLoop.setBasePrompt(initialBasePrompt);
    } else if (typeof initialSystemPrompt === 'string' && initialSystemPrompt.trim()) {
      agentLoop.systemPrompt.apply(initialSystemPrompt);
    }

    return agentLoop;
  }

  /**
   * Create an AgentLoop with a pi-agent-core Agent constructed internally.
   *
   * This eliminates the consumer's need to import pi-agent-core directly.
   * The factory dynamically imports pi-agent-core and pi-ai, resolves the
   * model, creates the internal Agent, and returns a fully configured
   * AgentLoop.
   *
   * @param config - AgentLoop configuration (model, tools, options)
   * @returns A new AgentLoop wrapping an internally-created pi-agent-core Agent
   * @throws Error if pi-agent-core or pi-ai is not installed
   */
  static async create(config: AgentLoopConfig & {
    /**
     * Additional consumer-provided tools to register alongside the built-in tools.
     * Built-in tools (Read, Write, Edit, Glob, Grep, Bash, WebFetch, TaskOutput)
     * are registered automatically. Tools passed here must use Cortex's
     * execute(params, context?) contract. Wrap raw pi-agent-core tools with
     * fromPiAgentTool() before passing them to AgentLoop.create().
     */
    tools?: CortexTool[];
    /**
     * Whether to auto-register the SubAgent tool. Default true. An owner
     * assembling a role loop that must not spawn (the duplex talker, a
     * tier-capped child) sets false; combined with disableTools this yields
     * a loop with no built-in toolset at all.
     */
    enableSubAgentTool?: boolean;
    /** Whether to auto-register the load_skill tool. Default true. */
    enableLoadSkillTool?: boolean;
  }): Promise<AgentLoop> {
    const managedCreateParams: {
      cortexConfig: AgentLoopConfig;
      tools?: RegisteredTool[];
      initialBasePrompt?: string;
      constructorOptions?: AgentLoopConstructorOptions;
      missingDependencyMessage: string;
    } = {
      cortexConfig: config,
      missingDependencyMessage:
        'AgentLoop.create() requires @earendil-works/pi-agent-core to be installed. ' +
        'Install it as a dependency or peer dependency.',
    };
    if (config.tools) {
      managedCreateParams.tools = config.tools;
    }
    if (config.initialBasePrompt !== undefined) {
      managedCreateParams.initialBasePrompt = config.initialBasePrompt;
    }
    if (config.enableSubAgentTool !== undefined || config.enableLoadSkillTool !== undefined) {
      managedCreateParams.constructorOptions = {
        ...(config.enableSubAgentTool !== undefined
          ? { enableSubAgentTool: config.enableSubAgentTool }
          : {}),
        ...(config.enableLoadSkillTool !== undefined
          ? { enableLoadSkillTool: config.enableLoadSkillTool }
          : {}),
      };
    }
    return AgentLoop.createManagedAgent(managedCreateParams);
  }

  // -----------------------------------------------------------------------
  // Context
  // -----------------------------------------------------------------------

  /**
   * Get the ContextManager for slot and ephemeral context management.
   */
  getContextManager(): ContextManager {
    return this.contextManager;
  }

  // -----------------------------------------------------------------------
  // System Prompt
  // -----------------------------------------------------------------------

  /**
   * Compose a system prompt from the application/base prompt plus
   * Cortex operational sections.
   *
   * Base prompt content comes FIRST (identity, persona, domain instructions).
   * Cortex appends operational rules AFTER (system rules, tool guidance,
   * safety, environment info).
   *
   * @param basePrompt - The application/base prompt content
   * @returns The assembled system prompt
   */
  composeSystemPrompt(basePrompt: string): string {
    return this.systemPrompt.compose(basePrompt);
  }

  /**
   * Set the application/base prompt and update the live agent state.
   *
   * Preserves conversation history. Non-destructive.
   */
  setBasePrompt(basePrompt: string): string {
    return this.systemPrompt.setBase(basePrompt);
  }

  /**
   * Get the current application/base prompt.
   */
  getBasePrompt(): string {
    return this.systemPrompt.base() ?? '';
  }

  /**
   * Get the current assembled system prompt.
   */
  getCurrentSystemPrompt(): string {
    return this.systemPrompt.current();
  }

  /**
   * Get the Cortex operational system prompt sections as structured data.
   * Useful for context snapshot / inspector tooling.
   */
  getSystemPromptSections(): Array<{ name: string; content: string }> {
    return this.systemPrompt.sections();
  }

  // -----------------------------------------------------------------------
  // Persistence (consumer-owned storage)
  // -----------------------------------------------------------------------

  /**
   * Get conversation history, excluding the slot region.
   *
   * Returns messages from position slotCount through the end of the array.
   * The consumer snapshots this to their storage.
   *
   * @returns Conversation history messages (everything after slots)
   */
  getConversationHistory(): AgentMessage[] {
    const slotCount = this.contextManager.slotCount;
    return this.agent.state.messages.slice(slotCount);
  }

  /**
   * Restore conversation history after the slot region.
   *
   * Splices saved messages into the array starting at position slotCount,
   * replacing any existing conversation history.
   *
   * @param messages - Previously saved conversation history
   */
  restoreConversationHistory(messages: AgentMessage[]): void {
    const slotCount = this.contextManager.slotCount;
    // Remove existing conversation history (everything after slots)
    this.agent.state.messages.splice(slotCount);
    // Sanitize restored messages: fix undefined/null/empty content that may
    // have been checkpointed from previous sessions with tool execution bugs.
    const now = Date.now();
    const sanitized = messages.map(msg => {
      let patched = withPlaceholderContent(msg);
      // Migrate messages from old sessions that predate the timestamp field
      if (patched.timestamp == null) {
        patched = { ...patched, timestamp: now };
      }
      return patched;
    });
    // Append restored messages
    this.agent.state.messages.push(...sanitized);
  }

  // -----------------------------------------------------------------------
  // Model Access
  // -----------------------------------------------------------------------

  /**
   * Get the primary model.
   */
  getModel(): CortexModel {
    return this.models.primary;
  }

  /**
   * Get the resolved utility model.
   */
  getUtilityModel(): CortexModel {
    return this.models.utility;
  }

  /**
   * Peek at the utility model that auto-resolution would produce for the
   * current primary model, without applying it or clearing a manual override.
   *
   * For providers Cortex cannot enumerate (e.g. Ollama and custom
   * OpenAI-compatible endpoints), this returns the primary model itself,
   * mirroring the runtime fallback in resolveUtilityModels(). Consumers use
   * this to label an "Auto" choice in a UI with the model that will actually
   * run, instead of re-deriving it from a model list that the agent never sees.
   */
  getAutoResolvedUtilityModel(): CortexModel {
    return this.models.autoResolvedUtility();
  }

  /**
   * Hot-swap the primary model without restarting the agent.
   * Used when the user changes their provider/model in settings.
   *
   * @param model - The new CortexModel to use
   */
  setModel(model: CortexModel): void {
    this.models.setModel(model);
  }

  /**
   * Explicitly set the utility model, overriding auto-resolution.
   * The utility model must be from the same provider as the primary model.
   * After calling this, setModel() will NOT auto-resolve the utility model.
   * Call resetUtilityModel() to restore auto-resolution.
   *
   * @param model - The CortexModel to use as the utility model
   */
  setUtilityModel(model: CortexModel): void {
    this.models.setUtilityModel(model);
  }

  /**
   * Reset the utility model to auto-resolution based on the primary model's provider.
   * Clears any manual override set by setUtilityModel().
   */
  resetUtilityModel(): void {
    this.models.resetUtilityModel();
  }

  /**
   * Whether the utility model has been manually overridden.
   */
  isUtilityModelOverridden(): boolean {
    return this.models.isUtilityOverridden;
  }

  /**
   * Change the thinking/reasoning effort level.
   *
   * Does not validate against the model: callers that want a guaranteed
   * accepted value should pass the result of {@link clampThinkingLevel}.
   *
   * @param level - The consumer-facing thinking level
   */
  setThinkingLevel(level: ThinkingLevel): void {
    (this.agent.state as Record<string, unknown>)['thinkingLevel'] = toPiThinkingLevel(level);
  }

  /**
   * Get the current thinking/reasoning effort level.
   *
   * @returns The current consumer-facing thinking level, or 'medium' if unset
   *   or set to a level this Cortex build does not model.
   */
  getThinkingLevel(): ThinkingLevel {
    const piLevel = (this.agent.state as Record<string, unknown>)['thinkingLevel'];
    if (typeof piLevel !== 'string') return 'medium';
    return fromPiThinkingLevel(piLevel) ?? 'medium';
  }

  get isWorkingTagsEnabled(): boolean {
    return this.workingTagsEnabled;
  }

  setWorkingTagsEnabled(enabled: boolean): void {
    if (this.workingTagsEnabled === enabled) return;
    this.workingTagsEnabled = enabled;
    this.eventBridge.setWorkingTagsEnabled(enabled);
    const base = this.systemPrompt.base();
    if (base !== null) {
      this.setBasePrompt(base);
    }
  }

  /**
   * Get the thinking capabilities of the current primary model.
   * Uses pi-ai model metadata to expose the exact supported thinking levels.
   *
   * @returns Capabilities object describing thinking support
   */
  async getModelThinkingCapabilities(): Promise<ModelThinkingCapabilities> {
    return modelThinkingCapabilities(this.models.primaryPi);
  }

  /**
   * Clamp a requested thinking level to the nearest level the current model
   * accepts, never exceeding what was asked for.
   *
   * Deliberately does NOT delegate to pi's clampThinkingLevel. Pi clamps by
   * position in its own global ladder, so a level its build does not know is
   * not "too high", it is unrecognized: pi 0.80.3 answers clamp("max") with
   * "off", turning a request for the most thinking into none at all. Since
   * Cortex's vocabulary can legitimately run ahead of the installed pi (that
   * is the whole point of naming levels per-model), that failure mode is
   * reachable by ordinary config. Clamping against the model's own advertised
   * list keeps the answer bounded by what the model actually accepts.
   *
   * Callers should surface a clamp to users when latency or cost changes.
   */
  async clampThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> {
    const caps = await this.getModelThinkingCapabilities();
    return clampToSupported(level, caps.supportedLevels);
  }

  /**
   * Set the cache retention policy for the agentic loop.
   * Used by the consumer to switch between short/long cache based on
   * tick interval and provider. Managed agents pass this through the pi-ai
   * stream options for each provider request.
   */
  setCacheRetention(value: 'none' | 'short' | 'long'): void {
    this.models.setCacheRetention(value);
  }

  /**
   * Get the current cache retention policy.
   * Returns null if not yet resolved (pi-ai will use its own default).
   */
  getCacheRetention(): 'none' | 'short' | 'long' | null {
    return this.models.cacheRetention;
  }

  /**
   * Set the stable cache/session key forwarded to the provider as its
   * prompt_cache_key. Use a value stable across calls that share a prefix.
   * Pass null to clear (the provider then generates its own per-request key).
   */
  setSessionId(value: string | null): void {
    this.models.setSessionId(value);
  }

  /**
   * Get the current cache/session key, or null if unset.
   */
  getSessionId(): string | null {
    return this.models.sessionId;
  }

  /**
   * Update the agent's tool set by adapting Cortex's canonical in-process
   * tool contract to pi-agent-core's raw execute signature.
   *
   * When deferred tools are enabled, this also partitions the union of
   * registered + MCP tools into a "loaded" set (sent to the API) and a
   * "deferred" set (announced by name in the `_available_tools` slot).
   */
  refreshTools(): void {
    this.tools.refresh();
  }

  /**
   * Whether a tool call by this name skips the consumer permission gate.
   *
   * True only when the REGISTERED tool carries `permissionExempt` and is not
   * an MCP wrapper (a remote server must not self-exempt by declaring the
   * field), plus the legacy SubAgent name check. Exemption is a property of
   * the tool object this loop registered, never of the call: an unknown
   * name, or the same name arriving via MCP, still goes to the resolver.
   */
  isToolPermissionExempt(toolName: string): boolean {
    return this.tools.isPermissionExempt(toolName);
  }

  /**
   * Register an additional consumer-provided tool at runtime.
   * Useful for dynamic tool management (e.g., enabling a tool after agent
   * creation based on user permission changes).
   */
  addConsumerTool(tool: CortexTool): void {
    this.tools.add(tool);
  }

  /**
   * Remove a consumer-provided tool by name at runtime.
   * Built-in tools cannot be removed.
   */
  removeConsumerTool(toolName: string): void {
    this.tools.remove(toolName);
  }

  /**
   * Make a utility completion call using the utility model.
   * Convenience wrapper for internal operations (WebFetch summarization,
   * safety classification, etc.).
   *
   * Analogous to directComplete() but uses the utility model (smaller, cheaper)
   * instead of the primary model. Accepts the same raw or structured contexts
   * as directComplete(). Dynamically imports pi-ai's complete() function.
   *
   * @param context - Raw or structured completion context
   * @returns The response text from the LLM
   * @throws Error if pi-ai is not installed or the call fails
   */
  async utilityComplete(context: DirectCompletionContext, options?: DirectCompletionOptions): Promise<string> {
    return this.completions.utility(context, options);
  }


  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Abort the current agentic loop without destroying the agent.
   * The agent remains usable for subsequent prompts.
   */
  async abort(): Promise<void> {
    // Capture the current turn's unwind promise BEFORE aborting, so the
    // wait below is scoped to the turn being cancelled and never to a later
    // turn started by a background delivery.
    const unwound = this.turnUnwound;

    this.promptDiagnostics.recordAbortRequested();
    this.logger.info('abort requested', { isPrompting: this._isPrompting });
    this.queues.dropAllWakeForAbort();
    // A delivery can also park DURING the await windows below; it is
    // cancelled the same way. The live controller cannot express that (a
    // drain that starts mid-abort replaces it, and the gate wait is
    // skipped entirely when background deliveries are pending), so the
    // parked queue is epoch-gated instead: while this abort is in flight
    // every take of the queue drops its items, and the epoch advance in
    // the finally below marks anything stamped earlier as cancelled.
    const abort = this.abortState.begin();
    try {
      this.agent.abort();
      this.promptDiagnostics.startAbortWait();
      try {
        await this.agent.waitForIdle();
        // waitForIdle() only covers pi-agent-core's run promise (it resolves,
        // never rejects). The Cortex-side unwind (retry classification, the
        // prompt finally block) may not have observed the abort yet, so wait
        // for it too. Resetting the controller before that classification ran
        // used to reclassify a cancelled turn as a retryable failure and
        // resurrect it as a background retry.
        await unwound;
      } finally {
        this.promptDiagnostics.finishAbortWait();
      }

      // When no background delivery is pending, also wait for the gate to
      // release the aborted cycle so a follow-up prompt() cannot spuriously
      // fail fast on a stale gate. This is bounded: a queued task is either
      // the just-unwound running turn (its finally drain is an empty no-op
      // before release), a same-frame prompt() that has not started yet
      // (it sees the aborted controller at dequeue and cancels without ever
      // reaching pi), or a wake sweep that finds the parked list dropped
      // above (one parked during this window is dropped by the epoch gate
      // on every take of the parked queue) and never starts a run. When
      // deliveries ARE pending they start a fresh (non-aborted) loop, so
      // return immediately rather than blocking on it.
      if (this.background.pending.length === 0) {
        await this.gate.settled;
      }

      // Reset so the agent is reusable, unless teardown owns the controller
      // now or a newer turn (e.g. a background delivery that started during
      // the wait) already installed its own controller.
      if (!this.isShuttingDown()) abort.renew();
    } finally {
      abort.end();
    }
    this.logger.info('abort complete');
  }

  /**
   * Ordered cleanup of all resources.
   * Called by the consumer when the agent is no longer needed.
   *
   * Steps:
   * 1. Abort any in-progress agentic loop
   * 2. Wait for idle (with timeout)
   * 3. Cancel all sub-agents (stub, wired in Phase 4)
   * 4. Emit onLoopComplete for final checkpoint (best-effort)
   * 5. Close all MCP client connections (kills stdio subprocesses, closes HTTP)
   * 6. Clear skill buffer (stub, wired in Phase 4)
   * 7. Unsubscribe all event listeners
   * 8. Clear agent state
   * 9. Mark as destroyed
   *
   * @param timeoutMs - Maximum time to wait for cleanup (default: 8000ms)
   */
  async destroy(timeoutMs = 8000): Promise<void> {
    if (this.lifecycleState === 'destroyed') {
      return; // Already destroyed, idempotent
    }
    if (this.destroyPromise) {
      return this.destroyPromise; // Teardown already in progress, share it
    }

    this.logger.info('destroy start', {
      activeSubAgents: this.subAgentManager.activeCount,
      mcpConnections: this.mcp.manager.connectionCount,
    });

    // Transition BEFORE any await so nothing can start a new loop while
    // teardown runs: prompt() rejects, queued gate tasks no-op, background
    // completions are dropped, and the end-of-cycle drain is skipped.
    this.lifecycleState = 'destroying';
    // Cancel Cortex-side waits immediately: a pending retry-backoff timer is
    // cleared by its abort listener, and the current turn's unwind is
    // classified as cancelled instead of scheduling further retries.
    this.abortState.abortCurrent();

    this.destroyPromise = (async () => {
      try {
        // Race the cleanup against a force-kill deadline.
        if (await raceTimeout(this.orderedCleanup(), timeoutMs) === 'timeout') {
          this.processes.killAll();
        }
      } finally {
        this.promptDiagnostics.stop();
        this.lifecycleState = 'destroyed';
        this.logger.info('destroy complete');
      }
    })();
    return this.destroyPromise;
  }

  /**
   * Whether the agent is currently running an agentic loop.
   */
  get isRunning(): boolean {
    // Delegate to pi-agent-core's internal state check
    // The agent is "running" if it has an active streaming state
    return this.lifecycleState === 'active' && !this.isIdle();
  }

  /**
   * Get the current lifecycle state.
   */
  get state(): CortexLifecycleState {
    return this.lifecycleState;
  }

  /**
   * The number of messages in agent.state.messages before the current
   * prompt() call. Used by the cache breakpoint system to distinguish
   * "old history" (cacheable) from "new tick content" (ephemeral).
   */
  get prePromptMessageCount(): number {
    return this._prePromptMessageCount;
  }

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  /**
   * Register a handler for when the full agentic loop completes.
   * Maps to pi-agent-core's agent_end event.
   * The consumer uses this to trigger conversation history checkpoints.
   *
   * The origin context identifies which loop completed. It used to take no
   * arguments at all, which under a composite agent meant a consumer was told
   * that "a" loop had finished and could not act on which.
   */
  onLoopComplete(handler: (origin: LoopOriginContext) => void): void {
    this.loopCompleteHandlers.add(handler);
  }

  /**
   * Register a handler for classified errors during the agentic loop.
   * The origin context identifies which loop produced the error.
   */
  onError(handler: (error: ClassifiedError, origin: LoopOriginContext) => void): void {
    this.errorHandlers.add(handler);
  }

  /**
   * Register a handler fired before each background retry's backoff wait.
   * Consumers use this to render a compact, in-place retry status (countdown,
   * attempt count) instead of a hard error. See {@link RetryPolicy}.
   */
  onRetryScheduled(
    handler: (info: RetryScheduledInfo, origin: LoopOriginContext) => void,
  ): void {
    this.retryScheduledHandlers.add(handler);
  }

  /**
   * Register a handler fired when a background retry resolves the turn.
   * The consumer clears the retry status.
   */
  onRetrySucceeded(
    handler: (info: RetrySucceededInfo, origin: LoopOriginContext) => void,
  ): void {
    this.retrySucceededHandlers.add(handler);
  }

  /**
   * Register a handler fired when background retries are given up on. The
   * matching fatal `onError` fires immediately after, so the consumer shows a
   * terminal state.
   */
  onRetryExhausted(
    handler: (info: RetryExhaustedInfo, origin: LoopOriginContext) => void,
  ): void {
    this.retryExhaustedHandlers.add(handler);
  }

  /**
   * Register a handler called before compaction starts.
   * Handler is awaited. The consumer should flush critical state
   * (e.g., observational memory) before history is compacted.
   *
   * NOT called during mid-loop emergency truncation (Layer 3).
   */
  onBeforeCompaction(
    handler: (target: CompactionTarget, origin: LoopOriginContext) => Promise<void>,
  ): void {
    this.compactionManager.onBeforeCompaction(
      (target) => handler(target, this.originContext),
    );
  }

  /**
   * Register a handler called after compaction completes.
   * The consumer uses this to re-seed messages from messages.db,
   * update internal state, or perform other post-compaction work.
   */
  onPostCompaction(
    handler: (result: CompactionResult, origin: LoopOriginContext) => void,
  ): void {
    this.compactionManager.onPostCompaction(
      (result) => handler(result, this.originContext),
    );
  }

  /**
   * Register a handler for compaction errors.
   */
  onCompactionError(
    handler: (error: Error, origin: LoopOriginContext) => void,
  ): void {
    this.compactionManager.onCompactionError(
      (error) => handler(error, this.originContext),
    );
  }

  /**
   * Register a handler called when Layer 2 compaction failed and Layer 3
   * (emergency truncation) was used as fallback. The session continues
   * but context quality is degraded.
   */
  onCompactionDegraded(
    handler: (info: CompactionDegradedInfo, origin: LoopOriginContext) => void,
  ): void {
    this.compactionManager.onCompactionDegraded(
      (info) => handler(info, this.originContext),
    );
  }

  /**
   * Register a handler called when all compaction layers have failed.
   * The consumer should take recovery action (e.g., pause heartbeat,
   * abort the session, or notify the user).
   */
  onCompactionExhausted(
    handler: (info: CompactionExhaustedInfo, origin: LoopOriginContext) => void,
  ): void {
    this.compactionManager.onCompactionExhausted(
      (info) => handler(info, this.originContext),
    );
  }

  /**
   * Register a handler for turn completion with parsed working tag output.
   * The origin context identifies which loop completed the turn.
   */
  onTurnComplete(handler: (output: AgentTextOutput, origin: LoopOriginContext) => void): void {
    this.turnCompleteHandlers.add(handler);
  }

  /**
   * Register a handler for sub-agent spawn events.
   */
  onSubAgentSpawned(handler: (taskId: string, instructions: string, background: boolean) => void): void {
    this.subAgents.spawnedHandlers.add(handler);
  }

  /**
   * Register a handler for sub-agent completion events.
   */
  onSubAgentCompleted(handler: (taskId: string, result: string, status: string, usage: unknown) => void): void {
    this.subAgents.completedHandlers.add(handler);
  }

  /**
   * Register a handler for sub-agent failure events.
   */
  onSubAgentFailed(handler: (taskId: string, error: string) => void): void {
    this.subAgents.failedHandlers.add(handler);
  }

  /**
   * Register a handler that fires when background sub-agent results are about
   * to be delivered to the parent agent, restarting its agentic loop.
   * Consumers can use this to update UI state (show spinners, etc.).
   */
  onBackgroundResultDelivery(handler: (taskIds: string[]) => void): void {
    this.background.deliveryHandlers.add(handler);
  }

  /**
   * Register a handler that fires when content is dead-lettered: a
   * background completion whose delivery gave up (attempts exhausted,
   * elapsed budget spent, or a fatal error) or that the agent shut down
   * before delivering, or a parked wake delivery dropped after its
   * carrying runs failed repeatedly (kind 'wake_delivery'). The consumer
   * can surface the content to the user or re-drive the work; Cortex will
   * not retry it.
   */
  onBackgroundResultDeadLettered(
    handler: (result: DeadLetteredBackgroundResult) => void,
  ): void {
    this.deadLetters.handlers.add(handler);
  }

  /**
   * Get the EventBridge for direct event access.
   * Consumers that need raw event data (for logging) can subscribe directly.
   */
  getEventBridge(): EventBridge {
    return this.eventBridge;
  }

  /**
   * Get the BudgetGuard for inspecting turn/cost state.
   */
  getBudgetGuard(): BudgetGuard {
    return this.budgetGuard;
  }

  /**
   * Get the usage data from the most recent directComplete() or
   * structuredComplete() call. Returns null if no usage was available
   * or no call has been made yet.
   *
   * This is the primary mechanism for consumers (like the backend pipeline)
   * to capture per-phase usage for persistence. The value is reset to null
   * at the start of each directComplete/structuredComplete call.
   */
  getLastDirectUsage(): CortexUsage | null {
    return this.usage.lastDirect;
  }

  /**
   * Get accumulated session usage (cost, turns, token breakdown).
   *
   * Unlike BudgetGuard (which resets per agentic loop), this accumulates
   * across the entire session lifetime. Consumers can persist this value
   * and restore it via restoreSessionUsage() after loading a saved session.
   */
  getSessionUsage(): SessionUsage {
    return this.usage.snapshot();
  }

  /**
   * Restore session usage from consumer-provided data.
   *
   * Call this after restoreConversationHistory() when resuming a saved session.
   * Values are added to any usage already accumulated (in case turns ran
   * before the restore call).
   */
  restoreSessionUsage(usage: SessionUsage): void {
    this.usage.restore(usage);
  }

  // -----------------------------------------------------------------------
  // Token Tracking and Pipeline Phase
  // -----------------------------------------------------------------------

  /**
   * Update the post-hoc current-context token count from LLM usage data.
   * Called by the consumer after each LLM call with the input_tokens
   * from AssistantMessage.usage.
   */
  updateCurrentContextTokenCount(inputTokens: number): void {
    this.compactionManager.updateCurrentContextTokenCount(inputTokens);
  }

  /**
   * Get the post-hoc current-context token count from the most recent parent turn.
   */
  get currentContextTokenCount(): number {
    return this.compactionManager.currentContextTokenCount;
  }

  /**
   * Estimate the current context tokens Cortex would send on the next parent LLM call.
   *
   * This is a heuristic estimate of the transformed context snapshot built from:
   * - the current system prompt
   * - slots and conversation history
   * - ephemeral context
   * - background task state
   * - loaded skills
   *
   * The estimate is compared against the most recent post-hoc parent turn usage
   * and the larger value is returned. This matches the compaction manager's
   * internal decision logic.
   */
  estimateCurrentContextTokens(): number {
    const boundary = this._isPrompting
      ? this._prePromptMessageCount
      : this.agent.state.messages.length;
    const snapshot = this.buildInjectedAndSanitizedContextSnapshot(
      this.buildAgentContextSnapshot(),
      boundary,
    );
    return this.compactionManager.estimateCurrentContextTokens(snapshot);
  }

  /**
   * Set the context window size (from model metadata).
   * If a contextWindowLimit is set, the effective value will be
   * min(limit, contextWindow).
   */
  setContextWindow(contextWindow: number): void {
    this.models.setContextWindow(contextWindow);
  }

  /**
   * Set a user-configured limit on the context window.
   * The effective context window becomes min(limit, model.contextWindow)
   * without increasing explicit limits. This does not resize server allocation.
   * Pass null to remove the limit and use the model's full context window.
   */
  setContextWindowLimit(limit: number | null): void {
    this.models.setContextWindowLimit(limit);
  }

  /**
   * Get the raw user-configured context window limit (null = no limit).
   */
  get contextWindowLimit(): number | null {
    return this.models.contextWindowLimit;
  }

  /**
   * Get the effective context window after clamping the limit to backend capacity.
   */
  get effectiveContextWindow(): number {
    return this.compactionManager.contextWindow;
  }

  /**
   * Get the model's actual context window (unaffected by consumer limits).
   */
  get modelContextWindow(): number {
    return this.compactionManager.modelContextWindow;
  }

  /**
   * Signal how recently the user last interacted.
   * Used by the compaction system to adjust thresholds:
   * - Recent interaction: use normal thresholds
   * - No interaction for a while: compact more aggressively
   *
   * The backend calls this during GATHER when a message-triggered tick fires
   * (set to Date.now()). For interval ticks, it is not called, so the
   * timestamp ages naturally.
   */
  setLastInteractionTime(timestamp: number): void {
    this.compactionManager.setLastInteractionTime(timestamp);
  }

  /**
   * Cap a tool result at insertion time. If the result exceeds
   * maxResultTokens, truncates to head+tail bookend format.
   * Call this when tool results enter conversation history.
   */
  capToolResult(content: string): string {
    return this.compactionManager.capToolResult(content);
  }

  // -----------------------------------------------------------------------
  // Observational Memory
  // -----------------------------------------------------------------------

  /**
   * Get the observational memory state for session persistence.
   * Returns null if not using the observational strategy.
   */
  getObservationalMemoryState(): ObservationalMemoryState | null {
    return this.compactionManager.getObservationalMemoryState();
  }

  /**
   * Restore observational memory state from a previous session.
   * Must be called after restoreConversationHistory().
   */
  restoreObservationalMemoryState(state: ObservationalMemoryState): void {
    // Conversation history is restored before this call, so the post-slot
    // message count is the length the buffer watermark must align with.
    const slotCount = this.contextManager.slotCount;
    const historyLength = Math.max(0, this.agent.state.messages.length - slotCount);
    this.compactionManager.restoreObservationalMemoryState(state, historyLength);
    // Populate the observation slot only when there are real observations to
    // show. getObservationSlotContent() always returns at least the preamble,
    // so guarding on hasObservations() keeps a resumed-but-never-observed
    // session looking like a fresh one (empty slot) instead of injecting the
    // preamble around an empty <observations> block.
    if (this.compactionManager.hasObservations()) {
      this.contextManager.setSlot('_observations', this.compactionManager.getObservationSlotContent());
    }
    // No observer is launched on resume. The restored buffer + watermark are
    // valid as-is, and the unobserved tail is restored as raw messages. The
    // observer catches up lazily on the next turn_end (async buffering from the
    // watermark), and the per-prompt activation check is the safety net if the
    // first turn pushes utilization past the activation threshold.
  }

  /**
   * Force a synchronous observation cycle.
   * Useful after critical user corrections.
   */
  async triggerObservation(): Promise<void> {
    const slotCount = this.contextManager.slotCount;
    await this.compactionManager.triggerObservation(this.agent.state.messages, slotCount);
    // Update the slot after the observer completes
    const slotContent = this.compactionManager.getObservationSlotContent();
    if (slotContent) {
      this.contextManager.setSlot('_observations', slotContent);
    }
  }

  /**
   * Register a handler for observation events.
   * Fires when messages are compressed into observations.
   */
  onObservation(
    handler: (event: ObservationEvent, origin: LoopOriginContext) => void,
  ): void {
    this.compactionManager.onObservation(
      (event) => handler(event, this.originContext),
    );
  }

  /**
   * Register a handler for reflection events.
   * Fires when the reflector condenses observations.
   */
  onReflection(
    handler: (event: ReflectionEvent, origin: LoopOriginContext) => void,
  ): void {
    this.compactionManager.onReflection(
      (event) => handler(event, this.originContext),
    );
  }

  /**
   * Run deferred digestion OUTSIDE a prompt: pending observation buffering
   * plus the threshold pass (observation activation, reflection, and, for
   * the classic strategy, summarization), with blocking work explicitly
   * allowed even under the non-blocking posture. This is the primitive
   * behind scheduling digestion in idle windows: without it, observation
   * only triggers on turn_end and compaction only runs inside
   * transformContext, so there is no way to do either between turns.
   *
   * Serialized through the loop gate, so it can never race a running
   * turn's history mutations; called while a turn is active, it runs after
   * that turn finishes. prompt() fails fast while digestion holds the gate
   * (deliver() parks or queues as usual). Both phases are bounded by
   * options.observerTimeoutMs (default 60s): the observer catch-up waits
   * time out inside the compaction manager, and the blocking threshold
   * pass is raced against the same deadline here, so a hung utility
   * request (observer, reflector, or summarizer) times the digestion out
   * instead of wedging the gate. A timed-out pass is invalidated, not just
   * abandoned: when its hung call eventually settles, its history rewrite
   * is discarded instead of being applied over messages a later prompt has
   * appended in the meantime.
   */
  async digestIdle(options?: IdleDigestionOptions): Promise<IdleDigestionResult> {
    this.assertNotShuttingDown();
    return this.enqueueLoopTask(async () => {
      if (this.isShuttingDown()) {
        return { observerRan: false, historyCompacted: false };
      }
      // Every wait below races the owner's preemption signal.
      const signal = options?.signal;
      if (signal?.aborted) {
        return { observerRan: false, historyCompacted: false, preempted: true };
      }

      // 1. Buffer catch-up (observational only): make sure the expensive
      // observer work over the unobserved tail is done and chunked, so the
      // next activation is a cheap merge. Preempting abandons only the
      // wait, like the timeout: the observer lands its chunk when it
      // settles.
      let observerRan = false;
      if (this.compactionManager.strategy === 'observational') {
        const outcome = await raceAbort(
          this.compactionManager.digestPendingObservationBuffers(
            this.agent.state.messages,
            this.contextManager.slotCount,
            options?.observerTimeoutMs,
          ),
          signal,
        );
        if (outcome === ABORTED) {
          this.logger.debug('idle digestion preempted during observer catch-up');
          return { observerRan: false, historyCompacted: false, preempted: true };
        }
        observerRan = outcome;
      }
      if (signal?.aborted) {
        return { observerRan, historyCompacted: false, preempted: true };
      }
      return this.runDigestionThresholdPass(observerRan, options);
    });
  }

  /**
   * Phase 2 of {@link digestIdle}, under the gate it holds: the threshold
   * pass, bounded by the timeout and by preemption, which abandon it the
   * same way.
   */
  private async runDigestionThresholdPass(
    observerRan: boolean,
    options?: IdleDigestionOptions,
  ): Promise<IdleDigestionResult> {
    // 2. Threshold pass: run the same pipeline transformContext runs
    // against the live source history. Source mutations (activation
    // trims, summarization rewrites) persist; the returned view is
    // discarded. _forceBlockingCompaction lets the manager run its
    // synchronous paths regardless of the configured posture; those
    // paths block on utility requests (reflection, summarization), so
    // the pass shares the observer deadline rather than holding the
    // gate indefinitely behind a hung request.
    const lengthBefore = this.agent.state.messages.length;
    const hook = this.getTransformContextHook();
    const passGeneration = this._digestionGeneration;
    this._forceBlockingCompaction = true;
    const thresholdPass = (async () => {
      try {
        await hook(this.buildAgentContextSnapshot());
      } finally {
        // Only the pass that still owns the current generation may lower
        // the flag: an abandoned pass settling here while a LATER pass is
        // mid-flight would otherwise silently degrade that pass to the
        // non-blocking posture.
        if (passGeneration === this._digestionGeneration) {
          this._forceBlockingCompaction = false;
        }
      }
    })();
    const timeoutMs = options?.observerTimeoutMs ?? DEFAULT_IDLE_DIGESTION_OBSERVER_TIMEOUT_MS;
    const outcome = await raceTimeout(thresholdPass, timeoutMs, options?.signal);
    const wasPreempted = outcome === 'aborted';
    if (outcome !== 'settled') {
      // Abandoned (timed out or preempted), not cancelled: nothing can
      // cancel the utility call, so it can still settle minutes from
      // now, after the gate released and a real prompt appended live
      // messages. Advance the generation so that late continuation
      // discards itself instead of replacing live history from its stale
      // snapshot, and lower the flag for the pass (its own finally is now
      // stale). The race already swallows the eventual settlement.
      this._digestionGeneration += 1;
      this._forceBlockingCompaction = false;
      if (wasPreempted) {
        this.logger.debug('idle digestion threshold pass preempted');
      } else {
        this.logger.warn('idle digestion threshold pass timed out', { timeoutMs });
      }
    }
    const historyCompacted = this.agent.state.messages.length !== lengthBefore;

    this.logger.debug('idle digestion complete', { observerRan, historyCompacted });
    return { observerRan, historyCompacted, ...(wasPreempted ? { preempted: true } : {}) };
  }

  /**
   * Run end-of-tick compaction check. Call after EXECUTE completes,
   * before the next tick starts. Returns the CompactionResult if
   * Layer 2 compaction ran, null otherwise.
   */
  async checkAndRunCompaction(): Promise<CompactionResult | null> {
    return this.compactionManager.checkAndRunCompaction(
      () => this.getConversationHistory(),
      (history) => this.restoreConversationHistory(history),
    );
  }

  /**
   * Get the CompactionManager for advanced use.
   */
  getCompactionManager(): CompactionManager {
    return this.compactionManager;
  }

  /**
   * Get the configured environment variable overrides.
   * Consumers use this when creating built-in tools (e.g., BashToolConfig.envOverrides)
   * to ensure all subprocess environments include these overrides.
   */
  getEnvOverrides(): Record<string, string> | undefined {
    return this.envOverrides;
  }

  /**
   * Get the McpClientManager for managing MCP server connections.
   * Consumers use this to connect/disconnect plugin tool servers
   * and to retrieve discovered tools.
   */
  getMcpClientManager(): McpClientManager {
    return this.mcp.manager;
  }

  /**
   * Connect to an MCP server and discover its tools.
   * Convenience wrapper around mcpClientManager.connect().
   *
   * @param serverName - Unique name for this server (used for tool namespacing)
   * @param config - Transport configuration (stdio or http)
   */
  async connectMcpServer(serverName: string, config: McpTransportConfig): Promise<void> {
    await this.mcp.manager.connect(serverName, config);
  }

  /**
   * Disconnect from an MCP server and remove its tools.
   * Convenience wrapper around mcpClientManager.disconnect().
   *
   * @param serverName - The server name to disconnect
   */
  async disconnectMcpServer(serverName: string): Promise<void> {
    await this.mcp.manager.disconnect(serverName);
  }

  /**
   * Snapshot of every MCP server this agent is currently connected to (or
   * attempting to reconnect to). The shape is deliberately read-only: use
   * {@link connectMcpServer} / {@link disconnectMcpServer} to mutate. The
   * consumer (`cortex-code`'s hot-reload watcher) uses this to compute the
   * diff between desired (config files) and current state between turns.
   */
  getMcpServerStates(): McpConnectionState[] {
    return this.mcp.manager.getConnectionStates();
  }

  /**
   * Whether the live config for a connected MCP server structurally matches
   * `config`. Delegates to the MCP client manager, which compares the full
   * stored config (including secret `env`/`headers`) without exposing it. The
   * hot-reload watcher and `/mcp-reload` use this to decide whether a server
   * needs reconnecting after its on-disk config changed, since
   * {@link getMcpServerStates} deliberately returns redacted configs. Returns
   * false when no server is connected under `serverName`.
   */
  mcpConfigMatches(serverName: string, config: McpTransportConfig): boolean {
    return this.mcp.manager.configMatches(serverName, config);
  }

  /**
   * Register a callback fired when MCP tool servers emit
   * `notifications/progress` during a long-running `tools/call`. Consumers
   * wire this to whatever UI affordance they have for "still waiting…".
   * Replace semantics per loop: setting a handler displaces this loop's
   * previous one (undefined clears it), while other holders of a shared
   * manager keep their own registrations.
   */
  setMcpToolCallProgressHandler(
    handler: ((progress: McpToolCallProgress) => void) | undefined,
  ): void {
    this.mcp.setProgressHandler(handler);
  }

  /**
   * Get all tools from all sources: built-in tools registered on the
   * pi-agent-core Agent, plus MCP-wrapped tools from connected servers.
   *
   * Returns only the MCP-wrapped tools. Built-in tools are registered
   * directly on the Agent and are not included here.
   */
  getMcpTools(): CortexTool[] {
    return this.mcp.manager.getTools();
  }

  // -----------------------------------------------------------------------
  // transformContext hook composition
  // -----------------------------------------------------------------------

  /**
   * Get the composed transformContext hook for the pi-agent-core Agent.
   *
   * Composes five steps in order:
   * 0. Tier 1 insertion-time cap (mutates source messages)
   * 1. Insert ephemeral + skill buffer at the boundary position
   *    (after old history, before new tick content) for cache optimization
   * 2. Message sanitization
   * 3. Compaction (all three layers: microcompaction, summarization, failsafe)
   * 4. Compute API message indices for cache breakpoints BP2 and BP3
   *
   * Cache breakpoint strategy:
   *   Anthropic allows 4 cache_control breakpoints. Pi-ai sets up to 3
   *   (system prompt, last tool definition, last user message). The
   *   onPayload hook strips the tool breakpoint and adds BP2 (after last
   *   slot) and BP3 (old history boundary), keeping the total at 4.
   *
   *   By inserting ephemeral at the boundary instead of the end, the
   *   conversation history prefix becomes stable across ticks, enabling
   *   cache reads on ~128K of tokens instead of only ~5.5K.
   *
   * The hook is async because Layer 2 compaction may require an LLM call
   * for summarization. Pi-agent-core's transformContext supports async hooks.
   *
   * @returns An async transformContext function for the Agent constructor
   */
  getTransformContextHook(): (context: AgentContext) => Promise<AgentContext> {
    const slotCount = this.contextManager.slotCount;

    return async (context: AgentContext): Promise<AgentContext> => {
      const sourceMessages = context.messages;
      // Generation this pass runs under. digestIdle() advances it when it
      // abandons a timed-out pass; from then on this pass's continuation is
      // stale and must not touch live state (its hung call can settle after
      // a later prompt appended messages to the same live history).
      const passGeneration = this._digestionGeneration;
      const passIsStale = (): boolean => passGeneration !== this._digestionGeneration;

      // Step 0: Apply Tier 1 insertion-time cap to the source messages.
      // Mutate the active transformContext source array, not only
      // agent.state.messages. Pi-agent-core keeps its own in-loop
      // currentContext.messages array and does not replace it with the
      // transformContext return value, so source mutations must hit this
      // array to persist for the next turn in the same loop.
      // passIsStale is threaded in: the aggregate phase awaits a consumer
      // persistResult, and an abandoned pass settling there must not write
      // a stale message back into an array a later splice has changed.
      await this.compactionManager.applyInsertionCap(
        sourceMessages,
        slotCount,
        passIsStale,
      );
      if (passIsStale()) return context;
      this.agent.state.messages = [...sourceMessages];

      // Step 1: Insert ephemeral and skill buffer at the boundary position
      // (after old history, before new tick content).
      // This keeps the tick prompt as the last message for better model
      // attention and enables cross-tick conversation history caching.
      // Previously, ephemeral was appended at the END of messages, making
      // it the "last user message" where pi-ai places BP4. That meant
      // the entire conversation history was cache-WRITTEN but never
      // cache-READ because the ephemeral prefix changed every tick.
      const boundary = this._prePromptMessageCount;
      let result = this.buildInjectedAndSanitizedContextSnapshot(context, boundary);

      // Step 3: Compaction (all three layers integrated)
      // Source-history compaction operates on the active pi-agent-core loop
      // transcript and syncs that result back to agent.state.messages. The
      // returned context alone only affects the immediate LLM call.
      result = await this.compactionManager.applyInTransformContext(
        result,
        // getHistory: extract conversation history (post-slot region)
        (ctx) => ctx.messages.slice(slotCount),
        // setHistory: replace conversation history in the context
        (ctx, history) => ({
          ...ctx,
          messages: [...ctx.messages.slice(0, slotCount), ...history],
        }),
        // getSourceHistory: get original transcript history from the active
        // pi-agent-core loop context, not only agent.state.messages.
        () => sourceMessages.slice(slotCount),
        // setSourceHistory: replace original transcript after compaction in
        // both the active loop context and the persisted agent state.
        // Covers the observational activation trim and sync-observer paths
        // and the classic summarizer rewrite: all of them land here.
        (history) => {
          if (passIsStale()) {
            // An abandoned digestIdle() pass settling late: its snapshot
            // predates messages a real prompt has since appended, so this
            // rewrite would silently destroy them. Discard it.
            this.logger.warn('discarding history rewrite from an abandoned digestion pass');
            return;
          }
          // Adjust boundary after compaction. This recalculation is exact
          // only while every rewrite keeps the current tick's messages as a
          // contiguous suffix of `history`; all setSourceHistory callers
          // hold that today, and a strategy that breaks it skews the tick
          // boundary silently.
          const currentTickCount = sourceMessages.length - this._prePromptMessageCount;
          sourceMessages.splice(slotCount, sourceMessages.length - slotCount, ...history);
          this.agent.state.messages = [...sourceMessages];
          // Recalculate boundary: new total minus current-tick messages
          this._prePromptMessageCount = Math.max(
            slotCount,
            sourceMessages.length - currentTickCount,
          );
        },
        // digestIdle() re-enables blocking work for its pass; otherwise the
        // manager's configured posture decides. Staleness is threaded so an
        // abandoned pass suppresses its compaction/observation/reflection
        // event dispatch: its rewrite is discarded (setSourceHistory
        // above), and a consumer must never see a compaction reported for
        // a rewrite that never landed.
        {
          ...(this._forceBlockingCompaction ? { allowBlocking: true } : {}),
          isStale: passIsStale,
        },
      );
      // A pass abandoned while the manager call hung must not mutate the
      // live observation slot or breakpoint state either; its return value
      // goes nowhere.
      if (passIsStale()) return result;

      // After compaction/observation runs, update the observation slot
      if (this.compactionManager.strategy === 'observational') {
        const slotContent = this.compactionManager.getObservationSlotContent();
        if (slotContent) {
          this.contextManager.setSlot('_observations', slotContent);
          // Also update the in-memory context for this LLM call so the
          // returned context reflects post-reflection observation content
          if (this.compactionManager.hasObservations()) {
            const obsSlotIndex = this.contextManager.slotCount - 1;
            if (obsSlotIndex >= 0 && obsSlotIndex < result.messages.length) {
              result.messages[obsSlotIndex] = { role: 'user', content: slotContent, timestamp: Date.now() };
            }
          }
        }
      }

      // Step 4: Compute API message indices for cache breakpoints.
      // Count how messages map from our array to the Anthropic API format
      // (convertMessages skips empty messages and merges consecutive
      // toolResults). The indices are consumed by the onPayload hook.
      //
      // BP3 covers old history plus the stable injections (ephemeral and
      // skills, which hold constant across ticks within a turn). Background
      // task state churns every tick, so it is injected after this boundary
      // and stays outside the cached prefix.
      const stableInjectionCount =
        (this.contextManager.getEphemeral() ? 1 : 0) +
        (this.skills.loadedCount > 0 ? 1 : 0);
      this._cacheBreakpointIndices = computeCacheBreakpointIndices(result.messages, {
        slotCount,
        boundary: this._prePromptMessageCount + stableInjectionCount,
      });

      return result;
    };
  }

  private buildAgentContextSnapshot(): AgentContext {
    return {
      systemPrompt: this.agent.state.systemPrompt ?? '',
      model: this.agent.state.model ?? null,
      messages: this.agent.state.messages,
      tools: (this.agent.state.tools ?? []) as unknown[],
      thinkingLevel: typeof this.agent.state.thinkingLevel === 'string'
        ? this.agent.state.thinkingLevel
        : 'medium',
    };
  }

  private buildInjectedAndSanitizedContextSnapshot(
    context: AgentContext,
    boundary: number,
  ): AgentContext {
    let result = context;
    const ephemeralContent = this.contextManager.getEphemeral();

    // Build injection messages ordered by stability: ephemeral and skills
    // hold constant across ticks within a turn, so the BP3 cache breakpoint
    // can sit after them. Background task state (durations, live output)
    // churns every tick and must come last, outside the cached prefix.
    const injections: AgentMessage[] = [];
    if (ephemeralContent) {
      injections.push({ role: 'user' as const, content: ephemeralContent, timestamp: Date.now() });
    }
    const skills = this.skills.renderInjection();
    if (skills) {
      injections.push({ role: 'user' as const, content: skills, timestamp: Date.now() });
    }

    // Inject background task state so the agent has visibility into
    // running sub-agents and background bash processes.
    const backgroundState = this.buildBackgroundTaskState();
    if (backgroundState) {
      injections.push({ role: 'user' as const, content: backgroundState, timestamp: Date.now() });
    }

    // Consumer-fed headline block (facade status lines). Like background
    // task state it churns every tick, so it rides after the BP3 boundary
    // (it is NOT counted in stableInjectionCount) while still being built
    // here so token estimation and compaction utilization see it.
    const headline = this.buildHeadlineInjection();
    if (headline) {
      injections.push({ role: 'user' as const, content: headline, timestamp: Date.now() });
    }

    if (injections.length > 0) {
      // Insert at boundary: [...slots + old_history] [injections] [...new_tick_content]
      const messages = [...result.messages];
      // boundary may exceed array length on first tick or after reset
      const insertIdx = Math.min(boundary, messages.length);
      messages.splice(insertIdx, 0, ...injections);
      result = { ...result, messages };
    }

    // Sanitize messages before token estimation or compaction.
    return {
      ...result,
      messages: result.messages.map(withPlaceholderContent),
    };
  }

  // Cache breakpoint index computation lives in cache-breakpoints.ts,
  // shared with the direct completion endpoints.

  // -----------------------------------------------------------------------
  // Private: Model resolution
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Private: Lifecycle helpers
  // -----------------------------------------------------------------------

  /**
   * Check if the agent was aborted (user or system cancellation).
   * Only returns true for actual abort/cancel signals, not arbitrary errors.
   */
  private isAborted(): boolean {
    return this.abortState.signal.aborted ||
      isAbortShapedError(this.agent.state as Record<string, unknown>);
  }

  /**
   * Check if the agent is currently idle (not running a loop).
   * Tracked via a boolean flag set at prompt() entry and cleared in its finally block.
   */
  private isIdle(): boolean {
    return !this._isPrompting;
  }

  /**
   * Perform ordered cleanup.
   */
  private async orderedCleanup(): Promise<void> {
    // 1. Abort any in-progress agentic loop
    this.agent.abort();

    try {
      await this.agent.waitForIdle();
    } catch {
      // Ignore errors during wait (agent may already be idle)
    }

    // 1b. Wait for the loop gate to drain: the aborted cycle's Cortex-side
    // unwind plus any queued delivery tasks (which no-op now that the
    // lifecycle is 'destroying'). Bounded by destroy()'s force-kill race.
    await this.gate.settled;

    // 1c. Dead-letter completions still awaiting delivery. The queued drain
    // tasks above no-oped once teardown began, so anything still pending
    // will never be delivered; record it (and notify handlers, which are
    // still registered at this point) rather than letting completed work
    // vanish with the shutdown.
    this.background.deadLetterAllPending('agent shut down before delivery');

    // 2. Cancel all sub-agents. Full child destroy(), not just a pi-level
    // abort: an abort alone left the child's MCP connections, event
    // subscriptions, and compaction timers alive until (and unless) its
    // completion continuation got around to destroying it. Bounded by this
    // destroy()'s own force-kill deadline.
    try {
      await this.subAgentManager.cancelAll(async (agent) => {
        await agent.destroy();
      });
    } catch {
      // Best-effort sub-agent cleanup
    }

    // 3. Emit onLoopComplete for final checkpoint (best-effort: a throwing
    // handler is logged and teardown continues)
    this.loopCompleteHandlers.emit(this.originContext);

    // 4. Detach from the MCP manager; close connections only when owned (a
    // shared manager's connections belong to its owner and outlive this loop)
    await this.mcp.detach();

    // 5. Clear skill buffer and registry
    this.skills.destroy();
    this.subAgentManager.destroy();

    // 6. Unsubscribe all event listeners
    this.budgetGuard.destroy();
    this.eventBridge.destroy();
    for (const unsub of this.eventUnsubscribers) {
      unsub();
    }
    this.eventUnsubscribers = [];

    // 7. Clear agent state
    this.agent.reset();

    // 8. Clean up compaction manager
    this.compactionManager.destroy();
    this.tools.runtime.destroy();

    // 9. Clear all handler arrays
    this.loopCompleteHandlers.clear();
    this.errorHandlers.clear();
    this.turnCompleteHandlers.clear();
    this.subAgents.spawnedHandlers.clear();
    this.subAgents.completedHandlers.clear();
    this.subAgents.failedHandlers.clear();
    this.background.deliveryHandlers.clear();
    this.deadLetters.handlers.clear();
    this.queues.clearForTeardown();
    this.asks.clear();
    // The dead-letter store itself is deliberately kept: it must still
    // answer after destroy() (which itself dead-letters anything pending).
  }

  // -----------------------------------------------------------------------
  // Skill System
  // -----------------------------------------------------------------------

  /**
   * Get the SkillRegistry for add/remove/query operations.
   */
  getSkillRegistry(): SkillRegistry {
    return this.skills.registry;
  }

  /**
   * Pre-load a skill into the ephemeral context for the current loop.
   * Same path as the load_skill tool, but triggered by the consumer.
   * No LLM turn is consumed.
   */
  async loadSkill(name: string, args?: string): Promise<void> {
    await this.skills.load(name, args);
  }

  /**
   * Clear the skill buffer. The consumer should call this at the start
   * of each tick (before pre-loading skills for the new loop).
   * Cortex cannot auto-clear because it has no concept of tick boundaries,
   * and clearing at prompt() start would wipe consumer pre-loaded skills.
   */
  clearSkillBuffer(): void {
    this.skills.clear();
  }

  /**
   * Get the current skill buffer contents.
   */
  getSkillBuffer(): LoadedSkill[] {
    return this.skills.snapshot();
  }

  /**
   * Set consumer-provided variables for ${VAR} substitution in skills.
   * Merged with Cortex built-ins (SKILL_DIR, ARGUMENTS).
   * Consumer variables take precedence on collision.
   * Call this each tick during GATHER to update runtime values.
   */
  setPreprocessorVariables(variables: Record<string, string>): void {
    this.skills.registry.setPreprocessorVariables(variables);
  }

  /**
   * Set consumer-provided context that will be passed to skill scripts.
   * Merged with Cortex built-in fields (skillDir, args, scriptArgs).
   * Consumer fields take precedence on collision.
   * Call this each tick during GATHER to update runtime values.
   */
  setScriptContext(context: Record<string, unknown>): void {
    this.skills.registry.setScriptContext(context);
  }

  // -----------------------------------------------------------------------
  // Sub-Agent System
  // -----------------------------------------------------------------------

  /**
   * Get the SubAgentManager for direct sub-agent tracking.
   */
  getSubAgentManager(): SubAgentManager {
    return this.subAgentManager;
  }

  /**
   * Spawn a background sub-agent and return its task ID immediately.
   * Used by consumers that manage delegated work outside the SubAgent tool.
   * Throws when the concurrency limit is reached.
   */
  async spawnBackgroundSubAgent(params: Omit<SubAgentSpawnConfig, 'background'>): Promise<{ taskId: string }> {
    return this.subAgents.spawnBackgroundChecked(params);
  }

  /**
   * Cancel a running sub-agent: destroy the child agent, untrack it, resolve
   * its completion promise as cancelled, and discard any pending or late
   * result so cancelled work is never delivered to the loop.
   * Returns false when the task ID is not an active sub-agent.
   */
  async cancelSubAgent(taskId: string): Promise<boolean> {
    return this.subAgents.cancel(taskId);
  }

  /**
   * Deliver a steering message to a running sub-agent by task ID. The
   * redirect rides the child's public steering queue, so it lands at the
   * next turn boundary of the child's in-flight run. Returns false when
   * the task ID is not an active sub-agent, the child is tearing down, or
   * no run is in flight on the child (not started yet, settle window, or
   * the end-of-cycle drain after its run ended): a redirect accepted in
   * those windows is never polled again and dies with the child, so it is
   * reported undeliverable and the caller decides how to re-route it.
   *
   * True means queued into a live run, not consumed: pi's last steering
   * poll of a run precedes its decision to stop, so a message queued after
   * that final poll (a near-run-end race the parent cannot detect) is
   * never polled and dies with the child. The in-flight gate narrows the
   * lost window to the tail of the final turn; it does not close it. A
   * caller that cannot afford to lose the redirect should confirm the
   * child acted on it rather than treat true as delivery.
   */
  steerSubAgent(taskId: string, message: string): boolean {
    return this.subAgents.steer(taskId, message);
  }

  /**
   * Snapshot of all currently running sub-agents, including live cost and
   * activity. Read-only; safe to call from anywhere (e.g. budget accounting
   * or status surfaces). Returns an empty array when none are running.
   */
  getActiveSubAgents(): SubAgentSnapshot[] {
    return this.subAgents.snapshots();
  }

  /**
   * Build a <background-tasks> block describing running sub-agents and
   * background bash processes. Returns null if nothing is running.
   * Called from transformContext before each LLM call.
   */
  private buildBackgroundTaskState(): string | null {
    const subAgents = this.subAgentManager.getActiveTaskIds()
      .map((taskId) => this.subAgentManager.get(taskId))
      .filter((entry): entry is TrackedSubAgent => entry !== undefined);
    return buildBackgroundTaskState({
      subAgents,
      bashTasks: this.tools.runtime.backgroundTasks.getAll(),
      now: Date.now(),
    });
  }

  /**
   * After a failed delivery attempt, restore the transcript to its
   * pre-delivery state when possible. pi pushes the delivery's user message
   * at run start (before any model call) and appends a synthetic assistant
   * failure stub when the run fails; both must be removed before a
   * re-attempt, or the re-queued delivery appends the same body again.
   *
   * Returns true when the delivery message is no longer in the transcript
   * (unwound here, or it never landed), meaning the batch must be re-queued
   * to survive. Returns false when the run progressed past the delivery
   * message (a model response, tool results, or a steer landed after it):
   * its content stays in history, so the completion counts as delivered and
   * re-queueing would duplicate it.
   */
  private unwindFailedDelivery(preDeliveryCount: number, runAbortEpoch: number): boolean {
    return this.queues.unwindFailedDelivery(preDeliveryCount, runAbortEpoch);
  }

  /**
   * Dead-lettered content (newest last, bounded): background completions
   * whose delivery failed repeatedly, and wake deliveries dropped after
   * their carrying runs failed repeatedly. The consumer can surface these
   * to the user or re-drive the work; Cortex will not retry them.
   */
  getDeadLetteredBackgroundResults(): DeadLetteredBackgroundResult[] {
    return this.deadLetters.list();
  }

  /** Build a sub-agent's loop (the spawner's factory; tests stand in for it). */
  private async createChildAgent(params: ChildLoopParams): Promise<AgentLoop> {
    const { createParams, seedContext } = await prepareChildLoop({
      config: this.config,
      model: this.models.primary,
      workingTagsEnabled: this.workingTagsEnabled,
      contextWindowLimit: this.models.contextWindowLimit,
      loopPath: this.loopPath,
      prompt: { base: this.systemPrompt.base(), current: this.systemPrompt.current() },
      rawPersistResult: this.tools.rawPersistResult,
      resultThresholds: this.tools.resultThresholds,
      inheritableTools: (requested) => this.tools.childInheritable(requested),
      childResolver: (taskId) => this.config.resolvePermission
        ? this.wrapChildPermissionResolver(this.config.resolvePermission, taskId)
        : undefined,
      logger: this.logger,
    }, params);
    const childAgent = await AgentLoop.createManagedAgent(createParams);

    // Seed background context as the child's leading context slot. This is
    // reference material, not the child's objective (its task is its
    // instructions). Positioned before history for prefix-cache stability.
    if (seedContext) {
      childAgent.getContextManager().setSlot(CHILD_SEED_CONTEXT_SLOT, seedContext);
    }
    childAgent.setCacheRetention(this.getCacheRetention() ?? 'none');
    return childAgent;
  }

  /** The consumer's resolver as a child sees it: mirrored into this loop's asks. */
  private wrapChildPermissionResolver(
    parentResolver: NonNullable<AgentLoopConfig['resolvePermission']>,
    childTaskId: string,
  ): NonNullable<AgentLoopConfig['resolvePermission']> {
    return mirrorChildPermissionResolver(parentResolver, {
      asks: this.asks,
      subAgents: this.subAgentManager,
      childTaskId,
      childLoopPath: `${this.loopPath}/${childTaskId}`,
    });
  }

  // -----------------------------------------------------------------------
  // TEMPORARY test compat: old private names that tests still reach
  // through casts, forwarding to the owning module. Pinned by
  // tests/unit/agent-loop-internals-contract.test.ts; removed once the
  // tests move onto the modules.
  // -----------------------------------------------------------------------

  private spawnForegroundSubAgentInternal(params: SubAgentSpawnParams): Promise<ForegroundSpawnResult> {
    return this.subAgents.spawnForeground(params);
  }

  private spawnBackgroundSubAgentInternal(params: SubAgentSpawnParams): Promise<{ taskId: string }> {
    return this.subAgents.spawnBackground(params);
  }

  private registerPendingAsk(ask: PendingAsk): void {
    this.asks.register(ask);
  }

  private settlePendingAsk(askId: string): void {
    this.asks.settle(askId);
  }

  private get pendingBackgroundResults(): PendingBackgroundCompletion[] {
    return this.background.pending;
  }

  private deliverOrQueueBackgroundCompletion(item: PendingBackgroundCompletion): Promise<void> {
    return this.background.enqueue(item);
  }

  private schedulePendingResultDelivery(): Promise<void> {
    return this.background.schedule();
  }

  private drainPendingBackgroundResults(): Promise<void> {
    return this.background.drain();
  }

  private requeueOrDeadLetter(batch: PendingBackgroundCompletion[], err: unknown): void {
    this.background.requeueOrDeadLetter(batch, err);
  }

  private batchRecoveredAfterRequeue(batch: PendingBackgroundCompletion[]): boolean {
    return this.background.batchRecoveredAfterRequeue(batch);
  }

  private get pendingWakeDeliveries(): QueuedDelivery[] {
    return this.queues.wake;
  }

  private get _abortEpoch(): number {
    return this.abortState.epoch;
  }

  private set _abortEpoch(value: number) {
    this.abortState.epoch = value;
  }

  private get trackedPids(): ReadonlySet<number> {
    return this.processes.pids;
  }

  private get registeredTools(): RegisteredTool[] {
    return this.tools.registered;
  }

  private get toolRuntime(): CortexToolRuntime {
    return this.tools.runtime;
  }

  private buildChildToolSet(requestedTools?: string[]): RegisteredTool[] {
    return this.tools.childInheritable(requestedTools);
  }
}

