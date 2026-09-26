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
import type { CacheBreakpointIndices, DirectCompletionContext } from './cache-breakpoints.js';
import { EventBridge } from './event-bridge.js';
import { BudgetGuard } from './budget-guard.js';
import { classifyError } from './error-classifier.js';
import { withPlaceholderContent } from './pi-message.js';
import type { McpClientManager } from './mcp-client.js';
import { CompactionManager } from './compaction/index.js';
import type { ObservationalMemoryState, ObservationEvent, ReflectionEvent } from './compaction/observational/types.js';
import { SubAgentManager } from './sub-agent-manager.js';
import type { SkillRegistry } from './skill-registry.js';
import type { CortexModel } from './model-wrapper.js';
import { assembleLoop, backgroundTaskState } from './agent-loop/assembly.js';
import type { LoopParts } from './agent-loop/assembly.js';
import type { IdleDigestionOptions, IdleDigestionResult } from './agent-loop/context-pipeline.js';
import type { PendingBackgroundCompletion } from './agent-loop/background-delivery.js';
import type {
  DeliverOptions,
  DeliverResult,
  QueuedDelivery,
} from './agent-loop/delivery-queues.js';
import {
  isAbortShapedError,
} from './agent-loop/run-control.js';
import { CHILD_SEED_CONTEXT_SLOT, prepareChildLoop } from './agent-loop/child-loop-config.js';
import type { ChildLoopParams } from './agent-loop/child-loop-config.js';
import type { ForegroundSpawnResult, SubAgentSpawnParams } from './agent-loop/sub-agent-spawner.js';
import { mirrorChildPermissionResolver } from './agent-loop/permissions.js';
import {
  buildPiAgentConfig,
  loadAgentClass,
  wirePiTransformContext,
} from './agent-loop/pi-hooks.js';
import type { PiHookHost, ToolResultInterceptor } from './agent-loop/pi-hooks.js';
import type { DirectCompletionOptions } from './agent-loop/direct-completion.js';
import type { CortexToolRuntime } from './tools/runtime.js';
import { NOOP_LOGGER } from './noop-logger.js';
import type { CortexTool } from './tool-contract.js';
import type {
  CortexLogger,
  AgentLoopConfig,
  CortexLifecycleState,
  CortexUsage,
  SessionUsage,
  ClassifiedError,
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
  PendingAsk,
  LoopOriginContext,
  ThinkingLevel,
  ModelThinkingCapabilities,
} from './types.js';
import { DEFAULT_LOOP_PATH } from './types.js';
import {
  clampToSupported,
  fromPiThinkingLevel,
  modelThinkingCapabilities,
  toPiThinkingLevel,
} from './agent-loop/pi-agent.js';
import type {
  AgentLoopConstructorOptions,
  PiAgent,
  QueueDrainMode,
  RegisteredTool,
} from './agent-loop/pi-agent.js';

export type { PiAgent, PiModel, QueueDrainMode } from './agent-loop/pi-agent.js';
export type { DirectCompletionOptions } from './agent-loop/direct-completion.js';
export type { DeliverOptions, DeliverOutcome, DeliverResult } from './agent-loop/delivery-queues.js';
export type { IdleDigestionOptions, IdleDigestionResult } from './agent-loop/context-pipeline.js';
export { TOOL_RESULT_WORKING_TAGS_REMINDER } from './agent-loop/pi-hooks.js';
export type {
  ToolResultInterceptor,
  ToolResultInterceptorInfo,
  ToolResultInterceptorResult,
} from './agent-loop/pi-hooks.js';

/**
 * Legacy fallback for unknown capacity. Explicit budgets have no minimum floor.
 */
export { MINIMUM_CONTEXT_WINDOW } from './context-budget.js';

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
  private readonly config: AgentLoopConfig;
  private readonly logger: CortexLogger;
  /**
   * Path identity of this loop (config `loopPath`, default 'main'). Threaded
   * through permission asks, callback origin context, persistResult metadata,
   * and log prefixes; sub-agents extend it with '/<taskId>'.
   */
  readonly loopPath: string;
  private workingTagsEnabled: boolean;
  /** The loop's modules, wired by assembly.ts. */
  private readonly parts: LoopParts;

  /**
   * This loop's identity as the trailing argument of every fan-out callback.
   * A composite agent registers one consumer handler on several loops; the
   * origin says which loop did the thing.
   */
  private get originContext(): LoopOriginContext {
    return this.parts.origin;
  }

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
    this.loopPath = config.loopPath ?? DEFAULT_LOOP_PATH;
    this.logger = prefixLoggerWithLoopPath(config.logger ?? NOOP_LOGGER, this.loopPath);
    this.workingTagsEnabled = config.workingTags?.enabled ?? true;
    this.parts = assembleLoop({
      agent,
      config,
      tools,
      options,
      loopPath: this.loopPath,
      logger: this.logger,
      host: {
        workingTagsEnabled: () => this.workingTagsEnabled,
        prompt: (input, promptOptions) => this.prompt(input, promptOptions),
        refreshTools: () => this.refreshTools(),
        directComplete: (context, completeOptions) => this.directComplete(context, completeOptions),
        utilityComplete: (context, completeOptions) => this.utilityComplete(context, completeOptions),
        isAborted: () => this.isAborted(),
        emitError: (error, wasAborted) => this.emitError(error, wasAborted),
        getConversationHistory: () => this.getConversationHistory(),
        restoreConversationHistory: (messages) => this.restoreConversationHistory(messages),
        createChildAgent: (params) => this.createChildAgent(params),
      },
    });
    if (typeof config.initialBasePrompt === 'string') {
      this.setBasePrompt(config.initialBasePrompt);
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
    this.parts.lifecycle.assertNotShuttingDown();
    if (!this.parts.systemPrompt.isConfigured()) {
      throw new Error(
        'AgentLoop prompt is not configured. Call setBasePrompt() before prompt(), ' +
        'or provide initialBasePrompt during creation.',
      );
    }
    if (this.parts.gate.isActive) {
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
    this.parts.abortState.renewIfAborted();

    return this.parts.gate.enqueue(() => this.parts.runner.runCycle(input, options));
  }

  /**
   * True while any gate task is running or queued: a prompt cycle, a
   * background-completion drain, an idle digestion pass, or a delivery
   * sweep. While true, prompt() fails fast and deliver() steers or queues
   * instead of starting a turn.
   */
  get isLoopActive(): boolean {
    return this.parts.gate.isActive;
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
    return this.parts.runner.isPrompting;
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
    return this.parts.runner.activeCauseTags;
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
    return this.parts.gate.waitForIdle();
  }

  // -----------------------------------------------------------------------
  // Background retry
  // -----------------------------------------------------------------------



  private fireRetryScheduled(info: RetryScheduledInfo): void {
    this.parts.runner.retryScheduled.emit(info, this.originContext);
  }

  private fireRetrySucceeded(info: RetrySucceededInfo): void {
    this.parts.runner.retrySucceeded.emit(info, this.originContext);
  }

  private fireRetryExhausted(info: RetryExhaustedInfo): void {
    this.parts.runner.retryExhausted.emit(info, this.originContext);
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
    this.parts.queues.steer(message);
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
    return this.parts.queues.deliver(content, options);
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
    this.parts.queues.followUp(message);
  }

  /** Set how pi drains queued steering messages. */
  setSteeringQueueMode(mode: QueueDrainMode): void {
    this.parts.queues.setSteeringQueueMode(mode);
  }

  /** Set how pi drains queued follow-up messages. */
  setFollowUpQueueMode(mode: QueueDrainMode): void {
    this.parts.queues.setFollowUpQueueMode(mode);
  }

  /**
   * Remove all queued steering messages from pi's steering queue (public
   * steer() content). Parked wake deliveries are loop-owned and are not
   * affected; drop those via {@link clearAllQueues}.
   */
  clearSteeringQueue(): void {
    this.parts.queues.clearSteeringQueue();
  }

  /** Remove all queued follow-up messages from pi's follow-up queue. */
  clearFollowUpQueue(): void {
    this.parts.queues.clearFollowUpQueue();
  }

  /**
   * Remove every queued message: pi's steering and follow-up queues plus
   * this loop's silent delivery queue and parked wake deliveries. Returns
   * the dropped loop-owned content (silent first, then parked wake, each
   * in queue order) so a caller can re-route or persist it. A pending
   * sweep task finds nothing and no-ops.
   */
  clearAllQueues(): string[] {
    return this.parts.queues.clearAll();
  }

  /** Number of silent deliveries waiting for the next real prompt. */
  get queuedDeliveryCount(): number {
    return this.parts.queues.silentCount;
  }

  /** Number of parked wake deliveries waiting for the next run. */
  get pendingWakeDeliveryCount(): number {
    return this.parts.queues.wakeCount;
  }

  /**
   * Drop all queued silent deliveries, returning their content in queue
   * order so the caller can re-route or persist them.
   */
  clearQueuedDeliveries(): string[] {
    return this.parts.queues.clearSilent();
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
    return this.parts.queues.dropWake(predicate);
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
    return this.parts.asks.list();
  }

  /**
   * Mark a pending ask as voiced (presented to the human). Consent binding
   * accepts an allow only for the most recently voiced ask, so a broker
   * calls this at the moment it actually surfaces the request. Returns
   * false for an unknown or already-settled askId.
   */
  markAskVoiced(askId: string): boolean {
    return this.parts.asks.markVoiced(askId);
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
    return this.parts.asks.waitForSettlement();
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
    this.parts.pipeline.headline.set(provider, options);
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
    this.parts.finalizer.setInterceptor(interceptor);
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

    this.parts.errorHandlers.emit(classified, { loopPath: this.loopPath });

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
    return this.parts.completions.direct(context, options);
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
    return this.parts.completions.structured(context, schema, toolName, toolDescription, options);
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
      asks: this.parts.asks,
      streamOptions: () => ({
        retention: this.parts.runner.activeCacheRetention ?? this.parts.models.cacheRetention ?? null,
        sessionId: this.parts.models.sessionId ?? null,
      }),
      syncActiveLoopTools: (ctx) => this.parts.tools.syncActiveLoopTools(ctx),
      finalizer: this.parts.finalizer,
      cacheBreakpointIndices: () => this.parts.pipeline.cacheBreakpointIndices,
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
      agentLoop.parts.systemPrompt.apply(initialSystemPrompt);
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
    return this.parts.contextManager;
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
    return this.parts.systemPrompt.compose(basePrompt);
  }

  /**
   * Set the application/base prompt and update the live agent state.
   *
   * Preserves conversation history. Non-destructive.
   */
  setBasePrompt(basePrompt: string): string {
    return this.parts.systemPrompt.setBase(basePrompt);
  }

  /**
   * Get the current application/base prompt.
   */
  getBasePrompt(): string {
    return this.parts.systemPrompt.base() ?? '';
  }

  /**
   * Get the current assembled system prompt.
   */
  getCurrentSystemPrompt(): string {
    return this.parts.systemPrompt.current();
  }

  /**
   * Get the Cortex operational system prompt sections as structured data.
   * Useful for context snapshot / inspector tooling.
   */
  getSystemPromptSections(): Array<{ name: string; content: string }> {
    return this.parts.systemPrompt.sections();
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
    const slotCount = this.parts.contextManager.slotCount;
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
    const slotCount = this.parts.contextManager.slotCount;
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
    return this.parts.models.primary;
  }

  /**
   * Get the resolved utility model.
   */
  getUtilityModel(): CortexModel {
    return this.parts.models.utility;
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
    return this.parts.models.autoResolvedUtility();
  }

  /**
   * Hot-swap the primary model without restarting the agent.
   * Used when the user changes their provider/model in settings.
   *
   * @param model - The new CortexModel to use
   */
  setModel(model: CortexModel): void {
    this.parts.models.setModel(model);
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
    this.parts.models.setUtilityModel(model);
  }

  /**
   * Reset the utility model to auto-resolution based on the primary model's provider.
   * Clears any manual override set by setUtilityModel().
   */
  resetUtilityModel(): void {
    this.parts.models.resetUtilityModel();
  }

  /**
   * Whether the utility model has been manually overridden.
   */
  isUtilityModelOverridden(): boolean {
    return this.parts.models.isUtilityOverridden;
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
    this.parts.eventBridge.setWorkingTagsEnabled(enabled);
    const base = this.parts.systemPrompt.base();
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
    return modelThinkingCapabilities(this.parts.models.primaryPi);
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
    this.parts.models.setCacheRetention(value);
  }

  /**
   * Get the current cache retention policy.
   * Returns null if not yet resolved (pi-ai will use its own default).
   */
  getCacheRetention(): 'none' | 'short' | 'long' | null {
    return this.parts.models.cacheRetention;
  }

  /**
   * Set the stable cache/session key forwarded to the provider as its
   * prompt_cache_key. Use a value stable across calls that share a prefix.
   * Pass null to clear (the provider then generates its own per-request key).
   */
  setSessionId(value: string | null): void {
    this.parts.models.setSessionId(value);
  }

  /**
   * Get the current cache/session key, or null if unset.
   */
  getSessionId(): string | null {
    return this.parts.models.sessionId;
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
    this.parts.tools.refresh();
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
    return this.parts.tools.isPermissionExempt(toolName);
  }

  /**
   * Register an additional consumer-provided tool at runtime.
   * Useful for dynamic tool management (e.g., enabling a tool after agent
   * creation based on user permission changes).
   */
  addConsumerTool(tool: CortexTool): void {
    this.parts.tools.add(tool);
  }

  /**
   * Remove a consumer-provided tool by name at runtime.
   * Built-in tools cannot be removed.
   */
  removeConsumerTool(toolName: string): void {
    this.parts.tools.remove(toolName);
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
    return this.parts.completions.utility(context, options);
  }


  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Abort the current agentic loop without destroying the agent.
   * The agent remains usable for subsequent prompts.
   */
  async abort(): Promise<void> {
    return this.parts.lifecycle.abort();
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
    return this.parts.lifecycle.destroy(timeoutMs);
  }

  /**
   * Whether the agent is currently running an agentic loop.
   */
  get isRunning(): boolean {
    return this.parts.lifecycle.state === 'active' && this.parts.runner.isPrompting;
  }

  /**
   * Get the current lifecycle state.
   */
  get state(): CortexLifecycleState {
    return this.parts.lifecycle.state;
  }

  /**
   * The number of messages in agent.state.messages before the current
   * prompt() call. Used by the cache breakpoint system to distinguish
   * "old history" (cacheable) from "new tick content" (ephemeral).
   */
  get prePromptMessageCount(): number {
    return this.parts.runner.boundary;
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
    this.parts.loopComplete.add(handler);
  }

  /**
   * Register a handler for classified errors during the agentic loop.
   * The origin context identifies which loop produced the error.
   */
  onError(handler: (error: ClassifiedError, origin: LoopOriginContext) => void): void {
    this.parts.errorHandlers.add(handler);
  }

  /**
   * Register a handler fired before each background retry's backoff wait.
   * Consumers use this to render a compact, in-place retry status (countdown,
   * attempt count) instead of a hard error. See {@link RetryPolicy}.
   */
  onRetryScheduled(
    handler: (info: RetryScheduledInfo, origin: LoopOriginContext) => void,
  ): void {
    this.parts.runner.retryScheduled.add(handler);
  }

  /**
   * Register a handler fired when a background retry resolves the turn.
   * The consumer clears the retry status.
   */
  onRetrySucceeded(
    handler: (info: RetrySucceededInfo, origin: LoopOriginContext) => void,
  ): void {
    this.parts.runner.retrySucceeded.add(handler);
  }

  /**
   * Register a handler fired when background retries are given up on. The
   * matching fatal `onError` fires immediately after, so the consumer shows a
   * terminal state.
   */
  onRetryExhausted(
    handler: (info: RetryExhaustedInfo, origin: LoopOriginContext) => void,
  ): void {
    this.parts.runner.retryExhausted.add(handler);
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
    this.parts.compactionManager.onBeforeCompaction(
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
    this.parts.compactionManager.onPostCompaction(
      (result) => handler(result, this.originContext),
    );
  }

  /**
   * Register a handler for compaction errors.
   */
  onCompactionError(
    handler: (error: Error, origin: LoopOriginContext) => void,
  ): void {
    this.parts.compactionManager.onCompactionError(
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
    this.parts.compactionManager.onCompactionDegraded(
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
    this.parts.compactionManager.onCompactionExhausted(
      (info) => handler(info, this.originContext),
    );
  }

  /**
   * Register a handler for turn completion with parsed working tag output.
   * The origin context identifies which loop completed the turn.
   */
  onTurnComplete(handler: (output: AgentTextOutput, origin: LoopOriginContext) => void): void {
    this.parts.turnComplete.add(handler);
  }

  /**
   * Register a handler for sub-agent spawn events.
   */
  onSubAgentSpawned(handler: (taskId: string, instructions: string, background: boolean) => void): void {
    this.parts.subAgents.spawnedHandlers.add(handler);
  }

  /**
   * Register a handler for sub-agent completion events.
   */
  onSubAgentCompleted(handler: (taskId: string, result: string, status: string, usage: unknown) => void): void {
    this.parts.subAgents.completedHandlers.add(handler);
  }

  /**
   * Register a handler for sub-agent failure events.
   */
  onSubAgentFailed(handler: (taskId: string, error: string) => void): void {
    this.parts.subAgents.failedHandlers.add(handler);
  }

  /**
   * Register a handler that fires when background sub-agent results are about
   * to be delivered to the parent agent, restarting its agentic loop.
   * Consumers can use this to update UI state (show spinners, etc.).
   */
  onBackgroundResultDelivery(handler: (taskIds: string[]) => void): void {
    this.parts.background.deliveryHandlers.add(handler);
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
    this.parts.deadLetters.handlers.add(handler);
  }

  /**
   * Get the EventBridge for direct event access.
   * Consumers that need raw event data (for logging) can subscribe directly.
   */
  getEventBridge(): EventBridge {
    return this.parts.eventBridge;
  }

  /**
   * Get the BudgetGuard for inspecting turn/cost state.
   */
  getBudgetGuard(): BudgetGuard {
    return this.parts.budgetGuard;
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
    return this.parts.usage.lastDirect;
  }

  /**
   * Get accumulated session usage (cost, turns, token breakdown).
   *
   * Unlike BudgetGuard (which resets per agentic loop), this accumulates
   * across the entire session lifetime. Consumers can persist this value
   * and restore it via restoreSessionUsage() after loading a saved session.
   */
  getSessionUsage(): SessionUsage {
    return this.parts.usage.snapshot();
  }

  /**
   * Restore session usage from consumer-provided data.
   *
   * Call this after restoreConversationHistory() when resuming a saved session.
   * Values are added to any usage already accumulated (in case turns ran
   * before the restore call).
   */
  restoreSessionUsage(usage: SessionUsage): void {
    this.parts.usage.restore(usage);
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
    this.parts.compactionManager.updateCurrentContextTokenCount(inputTokens);
  }

  /**
   * Get the post-hoc current-context token count from the most recent parent turn.
   */
  get currentContextTokenCount(): number {
    return this.parts.compactionManager.currentContextTokenCount;
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
    return this.parts.pipeline.estimateTokens();
  }

  /**
   * Set the context window size (from model metadata).
   * If a contextWindowLimit is set, the effective value will be
   * min(limit, contextWindow).
   */
  setContextWindow(contextWindow: number): void {
    this.parts.models.setContextWindow(contextWindow);
  }

  /**
   * Set a user-configured limit on the context window.
   * The effective context window becomes min(limit, model.contextWindow)
   * without increasing explicit limits. This does not resize server allocation.
   * Pass null to remove the limit and use the model's full context window.
   */
  setContextWindowLimit(limit: number | null): void {
    this.parts.models.setContextWindowLimit(limit);
  }

  /**
   * Get the raw user-configured context window limit (null = no limit).
   */
  get contextWindowLimit(): number | null {
    return this.parts.models.contextWindowLimit;
  }

  /**
   * Get the effective context window after clamping the limit to backend capacity.
   */
  get effectiveContextWindow(): number {
    return this.parts.compactionManager.contextWindow;
  }

  /**
   * Get the model's actual context window (unaffected by consumer limits).
   */
  get modelContextWindow(): number {
    return this.parts.compactionManager.modelContextWindow;
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
    this.parts.compactionManager.setLastInteractionTime(timestamp);
  }

  /**
   * Cap a tool result at insertion time. If the result exceeds
   * maxResultTokens, truncates to head+tail bookend format.
   * Call this when tool results enter conversation history.
   */
  capToolResult(content: string): string {
    return this.parts.compactionManager.capToolResult(content);
  }

  // -----------------------------------------------------------------------
  // Observational Memory
  // -----------------------------------------------------------------------

  /**
   * Get the observational memory state for session persistence.
   * Returns null if not using the observational strategy.
   */
  getObservationalMemoryState(): ObservationalMemoryState | null {
    return this.parts.compactionManager.getObservationalMemoryState();
  }

  /**
   * Restore observational memory state from a previous session.
   * Must be called after restoreConversationHistory().
   */
  restoreObservationalMemoryState(state: ObservationalMemoryState): void {
    // Conversation history is restored before this call, so the post-slot
    // message count is the length the buffer watermark must align with.
    const slotCount = this.parts.contextManager.slotCount;
    const historyLength = Math.max(0, this.agent.state.messages.length - slotCount);
    this.parts.compactionManager.restoreObservationalMemoryState(state, historyLength);
    // Populate the observation slot only when there are real observations to
    // show. getObservationSlotContent() always returns at least the preamble,
    // so guarding on hasObservations() keeps a resumed-but-never-observed
    // session looking like a fresh one (empty slot) instead of injecting the
    // preamble around an empty <observations> block.
    if (this.parts.compactionManager.hasObservations()) {
      this.parts.contextManager.setSlot('_observations', this.parts.compactionManager.getObservationSlotContent());
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
    const slotCount = this.parts.contextManager.slotCount;
    await this.parts.compactionManager.triggerObservation(this.agent.state.messages, slotCount);
    // Update the slot after the observer completes
    const slotContent = this.parts.compactionManager.getObservationSlotContent();
    if (slotContent) {
      this.parts.contextManager.setSlot('_observations', slotContent);
    }
  }

  /**
   * Register a handler for observation events.
   * Fires when messages are compressed into observations.
   */
  onObservation(
    handler: (event: ObservationEvent, origin: LoopOriginContext) => void,
  ): void {
    this.parts.compactionManager.onObservation(
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
    this.parts.compactionManager.onReflection(
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
    return this.parts.pipeline.digest(options);
  }

  /**
   * Run end-of-tick compaction check. Call after EXECUTE completes,
   * before the next tick starts. Returns the CompactionResult if
   * Layer 2 compaction ran, null otherwise.
   */
  async checkAndRunCompaction(): Promise<CompactionResult | null> {
    return this.parts.compactionManager.checkAndRunCompaction(
      () => this.getConversationHistory(),
      (history) => this.restoreConversationHistory(history),
    );
  }

  /**
   * Get the CompactionManager for advanced use.
   */
  getCompactionManager(): CompactionManager {
    return this.parts.compactionManager;
  }

  /**
   * Get the configured environment variable overrides.
   * Consumers use this when creating built-in tools (e.g., BashToolConfig.envOverrides)
   * to ensure all subprocess environments include these overrides.
   */
  getEnvOverrides(): Record<string, string> | undefined {
    return this.config.envOverrides;
  }

  /**
   * Get the McpClientManager for managing MCP server connections.
   * Consumers use this to connect/disconnect plugin tool servers
   * and to retrieve discovered tools.
   */
  getMcpClientManager(): McpClientManager {
    return this.parts.mcp.manager;
  }

  /**
   * Connect to an MCP server and discover its tools.
   * Convenience wrapper around mcpClientManager.connect().
   *
   * @param serverName - Unique name for this server (used for tool namespacing)
   * @param config - Transport configuration (stdio or http)
   */
  async connectMcpServer(serverName: string, config: McpTransportConfig): Promise<void> {
    await this.parts.mcp.manager.connect(serverName, config);
  }

  /**
   * Disconnect from an MCP server and remove its tools.
   * Convenience wrapper around mcpClientManager.disconnect().
   *
   * @param serverName - The server name to disconnect
   */
  async disconnectMcpServer(serverName: string): Promise<void> {
    await this.parts.mcp.manager.disconnect(serverName);
  }

  /**
   * Snapshot of every MCP server this agent is currently connected to (or
   * attempting to reconnect to). The shape is deliberately read-only: use
   * {@link connectMcpServer} / {@link disconnectMcpServer} to mutate. The
   * consumer (`cortex-code`'s hot-reload watcher) uses this to compute the
   * diff between desired (config files) and current state between turns.
   */
  getMcpServerStates(): McpConnectionState[] {
    return this.parts.mcp.manager.getConnectionStates();
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
    return this.parts.mcp.manager.configMatches(serverName, config);
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
    this.parts.mcp.setProgressHandler(handler);
  }

  /**
   * Get all tools from all sources: built-in tools registered on the
   * pi-agent-core Agent, plus MCP-wrapped tools from connected servers.
   *
   * Returns only the MCP-wrapped tools. Built-in tools are registered
   * directly on the Agent and are not included here.
   */
  getMcpTools(): CortexTool[] {
    return this.parts.mcp.manager.getTools();
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
    return this.parts.pipeline.hook();
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
    return this.parts.abortState.signal.aborted ||
      isAbortShapedError(this.agent.state as Record<string, unknown>);
  }

  // -----------------------------------------------------------------------
  // Skill System
  // -----------------------------------------------------------------------

  /**
   * Get the SkillRegistry for add/remove/query operations.
   */
  getSkillRegistry(): SkillRegistry {
    return this.parts.skills.registry;
  }

  /**
   * Pre-load a skill into the ephemeral context for the current loop.
   * Same path as the load_skill tool, but triggered by the consumer.
   * No LLM turn is consumed.
   */
  async loadSkill(name: string, args?: string): Promise<void> {
    await this.parts.skills.load(name, args);
  }

  /**
   * Clear the skill buffer. The consumer should call this at the start
   * of each tick (before pre-loading skills for the new loop).
   * Cortex cannot auto-clear because it has no concept of tick boundaries,
   * and clearing at prompt() start would wipe consumer pre-loaded skills.
   */
  clearSkillBuffer(): void {
    this.parts.skills.clear();
  }

  /**
   * Get the current skill buffer contents.
   */
  getSkillBuffer(): LoadedSkill[] {
    return this.parts.skills.snapshot();
  }

  /**
   * Set consumer-provided variables for ${VAR} substitution in skills.
   * Merged with Cortex built-ins (SKILL_DIR, ARGUMENTS).
   * Consumer variables take precedence on collision.
   * Call this each tick during GATHER to update runtime values.
   */
  setPreprocessorVariables(variables: Record<string, string>): void {
    this.parts.skills.registry.setPreprocessorVariables(variables);
  }

  /**
   * Set consumer-provided context that will be passed to skill scripts.
   * Merged with Cortex built-in fields (skillDir, args, scriptArgs).
   * Consumer fields take precedence on collision.
   * Call this each tick during GATHER to update runtime values.
   */
  setScriptContext(context: Record<string, unknown>): void {
    this.parts.skills.registry.setScriptContext(context);
  }

  // -----------------------------------------------------------------------
  // Sub-Agent System
  // -----------------------------------------------------------------------

  /**
   * Get the SubAgentManager for direct sub-agent tracking.
   */
  getSubAgentManager(): SubAgentManager {
    return this.parts.subAgentManager;
  }

  /**
   * Spawn a background sub-agent and return its task ID immediately.
   * Used by consumers that manage delegated work outside the SubAgent tool.
   * Throws when the concurrency limit is reached.
   */
  async spawnBackgroundSubAgent(params: Omit<SubAgentSpawnConfig, 'background'>): Promise<{ taskId: string }> {
    return this.parts.subAgents.spawnBackgroundChecked(params);
  }

  /**
   * Cancel a running sub-agent: destroy the child agent, untrack it, resolve
   * its completion promise as cancelled, and discard any pending or late
   * result so cancelled work is never delivered to the loop.
   * Returns false when the task ID is not an active sub-agent.
   */
  async cancelSubAgent(taskId: string): Promise<boolean> {
    return this.parts.subAgents.cancel(taskId);
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
    return this.parts.subAgents.steer(taskId, message);
  }

  /**
   * Snapshot of all currently running sub-agents, including live cost and
   * activity. Read-only; safe to call from anywhere (e.g. budget accounting
   * or status surfaces). Returns an empty array when none are running.
   */
  getActiveSubAgents(): SubAgentSnapshot[] {
    return this.parts.subAgents.snapshots();
  }

  /**
   * Build a <background-tasks> block describing running sub-agents and
   * background bash processes. Returns null if nothing is running.
   * Called from transformContext before each LLM call.
   */
  private buildBackgroundTaskState(): string | null {
    return backgroundTaskState(this.parts.subAgentManager, this.parts.tools);
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
    return this.parts.queues.unwindFailedDelivery(preDeliveryCount, runAbortEpoch);
  }

  /**
   * Dead-lettered content (newest last, bounded): background completions
   * whose delivery failed repeatedly, and wake deliveries dropped after
   * their carrying runs failed repeatedly. The consumer can surface these
   * to the user or re-drive the work; Cortex will not retry them.
   */
  getDeadLetteredBackgroundResults(): DeadLetteredBackgroundResult[] {
    return this.parts.deadLetters.list();
  }

  /** Build a sub-agent's loop (the spawner's factory; tests stand in for it). */
  private async createChildAgent(params: ChildLoopParams): Promise<AgentLoop> {
    const { createParams, seedContext } = await prepareChildLoop({
      config: this.config,
      model: this.parts.models.primary,
      workingTagsEnabled: this.workingTagsEnabled,
      contextWindowLimit: this.parts.models.contextWindowLimit,
      loopPath: this.loopPath,
      prompt: { base: this.parts.systemPrompt.base(), current: this.parts.systemPrompt.current() },
      rawPersistResult: this.parts.tools.rawPersistResult,
      resultThresholds: this.parts.tools.resultThresholds,
      inheritableTools: (requested) => this.parts.tools.childInheritable(requested),
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
      asks: this.parts.asks,
      subAgents: this.parts.subAgentManager,
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

  private get compactionManager(): CompactionManager {
    return this.parts.compactionManager;
  }

  private get subAgentManager(): SubAgentManager {
    return this.parts.subAgentManager;
  }

  private spawnForegroundSubAgentInternal(params: SubAgentSpawnParams): Promise<ForegroundSpawnResult> {
    return this.parts.subAgents.spawnForeground(params);
  }

  private spawnBackgroundSubAgentInternal(params: SubAgentSpawnParams): Promise<{ taskId: string }> {
    return this.parts.subAgents.spawnBackground(params);
  }

  private registerPendingAsk(ask: PendingAsk): void {
    this.parts.asks.register(ask);
  }

  private settlePendingAsk(askId: string): void {
    this.parts.asks.settle(askId);
  }

  private get _prePromptMessageCount(): number {
    return this.parts.runner.boundary;
  }

  private set _prePromptMessageCount(value: number) {
    this.parts.runner.boundary = value;
  }

  private get _isPrompting(): boolean {
    return this.parts.runner.isPrompting;
  }

  private get headlineProvider(): (() => string | null) | null {
    return this.parts.pipeline.headline.current;
  }

  private get _cacheBreakpointIndices(): CacheBreakpointIndices | null {
    return this.parts.pipeline.cacheBreakpointIndices;
  }

  private set _cacheBreakpointIndices(indices: CacheBreakpointIndices | null) {
    this.parts.pipeline.cacheBreakpointIndices = indices;
  }

  private get pendingBackgroundResults(): PendingBackgroundCompletion[] {
    return this.parts.background.pending;
  }

  private deliverOrQueueBackgroundCompletion(item: PendingBackgroundCompletion): Promise<void> {
    return this.parts.background.enqueue(item);
  }

  private schedulePendingResultDelivery(): Promise<void> {
    return this.parts.background.schedule();
  }

  private drainPendingBackgroundResults(): Promise<void> {
    return this.parts.background.drain();
  }

  private requeueOrDeadLetter(batch: PendingBackgroundCompletion[], err: unknown): void {
    this.parts.background.requeueOrDeadLetter(batch, err);
  }

  private batchRecoveredAfterRequeue(batch: PendingBackgroundCompletion[]): boolean {
    return this.parts.background.batchRecoveredAfterRequeue(batch);
  }

  private get pendingWakeDeliveries(): QueuedDelivery[] {
    return this.parts.queues.wake;
  }

  private get _abortEpoch(): number {
    return this.parts.abortState.epoch;
  }

  private set _abortEpoch(value: number) {
    this.parts.abortState.epoch = value;
  }

  private get trackedPids(): ReadonlySet<number> {
    return this.parts.processes.pids;
  }

  private get registeredTools(): RegisteredTool[] {
    return this.parts.tools.registered;
  }

  private get toolRuntime(): CortexToolRuntime {
    return this.parts.tools.runtime;
  }

  private buildChildToolSet(requestedTools?: string[]): RegisteredTool[] {
    return this.parts.tools.childInheritable(requestedTools);
  }
}

