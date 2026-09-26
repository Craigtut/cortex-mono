/**
 * CortexAgent: the composite facade over the AgentLoop primitive
 * (docs/cortex/duplex/facade-api.md, architecture.md).
 *
 * Consumers interact with one CortexAgent. Internally it owns the resident
 * loop(s), the session log, the duplex router, settlement predicates, and
 * composite persistence. Two modes:
 *
 * - `duplex` (the default, decisions.md D14): a fast talker loop fronting
 *   the persistent reasoner. The talker carries the fixed control toolset
 *   only; the reasoner does all real work and reports back through the
 *   router's wake policy.
 * - `passthrough`: a single reasoner loop, reproducing direct AgentLoop
 *   behavior exactly. This is the consumer opt-out and the parity baseline
 *   for tests.
 *
 * The talker/reasoner split is never exposed in this API; consumer config
 * is routed internally per the routing table below.
 */

import { AgentLoop } from './agent-loop.js';
import { buildReasonerConfig, DEFAULT_MODE, routerOptionsFrom } from './facade/config.js';
import type {
  CortexAgentConfig,
  CortexAgentMode,
  ResolvedCortexAgentConfig,
} from './facade/config.js';
import type {
  DeliverOptions,
  DeliverResult,
  DirectCompletionOptions,
  IdleDigestionOptions,
  IdleDigestionResult,
  QueueDrainMode,
  ToolResultInterceptorInfo,
  ToolResultInterceptorResult,
} from './agent-loop.js';
import { McpClientManager } from './mcp-client.js';
import type { CompactionManager } from './compaction/index.js';
import type { DirectCompletionContext } from './cache-breakpoints.js';
import type {
  AgentLoopConfig,
  AgentTextOutput,
  BudgetGuardConfig,
  ClassifiedError,
  CompactionDegradedInfo,
  CompactionExhaustedInfo,
  CompactionResult,
  CompactionTarget,
  CortexCompactionConfig,
  CortexLifecycleState,
  CortexLogger,
  CortexUsage,
  DeadLetteredBackgroundResult,
  LoadedSkill,
  LoopOriginContext,
  McpConnectionState,
  McpToolCallProgress,
  McpTransportConfig,
  ModelThinkingCapabilities,
  PendingAsk,
  RetryExhaustedInfo,
  RetryPolicy,
  RetryScheduledInfo,
  RetrySucceededInfo,
  SessionUsage,
  SkillConfig,
  SubAgentSnapshot,
  SubAgentSpawnConfig,
  ThinkingLevel,
} from './types.js';
import type { CortexTool } from './tool-contract.js';
import type { CortexModel } from './model-wrapper.js';
import type { AgentMessage } from './context-manager.js';
import type { ContextManager } from './context-manager.js';
import { EventBridge, extractResponseChunkText } from './event-bridge.js';
import type { CortexEvent } from './event-bridge.js';
import { BudgetGuard } from './budget-guard.js';
import type { SkillRegistry } from './skill-registry.js';
import type {
  ObservationEvent,
  ObservationalMemoryState,
  ReflectionEvent,
} from './compaction/index.js';
import { COMPACTION_DEFAULTS } from './compaction/compaction.js';
import { OBSERVATIONAL_MEMORY_DEFAULTS } from './compaction/observational/constants.js';
import { SessionLog } from './session-log.js';
import type {
  SessionLogEntry,
  SessionLogEntryType,
  SessionLogEvent,
  SessionLogSubscriber,
  WakeClass,
} from './session-log.js';
import { NOOP_LOGGER } from './noop-logger.js';
import { errorMessageOf } from './error-classifier.js';
import {
  cloneResolutionNote,
  collectAssemblyResolutionNotes,
  networkResolverUnwiredNote,
  resolutionWarnText,
} from './resolution-report.js';
import type { ResolutionNote, ResolutionNoteCode } from './resolution-report.js';
import { spokenText, WorkingTagStreamFilter } from './working-tags.js';
import {
  addSessionUsage,
  cloneSessionUsage,
  diffSessionUsage,
  isZeroSessionUsage,
  zeroSessionUsage,
} from './session-usage.js';
import { TOOL_NAMES } from './tools/index.js';
import { toolCallSubject } from './tools/tool-call-subject.js';
import { DuplexRouter, deliveryConcludes } from './duplex/router.js';
import type {
  DuplexRouterPorts,
  DuplexRouterState,
  ReasonerDispatchOptions,
} from './duplex/router.js';
import { collectCauseTags, latestCauseSeq } from './duplex/cause-tags.js';
import { FanOutContextManager } from './duplex/fanout-context-manager.js';
import { DuplexHeadlines } from './duplex/headlines.js';
import { stripAskFence } from './duplex/ask-fence.js';
import type { CauseTag } from './duplex/cause-tags.js';
import { buildControlTools, isControlToolName } from './duplex/control-tools.js';
import {
  buildBrokeredNetworkResolver,
  buildBrokeredPermissionResolver,
} from './duplex/permission-broker.js';
import type { PermissionBroker } from './duplex/permission-broker.js';
import type { ResolveNetworkAccess, SandboxRung } from './sandbox/types.js';
import type { SandboxState } from './sandbox/options.js';
import { isSandboxProvider } from './sandbox/options.js';
import { SandboxSession } from './sandbox/session.js';
import { buildDeliverTool, buildSteerSubAgentTool } from './duplex/reasoner-tools.js';
import { QuickLookupManager } from './duplex/quick-lookups.js';
import type { QuickLookupOutcome } from './duplex/quick-lookups.js';
import {
  buildQuickLookupPrompt,
  REASONER_ROLE_PROMPT,
  SPEAK_NOW_APPENDIX,
  TALKER_ROLE_PROMPT,
  TALKER_TRUNCATION_REPAIR_MESSAGE,
  wrapExternalContent,
} from './duplex/prompts.js';

// ---------------------------------------------------------------------------
// Modes and config
// ---------------------------------------------------------------------------

export { CONFIG_ROUTING, DEFAULT_MODE, buildReasonerConfig } from './facade/config.js';
export type {
  CortexAgentConfig,
  CortexAgentMode,
  CortexSessionLogConfig,
  ConfigDestination,
  DuplexTuningConfig,
  TalkerConfig,
} from './facade/config.js';

/** Scope for {@link CortexAgent.abort} (facade-api.md abort table). */
export type CortexAbortScope = 'conversation' | 'work' | 'all';

// ---------------------------------------------------------------------------
// Duplex loop configs
// ---------------------------------------------------------------------------

/**
 * The talker's facade-set hard turn cap per exchange (decisions.md D17).
 * Consumer budget config cannot raise it: an unbounded talker plus any
 * result missing `terminate` is an unbounded retry cycle with no attacker
 * involved (review-findings F9). Low but with room for the deliberate
 * recovery turns the guards force (empty-spoken-text follow-up, truncation
 * repair, one malformed-call recovery).
 */
export const TALKER_MAX_TURNS = 8;

/**
 * Fail-fast talker retries (facade-api.md): a transient provider error on
 * the presence loop must never become minutes of silent backoff. The
 * reasoner keeps the consumer's (or default) long-haul policy.
 */
const TALKER_RETRY_POLICY: Partial<RetryPolicy> = {
  maxAttempts: 2,
  backoffMs: [1_000, 2_000],
  maxBackoffMs: 2_000,
  maxElapsedMs: 10_000,
};

/**
 * Threshold stagger between the loops (log-and-context.md): the talker
 * compacts slightly earlier than the reasoner so blocking work on one
 * never coincides with an activation on the other.
 */
const COMPACTION_THRESHOLD_STAGGER = 0.05;

/**
 * Stagger a talker threshold below the reasoner's effective value. The
 * pair is clamped together rather than one side against a fixed floor: the
 * talker gets the full stagger whenever the reasoner's threshold leaves
 * room for it, and a pathologically low reasoner threshold shrinks the
 * stagger to half the reasoner's value instead of letting the pair
 * collapse to equality or invert. Strictly below the reasoner for every
 * input in (0, 1], which is the property the stagger exists for.
 *
 * The input is clamped into [0, 1] first (thresholds are fractions of the
 * context window) rather than trusting the caller: below zero the raw
 * arithmetic INVERTS (a negative half-value stagger lands the talker ABOVE
 * the reasoner), and a non-finite or non-positive threshold is
 * misconfiguration where both loops degenerate to the same always-compact
 * posture anyway.
 */
function staggerBelow(reasonerThreshold: number): number {
  const clamped = reasonerThreshold > 0 ? Math.min(reasonerThreshold, 1) : 0;
  const stagger = Math.min(COMPACTION_THRESHOLD_STAGGER, clamped / 2);
  return clamped - stagger;
}

/** Suffix appended to the consumer session id for the talker's cache key. */
const TALKER_SESSION_ID_SUFFIX = ':talker';

/**
 * Hard token cap on the talker's headline block (log-and-context.md):
 * injected user-role content is never trimmed by microcompaction, so an
 * unbounded block would inflate utilization and trigger early source
 * compaction without itself shrinking. Enforced with truncation by the
 * loop's headline provider machinery.
 */
export const TALKER_HEADLINE_MAX_TOKENS = 1_500;

/**
 * Identifying detail for the headline's "Current:" line, mirroring the
 * loop's own log-line summarization: paths, commands, and patterns without
 * content or results. Escaping happens inside the headline builder.
 */
function summarizeHeadlineArgs(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;
  const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const subject = toolCallSubject(toolName, args);
  if ('command' in subject) return str(subject.command)?.slice(0, 120) ?? null;
  if ('path' in subject) return str(subject.path);
  if ('pattern' in subject) return str(subject.pattern);
  if ('url' in subject) return str(subject.url);
  return null;
}

function appendRolePrompt(basePrompt: string | undefined, rolePrompt: string): string | undefined {
  // An absent or blank base prompt stays absent so the facade's
  // prompt-not-configured guard still trips; the role prompt alone is not
  // a usable identity.
  if (basePrompt === undefined || basePrompt.trim().length === 0) return basePrompt;
  return `${basePrompt}\n\n${rolePrompt}`;
}

/**
 * The reasoner's config in duplex mode: consumer routing per the table,
 * plus the duplex posture. Exported for tests.
 */
export function buildDuplexReasonerConfig(
  config: ResolvedCortexAgentConfig,
): AgentLoopConfig & { tools?: CortexTool[] } {
  const routed = buildReasonerConfig(config);
  const duplexed: AgentLoopConfig & { tools?: CortexTool[] } = {
    ...routed,
    loopPath: 'reasoner',
    // A resident reasoner woken repeatedly by dispatches continues one
    // logical working session; wiping tool-runtime state (cwd,
    // read-before-edit, undo) per prompt would break it mid-task. An
    // explicit consumer value still wins.
    persistentRuntime: config.persistentRuntime ?? true,
  };
  const basePrompt = appendRolePrompt(config.initialBasePrompt, REASONER_ROLE_PROMPT);
  if (basePrompt !== undefined) duplexed.initialBasePrompt = basePrompt;
  // The reasoner keeps the bare consumer sessionId (routing table): a
  // session that flips modes keeps its reasoner prefix cache warm.
  return duplexed;
}

/**
 * Drop explicitly-undefined keys before spreading, so a consumer object
 * like `{ threshold: 0.8, preserveRecentTurns: undefined }` cannot clobber
 * a default with `undefined` (the spread copies the key; `?? default`
 * downstream never runs because the key exists).
 */
function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>;
}

/**
 * The talker's compaction posture: the consumer's config forced
 * non-blocking (a synchronous observer call inside transformContext is
 * multi-second dead air on the presence loop, review-findings F7) with
 * activation staggered ahead of the reasoner's.
 */
function buildTalkerCompactionConfig(
  consumer: Partial<CortexCompactionConfig> | undefined,
): Partial<CortexCompactionConfig> {
  // Stagger relative to the reasoner's EFFECTIVE thresholds: the consumer's
  // value when set, the strategy default otherwise. Defaults stagger too;
  // an unset classic threshold still lands 0.70 on the reasoner, and the
  // talker must sit below whatever the reasoner actually runs.
  const reasonerActivation = consumer?.observational?.activationThreshold
    ?? OBSERVATIONAL_MEMORY_DEFAULTS.activationThreshold;
  const reasonerClassic = consumer?.compaction?.threshold ?? COMPACTION_DEFAULTS.threshold;
  return {
    ...stripUndefined(consumer),
    nonBlocking: true,
    observational: {
      ...stripUndefined(consumer?.observational),
      activationThreshold: staggerBelow(reasonerActivation),
    },
    compaction: {
      ...COMPACTION_DEFAULTS,
      ...stripUndefined(consumer?.compaction),
      threshold: staggerBelow(reasonerClassic),
    },
  };
}

/**
 * The talker's AgentLoop config (architecture.md): fast model, the fixed
 * control toolset only (registered by the facade after construction), no
 * built-in tools, no permission resolver, a facade-set hard maxTurns that
 * consumer config cannot raise, fail-fast retries, non-blocking compaction
 * with a staggered threshold, and a derived stable session id. Exported
 * for tests.
 */
export function buildTalkerConfig(
  config: ResolvedCortexAgentConfig,
  talkerModel: CortexModel,
): AgentLoopConfig & { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean } {
  const talker: AgentLoopConfig & {
    enableSubAgentTool?: boolean;
    enableLoadSkillTool?: boolean;
  } = {
    model: talkerModel,
    workingDirectory: config.workingDirectory,
    loopPath: 'talker',
    // The talker separates thinking from speech with working tags in-band;
    // API-level reasoning would sit on the presence loop's latency budget.
    thinkingLevel: 'off',
    budgetGuard: { maxTurns: TALKER_MAX_TURNS, scope: 'prompt' },
    retryPolicy: TALKER_RETRY_POLICY,
    compaction: buildTalkerCompactionConfig(config.compaction),
    // No built-in toolset: the talker's turns are structurally incapable of
    // blocking on tool execution (D5). The observational Recall tool is the
    // one allowed non-control tool (review-findings F19) and registers via
    // the compaction config like anywhere else.
    disableTools: Object.values(TOOL_NAMES),
    enableSubAgentTool: false,
    enableLoadSkillTool: false,
    // Deliberately absent: resolvePermission (wiring the broker as the
    // talker's resolver would deadlock answer_ask against the ask it is
    // answering, communication.md), resolveNetworkAccess, consumer tools,
    // MCP, skills, sub-agent config, and the consumer's budget guard.
  };

  // Consumer slots go to both loops, identical content (D6); the base
  // prompt goes to both in full with the role prompt appended.
  if (config.slots) talker.slots = config.slots;
  const basePrompt = appendRolePrompt(config.initialBasePrompt, TALKER_ROLE_PROMPT);
  if (basePrompt !== undefined) talker.initialBasePrompt = basePrompt;
  if (config.workingTags) talker.workingTags = config.workingTags;
  // Per-loop, not reasoner-only (CONFIG_ROUTING contextWindowLimit): the
  // same consumer number, clamped inside each loop against its own model
  // window and the safe floor. The talker's context IS the conversation, so
  // leaving it uncapped means the surface that grows fastest is the one the
  // consumer's compaction budget never reaches.
  if (config.contextWindowLimit !== undefined) {
    talker.contextWindowLimit = config.contextWindowLimit;
  }
  // Per loop as well (CONFIG_ROUTING utilityModel), but with the
  // same-provider constraint checked here rather than assumed.
  //
  // A loop THROWS at construction when its utility model's provider differs
  // from its own primary model's (AgentLoop.resolveUtilityModels), so
  // copying this one blind would not degrade duplex, it would fail assembly
  // outright on any consumer whose talker runs elsewhere. Copying nothing is
  // wrong too: the talker defaults to the fast tier of the PRIMARY provider,
  // so the providers match for most consumers and the setting is exactly
  // what they meant. So: copy when it can apply, and skip when it cannot.
  //
  // The skip is the one case where the talker's observational spend silently
  // goes to a model the consumer did not choose, and it is reported as a
  // 'talker-utility-model-skipped' resolution note. That note is read off
  // the ASSEMBLED loops rather than announced from here, so it cannot claim
  // a skip this branch did not make (resolution-report.ts).
  if (config.utilityModel === 'default') {
    // Not a model, so no provider to disagree with: it means auto-resolve,
    // which is what the talker would do anyway. Copied so the two loops
    // report the same dial.
    talker.utilityModel = 'default';
  } else if (
    config.utilityModel !== undefined &&
    config.utilityModel.provider === talkerModel.provider
  ) {
    talker.utilityModel = config.utilityModel;
  }

  // Shared environment-level wiring.
  if (config.getApiKey) talker.getApiKey = config.getApiKey;
  if (config.sandbox) talker.sandbox = config.sandbox;
  if (config.envOverrides) talker.envOverrides = config.envOverrides;
  if (config.logger) talker.logger = config.logger;
  if (config.diagnostics) talker.diagnostics = config.diagnostics;
  if (config.persistResult) talker.persistResult = config.persistResult;

  // Distinct stable per-loop cache identity derived from the consumer's.
  if (config.sessionId) talker.sessionId = `${config.sessionId}${TALKER_SESSION_ID_SUFFIX}`;

  return talker;
}

/**
 * The lookup loop's hard turn cap. Small by design: a lookup is a few read
 * tool calls plus an answer; anything longer belongs on the reasoner.
 */
export const LOOKUP_MAX_TURNS = 6;

/** Read-surface toolset a quick lookup keeps (everything else disabled). */
const LOOKUP_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL_NAMES.Read,
  TOOL_NAMES.Grep,
  TOOL_NAMES.Glob,
]);

/**
 * Config for one ephemeral quick-lookup loop (decisions.md D13, F12): fast
 * model, Read/Grep/Glob only, an in-tool path allowlist rooted at the
 * working directory, the shared sandbox, broker-gated permissions (the
 * config's resolvePermission is already the brokered wrapper in duplex),
 * fail-fast retries, and a hard turn cap. No conversation context by
 * design. Exported for tests.
 */
export function buildQuickLookupConfig(
  config: ResolvedCortexAgentConfig,
  model: CortexModel,
  alias: string,
): AgentLoopConfig & { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean } {
  const lookup: AgentLoopConfig & {
    enableSubAgentTool?: boolean;
    enableLoadSkillTool?: boolean;
  } = {
    model,
    workingDirectory: config.workingDirectory,
    loopPath: `lookup/${alias}`,
    thinkingLevel: 'off',
    budgetGuard: { maxTurns: LOOKUP_MAX_TURNS, scope: 'prompt' },
    retryPolicy: TALKER_RETRY_POLICY,
    initialBasePrompt: buildQuickLookupPrompt(config.workingDirectory),
    // Read-only toolset (D13): no write, exec, network, or spawn surface.
    disableTools: Object.values(TOOL_NAMES).filter((name) => !LOOKUP_TOOL_NAMES.has(name)),
    // The security half (F12), enforced in-tool rather than by prompt:
    // lookup answers become spoken conversation, so a read outside the
    // working directory is a direct exfiltration path.
    readPathAllowlist: [config.workingDirectory],
    enableSubAgentTool: false,
    enableLoadSkillTool: false,
  };
  if (config.getApiKey) lookup.getApiKey = config.getApiKey;
  if (config.sandbox) lookup.sandbox = config.sandbox;
  if (config.envOverrides) lookup.envOverrides = config.envOverrides;
  if (config.logger) lookup.logger = config.logger;
  if (config.diagnostics) lookup.diagnostics = config.diagnostics;
  if (config.persistResult) lookup.persistResult = config.persistResult;
  if (config.toolResultThresholds) lookup.toolResultThresholds = config.toolResultThresholds;
  // Broker-gated like any other loop: in duplex create() this is the
  // brokered wrapper, so an `ask` is voiced through the talker rather than
  // blocking the lookup invisibly (the lookup's timeout still bounds it).
  if (config.resolvePermission) lookup.resolvePermission = config.resolvePermission;
  if (config.isAutoApprove) lookup.isAutoApprove = config.isAutoApprove;
  return lookup;
}

/**
 * Route the blocking permission surfaces through the duplex broker
 * (communication.md "Full coverage"): the consumer's resolvePermission and
 * resolveNetworkAccess are wrapped so an `ask` becomes a voiced
 * conversation ask instead of blocking a loop invisibly, while allow and
 * block/deny decisions pass through untouched. The wrapped functions flow
 * to the reasoner and, by inheritance, its sub-agents; the talker receives
 * neither (buildTalkerConfig omits them: wiring the broker as the talker's
 * resolver would deadlock answer_ask against the ask it is answering).
 * Exported for tests.
 */
export function withBrokeredPermissions(
  config: ResolvedCortexAgentConfig,
  getBroker: () => PermissionBroker | null,
): ResolvedCortexAgentConfig {
  if (!config.resolvePermission && !config.resolveNetworkAccess) return config;
  const brokered: ResolvedCortexAgentConfig = { ...config };
  if (config.resolvePermission) {
    brokered.resolvePermission = buildBrokeredPermissionResolver(
      config.resolvePermission,
      config.isAutoApprove,
      getBroker,
    );
  }
  if (config.resolveNetworkAccess) {
    brokered.resolveNetworkAccess = buildBrokeredNetworkResolver(
      config.resolveNetworkAccess,
      getBroker,
      // Third argument, unlike the tool resolver's second. Both pipelines
      // must agree about what auto-approve means: a consumer that asked not
      // to be interrupted should not have egress asks voiced at it and then
      // time out to deny. The resolver consults this only AFTER the broker
      // lookup, so an unbound broker still fails closed.
      config.isAutoApprove,
    );
  }
  return brokered;
}

// ---------------------------------------------------------------------------
// Delegation surface
// ---------------------------------------------------------------------------

/**
 * How a public AgentLoop member maps onto the facade.
 *
 * - `forwarded`: same-name member on CortexAgent, delegating to the loop
 *   (pure delegation in passthrough; duplex routing notes live at each
 *   delegation site).
 * - `subsumed`: no same-name member; the capability exists on the facade
 *   under a composite-aware surface (named in the table comment).
 * - `withheld`: deliberately not exposed (reason in the table comment).
 */
export type AgentLoopMemberDisposition = 'forwarded' | 'subsumed' | 'withheld';

/**
 * The complete delegation table over AgentLoop's public surface. Like
 * CONFIG_ROUTING, this mapped object is the contract: adding a public
 * member to AgentLoop without routing it here is a compile error, and the
 * structural test in tests/unit/cortex-agent.test.ts asserts the runtime
 * facade matches every disposition, so a delegation gap cannot silently
 * reappear. The rule is: forward everything that is pure delegation;
 * subsume or withhold only with a stated reason.
 */
export const AGENT_LOOP_DELEGATION = {
  // Interaction surface (facade semantics documented on each method).
  prompt: 'forwarded',
  deliver: 'forwarded',
  steer: 'forwarded',
  abort: 'forwarded',
  destroy: 'forwarded',
  followUp: 'forwarded',
  isPrompting: 'forwarded',
  // Subsumed: the settlement predicates (conversationIdle / workSettled and
  // their awaitable forms) are the composite-aware forms of the loop-gate
  // reads; in duplex a single loop's gate is not "the agent is idle".
  isLoopActive: 'subsumed',
  waitForLoopIdle: 'subsumed',
  waitForAskSettlement: 'subsumed',
  // Queues.
  setSteeringQueueMode: 'forwarded',
  setFollowUpQueueMode: 'forwarded',
  clearSteeringQueue: 'forwarded',
  clearFollowUpQueue: 'forwarded',
  clearQueuedDeliveries: 'forwarded',
  queuedDeliveryCount: 'forwarded',
  pendingWakeDeliveryCount: 'forwarded',
  // Partially subsumed: facade abort() and restore() call clearAllQueues()
  // internally but discard its return value (the cleared silent and
  // parked-wake items, returned for re-routing). The facade surfaces
  // clearQueuedDeliveries() (silent only) and pendingWakeDeliveryCount (a
  // count), so parked-wake content dropped by a facade abort or restore is
  // currently unrecoverable and unrecorded; routing it to the session log
  // is 2b delivery routing.
  clearAllQueues: 'subsumed',
  // Withheld: a retraction primitive the facade uses to drop permission
  // voicings whose ask an abort already settled. It asks the caller to
  // recognize its own content by text, which is a composition concern; a
  // consumer wanting to drop queued content has clearQueuedDeliveries().
  dropPendingWakeDeliveries: 'withheld',
  // Asks and headlines.
  getPendingAsks: 'forwarded',
  markAskVoiced: 'forwarded',
  setHeadlineProvider: 'forwarded',
  // Withheld: the facade owns this hook in duplex (the control-tool
  // terminate guards install through it, D17); exposing it would let a
  // consumer displace those guards. Direct AgentLoop users keep it.
  setToolResultInterceptor: 'withheld',
  // Prompt and model surface. In duplex the setters for model, utility
  // model, cache retention, context-window limit and session id reach both
  // resident loops (setModel re-mirrors an unpinned talker); thinking level
  // and setContextWindow stay reasoner-only (the talker's model is different
  // and its thinking is fixed off). Getters report the reasoner.
  setBasePrompt: 'forwarded',
  getBasePrompt: 'forwarded',
  getCurrentSystemPrompt: 'forwarded',
  composeSystemPrompt: 'forwarded',
  getSystemPromptSections: 'forwarded',
  getModel: 'forwarded',
  setModel: 'forwarded',
  getUtilityModel: 'forwarded',
  setUtilityModel: 'forwarded',
  resetUtilityModel: 'forwarded',
  getAutoResolvedUtilityModel: 'forwarded',
  isUtilityModelOverridden: 'forwarded',
  getThinkingLevel: 'forwarded',
  setThinkingLevel: 'forwarded',
  getModelThinkingCapabilities: 'forwarded',
  clampThinkingLevel: 'forwarded',
  setCacheRetention: 'forwarded',
  getCacheRetention: 'forwarded',
  setSessionId: 'forwarded',
  getSessionId: 'forwarded',
  // Context window and token accounting.
  setContextWindow: 'forwarded',
  setContextWindowLimit: 'forwarded',
  contextWindowLimit: 'forwarded',
  effectiveContextWindow: 'forwarded',
  modelContextWindow: 'forwarded',
  currentContextTokenCount: 'forwarded',
  updateCurrentContextTokenCount: 'forwarded',
  estimateCurrentContextTokens: 'forwarded',
  capToolResult: 'forwarded',
  // Direct completions and usage.
  directComplete: 'forwarded',
  structuredComplete: 'forwarded',
  utilityComplete: 'forwarded',
  getLastDirectUsage: 'forwarded',
  getSessionUsage: 'forwarded',
  // Subsumed: restore() takes the versioned composite artifact and applies
  // per-loop ordering internally; piecemeal per-loop restores would bypass
  // the guard and the baseline-plus-delta usage model.
  restoreConversationHistory: 'subsumed',
  restoreObservationalMemoryState: 'subsumed',
  restoreSessionUsage: 'subsumed',
  // History, memory, digestion, compaction.
  getConversationHistory: 'forwarded',
  getObservationalMemoryState: 'forwarded',
  digestIdle: 'forwarded',
  checkAndRunCompaction: 'forwarded',
  triggerObservation: 'forwarded',
  getCompactionManager: 'forwarded',
  // Tools, MCP, skills.
  addConsumerTool: 'forwarded',
  removeConsumerTool: 'forwarded',
  refreshTools: 'forwarded',
  connectMcpServer: 'forwarded',
  disconnectMcpServer: 'forwarded',
  getMcpServerStates: 'forwarded',
  mcpConfigMatches: 'forwarded',
  setMcpToolCallProgressHandler: 'forwarded',
  getMcpClientManager: 'forwarded',
  getMcpTools: 'forwarded',
  getSkillRegistry: 'forwarded',
  loadSkill: 'forwarded',
  clearSkillBuffer: 'forwarded',
  getSkillBuffer: 'forwarded',
  setPreprocessorVariables: 'forwarded',
  setScriptContext: 'forwarded',
  // Sub-agents.
  spawnBackgroundSubAgent: 'forwarded',
  cancelSubAgent: 'forwarded',
  steerSubAgent: 'forwarded',
  getActiveSubAgents: 'forwarded',
  getDeadLetteredBackgroundResults: 'forwarded',
  // Withheld: raw manager internals. Consumers have getActiveSubAgents,
  // spawnBackgroundSubAgent, cancelSubAgent, and steerSubAgent; handing out
  // the manager would let a consumer mutate tracking state the facade's
  // lifecycle log depends on.
  getSubAgentManager: 'withheld',
  // State reads and misc.
  isRunning: 'forwarded',
  state: 'forwarded',
  isWorkingTagsEnabled: 'forwarded',
  setWorkingTagsEnabled: 'forwarded',
  setLastInteractionTime: 'forwarded',
  getEnvOverrides: 'forwarded',
  getEventBridge: 'forwarded',
  getBudgetGuard: 'forwarded',
  getContextManager: 'forwarded',
  // Withheld: no single composite value exists in duplex (each loop has its
  // own path); origin reaches consumers via LoopOriginContext on callbacks.
  loopPath: 'withheld',
  // Withheld: internal causation plumbing (the facade stamps log-entry
  // causedBy from it); the log's causedBy field is the consumer surface.
  activeRunCauseTags: 'withheld',
  // Withheld: cache-breakpoint internal (the boundary between cacheable
  // history and tick content); meaningless as a composite value.
  prePromptMessageCount: 'withheld',
  // Withheld: context-composition internals; the hook is wiring between the
  // loop and pi, not a consumer surface.
  getTransformContextHook: 'withheld',
  // Withheld: permission-gate internal (which registered tools bypass the
  // resolver); per-loop by construction, meaningless as a composite value.
  isToolPermissionExempt: 'withheld',
  // Callback registration.
  onLoopComplete: 'forwarded',
  onError: 'forwarded',
  onTurnComplete: 'forwarded',
  onRetryScheduled: 'forwarded',
  onRetrySucceeded: 'forwarded',
  onRetryExhausted: 'forwarded',
  onBeforeCompaction: 'forwarded',
  onPostCompaction: 'forwarded',
  onCompactionError: 'forwarded',
  onCompactionDegraded: 'forwarded',
  onCompactionExhausted: 'forwarded',
  onSubAgentSpawned: 'forwarded',
  onSubAgentCompleted: 'forwarded',
  onSubAgentFailed: 'forwarded',
  onBackgroundResultDelivery: 'forwarded',
  onBackgroundResultDeadLettered: 'forwarded',
  onObservation: 'forwarded',
  onReflection: 'forwarded',
} as const satisfies Record<keyof AgentLoop, AgentLoopMemberDisposition>;

type DelegationTable = typeof AGENT_LOOP_DELEGATION;

/**
 * The keys the table marks 'forwarded'. Exported so the behavioural
 * delegation test can be exhaustive over it: the structural test only sees
 * that a forwarded member EXISTS on the facade, never that it behaves the
 * same, which is how the post-destroy divergence in steer()/abort() shipped.
 */
export type ForwardedLoopMember = {
  [K in keyof DelegationTable]: DelegationTable[K] extends 'forwarded' ? K : never;
}[keyof DelegationTable];

type AssertExtends<A extends B, B> = A;

/**
 * Compile-time check: every forwarded member exists on CortexAgent. Fails
 * to typecheck when a member marked 'forwarded' has no facade counterpart.
 */
export type _ForwardedMembersExistOnFacade = AssertExtends<
  ForwardedLoopMember,
  keyof CortexAgent
>;

// ---------------------------------------------------------------------------
// Persisted state (versioned composite artifact)
// ---------------------------------------------------------------------------

/** Usage in the v2 artifact: one aggregate plus per-loop attribution. */
export interface CortexAgentUsageBreakdown {
  /**
   * Aggregate across every loop, sub-agent, and utility call. Children are
   * counted exactly once: each loop's session usage already includes its
   * forwarded child events (bridge-of-record), so the aggregate is the sum
   * of per-loop totals with SubAgentResult.usage never re-added on top.
   */
  total: SessionUsage;
  /**
   * Per-loop breakdown, so attribution survives a restore (a single blob
   * would erase it). `talker` is null for passthrough sessions.
   */
  perLoop: {
    talker: SessionUsage | null;
    reasoner: SessionUsage;
    /**
     * Accumulated quick-lookup spend (settled lookup loops, duplex only).
     * Absent when no lookup has ever run; carried through restores.
     */
    lookups?: SessionUsage;
  };
}

/**
 * Version 2: the composite artifact (facade-api.md). The log, per-loop
 * histories, per-loop observational states, and the usage breakdown.
 * Sub-agent state is deliberately absent (tasks re-derive from the log's
 * directive/lifecycle entries; resumable tasks are out of scope).
 */
export interface CortexAgentStateV2 {
  version: 2;
  log: SessionLogEntry[];
  /** Post-slot talker history. Empty for passthrough sessions. */
  talkerHistory: AgentMessage[];
  /** Post-slot reasoner history. */
  reasonerHistory: AgentMessage[];
  /** Talker observational state, order-coupled to talkerHistory. */
  talkerMemory: ObservationalMemoryState | null;
  /** Reasoner observational state, order-coupled to reasonerHistory. */
  reasonerMemory: ObservationalMemoryState | null;
  usage: CortexAgentUsageBreakdown;
  /**
   * Duplex router state that must outlive a restore: the task alias
   * counter, tracked tasks, results logged but not yet handed to the
   * talker, and conversation the reasoner has not seen yet. Optional, so
   * artifacts written before it existed still restore (the alias counter
   * is then recovered from the log). Absent for sessions that never ran
   * duplex.
   */
  router?: DuplexRouterState;
}

/**
 * Version 1: today's single-loop persistence surface (a conversation
 * history plus optionally observational state and session usage), given a
 * version wrapper so existing sessions upgrade transparently. It restores
 * into the reasoner with an empty talker and a log synthesized from
 * nothing.
 */
export interface CortexAgentStateV1 {
  version: 1;
  history: AgentMessage[];
  /**
   * Both optional fields accept an explicit null so a consumer can build
   * the artifact with a uniform spread. Under exactOptionalPropertyTypes a
   * `SessionUsage | undefined` cannot be assigned to `usage?: SessionUsage`,
   * which forced a conditional spread on one field while the other took a
   * plain `?? null`; treating absent and null alike removes that asymmetry.
   */
  memory?: ObservationalMemoryState | null;
  usage?: SessionUsage | null;
}

/**
 * Compile-time check on that uniformity. A consumer holding both fields as
 * `T | null` must be able to assign both directly; while `usage` was
 * `SessionUsage` only, exactOptionalPropertyTypes rejected the null and
 * forced a conditional spread on one field beside a plain `?? null` on the
 * other. Fails to typecheck if either field stops accepting null.
 */
export type _V1OptionalFieldsAcceptNull = AssertExtends<
  {
    version: 1;
    history: AgentMessage[];
    memory: ObservationalMemoryState | null;
    usage: SessionUsage | null;
  },
  CortexAgentStateV1
>;

/**
 * What restore() accepts: a versioned artifact, or a bare message array
 * (today's rawest persistence shape, treated as v1 history).
 */
export type CortexAgentPersistedState =
  | CortexAgentStateV2
  | CortexAgentStateV1
  | AgentMessage[];

/**
 * The highest `task-N` alias the log's directives mention, or 0. The floor
 * for the alias counter after a restore, whatever the artifact carried.
 */
function highestTaskAliasInLog(log: readonly SessionLogEntry[]): number {
  let highest = 0;
  for (const entry of log) {
    if (entry.type !== 'directive') continue;
    const alias = (entry.data as { alias?: unknown } | undefined)?.alias;
    const match = typeof alias === 'string' ? /^task-(\d+)$/.exec(alias) : null;
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

/** Normalize any accepted persisted shape to v2. */
function normalizePersistedState(state: CortexAgentPersistedState): CortexAgentStateV2 {
  if (Array.isArray(state)) {
    return upgradeV1({ version: 1, history: state });
  }
  if (state.version === 1) {
    return upgradeV1(state);
  }
  if (state.version === 2) {
    return state;
  }
  throw new Error(
    `Unsupported CortexAgent state version: ${String((state as { version: unknown }).version)}`,
  );
}

/** A v1 artifact restores into the reasoner with an empty talker and log. */
function upgradeV1(state: CortexAgentStateV1): CortexAgentStateV2 {
  const usage = state.usage ? cloneSessionUsage(state.usage) : zeroSessionUsage();
  return {
    version: 2,
    log: [],
    talkerHistory: [],
    reasonerHistory: state.history,
    talkerMemory: null,
    reasonerMemory: state.memory ?? null,
    usage: {
      total: cloneSessionUsage(usage),
      perLoop: { talker: null, reasoner: usage },
    },
  };
}

// ---------------------------------------------------------------------------
// Facade deliver options
// ---------------------------------------------------------------------------

/** Options for {@link CortexAgent.deliver}. */
export interface CortexDeliverOptions {
  /**
   * Whether the delivery may wake an idle loop by starting a turn.
   * Default true. See AgentLoop.deliver.
   */
  wake?: boolean;
  /**
   * Which surface the input addresses. In passthrough both resolve to the
   * reasoner; in duplex (2b) 'conversation' is the talker and 'work' the
   * reasoner. Default: 'conversation'.
   */
  target?: 'conversation' | 'work';
  /**
   * Who is speaking. Only 'user' mints a consent-qualifying cause tag, so a
   * caller relaying actual human speech must say so; everything else
   * (notifications, status, anything the application itself says) defaults
   * to 'system' and cannot satisfy a permission ask.
   *
   * The default is deliberately not 'user'. Defaulting the other way makes
   * every notification path a silent consent source: voice an escalation
   * ask, wait for any routine "your build finished", and a persuaded talker
   * can grant permission whose audit trail points at the build message.
   * Defaulting to 'system' costs at most one re-voice when a consumer
   * forgets to mark real speech. See docs/cortex/duplex/decisions.md D16.
   *
   * `prompt()` is unambiguous user speech and always mints the user tag.
   */
  speaker?: 'user' | 'system';
}

// ---------------------------------------------------------------------------
// CortexAgent
// ---------------------------------------------------------------------------

const DEFAULT_STATE_DEBOUNCE_MS = 500;

/**
 * Producer identity on a resolution note's lifecycle entry. Not a loop: the
 * facade resolved the configuration, and attributing it to the reasoner or
 * the talker would claim a loop said something about its own assembly.
 */
const RESOLUTION_LOOP_PATH = 'facade';

/**
 * Notes read off the talker's model, re-evaluated when the facade itself
 * re-resolves that model (setModel on an unpinned talker).
 */
const MODEL_RESOLUTION_NOTE_CODES: ReadonlySet<ResolutionNoteCode> = new Set<ResolutionNoteCode>([
  'talker-model-fallback',
  'talker-utility-model-skipped',
]);

/** One macrotask yield: lets pending microtask cascades finish. */
function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Chars of a provider error message carried into a failure delivery. */
const MAX_FAILURE_DETAIL_CHARS = 300;

/**
 * Bound a provider error message before it rides a failure delivery into the
 * talker's transcript. Provider text is arbitrary length and not ours; the
 * delivery wrapper already fences it as information rather than instruction,
 * so all that is left to do is stop a multi-kilobyte body from crowding out
 * the conversation.
 */
function clipFailureDetail(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) return 'no detail reported';
  return trimmed.length > MAX_FAILURE_DETAIL_CHARS
    ? `${trimmed.slice(0, MAX_FAILURE_DETAIL_CHARS)}…`
    : trimmed;
}

/**
 * Why a voicing hand-off was refused. Surfaces in the broker's delivery-failed
 * log line, so a deliberate hold reads as one rather than as a talker fault.
 */
const ASK_VOICING_HELD_REASON =
  'conversation aborted; the permission request is held until the conversation reopens';

/**
 * Cap on remembered ask-voicing texts. They exist only to recognize the
 * facade's own content among the talker's PARKED deliveries, which a run
 * drains at the next turn, so the live window is a handful at most. An
 * evicted text degrades to "not recognized as a voicing", which leaves a
 * moot request readable rather than dropping something else: the safe
 * direction for a bounded cache to fail in.
 */
const MAX_TRACKED_ASK_VOICINGS = 32;

/** Append the D17 speak-now appendix to a control-tool receipt. */
function appendSpeakNudge(content: unknown): unknown {
  const nudge = `\n\n${SPEAK_NOW_APPENDIX}`;
  if (typeof content === 'string') return content + nudge;
  if (Array.isArray(content)) return [...content, { type: 'text', text: nudge }];
  return content;
}

export class CortexAgent {
  private readonly reasoner: AgentLoop;
  /** The talker loop; null in passthrough. */
  private readonly talker: AgentLoop | null;
  private readonly mode: CortexAgentMode;
  private readonly log: SessionLog;
  private readonly logger: CortexLogger;

  // Duplex machinery (null in passthrough).
  private router: DuplexRouter | null = null;
  private headlines: DuplexHeadlines | null = null;
  private mergedBridge: EventBridge | null = null;
  private aggregateGuard: BudgetGuard | null = null;
  /** Facade-owned quick-lookup fleet (D13); null in passthrough. */
  private lookups: QuickLookupManager | null = null;
  /**
   * The facade-minted shared MCP manager (duplex): loops sharing it never
   * close it, so the facade does at destroy. Null in passthrough and when
   * the consumer supplied their own manager (their lifecycle, not ours).
   */
  private ownedMcpManager: McpClientManager | null = null;
  private aggregateBreachLogged = false;
  /**
   * Whether the current reasoner run delivered a result through Deliver
   * (implicit-delivery guard). Progress notes (`silent`) do not count.
   */
  private reasonerDeliveredResultThisRun = false;
  /**
   * Set while a cancel_task is aborting a reasoner run that served only the
   * cancelled work; later dispatches chain behind it (see dispatchToReasoner).
   */
  private reasonerCancelAbort: Promise<void> | null = null;
  /**
   * Set while the facade itself is aborting the reasoner (a user abort, a
   * cancel), so the run end that abort produces is not mistaken for a stop
   * nobody asked for. Budget stops are read off the guards instead.
   */
  private reasonerAbortCause: 'user' | 'cancel' | null = null;
  /**
   * Whether the reasoner's current terminal failure already produced a
   * delivery. See deliverReasonerFailure for why a per-run reset is the
   * right unit for this and would not be for anything announced mid-ladder.
   */
  private reasonerFailureAnnounced = false;
  /** One truncation repair per streak (D17 stop-reason audit). */
  private talkerRepairPending = false;
  /**
   * Ask-voicing texts handed to the talker, so the facade can recognize its
   * own voicings among the talker's parked deliveries and retract the ones
   * an abort has made moot. Bounded; see MAX_TRACKED_ASK_VOICINGS.
   */
  private readonly trackedAskVoicings = new Set<string>();
  /** True while a conversation abort is refusing voicing hand-offs. */
  private askVoicingHeld = false;
  /**
   * A voicing was withheld by a conversation abort and the request is now
   * pending and silent. It is read out again the next time the conversation
   * surface receives input, which is the next moment the agent is talking to
   * the user anyway.
   */
  private deferredAskVoicing = false;
  /** The consumer's base prompt without the appended role prompts. */
  private consumerBasePrompt: string | null = null;
  /**
   * The network egress decision function the facade actually enforces: the
   * broker-routed wrapper in duplex, the consumer's own function in
   * passthrough. Exposed via getNetworkAccessResolver() for the sandbox
   * ask-callback wiring.
   */
  private readonly networkResolver: ResolveNetworkAccess | null;
  /** Whether a sandbox was configured (for the egress-wiring warning). */
  private readonly sandboxConfigured: boolean;
  /**
   * Whether the consumer pinned `talker.model`. An unpinned talker mirrors
   * the reasoner's auto-resolved fast tier, at assembly and again on every
   * facade setModel(); a pinned one keeps the consumer's choice.
   */
  private readonly talkerModelPinned: boolean;
  private ownedSandbox: SandboxSession | undefined;
  /** Whether anyone took the resolver to wire into a sandbox. */
  private networkResolverHandedOut = false;
  private unwiredNetworkResolverWarned = false;
  /** Lazily-built D6 fan-out view over both loops' context managers. */
  private fanOutContextManager: FanOutContextManager | null = null;
  private digestionTimer: ReturnType<typeof setTimeout> | null = null;
  private idleDigestionDelayMs = 10_000;
  /**
   * Preempts the idle digestion pass in flight, if any. Digestion holds a
   * loop's gate, so any input bound for either loop aborts it rather than
   * waiting behind background compaction (see preemptIdleDigestion).
   */
  private digestionPreempt: AbortController | null = null;

  /** Serializes facade prompt() calls (concurrent prompts queue, never throw). */
  private promptChain: Promise<void> = Promise.resolve();
  /** Facade prompts accepted but not yet settled (chain-queued or running). */
  private pendingFacadePrompts = 0;
  /** Waiters released whenever pendingFacadePrompts returns to zero. */
  private promptSettlers: Array<() => void> = [];
  /** Waiters released on the next log append (see waitForLogAppend). */
  private logAppendWaiters: Array<() => void> = [];

  /**
   * Passthrough only: seq of the utterance whose facade-initiated reasoner
   * run is currently live. Entries produced by that run (replies, errors,
   * spawn lifecycle) carry it as their causation stamp; entries produced
   * while no facade-initiated run is live (e.g. by a background delivery
   * run) carry no stamp rather than a guessed one.
   *
   * Duplex does not use this field: causation there is bound to the run
   * inside the loop (deliver() causeTags read back via activeRunCauseTags),
   * so a parked barge-in keeps its stamp through the sweep and a sweep run
   * can never inherit a previous run's stamp from a facade field raced
   * against the loop gate.
   */
  private activeCauseSeq: number | null = null;
  /** Spawn lifecycle seq per live task, for completion causation. */
  private readonly spawnSeqByTaskId = new Map<string, number>();

  // Baseline-plus-delta usage model: loops restart at zero after a
  // restore, so the composite aggregate is restoredBaseline + live deltas
  // rather than an additive merge into live counters (which would
  // double-count on repeated restores).
  private usageBaseline: {
    talker: SessionUsage | null;
    reasoner: SessionUsage;
    lookups: SessionUsage | null;
  } | null = null;
  /** Reasoner live counters at the moment of the last restore. */
  private usageAtRestore: SessionUsage | null = null;
  /** Talker live counters at the moment of the last restore (duplex). */
  private talkerUsageAtRestore: SessionUsage | null = null;
  /** Lookup accumulator reading at the moment of the last restore (duplex). */
  private lookupUsageAtRestore: SessionUsage | null = null;
  /**
   * Talker-side artifact content carried through a passthrough session
   * opaquely: passthrough has no talker loop to hydrate, but a restored
   * duplex artifact must round-trip getState() without losing that side.
   */
  private retainedTalkerHistory: AgentMessage[] = [];
  /** A restored duplex artifact's router state, carried through passthrough. */
  private retainedRouterState: DuplexRouterState | null = null;
  private retainedTalkerMemory: ObservationalMemoryState | null = null;

  private readonly stateChangedHandlers: Array<(state: CortexAgentStateV2) => void> = [];
  private readonly stateDebounceMs: number;
  private stateDirty = false;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private emittingState = false;

  private destroyPromise: Promise<void> | null = null;
  private destroyed = false;

  /**
   * What this assembly resolved to where it differs from what was asked for
   * (resolution-report.ts). Computed once at construction, plus the one
   * condition that cannot be known then (the unwired egress resolver). The
   * warns and the lifecycle log entries are both derived from these, never
   * written alongside them.
   */
  private readonly resolutionNotes: ResolutionNote[] = [];
  /**
   * The consumer-supplied inputs the model-derived notes are read against,
   * kept so a talker re-mirror (setModel) can re-evaluate them against the
   * loops as they now are.
   */
  private readonly resolutionInputs: {
    requestedTalkerModel: CortexModel | undefined;
    configuredUtilityModel: CortexModel | 'default' | undefined;
    perPromptMaxCost: number | undefined;
  };

  private constructor(reasoner: AgentLoop, config: ResolvedCortexAgentConfig, talker?: AgentLoop) {
    this.mode = config.mode ?? DEFAULT_MODE;
    if (this.mode === 'duplex' && !talker) {
      throw new Error('CortexAgent duplex mode requires a talker loop.');
    }
    this.reasoner = reasoner;
    this.talker = this.mode === 'duplex' ? talker! : null;
    const baseLogger = config.logger ?? NOOP_LOGGER;
    this.logger = {
      debug: (message, data) => baseLogger.debug(`[CortexAgent] ${message}`, data),
      info: (message, data) => baseLogger.info(`[CortexAgent] ${message}`, data),
      warn: (message, data) => baseLogger.warn(`[CortexAgent] ${message}`, data),
      error: (message, data) => baseLogger.error(`[CortexAgent] ${message}`, data),
    };

    this.log = new SessionLog({
      ...(config.sessionLog?.maxEntries !== undefined
        ? { maxEntries: config.sessionLog.maxEntries }
        : {}),
      ...(config.sessionLog?.maxSubscriberBuffer !== undefined
        ? { maxSubscriberBuffer: config.sessionLog.maxSubscriberBuffer }
        : {}),
      logger: this.logger,
      onEvict: (evicted) => this.spillEvictedEntries(evicted, config),
    });

    this.stateDebounceMs = config.stateChangeDebounceMs ?? DEFAULT_STATE_DEBOUNCE_MS;
    this.consumerBasePrompt = config.initialBasePrompt ?? null;
    this.idleDigestionDelayMs = config.duplex?.idleDigestionDelayMs ?? 10_000;
    // In duplex, create() has already wrapped this in the broker pipeline.
    this.networkResolver = config.resolveNetworkAccess ?? null;
    this.sandboxConfigured = config.sandbox !== undefined;
    this.talkerModelPinned = config.talker?.model !== undefined;
    this.resolutionInputs = {
      requestedTalkerModel: config.talker?.model,
      configuredUtilityModel: config.utilityModel,
      perPromptMaxCost: config.budgetGuard?.maxCost,
    };

    if (this.mode === 'duplex') {
      this.wireDuplex(config);
    } else {
      this.wireLogProducers();
    }
    this.wireStateTriggers();
    // Last, because it reads the assembly back: the loops are built, the
    // aggregate guard exists, and every note below is a statement about what
    // this constructor just produced.
    this.collectAssemblyResolution();
  }

  /**
   * Create a CortexAgent. Routes consumer config per {@link CONFIG_ROUTING}
   * and constructs the resident loop(s): the reasoner alone in passthrough
   * (reproducing direct AgentLoop behavior exactly), or the talker plus the
   * persistent reasoner in duplex.
   */
  static async create(config: CortexAgentConfig): Promise<CortexAgent> {
    const { sandbox, ...rest } = config;
    // The facade owns the managed session; loops only receive its provider wrapper.
    const managed = sandbox !== undefined && !isSandboxProvider(sandbox)
      ? await SandboxSession.create(sandbox, config.workingDirectory, config.resolveNetworkAccess)
      : undefined;
    const resolved: ResolvedCortexAgentConfig = {
      ...rest,
      ...(managed ? { sandbox: managed, resolveNetworkAccess: managed.resolveNetworkAccess }
        : isSandboxProvider(sandbox) ? { sandbox } : {}),
    };
    try {
      const agent = await CortexAgent.createResolved(resolved, managed);
      agent.ownedSandbox = managed;
      return agent;
    } catch (error) {
      await managed?.dispose().catch(() => {});
      throw error;
    }
  }

  private static async createResolved(config: ResolvedCortexAgentConfig, managed?: SandboxSession): Promise<CortexAgent> {
    if ((config.mode ?? DEFAULT_MODE) === 'duplex') {
      // Broker the blocking permission surfaces before the loop configs are
      // built: the loops capture the resolver closures at creation, so the
      // broker reference is late-bound through a box that is filled
      // synchronously below, before create() returns and before any tool
      // call can run. Allow/block/deny decisions pass through untouched;
      // only `ask` routes through the conversation (D16).
      const brokerBox: { broker: PermissionBroker | null } = { broker: null };
      let brokered = withBrokeredPermissions(config, () => brokerBox.broker);
      if (managed && brokered.resolveNetworkAccess) managed.setNetworkResolver(brokered.resolveNetworkAccess);
      // The MCP multiplexer: one manager, one connection per server total,
      // projected to the reasoner (and its sub-agents via tool closures);
      // never the talker. A consumer-provided manager is adopted (and its
      // lifecycle stays the consumer's); otherwise the facade mints and
      // owns one, configured here because loops only configure managers
      // they own.
      const facadeMintedMcp = config.mcpClientManager === undefined;
      const sharedMcp = config.mcpClientManager ?? new McpClientManager();
      if (facadeMintedMcp) {
        if (config.logger) sharedMcp.logger = config.logger;
        if (config.envOverrides) sharedMcp.envOverrides = config.envOverrides;
        if (config.sandbox) sharedMcp.sandbox = config.sandbox;
      }
      brokered = { ...brokered, mcpClientManager: sharedMcp };
      const reasoner = await AgentLoop.create(buildDuplexReasonerConfig(brokered));
      let talker: AgentLoop;
      try {
        // Default talker model: the fast tier resolved from the primary
        // provider, which is exactly what the reasoner's utility-model
        // auto-resolution computes. That resolution cannot fail; for a
        // provider Cortex cannot enumerate (Ollama, custom OpenAI-compatible
        // endpoints) it falls back to the primary model, so duplex still
        // assembles and runs but the talker is as slow as the reasoner,
        // which is the whole latency case gone. That outcome is reported as
        // a 'talker-model-fallback' resolution note, computed in the
        // constructor from the loops as assembled rather than from this
        // local, so the report describes the agent that exists.
        const talkerModel = brokered.talker?.model ?? reasoner.getAutoResolvedUtilityModel();
        talker = await AgentLoop.create(buildTalkerConfig(brokered, talkerModel));
      } catch (err) {
        // A half-assembled duplex must not leak a live reasoner.
        await reasoner.destroy().catch(() => {});
        if (facadeMintedMcp) await sharedMcp.closeAll().catch(() => {});
        throw err;
      }
      const agent = new CortexAgent(reasoner, brokered, talker);
      if (managed) agent.networkResolverHandedOut = true;
      brokerBox.broker = agent.router?.permissionBroker ?? null;
      if (facadeMintedMcp) agent.ownedMcpManager = sharedMcp;
      return agent;
    }
    const reasoner = await AgentLoop.create(buildReasonerConfig(config));
    return new CortexAgent(reasoner, config);
  }

  // -------------------------------------------------------------------------
  // Duplex assembly
  // -------------------------------------------------------------------------

  /** The loop holding the conversation surface: talker in duplex. */
  private get conversationLoop(): AgentLoop {
    return this.talker ?? this.reasoner;
  }

  private wireDuplex(config: ResolvedCortexAgentConfig): void {
    const talker = this.talker!;

    // The facade-owned quick-lookup fleet (D13): ephemeral read-only loops
    // on the talker's fast model, spawned on the talker's behalf, with their
    // own small pool. Created before the router so its ports can dispatch
    // into it synchronously.
    const lookups = new QuickLookupManager(
      {
        createLoop: async (alias) => {
          const loop = await AgentLoop.create(
            buildQuickLookupConfig(config, talker.getModel(), alias),
          );
          // Label lookup events on the merged stream ('lookup/lk-1'), which
          // also feeds the aggregate budget guard, so lookup spend is
          // bounded like everything else.
          const cleanup = this.mergedBridge
            ? this.mergedBridge.forwardLoopFrom(loop.getEventBridge(), loop.loopPath)
            : undefined;
          return { loop, ...(cleanup ? { cleanup } : {}) };
        },
        onOutcome: (outcome) => this.handleLookupOutcome(outcome),
        logger: this.logger,
      },
      {
        ...(config.duplex?.maxConcurrentLookups !== undefined
          ? { maxConcurrent: config.duplex.maxConcurrentLookups }
          : {}),
        ...(config.duplex?.lookupTimeoutMs !== undefined
          ? { timeoutMs: config.duplex.lookupTimeoutMs }
          : {}),
      },
    );
    this.lookups = lookups;

    const ports: DuplexRouterPorts = {
      deliverToTalker: (content, wake) => {
        if (wake) this.preemptIdleDigestion();
        talker.deliver(content, { wake });
      },
      talkerIdle: () => !talker.isLoopActive,
      spawnLookup: (question, causeSeq) => lookups.request(question, causeSeq),
      dispatchToReasoner: (message, causeSeq, options) =>
        this.dispatchToReasoner(message, causeSeq, options),
      appendLog: (input) => this.appendEntry({
        type: input.type,
        loopPath: input.loopPath,
        content: input.content,
        // The router supplies causation explicitly; entries it cannot
        // attribute carry no stamp rather than a guessed one.
        causedBy: input.causedBy ?? null,
        ...(input.wake !== undefined ? { wake: input.wake } : {}),
        ...(input.data !== undefined ? { data: input.data } : {}),
      }).seq,
      // Read from the loops' live-run cause tags, never from facade fields:
      // the tags travel with the content, so a barge-in parked behind a
      // live run keeps its utterance seq through the sweep run (B1).
      currentTalkerCauseSeq: () => latestCauseSeq(talker.activeRunCauseTags),
      currentTalkerCauseTags: () => collectCauseTags(talker.activeRunCauseTags),
      // One reasoner causation port: the router derives its own log-stamping
      // collapse from this set, so there is no second port to fall out of
      // step with it.
      currentReasonerCauseTags: () => collectCauseTags(this.reasoner.activeRunCauseTags),
      // The broker's ask lane: a real wake delivery carrying the ask-kind
      // cause tag, so the run that voices the request is identifiable to
      // the consent check (an answer from that same run cannot bind).
      voiceAskToTalker: (content, causeTag) => {
        if (this.askVoicingHeld) {
          // A conversation abort just happened: the user said stop, so the
          // request is not read out now. Refusing the hand-off is how the
          // ask stays SAFE while it stays quiet: the broker treats a throw
          // as "nothing reached the user" and withdraws the consent anchor,
          // which is exactly true here. Delivering and then discarding
          // would leave the ask anchored for a voicing nobody heard.
          throw new Error(ASK_VOICING_HELD_REASON);
        }
        this.deferredAskVoicing = false;
        this.trackAskVoicing(content);
        this.preemptIdleDigestion();
        talker.deliver(content, { wake: true, causeTag });
      },
      // Keep the loop registry's voiced flag truthful for tool asks so
      // headline and consumer surfaces show what has been read out.
      markAskVoiced: (askId) => {
        this.reasoner.markAskVoiced(askId);
      },
      workRefusal: () => (this.aggregateGuard?.isBreached()
        ? "the session's spending limit has been reached"
        : null),
      idleSignal: config.idleSignal,
      logger: this.logger,
      talkerLoopPath: talker.loopPath,
      reasonerLoopPath: this.reasoner.loopPath,
    };
    const router = new DuplexRouter(ports, routerOptionsFrom(config.duplex));
    this.router = router;

    // The talker carries exactly the control toolset (D5/D8); the reasoner
    // gains Deliver (F1) and SteerSubAgent (D12).
    for (const tool of buildControlTools(router)) {
      talker.addConsumerTool(tool);
    }
    this.reasoner.addConsumerTool(buildDeliverTool({
      deliverFromReasoner: (content, wake, meta) => {
        // An explicit Deliver that concludes the work suppresses the
        // implicit final-text delivery for the same run. A silent progress
        // note does not: the role prompt encourages those mid-work, and
        // letting one swallow the final answer would leave the user with
        // "halfway there" as the last thing they heard.
        if (deliveryConcludes(wake, meta)) this.reasonerDeliveredResultThisRun = true;
        return router.deliverFromReasoner(content, wake, meta);
      },
    }));
    this.reasoner.addConsumerTool(buildSteerSubAgentTool(this.reasoner));

    // D17 terminate guards: bare receipts and empty-spoken-text
    // suppression, enforced in the tool-result path, not by prompt.
    talker.setToolResultInterceptor((info) => this.talkerToolResultGuard(info));

    // Conversation-side log producers and delta capture.
    talker.onTurnComplete((output: AgentTextOutput, origin: LoopOriginContext) => {
      if (output.userFacing.trim().length === 0) return;
      this.appendEntry({
        type: 'reply',
        loopPath: origin.loopPath,
        content: output.userFacing,
      });
      // The log entry above keeps the raw text on purpose: it is the audit
      // trail and has to record what the talker actually said. Only the
      // reasoner-bound copy is sanitized, so a talker that quotes a
      // permission marker cannot carry the fence nonce to the loop that
      // authors the fenced content.
      router.noteTalkerReply(stripAskFence(output.userFacing));
    });
    this.wireErrorProducers(talker);
    this.wireErrorProducers(this.reasoner);
    this.wireWorkLoopProducers();
    // The talker has no background completions, but its parked wake
    // deliveries (user utterances among them) can dead-letter after
    // repeated failed carrying runs; those drops must reach the log.
    this.wireDeadLetterProducer(talker);

    // The facade-fed headline block (communication.md): live status per
    // loop and running sub-agent, view-injected into the talker every turn
    // outside BP3, hard token cap with truncation, all interpolated values
    // escaped. Facade state, never log entries.
    const headlines = new DuplexHeadlines({
      reasonerRunning: () => this.reasoner.isPrompting,
      reasonerUsage: () => this.reasoner.getSessionUsage(),
      activeSubAgents: () => this.reasoner.getActiveSubAgents(),
      delegations: () => router.getDelegations(),
      // The BROKER, not the facade's merged consumer view. The broker holds
      // every ask (tool, escalation, network, so a blocked egress wait is
      // visible here too) and is the authority on whether one has actually
      // been read out: the loop registry's `voiced` is set at hand-off and
      // never cleared, so a voicing the broker later withdrew still reads as
      // heard there, and the block would offer a request as answerable that
      // the router would refuse an answer for.
      pendingAsks: () => router.permissionBroker.getPendingAsks(),
    });
    this.headlines = headlines;
    talker.setHeadlineProvider(() => headlines.build(), {
      maxTokens: TALKER_HEADLINE_MAX_TOKENS,
    });
    this.wireReasonerFailureSurfacing(headlines);

    // Run tracking: implicit deliveries, the liveness watchdog, the
    // per-turn dispatch cap, the stop-reason audit, and the headline feed.
    const reasonerBridge = this.reasoner.getEventBridge();
    reasonerBridge.on('loop_start', (event) => {
      if (event.childTaskId) return;
      this.reasonerDeliveredResultThisRun = false;
      this.reasonerFailureAnnounced = false;
      router.noteReasonerRunStart();
      headlines.noteRunStart();
    });
    reasonerBridge.on('loop_end', (event) => {
      if (event.childTaskId) return;
      this.handleReasonerRunEnd(event);
      headlines.noteRunEnd();
      this.scheduleIdleDigestion();
    });
    // Headline activity feed: the reasoner's own tool calls and last
    // user-facing output. Child tool activity reaches the block through
    // getActiveSubAgents() (the sub-agent manager tracks it), so only
    // main-loop events feed here.
    reasonerBridge.on('tool_call_start', (event) => {
      if (event.childTaskId) return;
      const payload = event.payload as { toolName?: string; args?: Record<string, unknown> } | undefined;
      if (!payload?.toolName) return;
      headlines.noteToolStart(payload.toolName, summarizeHeadlineArgs(payload.toolName, payload.args));
    });
    reasonerBridge.on('tool_call_end', (event) => {
      if (event.childTaskId) return;
      headlines.noteToolEnd();
    });
    reasonerBridge.on('turn_end', (event) => {
      if (event.childTaskId) return;
      const userFacing = event.textOutput?.userFacing;
      if (userFacing && userFacing.trim().length > 0) {
        headlines.noteOutput(userFacing);
      }
    });
    const talkerBridge = talker.getEventBridge();
    talkerBridge.on('turn_end', (event) => {
      if (event.childTaskId) return;
      router.noteTalkerTurnEnd();
      this.auditTalkerTurnEnd(event);
    });
    talkerBridge.on('loop_end', (event) => {
      if (event.childTaskId) return;
      this.scheduleIdleDigestion();
    });

    // One merged event stream, every event labeled with its loop path in
    // its own loopPath field. Never forwardFrom: that would stamp
    // childTaskId, and main-loop events arriving as pseudo-children go
    // dark against every `if (event.childTaskId) return;` consumer filter.
    this.mergedBridge = new EventBridge(false, this.logger);
    this.mergedBridge.forwardLoopFrom(talkerBridge, talker.loopPath);
    this.mergedBridge.forwardLoopFrom(reasonerBridge, this.reasoner.loopPath);

    // The sanitized talker-delta stream (F6): voice consumers must never
    // route raw response_chunk to TTS, because working tags are stripped
    // only at turn_end and split across chunks at arbitrary positions. The
    // filter holds text from any '<' until the tag disambiguates, per
    // assistant message; stream end releases a trailing prefix that never
    // became a tag and drops unterminated working content. flush() is
    // unconditional, so a close tag that never arrives cannot wedge the
    // stream.
    const mergedBridge = this.mergedBridge;
    const deltaFilter = new WorkingTagStreamFilter();
    talkerBridge.on('response_start', (event) => {
      if (event.childTaskId) return;
      deltaFilter.reset();
    });
    talkerBridge.on('response_chunk', (event) => {
      if (event.childTaskId) return;
      const delta = extractResponseChunkText(event.data);
      if (delta === null || delta.length === 0) return;
      const clean = deltaFilter.push(delta);
      if (clean.length > 0) mergedBridge.emitTalkerDelta(clean, talker.loopPath);
    });
    const flushDeltaFilter = (event: CortexEvent): void => {
      if (event.childTaskId) return;
      const tail = deltaFilter.flush();
      if (tail.length > 0) mergedBridge.emitTalkerDelta(tail, talker.loopPath);
    };
    // response_end is the per-message end; turn_end backstops it (flush is
    // idempotent: the held text clears on the first release).
    talkerBridge.on('response_end', flushDeltaFilter);
    talkerBridge.on('turn_end', flushDeltaFilter);

    // The aggregate budget guard, active from the first duplex assembly
    // (D19): lifetime scope over both loops, every sub-agent, and utility
    // spend (observer/reflector/summarization), which per-prompt loop
    // guards never see. Its cap is duplex.maxTotalCost, never the
    // consumer's budgetGuard.maxCost: that number keeps its per-prompt
    // meaning on the reasoner, and borrowing it here would silently turn
    // "$10 per prompt" into "$10 for the whole session". Turn counts are
    // not aggregated: turns across two loops plus children have no
    // comparable composite meaning.
    const aggregateConfig: Partial<BudgetGuardConfig> = {
      scope: 'lifetime',
      includeChildUsage: true,
      includeUtilityUsage: true,
    };
    // No finite default is invented when maxTotalCost is unset: a
    // session-level cost ceiling that silently aborts a long session is a
    // worse failure than an uncapped one, and any number Cortex picked would
    // be wrong for somebody. What is not acceptable is picking silently,
    // because the shape of duplex hides the exposure: two resident loops,
    // sub-agents, quick lookups and doubled observational spend, while the
    // only cost number most consumers set (budgetGuard.maxCost) keeps its
    // per-prompt meaning on the reasoner and bounds none of it. The uncapped
    // guard is reported as a 'duplex-cost-cap-unset' resolution note, read
    // back off the guard this builds rather than from the config.
    if (config.duplex?.maxTotalCost !== undefined) {
      aggregateConfig.maxCost = config.duplex.maxTotalCost;
    }
    this.aggregateGuard = new BudgetGuard(
      aggregateConfig,
      () => this.handleAggregateBreach(),
      this.logger,
    );
    this.aggregateGuard.wire(this.mergedBridge);
  }

  /**
   * Wake-deliver a dispatch to the reasoner. The directive seq rides the
   * delivery as its cause tag (stamped kind 'directive': the router only
   * ever dispatches on behalf of a directive entry it just appended), so
   * the run that consumes it (the turn it starts, or the sweep run when the
   * reasoner is busy) carries the causation regardless of which path
   * delivers it.
   */
  private dispatchToReasoner(
    message: string,
    causeSeq: number | null,
    options?: ReasonerDispatchOptions,
  ): void {
    this.preemptIdleDigestion();
    const deliverOptions: DeliverOptions = {
      ...(causeSeq !== null
        ? { causeTag: { kind: 'directive', seq: causeSeq } satisfies CauseTag }
        : {}),
      ...(options?.atTurnBoundary ? { atTurnBoundary: true } : {}),
    };
    if (this.reasonerCancelAbort) {
      // A cancel is stopping the reasoner's run. Anything handed over now
      // would park inside the abort window and be cancelled with the run,
      // so it waits for the abort to finish, in order.
      this.reasonerCancelAbort = this.reasonerCancelAbort.then(() => {
        this.deliverDispatchAfterCancel(message, deliverOptions, causeSeq);
      });
      return;
    }
    if (
      options?.abortLiveRun &&
      this.reasoner.isPrompting &&
      // Aborting drops everything parked behind the run (other tasks'
      // dispatches among it); stopping one task must not cost another.
      this.reasoner.pendingWakeDeliveryCount === 0
    ) {
      this.appendEntry({
        type: 'lifecycle',
        loopPath: this.reasoner.loopPath,
        content: 'Stopping the reasoner run: it served only cancelled work',
        data: { event: 'cancelled_run_stopped' },
        causedBy: causeSeq,
      });
      this.reasonerAbortCause = 'cancel';
      this.reasonerCancelAbort = this.reasoner.abort()
        .catch((err: unknown) => {
          this.logger.warn('cancel abort of the reasoner run failed', {
            error: errorMessageOf(err),
          });
        })
        .then(() => {
          // The aborted run has unwound; the next run is the cancel's own.
          if (this.reasonerAbortCause === 'cancel') this.reasonerAbortCause = null;
          this.deliverDispatchAfterCancel(message, deliverOptions, causeSeq);
        })
        .finally(() => {
          this.reasonerCancelAbort = null;
        });
      return;
    }
    this.reasoner.deliver(message, deliverOptions);
  }

  /**
   * A dispatch deferred behind a cancel abort. It can no longer fail the
   * control-tool call that produced it, so a failure is recorded the way
   * the router records a synchronous one.
   */
  private deliverDispatchAfterCancel(
    message: string,
    deliverOptions: DeliverOptions,
    causeSeq: number | null,
  ): void {
    if (this.destroyed) return;
    try {
      this.reasoner.deliver(message, deliverOptions);
    } catch (err) {
      this.logger.error('dispatch to reasoner failed after a cancel abort', {
        error: errorMessageOf(err),
      });
      this.appendEntry({
        type: 'lifecycle',
        loopPath: this.reasoner.loopPath,
        content: 'Dispatch to the reasoner failed',
        data: {
          event: 'dispatch_failed',
          error: errorMessageOf(err),
        },
        causedBy: causeSeq,
      });
    }
  }

  /**
   * D17 terminate guards over control-tool results. Bare receipts (the
   * working-tags reminder is suppressed: a dispatch receipt must not carry
   * permanent per-exchange reminder tokens), and terminate suppression
   * when the assistant message spoke nothing, so a preamble-less tool call
   * cannot end the exchange silently: the forced follow-up turn speaks.
   */
  private talkerToolResultGuard(
    info: ToolResultInterceptorInfo,
  ): ToolResultInterceptorResult | undefined {
    if (!isControlToolName(info.toolName)) return undefined;
    if (info.isError) {
      // A pi-level error result already omits terminate, buying the one
      // recovery turn (bounded by the talker's hard maxTurns).
      return undefined;
    }
    const spoken = spokenText(info.assistantMessage);
    if (spoken.length === 0) {
      // Open question (review N3): a model that keeps answering the nudge
      // with another silent tool call oscillates here until the talker's
      // hard maxTurns aborts the exchange. Whether to cap the forced
      // follow-ups separately (and say what instead: give up silently, or
      // synthesize a spoken fallback) is a policy call deferred until real
      // usage shows how often fast-tier models actually oscillate.
      return {
        terminate: false,
        suppressWorkingTagsReminder: true,
        content: appendSpeakNudge(info.result.content),
      };
    }
    return { suppressWorkingTagsReminder: true };
  }

  /**
   * Stop-reason audit (D17): a maxTokens ('length') stop with no tool call
   * in the truncated message can leave a spoken acknowledgment with
   * nothing dispatched and no error anywhere. Run one repair turn; a
   * truncated repair does not repair again until a clean turn resets the
   * streak.
   */
  private auditTalkerTurnEnd(event: CortexEvent): void {
    const message = (event.data as { message?: { stopReason?: unknown; content?: unknown } } | undefined)?.message;
    const truncated = message?.stopReason === 'length';
    const content = message?.content;
    const hasToolCall = Array.isArray(content) &&
      content.some((block) => (block as { type?: string } | null)?.type === 'toolCall');
    if (truncated && !hasToolCall) {
      if (!this.talkerRepairPending && this.talker) {
        this.talkerRepairPending = true;
        try {
          // The audit runs during the still-live run (turn_end fires while
          // the gate is held), so the run's cause tags are readable here
          // and ride the repair delivery as its causeTag. Without this the
          // repair turn carries an empty chain, and a user's "yes, go
          // ahead" into a turn that truncates would get consent refused by
          // D16 for a reason unrelated to consent. The FULL set travels
          // (as an array in the single causeTag slot; collectCauseTags
          // flattens it), never a collapsed seq, so mixed-kind causes stay
          // distinguishable in the repair run.
          const causeTags = collectCauseTags(this.talker.activeRunCauseTags);
          this.talker.deliver(TALKER_TRUNCATION_REPAIR_MESSAGE, {
            wake: true,
            ...(causeTags.length > 0 ? { causeTag: causeTags } : {}),
          });
        } catch (err) {
          this.logger.warn('truncation repair delivery failed', {
            error: errorMessageOf(err),
          });
        }
      }
      return;
    }
    this.talkerRepairPending = false;
  }

  /**
   * A reasoner run ended: if it never delivered a result through Deliver
   * (silent progress notes do not count) and its final assistant text is
   * user-facing, deliver that text as an implicit when_idle delivery so
   * results always surface (review-findings F1).
   */
  private handleReasonerRunEnd(event: CortexEvent): void {
    this.router?.noteReasonerRunEnd();
    const messages = (event.data as { messages?: unknown[] } | undefined)?.messages;
    if (!Array.isArray(messages)) return;
    let last: { stopReason?: unknown; content?: unknown; errorMessage?: unknown } | null = null;
    for (const message of messages) {
      if ((message as { role?: string } | null)?.role === 'assistant') {
        last = message as { stopReason?: unknown; content?: unknown; errorMessage?: unknown };
      }
    }
    if (!last) return;
    // Ahead of the delivered-result check: a run that reported one result
    // and was then stopped mid-way through more work was still stopped.
    if (last.stopReason === 'aborted') {
      this.handleReasonerStopped();
      return;
    }
    if (this.reasonerDeliveredResultThisRun) return;
    if (last.stopReason === 'error') {
      // Only when nothing else in the system is going to speak.
      //
      // pi emits agent_end for a FAILED run too, and on a retryable failure
      // that is attempt 1 of N. Announcing "it stopped with an error" here
      // contradicts the headline block, which correctly says "Retrying after
      // a network failure: attempt 1 of 3" at the same moment, and the
      // delivery is the louder of the two.
      //
      // The discriminator is the stub's own errorMessage. pi mirrors an
      // assistant message's errorMessage into state.errorMessage
      // (pi-agent-core agent.js:394), and the loop turns a recorded
      // state.errorMessage into a throw (agent-loop.ts runTurnWithRetry), so
      // a stub carrying one is guaranteed to reach the retry ladder and then
      // either onRetryExhausted or onError. Those own it, and they fire when
      // the ladder is DONE rather than per attempt.
      //
      // A stub with an error stop reason and NO errorMessage is the other
      // case: prompt() resolved, no throw, no ladder, no onError. This branch
      // is the only thing that can speak for it.
      if (last.errorMessage != null) return;
      this.deliverReasonerFailure(
        'The background work stopped with an error before producing a result. ' +
        'Tell the user plainly and offer to try again.',
      );
      return;
    }
    const spoken = spokenText(last);
    if (spoken.length === 0) return;
    this.router?.deliverFromReasoner(spoken, 'when_idle', { implicit: true });
  }

  /**
   * The reasoner's run was aborted. Reached from the run end (a run pi ended
   * as aborted) and from onError (an abort that surfaced as a cancelled
   * failure, including one landing in retry backoff, which produces no run
   * end at all), so everything here is idempotent per run.
   *
   * The work the run served is no longer in progress whoever stopped it, so
   * its delegations retire; before this they stayed listed as live until
   * the age-out, and the talker kept telling the user it was working. Only
   * a stop the user did not ask for is announced: a user abort or a cancel
   * was acknowledged when it was asked for, a budget stop was not.
   */
  private handleReasonerStopped(): void {
    if (this.destroyed || !this.router) return;
    this.router.retireRunDelegations();
    if (this.reasonerAbortCause !== null) return;
    // The aggregate breach announces itself once for the whole session
    // (handleAggregateBreach); a run it stops needs no second notice.
    if (this.aggregateGuard?.isBreached()) return;
    if (this.reasonerBudgetBreached()) {
      this.deliverReasonerFailure(
        'The background work was stopped because it reached its spending limit for this ' +
        'request. It produced no result. Tell the user plainly; it will not continue on its own.',
      );
    }
  }

  /** Whether a spending guard over the reasoner has tripped. */
  private reasonerBudgetBreached(): boolean {
    return this.reasoner.getBudgetGuard().isBreached() || this.aggregateGuard?.isBreached() === true;
  }

  /**
   * Surface a reasoner failure to the user, as an interrupt delivery.
   *
   * The fourth delivery producer, beside the Deliver tool, the implicit
   * final-text delivery, and the watchdog. The other three all describe work
   * that got somewhere; none of them fires on the path where a run dies, and
   * the watchdog stops the moment the run does, so before this a failed
   * reasoner was indistinguishable from a working one for as long as the
   * session lasted.
   *
   * Once per terminal failure. An exhausted ladder reaches here twice:
   * onRetryExhausted fires first, then emitError for the same failure, a few
   * statements later in the same synchronous unwind. The first wins because
   * its message is the better one ("gave up after N attempts").
   *
   * The guard is reset on `loop_start`, which is the correct unit ONLY
   * because nothing announces a failure mid-ladder any more: the run-end
   * branch defers a recorded stub to the error path, so the two calls above
   * are the only ones, and no run start falls between them. It is emphatically
   * not "once per logical turn" (pi emits agent_start per retry attempt, so a
   * turn spanning a ladder crosses several resets). Were a mid-ladder
   * announcement ever added back, this guard would not stop it repeating, and
   * the only thing standing behind it would be the router's content-hash
   * dedup, which has a time window the default backoff ladder outlives.
   */
  private deliverReasonerFailure(text: string): void {
    if (this.destroyed || !this.router) return;
    if (this.reasonerFailureAnnounced) return;
    this.reasonerFailureAnnounced = true;
    // interrupt: a user waiting on work that is never coming is exactly the
    // case the class exists for. The router may still demote it under
    // backpressure, which is the intended tradeoff. `terminal` marks it as a
    // conclusion despite being synthetic, so the delegation it answers stops
    // being listed as live work.
    this.router.deliverFromReasoner(text, 'interrupt', {
      synthetic: true,
      terminal: true,
    });
  }

  /**
   * Wire the reasoner's failure and retry signals into the talker's two
   * surfaces: the headline block (retrying is a different fact from working,
   * and the block could only say "working") and an interrupt delivery when
   * the ladder gives up or a fatal error lands.
   *
   * Reasoner-only. The talker's own failures are the consumer's to see
   * through onError; delivering them to the talker would ask a loop that
   * just failed to perform an update about itself.
   */
  private wireReasonerFailureSurfacing(headlines: DuplexHeadlines): void {
    this.reasoner.onRetryScheduled((info: RetryScheduledInfo) => {
      headlines.noteRetry({
        category: info.category,
        attempt: info.attempt,
        maxAttempts: info.maxAttempts,
      });
    });
    this.reasoner.onRetrySucceeded(() => {
      headlines.clearRetry();
    });
    this.reasoner.onRetryExhausted((info: RetryExhaustedInfo) => {
      headlines.clearRetry();
      this.deliverReasonerFailure(
        `The background work failed and has given up retrying (${info.category}, ` +
        `${info.attempts} attempts). It produced no result. Tell the user plainly ` +
        'and offer to try again.',
      );
    });
    this.reasoner.onError((error: ClassifiedError) => {
      // Only a failure that ended a reasoner TURN. emitError also serves the
      // direct and utility completion paths (an observation call failing,
      // say), which are not the user's work dying and must not be announced
      // as such. Inside a run the loop is still prompting here: the flag is
      // cleared in runPromptOnce's finally, well after this fires.
      if (!this.reasoner.isPrompting) return;

      // An abort is the user's own doing, already acknowledged on the
      // conversation surface. It also has to clear the retry line: an abort
      // during a backoff window produces neither a run start nor a run end,
      // and neither onRetrySucceeded nor onRetryExhausted, so nothing else
      // would ever take "Retrying, attempt 2 of 3" back down.
      // A breached budget guard is the reason the run died, whatever the
      // abort surfaced as (the abort comes from the guard, not the loop's
      // own controller, so it is not always classified as a cancellation).
      if (error.category === 'cancelled' || this.reasonerBudgetBreached()) {
        headlines.clearRetry();
        this.handleReasonerStopped();
        return;
      }

      // Everything else here is terminal by construction: the loop emits
      // onError from runTurnWithRetry only on the path where it has decided
      // NOT to retry, so reaching this point means the ladder is over (or
      // never ran). Severity picks the wording, not whether to speak: a
      // 'recoverable' classification that still ended the turn with no
      // result is exactly as silent to the user as a fatal one.
      const detail = clipFailureDetail(error.originalMessage);
      this.deliverReasonerFailure(
        error.severity === 'fatal'
          ? `The background work stopped with an error it cannot recover from: ${detail}. ` +
            'Tell the user plainly; it will not retry on its own.'
          : `The background work stopped and produced no result: ${detail}. ` +
            'Tell the user plainly and offer to try again.',
      );
    });
  }

  /**
   * A quick lookup settled. Non-cancelled outcomes (including timeouts and
   * failures, which must be visible) route through the router: durable
   * lookup_result entry, talker wake, reasoner delta. Cancelled lookups
   * were stopped on purpose (abort, restore, teardown): logged, never
   * delivered.
   */
  private handleLookupOutcome(outcome: QuickLookupOutcome): void {
    if (outcome.status === 'cancelled') {
      if (this.destroyed) return;
      this.appendEntry({
        type: 'lifecycle',
        loopPath: `lookup/${outcome.alias}`,
        content: `Quick lookup ${outcome.alias} cancelled`,
        data: {
          event: 'lookup_cancelled',
          alias: outcome.alias,
          question: outcome.question,
        },
        causedBy: outcome.causeSeq,
      });
      return;
    }
    this.router?.deliverLookupResult(outcome);
    this.markStateDirty();
  }

  /**
   * Aggregate budget breach: log once, then stop both loops and every
   * child. The lifetime guard keeps stopping anything that starts after
   * the breach, so later dispatches cannot leak spend.
   */
  private handleAggregateBreach(): void {
    if (this.destroyed) return;
    const firstBreach = !this.aggregateBreachLogged;
    if (!this.aggregateBreachLogged) {
      this.aggregateBreachLogged = true;
      this.appendEntry({
        type: 'lifecycle',
        loopPath: this.reasoner.loopPath,
        content: 'Aggregate budget limit breached; stopping work',
        data: {
          event: 'budget_breached',
          totalCost: this.aggregateGuard?.getTotalCost() ?? 0,
          maxCost: this.aggregateGuard?.getMaxCost() ?? 0,
        },
        causedBy: null,
      });
    }
    const swallow = (err: unknown): void => {
      this.logger.warn('budget-breach abort failed', {
        error: errorMessageOf(err),
      });
    };
    const stops: Array<Promise<unknown>> = [];
    if (this.talker) stops.push(this.talker.abort().catch(swallow));
    stops.push(this.reasoner.abort().catch(swallow));
    for (const taskId of this.reasoner.getSubAgentManager().getActiveTaskIds()) {
      stops.push(this.reasoner.cancelSubAgent(taskId).catch(swallow));
    }
    if (this.lookups) stops.push(this.lookups.cancelAll().catch(swallow));
    if (!firstBreach || !this.router) return;
    // Every piece of work is stopped, so none of it is live any more, and
    // the user has to be told why: nothing else will ever say it, and the
    // refusals that follow (workRefusal) only speak when the talker next
    // tries to delegate. Delivered once the aborts have unwound: the
    // talker's own abort would otherwise cancel the notice parked behind it.
    this.router.retireAllDelegations();
    void Promise.all(stops).then(() => {
      if (this.destroyed || !this.router) return;
      this.router.deliverFromReasoner(
        "The session's spending limit has been reached, so all background work was " +
        'stopped and no new work can start. Tell the user plainly.',
        'interrupt',
        { synthetic: true, terminal: true },
      );
    });
  }

  /**
   * Schedule deferred digestion (pending observation buffers, threshold
   * compaction) for a quiet moment. The talker runs a non-blocking
   * compaction posture, so this is where its blocking work happens; the
   * reasoner benefits opportunistically.
   */
  private scheduleIdleDigestion(): void {
    if (this.mode !== 'duplex' || this.destroyed) return;
    if (this.digestionTimer !== null) clearTimeout(this.digestionTimer);
    const timer = setTimeout(() => {
      this.digestionTimer = null;
      void this.runIdleDigestion();
    }, this.idleDigestionDelayMs);
    timer.unref?.();
    this.digestionTimer = timer;
  }

  private async runIdleDigestion(): Promise<void> {
    if (this.destroyed || !this.talker || !this.router) return;
    // Only when genuinely quiet; a digestion pass holds the loop gate, so a
    // busy moment skips and the next run completion reschedules.
    if (!this.conversationIdle || this.router.pendingDeliveryCount > 0) return;
    // The quiet moment can end at any time. Input arriving mid-pass aborts
    // this, and the pass releases the gate at once instead of making the
    // user's next words wait out observer catch-up and forced compaction
    // (up to two full utility timeouts per loop).
    const preempt = new AbortController();
    this.digestionPreempt = preempt;
    try {
      try {
        if (!this.talker.isLoopActive) await this.talker.digestIdle({ signal: preempt.signal });
      } catch (err) {
        this.logger.warn('talker idle digestion failed', {
          error: errorMessageOf(err),
        });
      }
      if (this.destroyed || preempt.signal.aborted) return;
      try {
        if (!this.reasoner.isLoopActive && this.reasoner.getSubAgentManager().activeCount === 0) {
          await this.reasoner.digestIdle({ signal: preempt.signal });
        }
      } catch (err) {
        this.logger.warn('reasoner idle digestion failed', {
          error: errorMessageOf(err),
        });
      }
    } finally {
      if (this.digestionPreempt === preempt) this.digestionPreempt = null;
    }
  }

  /**
   * Input is arriving for a loop: stop any idle digestion pass holding a
   * gate. Called on every path that hands wake content to either loop, so
   * nothing a user or the other loop is waiting on sits behind background
   * compaction. The next quiet moment reschedules digestion.
   */
  private preemptIdleDigestion(): void {
    if (!this.digestionPreempt) return;
    this.digestionPreempt.abort();
    this.digestionPreempt = null;
  }

  // -------------------------------------------------------------------------
  // Log producers
  // -------------------------------------------------------------------------

  /**
   * Register the facade's own handlers on the reasoner (passthrough). All
   * registrations are additive (the loop keeps handler arrays), so
   * consumer handlers and their signatures are untouched; passthrough
   * parity holds.
   */
  private wireLogProducers(): void {
    this.reasoner.onTurnComplete((output: AgentTextOutput, origin: LoopOriginContext) => {
      if (output.userFacing.trim().length === 0) return;
      this.appendEntry({
        type: 'reply',
        loopPath: origin.loopPath,
        content: output.userFacing,
      });
    });
    this.wireErrorProducers(this.reasoner);
    this.wireWorkLoopProducers();
  }

  /** Error and retry log producers for one loop (both loops in duplex). */
  private wireErrorProducers(loop: AgentLoop): void {
    loop.onError((error: ClassifiedError, origin: LoopOriginContext) => {
      this.appendEntry({
        type: 'error',
        loopPath: origin.loopPath,
        content: error.originalMessage,
        data: {
          category: error.category,
          severity: error.severity,
          ...(error.causeDetail !== undefined ? { causeDetail: error.causeDetail } : {}),
        },
      });
    });

    loop.onRetryScheduled((info: RetryScheduledInfo) => {
      this.appendEntry({
        type: 'retrying',
        loopPath: loop.loopPath,
        content: info.originalMessage,
        data: {
          category: info.category,
          attempt: info.attempt,
          maxAttempts: info.maxAttempts,
          delayMs: info.delayMs,
          nextAttemptAt: info.nextAttemptAt,
        },
      });
    });
  }

  /** Sub-agent lifecycle and dead-letter producers (the work surface). */
  private wireWorkLoopProducers(): void {
    this.reasoner.onSubAgentSpawned((taskId, instructions, background) => {
      const entry = this.appendEntry({
        type: 'lifecycle',
        loopPath: this.reasoner.loopPath,
        content: `Sub-agent ${taskId} spawned`,
        data: {
          event: 'sub_agent_spawned',
          taskId,
          background,
          instructions,
        },
      });
      this.spawnSeqByTaskId.set(taskId, entry.seq);
    });

    this.reasoner.onSubAgentCompleted((taskId, _result, status) => {
      const spawnSeq = this.spawnSeqByTaskId.get(taskId);
      this.spawnSeqByTaskId.delete(taskId);
      this.appendEntry({
        type: 'lifecycle',
        loopPath: this.reasoner.loopPath,
        content: `Sub-agent ${taskId} ${status}`,
        data: { event: 'sub_agent_completed', taskId, status },
        ...(spawnSeq !== undefined ? { causedBy: spawnSeq } : {}),
      });
    });

    this.reasoner.onSubAgentFailed((taskId, error) => {
      const spawnSeq = this.spawnSeqByTaskId.get(taskId);
      this.spawnSeqByTaskId.delete(taskId);
      // SubAgentManager.cancel fires the loop's onSubAgentFailed hook with
      // 'Cancelled' (the consumer callback contract keeps that shape), but
      // the log is the durable record the duplex router reads, and
      // log-and-context.md lists cancellations as their own milestone, not
      // failures. The manager marks the ID cancelled before any hook fires,
      // so this discriminator is reliable, unlike matching the error text.
      const manager = this.reasoner.getSubAgentManager();
      if (manager.isCancelled(taskId)) {
        this.appendEntry({
          type: 'lifecycle',
          loopPath: this.reasoner.loopPath,
          content: `Sub-agent ${taskId} cancelled`,
          // reason distinguishes an explicit cancel from a shutdown
          // teardown; 2b's delivery router keys on it.
          data: {
            event: 'sub_agent_cancelled',
            taskId,
            reason: manager.cancellationReason(taskId),
          },
          ...(spawnSeq !== undefined ? { causedBy: spawnSeq } : {}),
        });
        return;
      }
      this.appendEntry({
        type: 'lifecycle',
        loopPath: this.reasoner.loopPath,
        content: `Sub-agent ${taskId} failed: ${error}`,
        data: { event: 'sub_agent_failed', taskId, error },
        ...(spawnSeq !== undefined ? { causedBy: spawnSeq } : {}),
      });
    });

    this.wireDeadLetterProducer(this.reasoner);
  }

  /**
   * Dead-letter log producer for one loop. Background-completion drops
   * come from the reasoner; wake-delivery drops can come from either
   * resident loop (duplex wires the talker too), and without a lifecycle
   * entry for those the session log would show a user utterance with no
   * reply and nothing saying why.
   */
  private wireDeadLetterProducer(loop: AgentLoop): void {
    loop.onBackgroundResultDeadLettered((result: DeadLetteredBackgroundResult) => {
      this.appendEntry({
        type: 'lifecycle',
        loopPath: loop.loopPath,
        content: result.kind === 'wake_delivery'
          ? (result.attempts > 0
              ? `Wake delivery dropped after ${result.attempts} failed carrying runs`
              : `Wake delivery dropped: ${result.lastError}`)
          : `Background ${result.kind} ${result.taskId} delivery dead-lettered after ${result.attempts} attempts`,
        data: {
          event: 'delivery_dead_lettered',
          kind: result.kind,
          taskId: result.taskId,
          attempts: result.attempts,
          lastError: result.lastError,
          // The FULL destroyed content, not a preview: in duplex the router
          // owns delivery and the session log is the durable record of
          // undelivered content, so a truncated copy here would make the
          // in-memory dead-letter store (which does not survive the
          // process) the only complete record.
          ...(result.kind === 'wake_delivery' ? { message: result.message } : {}),
        },
      });
      // A destroyed wake delivery on the conversation surface may be a
      // permission voicing, in which case the user never heard the request
      // the broker still counts as read out. The broker withdraws its
      // consent anchor and reads it again (D16 anchor rules).
      if (result.kind === 'wake_delivery' && loop === this.talker) {
        this.router?.permissionBroker.noteDeliveryDestroyed(result.message);
      }
    });
  }

  /**
   * Record loop-queued content (silent deliveries, parked wake content, in
   * queue order as clearAllQueues returns it) destroyed by a facade abort
   * or restore. Without this the dropped content is unrecoverable AND
   * unrecorded: clearAllQueues returns it for re-routing and the facade is
   * the only caller in a position to preserve it (the loop-level abort
   * dead-letter path never sees content the facade already cleared).
   */
  private recordDroppedQueueContent(
    loop: AgentLoop,
    reason: 'abort' | 'restore',
    dropped: string[],
  ): void {
    if (dropped.length === 0) return;
    this.appendEntry({
      type: 'lifecycle',
      loopPath: loop.loopPath,
      content: `${dropped.length} queued item(s) dropped by ${reason}`,
      data: { event: 'queued_content_dropped', reason, items: dropped },
      causedBy: null,
    });
  }

  /**
   * History can change without a log entry (compaction rewrites,
   * observation activation trims, a run completing); these mark the
   * composite state dirty so onStateChanged fires for them too. Log
   * appends mark it in appendEntry.
   */
  private wireStateTriggers(): void {
    for (const loop of this.talker ? [this.reasoner, this.talker] : [this.reasoner]) {
      loop.onLoopComplete(() => this.markStateDirty());
      loop.onPostCompaction(() => this.markStateDirty());
      loop.onObservation(() => this.markStateDirty());
      loop.onReflection(() => this.markStateDirty());
    }
  }

  /**
   * Append a log entry, stamping causation from the live facade-initiated
   * run unless the caller supplies (or suppresses, with null) its own. In
   * duplex the fallback follows the producing surface: work-loop entries
   * default to the live dispatch's directive seq, everything else to the
   * live conversation run's utterance seq.
   */
  private appendEntry(input: {
    type: SessionLogEntry['type'];
    loopPath: string;
    content: string;
    causedBy?: number | null;
    wake?: WakeClass;
    data?: Record<string, unknown>;
  }): SessionLogEntry {
    const fallback = this.defaultCauseSeqFor(input.loopPath);
    const causedBy = input.causedBy === null
      ? undefined
      : input.causedBy ?? fallback ?? undefined;
    const entry = this.log.append({
      type: input.type,
      loopPath: input.loopPath,
      content: input.content,
      ...(causedBy !== undefined ? { causedBy } : {}),
      ...(input.wake !== undefined ? { wake: input.wake } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    });
    this.markStateDirty();
    if (this.logAppendWaiters.length > 0) {
      for (const resolve of this.logAppendWaiters.splice(0)) resolve();
    }
    return entry;
  }

  /**
   * Resolve on the next log append. The settlement wait uses this as the
   * event signal for broker-minted asks, which have no registry of their
   * own to wake it: every path that settles one appends its entry first, so
   * an append is guaranteed before the blocked resolver resumes. Deliberately
   * not a general "something happened" surface; it exists so
   * {@link waitForWorkSettled} never has to spin.
   */
  private waitForLogAppend(): Promise<void> {
    return new Promise((resolve) => this.logAppendWaiters.push(resolve));
  }

  /**
   * Which live-run causation track a producer's entries default to. Duplex
   * reads the producing loop's live-run cause tags (bound to the run inside
   * the loop, so parked content keeps its stamp through the sweep);
   * passthrough keeps the facade-field stamp around its serialized prompt.
   */
  private defaultCauseSeqFor(loopPath: string): number | null {
    if (this.talker) {
      if (loopPath !== this.talker.loopPath) {
        return latestCauseSeq(this.reasoner.activeRunCauseTags);
      }
      return latestCauseSeq(this.talker.activeRunCauseTags);
    }
    return this.activeCauseSeq;
  }

  /** Spill retention-evicted entries through persistResult when configured. */
  private spillEvictedEntries(evicted: SessionLogEntry[], config: ResolvedCortexAgentConfig): void {
    const persist = config.persistResult;
    if (!persist) return;
    const payload = evicted.map((entry) => JSON.stringify(entry)).join('\n');
    void persist(payload, {
      toolName: '_session_log',
      category: 'non-reproducible',
      loopPath: this.reasoner.loopPath,
    }).catch((err: unknown) => {
      this.logger.warn('session log spill failed', {
        error: errorMessageOf(err),
        entries: evicted.length,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Interaction surface
  // -------------------------------------------------------------------------

  /**
   * Mirror AgentLoop.prompt()'s synchronous validation (teardown state and
   * a configured system prompt) before anything is logged or queued, so the
   * log never records an utterance for input the loop rejects. The loop
   * performs the same checks itself; hoisting them keeps phantom entries
   * out of the log, exactly as deliver() validates at the point of misuse.
   */
  private assertPromptable(action: 'prompt' | 'deliver'): void {
    this.assertNotDestroyed();
    const loopState = this.conversationLoop.state;
    if (loopState === 'destroying') {
      throw new Error('Agent is being destroyed');
    }
    if (loopState === 'destroyed') {
      throw new Error('Agent has been destroyed');
    }
    if (this.conversationLoop.getCurrentSystemPrompt().trim().length === 0) {
      throw new Error(
        `CortexAgent prompt is not configured. Call setBasePrompt() before ${action}(), ` +
        'or provide initialBasePrompt during creation.',
      );
    }
  }

  /**
   * Prompt the agent. Routes to the reasoner (passthrough) or the talker
   * (duplex). Never throws on a busy loop. In passthrough, concurrent
   * calls are serialized by the facade, each resolving against the turn
   * that carries its input; the utterance is appended to the log when its
   * run starts (append-then-emit still holds: the entry lands before any
   * event of the run), so log order always matches execution order even
   * when a deliver() issued in the same tick starts its run ahead of a
   * queued prompt(). In duplex the input goes through the talker's
   * deliver() (barge-in is the conversation's core event, so a held gate
   * parks rather than queues behind the turn), and a parked input resolves
   * when the talker next quiesces, which is after the run that carried it.
   */
  async prompt(input: string, options?: DirectCompletionOptions): Promise<unknown> {
    this.assertPromptable('prompt');
    if (this.mode === 'duplex') {
      return this.promptDuplex(input, options);
    }
    this.noteUnwiredNetworkResolver();

    this.pendingFacadePrompts += 1;
    const run = this.promptChain.then(async () => {
      // Wait for gate quiescence, then act in the SAME frame: between the
      // idle wait resolving and this continuation running, an unrelated
      // continuation (e.g. a background-completion drain) can seize the
      // gate, and AgentLoop.prompt() fails fast on a held gate. The
      // synchronous isLoopActive re-check closes that window exactly.
      for (;;) {
        await this.reasoner.waitForLoopIdle();
        if (this.reasoner.isLoopActive) continue;
        // Re-validate at run start: a teardown that landed while this call
        // was queued must reject it before the utterance is logged.
        this.assertPromptable('prompt');
        // Logged here rather than at call time: the log is the ordering
        // authority, and content that reached the loop first (a same-tick
        // deliver()) must hold the lower seq.
        const entry = this.appendEntry({
          type: 'utterance',
          loopPath: this.reasoner.loopPath,
          content: input,
          causedBy: null,
        });
        this.activeCauseSeq = entry.seq;
        try {
          return await this.reasoner.prompt(input, options);
        } finally {
          if (this.activeCauseSeq === entry.seq) {
            this.activeCauseSeq = null;
          }
        }
      }
    });
    const settle = (): void => {
      this.pendingFacadePrompts -= 1;
      this.notifyPromptSettled();
    };
    this.promptChain = run.then(settle, settle);
    return run;
  }

  /** Duplex prompt path: talker deliver(), never talker prompt() (F15). */
  private async promptDuplex(input: string, options?: DirectCompletionOptions): Promise<unknown> {
    const talker = this.talker!;
    this.noteUnwiredNetworkResolver();
    this.preemptIdleDigestion();
    this.pendingFacadePrompts += 1;
    try {
      const entry = this.appendEntry({
        type: 'utterance',
        loopPath: talker.loopPath,
        content: input,
        causedBy: null,
      });
      // The user's own words reach the reasoner with the next dispatch
      // (D18). The exchange rollover for the delegation caps and dispatch
      // dedup happens when a talker run consumes this utterance (the
      // router reads its cause tag off the run), not here at arrival: a
      // barge-in arriving mid-batch must not reset state under the batch
      // still running.
      this.router!.noteUserUtterance(input);
      // The utterance travels with the content as a discriminated cause tag
      // (kind + seq): the run that consumes the input (the turn started
      // here, or the sweep run after a barge-in parks) exposes it through
      // activeRunCauseTags, which is where the router reads directive
      // causation and where D16's consent check will look for a qualifying
      // user utterance among mixed-kind causes (B1/D16).
      const result = talker.deliver(input, {
        wake: true,
        causeTag: { kind: 'utterance', seq: entry.seq } satisfies CauseTag,
        ...(options ? { promptOptions: options } : {}),
      });
      // The user is back, so a request an abort silenced is read out again,
      // behind this input rather than ahead of it.
      this.reopenHeldAskVoicing();
      if (result.outcome === 'prompted' && result.turn) {
        return await result.turn;
      }
      // Parked (barge-in): the input rides the talker's next run. Resolve
      // at the next gate quiescence, which is after that run.
      for (;;) {
        await talker.waitForLoopIdle();
        if (!talker.isLoopActive) return undefined;
      }
    } finally {
      this.pendingFacadePrompts -= 1;
      this.notifyPromptSettled();
    }
  }

  private notifyPromptSettled(): void {
    if (this.pendingFacadePrompts > 0 || this.promptSettlers.length === 0) return;
    const waiters = this.promptSettlers.splice(0);
    for (const resolve of waiters) resolve();
  }

  /** Resolves once no facade prompt is queued or running. */
  private waitForPromptSettled(): Promise<void> {
    if (this.pendingFacadePrompts === 0) return Promise.resolve();
    return new Promise((resolve) => this.promptSettlers.push(resolve));
  }

  /**
   * Fire-and-forget input, with the same non-throwing guarantee as
   * prompt(): the loop's own deliver() state machine decides whether the
   * content starts a turn now ('prompted'), opens the next run ('parked'),
   * or waits silently for the next real prompt ('queued').
   *
   * In duplex, delivered content is fenced in an `<external-update>`
   * wrapper on BOTH surfaces before it reaches a loop, the same way
   * reasoner deliveries and lookup results are fenced: content DELIVERED is
   * content about something. Consumers relay third-party text here, so the
   * fence is what keeps an email body out of a loop's instruction lane. On
   * the work surface the fence sits inside the dispatch, so the directive
   * framing is unchanged and the reasoner is still told to act on the
   * content. The session log keeps the unwrapped content on both paths.
   *
   * The one exception is `speaker: 'user'` on the conversation surface: that
   * is the consumer relaying actual human speech (an ASR transcript), which
   * is prompt()'s trust class, and it arrives bare like prompt() does. See
   * the fencing note at that branch.
   */
  deliver(content: string, options?: CortexDeliverOptions): DeliverResult {
    // Mirror AgentLoop.deliver's synchronous validation before appending,
    // so the log never records an utterance the loop rejected.
    this.assertPromptable('deliver');
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('deliver() requires non-whitespace string content');
    }
    if (this.mode === 'duplex') {
      return this.deliverDuplex(content, options);
    }
    const entry = this.appendEntry({
      type: 'utterance',
      loopPath: this.reasoner.loopPath,
      content,
      causedBy: null,
      ...(options?.target !== undefined ? { data: { target: options.target } } : {}),
    });

    const result = this.reasoner.deliver(
      content,
      options?.wake !== undefined ? { wake: options.wake } : undefined,
    );
    if (result.outcome === 'prompted' && result.turn) {
      // Bind causation for the run this delivery started. Parked and
      // queued deliveries have no bindable run in passthrough (the sweep
      // batches them); their runs' entries carry no stamp.
      this.activeCauseSeq = entry.seq;
      const clear = (): void => {
        if (this.activeCauseSeq === entry.seq) {
          this.activeCauseSeq = null;
        }
      };
      void result.turn.then(clear, clear);
    }
    return result;
  }

  /**
   * Duplex deliver: 'conversation' (default) reaches the talker,
   * 'work' reaches the reasoner as a dispatch. A no-wake work delivery is
   * context only: it joins the conversation-delta buffer and rides the
   * next dispatch rather than starting a reasoner turn (D18).
   */
  private deliverDuplex(content: string, options?: CortexDeliverOptions): DeliverResult {
    const target = options?.target ?? 'conversation';
    const router = this.router!;
    if (options?.wake !== false) this.preemptIdleDigestion();
    // Only an explicit 'user' speaker mints the consent-qualifying kind.
    // The default is 'system' so that a consumer notification can never
    // stand in for the user answering a permission ask (D16); prompt() is
    // unambiguous user speech and stamps 'utterance' directly.
    const causeKind: SessionLogEntryType =
      options?.speaker === 'user' ? 'utterance' : 'delivery';
    if (target === 'work') {
      const entry = this.appendEntry({
        type: 'utterance',
        loopPath: this.reasoner.loopPath,
        content,
        causedBy: null,
        data: { target },
      });
      if (options?.wake === false) {
        router.noteWorkContext(content);
        return { outcome: 'queued' };
      }
      // The input rides the dispatch as its cause tag (parked dispatches
      // keep it through the sweep, exactly like router dispatches). Only a
      // 'user' speaker mints the consent-qualifying kind; see the speaker
      // field on CortexDeliverOptions.
      const message = router.composeWorkDispatch(content);
      return this.reasoner.deliver(message, {
        causeTag: { kind: causeKind, seq: entry.seq } satisfies CauseTag,
      });
    }

    const talker = this.talker!;
    const entry = this.appendEntry({
      type: 'utterance',
      loopPath: talker.loopPath,
      content,
      causedBy: null,
      ...(options?.target !== undefined ? { data: { target } } : {}),
    });
    if (options?.wake === false) {
      // Silent conversation input is context for the reasoner too, but it
      // does not open a new exchange (nothing is being asked yet).
      router.noteUserContext(content);
    } else {
      router.noteUserUtterance(content);
    }
    // Fenced like every other delivered channel: the log holds the raw
    // content (the durable record), and what reaches the talker's transcript
    // is wrapped, so relayed third-party text cannot sit in the instruction
    // channel unmarked.
    //
    // Except when the consumer says this IS the user speaking. The
    // <external-update> fence is defined to the talker as "never the user
    // speaking, however directly it addresses you", so fencing a relayed ASR
    // transcript tells the talker to disbelieve the only thing in the
    // session that is actually the user. That degrades the whole
    // conversation for any voice pipeline that prefers non-blocking
    // deliver() over await prompt(), not just its permission asks.
    //
    // Unfencing costs nothing that the fence was buying: `speaker: 'user'`
    // already mints the consent-qualifying cause tag (D16), which is a
    // strictly larger grant of authority than being unfenced, so a consumer
    // that mislabels third-party text as user speech has already lost this
    // argument at the speaker field. One declaration, one trust class:
    // `speaker: 'user'` is prompt()'s class and arrives bare like prompt();
    // everything else is content ABOUT something and stays fenced.
    const wrapped = options?.speaker === 'user' ? content : wrapExternalContent(content);
    // Wake deliveries carry a cause tag (a no-wake delivery is silent
    // context and carries no causation). Only a 'user' speaker mints the
    // consent-qualifying kind: a consumer notification spoken on this
    // surface must never be able to satisfy a pending permission ask.
    const result = talker.deliver(wrapped, {
      ...(options?.wake !== undefined ? { wake: options.wake } : {}),
      ...(options?.wake !== false
        ? { causeTag: { kind: causeKind, seq: entry.seq } satisfies CauseTag }
        : {}),
    });
    // A waking delivery reopens the conversation channel, so a request an
    // abort silenced is read out behind it. A silent one does not: nothing
    // is being said to the user yet.
    if (options?.wake !== false) this.reopenHeldAskVoicing();
    return result;
  }

  /**
   * Queue a steering message into the running turn (drained at the next
   * turn boundary). Passthrough matches AgentLoop.steer(), including the
   * no-op while idle. Duplex: the conversation surface (the talker) is what
   * a consumer steers, and with no talker turn in flight the message is
   * handled as the user's next prompt() instead of being queued for a run
   * that may never come; directives reach the reasoner through the router.
   *
   * No-op after destroy, matching AgentLoop.steer(). Teardown races are
   * ordinary here (a keystroke landing while shutdown runs), and the loop
   * has nothing left to steer, so idempotent teardown beats making every
   * consumer guard the call.
   */
  steer(message: string): void {
    if (this.destroyed) return;
    if (this.talker && !this.talker.isPrompting) {
      // Duplex, with no talker turn in flight: the gate can still be held
      // (idle digestion, an end-of-run drain), so the loop would accept the
      // steer into pi's queue with no run to read it, where it waits for
      // whatever run starts next and is never logged. A consumer steers
      // precisely when it believes the conversation is busy, so this is the
      // user's next utterance: route it as one, logged, preempting the
      // digestion, and opening (or joining) the next talker run.
      void this.prompt(message).catch((err: unknown) => {
        this.logger.warn('steer delivered as a prompt failed', {
          error: errorMessageOf(err),
        });
      });
      return;
    }
    this.conversationLoop.steer(message);
  }

  /**
   * Abort per facade-api.md scope semantics. In passthrough the single
   * reasoner is both the conversation surface and the work surface, so
   * every scope aborts its in-flight turn and clears queued deliveries and
   * pi's steering/follow-up queues; 'work' and 'all' additionally cancel
   * running sub-agents. Pending asks resolve as deny through the abort
   * race. Completed-but-undelivered background results follow today's loop
   * behavior (delivered by a later drain); routing them to the log instead
   * is duplex delivery routing (2b).
   *
   * No-op after destroy (and once teardown has begun), matching
   * AgentLoop.abort(). Consumers wire abort to Ctrl+C and Escape
   * fire-and-forget, so a throw here lands as an unhandled rejection during
   * shutdown rather than anywhere a catch could see it; destroy() has
   * already aborted every loop, so there is nothing left to stop.
   */
  async abort(scope: CortexAbortScope = 'all'): Promise<void> {
    if (this.destroyed) return;
    this.appendEntry({
      type: 'lifecycle',
      loopPath: scope === 'conversation' ? this.conversationLoop.loopPath : this.reasoner.loopPath,
      content: `Abort requested (scope: ${scope})`,
      data: { event: 'abort', scope },
      causedBy: null,
    });

    if (this.mode === 'duplex') {
      // Per the facade-api.md abort table: each scope aborts its loop's
      // in-flight turn, drops queued deliveries to that target, and clears
      // its pi queues; router-held deliveries are dropped but stay in the
      // log (retained, not delivered). Pending asks resolve as deny
      // through the abort race on the aborted loop.
      const work: Array<Promise<unknown>> = [];
      if (scope === 'conversation' || scope === 'all') {
        this.router!.dropPendingDeliveries();
        this.recordDroppedQueueContent(this.talker!, 'abort', this.talker!.clearAllQueues());
        // Everything parked is gone, voicings included.
        this.trackedAskVoicings.clear();
        work.push(this.talker!.abort());
        // Quick lookups belong to the conversation surface (abort table):
        // cancelled here, untouched by a 'work' abort.
        if (this.lookups) work.push(this.lookups.cancelAll());
      }
      if (scope === 'work' || scope === 'all') {
        this.router!.dropWorkContext();
        // Held deliveries are results of the work being stopped: per the
        // abort table they are retained in the log, not delivered, for
        // every scope. Without this a completed-but-undelivered when_idle
        // result from the stopped work would degrade and still be voiced.
        this.router!.dropPendingDeliveries();
        this.recordDroppedQueueContent(this.reasoner, 'abort', this.reasoner.clearAllQueues());
        this.reasonerAbortCause = 'user';
        work.push(this.reasoner.abort());
        for (const taskId of this.reasoner.getSubAgentManager().getActiveTaskIds()) {
          work.push(this.reasoner.cancelSubAgent(taskId));
        }
        // All work is stopped, parked dispatches included, so no task may
        // go on being described as in progress. The user asked for this
        // and it was acknowledged on the conversation surface: retired
        // quietly, never announced back.
        this.router!.retireAllDelegations();
        // Pending asks belong to the stopped work and settle as deny: tool
        // asks through each aborted run's own signal race, network asks
        // (which carry no signal) here. Double settlement is guarded.
        this.router!.permissionBroker.settleAll('abort');
        // Settling an ask kills the request; it does not kill the voicing
        // that was already handed to the talker. A voicing parked behind a
        // busy talker outlives its ask, gets read out afterwards, and the
        // user's answer then lands in an empty registry and is told there
        // is nothing pending. Retract the voicings with their asks.
        this.dropMootAskVoicings('abort');
      }
      try {
        await Promise.all(work);
      } finally {
        if (this.reasonerAbortCause === 'user') this.reasonerAbortCause = null;
      }
      if (scope === 'conversation') {
        this.holdVoicingForReopen();
      }
      return;
    }

    // Dropped queued content: silent deliveries, parked wake deliveries
    // (abort() drops those itself too), and pi's steering/follow-up queues.
    this.recordDroppedQueueContent(this.reasoner, 'abort', this.reasoner.clearAllQueues());

    const work: Array<Promise<unknown>> = [this.reasoner.abort()];
    if (scope !== 'conversation') {
      for (const taskId of this.reasoner.getSubAgentManager().getActiveTaskIds()) {
        work.push(this.reasoner.cancelSubAgent(taskId));
      }
    }
    await Promise.all(work);
  }

  /**
   * Remember a voicing text so the facade can recognize it later among the
   * talker's parked deliveries. FIFO-bounded (Sets iterate insertion-order).
   */
  private trackAskVoicing(content: string): void {
    this.trackedAskVoicings.add(content);
    while (this.trackedAskVoicings.size > MAX_TRACKED_ASK_VOICINGS) {
      const oldest = this.trackedAskVoicings.values().next().value;
      if (oldest === undefined) break;
      this.trackedAskVoicings.delete(oldest);
    }
  }

  /**
   * Retract ask voicings still parked on the talker after their asks were
   * settled wholesale. Only the facade's own voicing texts are matched, so
   * a parked user utterance (and the cause tag that makes it able to grant
   * consent) is left exactly where it is.
   */
  private dropMootAskVoicings(reason: 'abort' | 'restore'): void {
    const talker = this.talker;
    if (!talker || this.trackedAskVoicings.size === 0) return;
    const dropped = talker.dropPendingWakeDeliveries(
      (content) => this.trackedAskVoicings.has(content),
    );
    // Every ask is gone, so every remembered voicing is moot whether or not
    // it was still parked.
    this.trackedAskVoicings.clear();
    if (dropped.length === 0) return;
    this.appendEntry({
      type: 'lifecycle',
      loopPath: talker.loopPath,
      content: `${dropped.length} permission voicing(s) dropped by ${reason}: their requests are settled`,
      data: { event: 'ask_voicing_dropped', reason, count: dropped.length },
      causedBy: null,
    });
  }

  /**
   * Conversation abort with a voiced ask still pending on live work.
   *
   * Two facts have to come apart here. The user never heard this request
   * (its voicing went with the talker's queues, or its read-out turn was
   * aborted mid-sentence), so the consent anchor must be withdrawn NOW:
   * left standing, the user's next words would satisfy D16's "an utterance
   * after the voicing" test for a request nobody read to them. But the user
   * just said stop, and following that with the agent immediately talking
   * again is the opposite of what they asked for.
   *
   * So the anchor is withdrawn and the read-out is not performed. Holding
   * the hand-off is what keeps those consistent: the broker's contract is
   * that a refused hand-off means nothing reached the user, which is
   * literally true, and it leaves the ask pending, silent and answerable
   * with no anchor. The request is read out again at the next conversation
   * opening ({@link reopenHeldAskVoicing}); until then it is still visible
   * in the headline block and still bounded by its own timeout.
   */
  private holdVoicingForReopen(): void {
    const broker = this.router?.permissionBroker;
    if (!broker) return;
    this.askVoicingHeld = true;
    let held: boolean;
    try {
      held = broker.noteVoicingLost();
    } finally {
      this.askVoicingHeld = false;
    }
    if (!held) return;
    this.deferredAskVoicing = true;
    this.appendEntry({
      type: 'lifecycle',
      loopPath: this.talker!.loopPath,
      content: 'Permission request held silent after a conversation abort; ' +
        'it will be read out again when the conversation reopens',
      data: { event: 'ask_voicing_deferred', reason: 'conversation_abort' },
      causedBy: null,
    });
  }

  /**
   * The conversation surface just received input, so the channel is open
   * again: read out any request {@link holdVoicingForReopen} silenced.
   * Called after the input is handed to the talker, so the voicing parks
   * behind that run and arrives carrying its ask cause tag, which is what
   * stops the same run from granting the request it is about to read.
   */
  private reopenHeldAskVoicing(): void {
    if (!this.deferredAskVoicing) return;
    this.deferredAskVoicing = false;
    // noteVoicingLost rather than revoiceCurrent: the anchor is already
    // withdrawn and this re-read must take a fresh one, and it must not be
    // swallowed by the re-voice damping window the abort just stamped.
    this.router?.permissionBroker.noteVoicingLost();
  }

  /** Tear down the facade and its loops. Idempotent; shares one teardown. */
  async destroy(timeoutMs?: number): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;
    if (this.stateTimer !== null) {
      clearTimeout(this.stateTimer);
      this.stateTimer = null;
    }
    if (this.digestionTimer !== null) {
      clearTimeout(this.digestionTimer);
      this.digestionTimer = null;
    }
    this.router?.destroy();
    this.aggregateGuard?.destroy();
    this.destroyPromise = (async () => {
      try {
        const teardowns: Array<Promise<void>> = [this.reasoner.destroy(timeoutMs)];
        if (this.talker) teardowns.push(this.talker.destroy(timeoutMs));
        if (this.lookups) teardowns.push(this.lookups.destroy());
        const results = await Promise.allSettled(teardowns);
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      } finally {
        // After the loops detach their listeners: the shared connections
        // (and stdio subprocesses) are facade-owned, so the loops never
        // close them.
        if (this.ownedMcpManager) {
          await this.ownedMcpManager.closeAll().catch(() => {});
        }
        try {
          await this.ownedSandbox?.dispose();
        } finally {
          this.mergedBridge?.destroy();
          this.log.clearSubscribers();
          // Nothing appends after teardown, so a settlement wait blocked on
          // the next append would never resume on its own.
          for (const resolve of this.logAppendWaiters.splice(0)) resolve();
        }
      }
    })();
    return this.destroyPromise;
  }

  /** Snapshot of the effective managed sandbox policy and enforcement. */
  getSandboxState(): SandboxState | undefined { return this.ownedSandbox?.getState(); }

  /** Host-only policy change. Work must settle before changing an OS boundary. */
  async setSandboxRung(rung: SandboxRung): Promise<void> {
    this.assertNotDestroyed();
    if (!this.ownedSandbox) throw new Error('No Cortex-managed sandbox was configured');
    if (!this.workSettled) throw new Error('Wait for work to settle before changing sandbox policy');
    if (this.getMcpClientManager().getConnectionStates().some((connection) =>
      connection.connected && connection.config.transport === 'stdio',
    )) throw new Error('Disconnect stdio MCP servers before changing sandbox policy, then reconnect them under the new policy');
    await this.ownedSandbox.setRung(rung);
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error('CortexAgent has been destroyed');
    }
  }

  // -------------------------------------------------------------------------
  // Resolution report
  // -------------------------------------------------------------------------

  /**
   * What this assembly resolved to, where that differs from what was asked
   * for: the talker silently on the primary model, a utilityModel the talker
   * could not take, an unwired egress resolver, an uncapped session
   * (resolution-report.ts for the full rationale).
   *
   * Present in both modes. Two of the conditions are not duplex-specific,
   * and a consumer should not have to branch on mode to ask "did I get what
   * I configured?"; passthrough simply earns fewer notes.
   *
   * A snapshot copy, so a consumer cannot mutate the record the log entries
   * were derived from. Readable after destroy() on purpose: the report is an
   * immutable statement about an assembly with no live resource behind it,
   * and "why was that session slow or expensive" is asked after the session,
   * not during it.
   */
  getResolutionReport(): ResolutionNote[] {
    return this.resolutionNotes.map(cloneResolutionNote);
  }

  /**
   * Read the assembly back and record what it resolved to. Eager rather than
   * lazy on first read: a report built on demand would observe post-assembly
   * mutation (a setModel(), a setUtilityModel()) and present it as an
   * assembly fact, and would also mean the log entries appeared whenever the
   * consumer happened to look.
   */
  private collectAssemblyResolution(): void {
    for (const note of this.currentResolutionNotes()) this.recordResolutionNote(note);
  }

  private currentResolutionNotes(): ResolutionNote[] {
    return collectAssemblyResolutionNotes({
      mode: this.mode,
      requestedTalkerModel: this.resolutionInputs.requestedTalkerModel,
      talkerModel: this.talker?.getModel() ?? null,
      reasonerModel: this.reasoner.getModel(),
      configuredUtilityModel: this.resolutionInputs.configuredUtilityModel,
      talkerUtilityModel: this.talker?.getUtilityModel() ?? null,
      aggregateCostCap: this.aggregateGuard?.getMaxCost() ?? null,
      perPromptMaxCost: this.resolutionInputs.perPromptMaxCost,
    });
  }

  /**
   * Re-evaluate the notes that describe the talker's model after the facade
   * re-resolved it (setModel re-mirrors an unpinned talker). This is not the
   * lazy report the eager design rules out: the facade itself just redid
   * part of the assembly, so the model notes are assembly facts again, and
   * leaving them would report a fallback that no longer exists or miss one
   * that now does (switching onto a provider Cortex cannot enumerate).
   * Mutation the facade did not make (a direct loop setModel) still changes
   * nothing here. A note that stops applying is removed from the report and
   * its clearing is logged, so the log still explains the report.
   */
  private refreshModelResolutionNotes(): void {
    const fresh = this.currentResolutionNotes()
      .filter((note) => MODEL_RESOLUTION_NOTE_CODES.has(note.code));
    for (const code of MODEL_RESOLUTION_NOTE_CODES) {
      const index = this.resolutionNotes.findIndex((note) => note.code === code);
      const current = index >= 0 ? this.resolutionNotes[index]! : null;
      const next = fresh.find((note) => note.code === code) ?? null;
      if (current && next && JSON.stringify(current) === JSON.stringify(next)) continue;
      if (current) {
        this.resolutionNotes.splice(index, 1);
        if (!next) {
          this.appendEntry({
            type: 'lifecycle',
            loopPath: RESOLUTION_LOOP_PATH,
            content: `Resolution note cleared: ${code}`,
            causedBy: null,
            data: { event: 'resolution_note_cleared', code },
          });
        }
      }
      if (next) this.recordResolutionNote(next);
    }
  }

  /**
   * The single write path for a note, and the reason the surfaces cannot
   * drift: the log line and the lifecycle entry are both built from the note
   * here, so there is no second place where the same fact is described.
   *
   * Every note warns regardless of severity. `info` is a classification for
   * the consumer's renderer, not a log level: the warn is the surface a
   * headless consumer has, and demoting the uncapped-session note to
   * `logger.info` would silently withdraw a warning consumers are
   * documented to receive.
   */
  private recordResolutionNote(note: ResolutionNote): void {
    this.resolutionNotes.push(cloneResolutionNote(note));
    this.logger.warn(resolutionWarnText(note));
    this.appendEntry({
      type: 'lifecycle',
      loopPath: RESOLUTION_LOOP_PATH,
      content: note.summary,
      // Assembly is nobody's turn: there is no causing entry to point at,
      // and the fallback stamp would attach it to whatever run happened to
      // be live when a late note landed.
      causedBy: null,
      data: { event: 'resolution_note', note: cloneResolutionNote(note) },
    });
  }

  // -------------------------------------------------------------------------
  // Session log surface
  // -------------------------------------------------------------------------

  /**
   * Snapshot copy (never a live reference) of log entries with
   * seq >= fromSeq (all retained entries when omitted).
   */
  getLog(fromSeq?: number): SessionLogEntry[] {
    this.assertNotDestroyed();
    return this.log.getLog(fromSeq);
  }

  /**
   * The same range as {@link getLog}, as an event sequence: retained entries
   * interleaved with a gap marker for every hole, in seq order.
   *
   * This is the hole-aware read, and the one a timeline should use.
   * `getLog()` returns entries and nothing else, so retention that evicted
   * churn from the middle or the end of the range is invisible in it. Built
   * by the same function that builds a subscription's replay, so a one-shot
   * read and a reconnecting subscriber can never disagree about where the
   * holes are.
   */
  getLogEvents(fromSeq?: number): SessionLogEvent[] {
    this.assertNotDestroyed();
    return this.log.getLogEvents(fromSeq);
  }

  /**
   * Subscribe to log events with replay from a seq, so a reconnecting UI
   * can ask for everything since it last saw. Slow subscribers are
   * buffered to a bound and then dropped with a gap marker rather than
   * applying backpressure to the loops. Returns an idempotent unsubscribe.
   */
  subscribeLog(cb: SessionLogSubscriber, fromSeq?: number): () => void {
    this.assertNotDestroyed();
    return this.log.subscribeLog(cb, fromSeq);
  }

  // -------------------------------------------------------------------------
  // Composite persistence (v2 artifact)
  // -------------------------------------------------------------------------

  /**
   * Capture the composite state at a consistent point: the log, histories,
   * observational states, and usage are all read in one synchronous frame
   * with the loop gate empty, never mid-run. Resolves once the current run
   * (and any queued gate work) finishes; under continuous activity that is
   * the next quiescence window.
   */
  async getState(): Promise<CortexAgentStateV2> {
    this.assertNotDestroyed();
    for (;;) {
      await this.reasoner.waitForLoopIdle();
      if (this.talker) await this.talker.waitForLoopIdle();
      if (!this.reasoner.isLoopActive && !(this.talker?.isLoopActive ?? false)) {
        return this.captureStateInFrame();
      }
    }
  }

  /** Synchronous composite snapshot; caller guarantees gate quiescence. */
  private captureStateInFrame(): CortexAgentStateV2 {
    const reasonerUsage = this.reasonerUsageWithBaseline();
    const talkerUsage = this.talkerUsageWithBaseline();
    const lookupUsage = this.lookupUsageWithBaseline();
    let total = reasonerUsage;
    if (talkerUsage) total = addSessionUsage(total, talkerUsage);
    if (lookupUsage) total = addSessionUsage(total, lookupUsage);
    return {
      version: 2,
      log: this.log.getLog(),
      // Duplex reads the live talker; passthrough carries a restored duplex
      // artifact's talker side through unchanged so nothing is lost on
      // round trip. Copied like getLog(): a persistence layer that
      // normalizes the snapshot in place must never mutate live facade
      // state.
      talkerHistory: this.talker
        ? this.talker.getConversationHistory()
        : structuredClone(this.retainedTalkerHistory),
      reasonerHistory: this.reasoner.getConversationHistory(),
      talkerMemory: this.talker
        ? this.talker.getObservationalMemoryState()
        : structuredClone(this.retainedTalkerMemory),
      reasonerMemory: this.reasoner.getObservationalMemoryState(),
      usage: {
        total,
        perLoop: {
          talker: talkerUsage,
          reasoner: reasonerUsage,
          ...(lookupUsage ? { lookups: lookupUsage } : {}),
        },
      },
      // Passthrough carries a restored duplex artifact's router state
      // through, like the talker side.
      ...(this.router
        ? { router: this.router.exportState() }
        : this.retainedRouterState ? { router: structuredClone(this.retainedRouterState) } : {}),
    };
  }

  /** Reasoner usage under the baseline-plus-delta model. */
  private reasonerUsageWithBaseline(): SessionUsage {
    const live = this.reasoner.getSessionUsage();
    if (!this.usageBaseline) return live;
    const delta = this.usageAtRestore ? diffSessionUsage(live, this.usageAtRestore) : live;
    return addSessionUsage(this.usageBaseline.reasoner, delta);
  }

  /**
   * Talker usage under the same model. Null only when no talker loop
   * exists and no restored baseline carries a talker side.
   */
  private talkerUsageWithBaseline(): SessionUsage | null {
    if (!this.talker) {
      return this.usageBaseline?.talker ? cloneSessionUsage(this.usageBaseline.talker) : null;
    }
    const live = this.talker.getSessionUsage();
    if (!this.usageBaseline) return live;
    const delta = this.talkerUsageAtRestore ? diffSessionUsage(live, this.talkerUsageAtRestore) : live;
    const baseline = this.usageBaseline.talker;
    return baseline ? addSessionUsage(baseline, delta) : delta;
  }

  /**
   * Quick-lookup spend under the same model. Null when nothing was ever
   * spent (the artifact omits an all-zero bucket rather than growing every
   * duplex snapshot).
   */
  private lookupUsageWithBaseline(): SessionUsage | null {
    const baseline = this.usageBaseline?.lookups ?? null;
    if (!this.lookups) {
      // Passthrough: carry a restored duplex artifact's lookup spend
      // through unchanged, like the retained talker side.
      return baseline ? cloneSessionUsage(baseline) : null;
    }
    const live = this.lookups.getSettledUsage();
    const delta = this.lookupUsageAtRestore ? diffSessionUsage(live, this.lookupUsageAtRestore) : live;
    const combined = baseline ? addSessionUsage(baseline, delta) : delta;
    return isZeroSessionUsage(combined) ? null : combined;
  }

  /**
   * Restore a persisted artifact: v2 composite, v1 single history, or a
   * bare message array (upgraded transparently). Rejected while any loop
   * is running: a restore under a live run would splice history out from
   * under pi's message mirror and desync the observation watermark.
   *
   * Per-loop restore ordering holds internally: history first, then
   * observational state (whose buffer watermark aligns to the post-slot
   * history length). Usage becomes the restored baseline; live counters
   * accumulate as deltas on top, so repeated restores are idempotent, not
   * additive.
   *
   * Async so every rejection is a rejection: the guards below are the
   * documented failure mode, and a synchronous throw next to the async
   * getState() means `await agent.restore(x).catch(...)` catches nothing.
   * The body still applies in one frame (there is no await inside it), so
   * the all-or-nothing property is unchanged.
   */
  async restore(state: CortexAgentPersistedState): Promise<void> {
    this.assertNotDestroyed();
    if (
      this.reasoner.isLoopActive ||
      (this.talker?.isLoopActive ?? false) ||
      this.pendingFacadePrompts > 0 ||
      this.reasoner.getSubAgentManager().activeCount > 0 ||
      (this.lookups?.activeCount ?? 0) > 0
    ) {
      throw new Error(
        'CortexAgent.restore() rejected: a loop is running. Await workSettled before restoring.',
      );
    }
    const v2 = normalizePersistedState(state);

    // Deep copies: the caller's artifact stays the caller's (a later
    // in-place mutation of it must never reach live facade state). Taken
    // before the first mutation below: structuredClone throws on proxies
    // and functions (a reactive-store artifact hands it exactly that), and
    // a clone failure must reject the restore with the facade untouched,
    // never half-applied.
    const talkerHistory = structuredClone(v2.talkerHistory);
    const talkerMemory = structuredClone(v2.talkerMemory);
    const routerState = v2.router ? structuredClone(v2.router) : undefined;

    // History before observational state (restore ordering), per loop.
    this.reasoner.restoreConversationHistory(v2.reasonerHistory);
    if (v2.reasonerMemory) {
      this.reasoner.restoreObservationalMemoryState(v2.reasonerMemory);
    }
    if (this.talker) {
      // Live talker hydration; the retained fields stay empty in duplex.
      this.talker.restoreConversationHistory(talkerHistory);
      if (talkerMemory) {
        this.talker.restoreObservationalMemoryState(talkerMemory);
      }
      this.retainedTalkerHistory = [];
      this.retainedTalkerMemory = null;
    } else {
      this.retainedTalkerHistory = talkerHistory;
      this.retainedTalkerMemory = talkerMemory;
    }
    this.log.restore(v2.log);

    this.usageBaseline = {
      talker: v2.usage.perLoop.talker ? cloneSessionUsage(v2.usage.perLoop.talker) : null,
      reasoner: cloneSessionUsage(v2.usage.perLoop.reasoner),
      lookups: v2.usage.perLoop.lookups ? cloneSessionUsage(v2.usage.perLoop.lookups) : null,
    };
    this.usageAtRestore = this.reasoner.getSessionUsage();
    this.talkerUsageAtRestore = this.talker ? this.talker.getSessionUsage() : null;
    this.lookupUsageAtRestore = this.lookups ? this.lookups.getSettledUsage() : null;
    this.spawnSeqByTaskId.clear();
    this.activeCauseSeq = null;
    // Pre-restore queued content belongs to the replaced session: left in
    // place, queued silent deliveries would flush into the first
    // post-restore prompt (and stale steer/follow-up content into its run).
    // What gets destroyed is recorded in the restored log, which is the
    // durable record of undelivered content from here on.
    this.recordDroppedQueueContent(this.reasoner, 'restore', this.reasoner.clearAllQueues());
    if (this.talker) {
      this.recordDroppedQueueContent(this.talker, 'restore', this.talker.clearAllQueues());
    }
    // Router state (delegations, deltas, held deliveries, dedup) describes
    // the replaced session too; what the artifact carries of it comes back.
    if (this.router) {
      this.router.resetForRestore();
      this.restoreRouterState(routerState);
    } else {
      this.retainedRouterState = routerState ?? null;
    }
    // The aggregate guard's counters describe the replaced session's spend;
    // without a reset a lifetime breach would keep aborting the restored
    // session forever and re-log a breach against a pre-restore total.
    this.aggregateGuard?.reset();
    this.aggregateBreachLogged = false;
    this.talkerRepairPending = false;
    // Voicings of the replaced session's asks: the queues that held them are
    // already cleared above, and resetForRestore settled the asks, so there
    // is nothing left for a deferred read-out to be about.
    this.trackedAskVoicings.clear();
    this.deferredAskVoicing = false;
  }

  /**
   * Re-apply the artifact's router state. Tasks that were still outstanding
   * lost the run serving them, so they are reported as interrupted instead
   * of left listed as live work: a lifecycle entry each, and one silent
   * note for the talker, which surfaces with the user's next turn rather
   * than waking the conversation on restore.
   */
  private restoreRouterState(state: DuplexRouterState | undefined): void {
    const router = this.router!;
    const interrupted = router.restoreState(state, highestTaskAliasInLog(this.log.getLog()));
    if (interrupted.length === 0) return;
    for (const delegation of interrupted) {
      this.appendEntry({
        type: 'lifecycle',
        loopPath: this.reasoner.loopPath,
        content: `Task ${delegation.alias} interrupted by the session restore`,
        data: { event: 'delegation_interrupted', alias: delegation.alias },
        causedBy: delegation.seq,
      });
    }
    const list = interrupted
      .map((delegation) => `${delegation.alias} (${delegation.instructions})`)
      .join(', ');
    router.deliverFromReasoner(
      `The session was restored. Background work that was in progress is no longer running: ${list}. ` +
      'If the user asks about it, say it was interrupted and offer to start it again.',
      'silent',
      { synthetic: true },
    );
  }

  /**
   * Debounced composite persistence trigger: fires with a consistent
   * getState() snapshot after state-changing activity (log appends, run
   * completions, compaction, observation) settles for stateChangeDebounceMs.
   * This replaces persisting on onLoopComplete, which is ambiguous once
   * multiple loops exist.
   */
  onStateChanged(handler: (state: CortexAgentStateV2) => void): void {
    this.stateChangedHandlers.push(handler);
    if (this.stateDirty) {
      this.scheduleStateEmit();
    }
  }

  private markStateDirty(): void {
    this.stateDirty = true;
    this.scheduleStateEmit();
  }

  private scheduleStateEmit(): void {
    if (this.destroyed || this.stateTimer !== null || this.emittingState) return;
    if (this.stateChangedHandlers.length === 0) return;
    if (this.isReasonerShuttingDown()) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      // No awaiter exists here: a getState() rejection escaping this timer
      // would be an unhandled rejection and, under Node's default
      // --unhandled-rejections=throw, kill the host process from a
      // debounce timer. Route it to the consumer's logger instead.
      this.emitStateChanged().catch((err: unknown) => {
        this.logger.error('onStateChanged snapshot failed', {
          error: errorMessageOf(err),
        });
      });
    }, this.stateDebounceMs);
  }

  /**
   * Whether a resident loop is tearing down without the facade knowing (a
   * direct AgentLoop.destroy()). Its final onLoopComplete checkpoint would
   * otherwise schedule a debounce timer that holds its handle for the full
   * window and then snapshots a torn-down loop.
   */
  private isReasonerShuttingDown(): boolean {
    const states = [this.reasoner.state, ...(this.talker ? [this.talker.state] : [])];
    return states.some((loopState) => loopState === 'destroying' || loopState === 'destroyed');
  }

  private async emitStateChanged(): Promise<void> {
    if (this.destroyed || this.stateChangedHandlers.length === 0) return;
    if (this.isReasonerShuttingDown()) return;
    this.emittingState = true;
    try {
      this.stateDirty = false;
      const state = await this.getState();
      if (this.destroyed) return;
      for (const handler of this.stateChangedHandlers) {
        try {
          handler(state);
        } catch (err) {
          this.logger.error('onStateChanged handler threw', {
            error: errorMessageOf(err),
          });
        }
      }
    } finally {
      this.emittingState = false;
      // Changes that landed while snapshotting get their own cycle.
      if (this.stateDirty) {
        this.scheduleStateEmit();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Settlement predicates
  // -------------------------------------------------------------------------

  /**
   * Whether the conversation surface is quiet: no facade prompt queued or
   * running and the conversation loop's gate empty. Built on gate depth,
   * not the prompting flag, which reads idle while gate tasks are queued.
   * In passthrough the conversation loop is the reasoner; in duplex (2b)
   * this keys on the talker.
   */
  get conversationIdle(): boolean {
    return this.pendingFacadePrompts === 0 && !this.conversationLoop.isLoopActive;
  }

  /**
   * Whether all work has settled: conversation idle, reasoner gate empty,
   * no active sub-agents or quick lookups, no parked wake deliveries on
   * either loop, no router-held deliveries, no pending permission asks.
   * Queued silent deliveries do not count: silent content deliberately
   * waits for the next prompt.
   *
   * The ask term reads the FACADE's merged registry, never the reasoner's
   * own. A broker-minted network ask (shell egress through the sandbox
   * callback, WebFetch) never enters a loop registry at all, so reading the
   * loop's would report settled with a resolver still blocked, which is the
   * one thing this predicate exists to rule out.
   */
  get workSettled(): boolean {
    return (
      this.conversationIdle &&
      !this.reasoner.isLoopActive &&
      this.reasoner.getSubAgentManager().activeCount === 0 &&
      (this.lookups?.activeCount ?? 0) === 0 &&
      this.reasoner.pendingWakeDeliveryCount === 0 &&
      (this.talker?.pendingWakeDeliveryCount ?? 0) === 0 &&
      (this.router?.pendingDeliveryCount ?? 0) === 0 &&
      this.getPendingAsks().length === 0
    );
  }

  /** Resolve once {@link conversationIdle} holds. */
  async waitForConversationIdle(): Promise<void> {
    for (;;) {
      if (this.pendingFacadePrompts > 0) {
        await this.waitForPromptSettled();
        continue;
      }
      await this.conversationLoop.waitForLoopIdle();
      if (this.conversationIdle) return;
    }
  }

  /**
   * Resolve once {@link workSettled} holds. Event-driven where a signal
   * exists (the loop gate, sub-agent completion promises); a single
   * macrotask yield between checks lets completion cascades (a finished
   * child scheduling its delivery drain) reach the gate before the final
   * verdict.
   */
  async waitForWorkSettled(): Promise<void> {
    for (;;) {
      if (this.pendingFacadePrompts > 0) {
        await this.waitForPromptSettled();
        continue;
      }
      await this.reasoner.waitForLoopIdle();
      if (this.talker) {
        await this.talker.waitForLoopIdle();
        if (this.router && this.router.pendingDeliveryCount > 0) {
          // Held wake deliveries start talker runs when they land; wait
          // event-driven on the router rather than spinning.
          await this.router.waitForDeliveriesSettled();
          continue;
        }
      }

      const manager = this.reasoner.getSubAgentManager();
      const activeIds = manager.getActiveTaskIds();
      if (activeIds.length > 0) {
        const completions = activeIds
          .map((taskId) => manager.get(taskId)?.completion)
          .filter((completion) => completion !== undefined);
        await Promise.all(completions);
        await yieldMacrotask();
        continue;
      }

      // Active quick lookups: their settlement enqueues router deliveries
      // and talker wakes, so loop back for a full re-check afterwards.
      if (this.lookups && this.lookups.activeCount > 0) {
        await this.lookups.waitForIdle();
        await yieldMacrotask();
        continue;
      }

      // Pending asks block on a settlement signal, never on a polling
      // yield: an ask can outlive the child that raised it, and a
      // setImmediate spin would otherwise run hot for as long as it stays
      // unanswered. Two registries, two signals. Loop asks have the loop's
      // own; broker-minted network asks have none, so they wait on the next
      // log append, which every broker settlement path (answer, timeout,
      // abort, drain) performs before resolving the blocked resolver.
      if (this.getPendingAsks().length > 0) {
        await (this.reasoner.getPendingAsks().length > 0
          ? this.reasoner.waitForAskSettlement()
          : this.waitForLogAppend());
        continue;
      }

      if (!this.workSettled) {
        await yieldMacrotask();
        continue;
      }
      // Confirm across one macrotask: a cascade between microtasks may
      // still be about to enqueue gate work for a just-settled child.
      await yieldMacrotask();
      if (this.workSettled) return;
    }
  }

  // -------------------------------------------------------------------------
  // Delegated surface (passthrough: the reasoner loop; labeled per loop in
  // duplex once 2b lands)
  // -------------------------------------------------------------------------

  /**
   * The merged event stream. In passthrough this is the reasoner's bridge
   * verbatim, so event identity and ordering match direct AgentLoop use
   * exactly. In duplex it is the facade's merged bridge: every event
   * carries its loop path in its own loopPath field ('talker', 'reasoner',
   * 'reasoner/task-7'), while childTaskId keeps meaning "this came from a
   * sub-agent" exactly as on a loop's own bridge.
   */
  getEventBridge(): EventBridge {
    return this.mergedBridge ?? this.reasoner.getEventBridge();
  }

  /**
   * The context manager. Passthrough returns the reasoner's manager
   * verbatim. Duplex returns a fan-out view (D6: mid-session slot writes
   * reach both loops so they never diverge; reads come from the reasoner;
   * no per-slot routing knob exists).
   */
  getContextManager(): ContextManager {
    if (this.talker) {
      this.fanOutContextManager ??= new FanOutContextManager(
        this.reasoner.getContextManager(),
        this.talker.getContextManager(),
      );
      return this.fanOutContextManager;
    }
    return this.reasoner.getContextManager();
  }

  /**
   * The guard built from the consumer's `budgetGuard` config, in both modes.
   *
   * This returns what the caller configured, which is the only thing a
   * `getMaxCost()` / `isBreached()` read can be checked against. It used to
   * return the facade's aggregate guard in duplex: a different object with a
   * different scope, a different cap (Infinity unless `duplex.maxTotalCost`
   * is set) and a different breach state, so a UI that set `maxCost` and
   * read it back silently got someone else's number. The aggregate is a
   * separate fact and has {@link getAggregateBudgetGuard}.
   */
  getBudgetGuard(): BudgetGuard {
    return this.reasoner.getBudgetGuard();
  }

  /**
   * The facade's aggregate guard: lifetime scope across both resident loops,
   * every sub-agent, quick lookups, and utility spend, capped by
   * `duplex.maxTotalCost`. This is the guard that stops a duplex session, so
   * a consumer showing "the agent halted on budget" reads `isBreached()`
   * here, not on the per-prompt guard above. Null in passthrough, where no
   * aggregate exists and the reasoner's own guard is the whole story.
   */
  getAggregateBudgetGuard(): BudgetGuard | null {
    return this.aggregateGuard;
  }

  getSkillRegistry(): SkillRegistry {
    return this.reasoner.getSkillRegistry();
  }

  /**
   * Register a skill with every loop that carries skills. The facade
   * registration API (docs/cortex/duplex/sub-agents.md): skills stay
   * per-loop (registry instances are never shared between loops), and this
   * fans the registration out so a consumer never reaches into a specific
   * loop's registry. Today the fan-out set is the reasoner; the talker
   * carries no skills by design (facade-api.md routing table), and any
   * future skill-carrying loop joins here without a consumer-visible
   * change.
   */
  addSkill(config: SkillConfig): void {
    for (const loop of this.skillLoops) {
      loop.getSkillRegistry().addSkill(config);
    }
  }

  /** Remove a skill from every loop that carries skills. */
  removeSkill(name: string): void {
    for (const loop of this.skillLoops) {
      loop.getSkillRegistry().removeSkill(name);
    }
  }

  /** The loops skills fan out to (never the talker). */
  private get skillLoops(): AgentLoop[] {
    return [this.reasoner];
  }

  // Prompt and model surface -----------------------------------------------

  /**
   * Set the consumer base prompt. Duplex appends each loop's role prompt
   * (the consumer supplies one undifferentiated prompt, facade-api.md);
   * the returned composition is the reasoner's, matching passthrough.
   */
  setBasePrompt(basePrompt: string): string {
    if (this.talker) {
      this.consumerBasePrompt = basePrompt;
      const talkerPrompt = appendRolePrompt(basePrompt, TALKER_ROLE_PROMPT);
      this.talker.setBasePrompt(talkerPrompt ?? basePrompt);
      const reasonerPrompt = appendRolePrompt(basePrompt, REASONER_ROLE_PROMPT);
      return this.reasoner.setBasePrompt(reasonerPrompt ?? basePrompt);
    }
    return this.reasoner.setBasePrompt(basePrompt);
  }

  /** The consumer's base prompt (role prompts excluded in duplex). */
  getBasePrompt(): string {
    if (this.talker) {
      return this.consumerBasePrompt ?? '';
    }
    return this.reasoner.getBasePrompt();
  }

  getCurrentSystemPrompt(): string {
    return this.reasoner.getCurrentSystemPrompt();
  }

  /**
   * Compose the full system prompt from a base prompt. Reasoner composition
   * in both modes; in duplex (2b) the talker appends its role prompt to the
   * same base (CONFIG_ROUTING initialBasePrompt: both loops in full).
   */
  composeSystemPrompt(basePrompt: string): string {
    return this.reasoner.composeSystemPrompt(basePrompt);
  }

  getSystemPromptSections(): Array<{ name: string; content: string }> {
    return this.reasoner.getSystemPromptSections();
  }

  getModel(): CortexModel {
    return this.reasoner.getModel();
  }

  /**
   * Swap the primary (reasoner) model. In duplex an unpinned talker is
   * re-mirrored to the fast tier of the new model, exactly as create()
   * picked it; without that a provider switch would leave the presence loop
   * (and every quick lookup, which builds from the talker's model) on the
   * old provider. A pinned `talker.model` is the consumer's choice and
   * stays.
   */
  setModel(model: CortexModel): void {
    this.reasoner.setModel(model);
    if (!this.talker || this.talkerModelPinned) return;
    this.talker.setModel(this.reasoner.getAutoResolvedUtilityModel());
    this.refreshModelResolutionNotes();
  }

  getUtilityModel(): CortexModel {
    return this.reasoner.getUtilityModel();
  }

  /**
   * Set the utility model on every resident loop that can take it
   * (CONFIG_ROUTING utilityModel: per-loop), under the same rule assembly
   * applies: the talker takes it when it shares the talker's provider and
   * skips it otherwise, because a loop rejects a utility model from another
   * provider. The talker's primary model is not affected: it mirrors the
   * reasoner's auto-resolved fast tier, which an override does not change.
   */
  setUtilityModel(model: CortexModel): void {
    this.reasoner.setUtilityModel(model);
    if (!this.talker) return;
    if (model.provider === this.talker.getModel().provider) {
      this.talker.setUtilityModel(model);
    } else {
      this.logger.warn('talker keeps its own utility model: the new one is from another provider', {
        utilityProvider: model.provider,
        talkerProvider: this.talker.getModel().provider,
      });
    }
  }

  resetUtilityModel(): void {
    this.reasoner.resetUtilityModel();
    this.talker?.resetUtilityModel();
  }

  // Utility-model reads are per loop in duplex (CONFIG_ROUTING utilityModel:
  // per-loop); until 2b decides the composite read, these report the
  // reasoner's dial, matching the setters above.
  getAutoResolvedUtilityModel(): CortexModel {
    return this.reasoner.getAutoResolvedUtilityModel();
  }

  isUtilityModelOverridden(): boolean {
    return this.reasoner.isUtilityModelOverridden();
  }

  getThinkingLevel(): ThinkingLevel {
    return this.reasoner.getThinkingLevel();
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.reasoner.setThinkingLevel(level);
  }

  async getModelThinkingCapabilities(): Promise<ModelThinkingCapabilities> {
    return this.reasoner.getModelThinkingCapabilities();
  }

  async clampThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> {
    return this.reasoner.clampThinkingLevel(level);
  }

  /**
   * Cache retention is a provider-request policy, not a per-model dial, so
   * it reaches every resident loop. The talker's small cached prefix is
   * where retention buys the most latency.
   */
  setCacheRetention(value: 'none' | 'short' | 'long'): void {
    this.reasoner.setCacheRetention(value);
    this.talker?.setCacheRetention(value);
  }

  getCacheRetention(): 'none' | 'short' | 'long' | null {
    return this.reasoner.getCacheRetention();
  }

  /**
   * Set the cache session id. Duplex derives the talker's stable id from
   * the same value (distinct per-loop prefix caches, log-and-context.md);
   * the reasoner keeps the bare id so mode flips keep its cache warm.
   */
  setSessionId(value: string | null): void {
    this.reasoner.setSessionId(value);
    this.talker?.setSessionId(value === null ? null : `${value}${TALKER_SESSION_ID_SUFFIX}`);
  }

  getSessionId(): string | null {
    return this.reasoner.getSessionId();
  }

  /**
   * Set the consumer's context-window limit on every resident loop
   * (CONFIG_ROUTING contextWindowLimit: per-loop). Each loop clamps the same
   * number against its own backend capacity, so the talker's
   * smaller fast-tier window is respected without the consumer knowing the
   * split exists.
   */
  setContextWindowLimit(limit: number | null): void {
    this.reasoner.setContextWindowLimit(limit);
    this.talker?.setContextWindowLimit(limit);
  }

  /** The configured limit. Identical on both loops; the clamp is per loop. */
  get contextWindowLimit(): number | null {
    return this.reasoner.contextWindowLimit;
  }

  get effectiveContextWindow(): number {
    return this.reasoner.effectiveContextWindow;
  }

  // Context-window values are per loop in duplex (CONFIG_ROUTING
  // contextWindowLimit: per-loop, derived from each loop's model); 2b
  // decides the composite read. Passthrough reports the reasoner's.
  get modelContextWindow(): number {
    return this.reasoner.modelContextWindow;
  }

  /**
   * Model metadata for the primary model, so reasoner only: the talker runs
   * a different model with its own window, set from its own metadata when
   * setModel() re-mirrors it.
   */
  setContextWindow(contextWindow: number): void {
    this.reasoner.setContextWindow(contextWindow);
  }

  get currentContextTokenCount(): number {
    return this.reasoner.currentContextTokenCount;
  }

  updateCurrentContextTokenCount(inputTokens: number): void {
    this.reasoner.updateCurrentContextTokenCount(inputTokens);
  }

  estimateCurrentContextTokens(): number {
    return this.reasoner.estimateCurrentContextTokens();
  }

  capToolResult(content: string): string {
    return this.reasoner.capToolResult(content);
  }

  // Direct completions ------------------------------------------------------

  async directComplete(
    context: DirectCompletionContext,
    options?: DirectCompletionOptions,
  ): Promise<string> {
    return this.reasoner.directComplete(context, options);
  }

  async structuredComplete(
    context: DirectCompletionContext,
    schema: unknown,
    toolName?: string,
    toolDescription?: string,
    options?: DirectCompletionOptions,
  ): Promise<Record<string, unknown> | null> {
    return this.reasoner.structuredComplete(context, schema, toolName, toolDescription, options);
  }

  async utilityComplete(
    context: DirectCompletionContext,
    options?: DirectCompletionOptions,
  ): Promise<string> {
    return this.reasoner.utilityComplete(context, options);
  }

  getLastDirectUsage(): CortexUsage | null {
    return this.reasoner.getLastDirectUsage();
  }

  /**
   * Accumulated session usage: the composite aggregate across both loops
   * and settled quick lookups (children counted once via each loop's own
   * accounting), under the baseline-plus-delta restore model, so totals
   * survive restores without double-counting.
   */
  getSessionUsage(): SessionUsage {
    let total = this.reasonerUsageWithBaseline();
    const talker = this.talkerUsageWithBaseline();
    if (talker) total = addSessionUsage(total, talker);
    const lookups = this.lookupUsageWithBaseline();
    if (lookups) total = addSessionUsage(total, lookups);
    return total;
  }

  // Tools, MCP, skills ------------------------------------------------------

  addConsumerTool(tool: CortexTool): void {
    this.reasoner.addConsumerTool(tool);
  }

  removeConsumerTool(toolName: string): void {
    this.reasoner.removeConsumerTool(toolName);
  }

  refreshTools(): void {
    this.reasoner.refreshTools();
  }

  async connectMcpServer(serverName: string, config: McpTransportConfig): Promise<void> {
    // Facade service in duplex (one connection multiplexed to the loops
    // that need it, 2b); the reasoner's manager in passthrough.
    return this.reasoner.connectMcpServer(serverName, config);
  }

  async disconnectMcpServer(serverName: string): Promise<void> {
    return this.reasoner.disconnectMcpServer(serverName);
  }

  getMcpServerStates(): McpConnectionState[] {
    return this.reasoner.getMcpServerStates();
  }

  mcpConfigMatches(serverName: string, config: McpTransportConfig): boolean {
    return this.reasoner.mcpConfigMatches(serverName, config);
  }

  setMcpToolCallProgressHandler(
    handler: ((progress: McpToolCallProgress) => void) | undefined,
  ): void {
    this.reasoner.setMcpToolCallProgressHandler(handler);
  }

  /**
   * The MCP client manager. A facade service in duplex (2b: one connection
   * multiplexed to the loops that need it, per facade-api.md); the
   * reasoner's manager in passthrough.
   */
  getMcpClientManager(): McpClientManager {
    return this.reasoner.getMcpClientManager();
  }

  getMcpTools(): CortexTool[] {
    return this.reasoner.getMcpTools();
  }

  async loadSkill(name: string, args?: string): Promise<void> {
    return this.reasoner.loadSkill(name, args);
  }

  // Skills are facade services projected to the reasoner and sub-agents in
  // duplex (never the talker, facade-api.md); the reasoner's buffer in
  // passthrough.
  clearSkillBuffer(): void {
    this.reasoner.clearSkillBuffer();
  }

  getSkillBuffer(): LoadedSkill[] {
    return this.reasoner.getSkillBuffer();
  }

  setPreprocessorVariables(variables: Record<string, string>): void {
    this.reasoner.setPreprocessorVariables(variables);
  }

  setScriptContext(context: Record<string, unknown>): void {
    this.reasoner.setScriptContext(context);
  }

  // Sub-agents --------------------------------------------------------------

  async spawnBackgroundSubAgent(
    params: Omit<SubAgentSpawnConfig, 'background'>,
  ): Promise<{ taskId: string }> {
    return this.reasoner.spawnBackgroundSubAgent(params);
  }

  async cancelSubAgent(taskId: string): Promise<boolean> {
    return this.reasoner.cancelSubAgent(taskId);
  }

  steerSubAgent(taskId: string, message: string): boolean {
    return this.reasoner.steerSubAgent(taskId, message);
  }

  getActiveSubAgents(): SubAgentSnapshot[] {
    return this.reasoner.getActiveSubAgents();
  }

  // Asks and queues ---------------------------------------------------------

  /**
   * Every permission ask currently blocked on a decision, from both
   * registries, deduplicated by askId.
   *
   * Two registries exist because two different things track asks. The
   * reasoner's holds its own and its sub-agents' (children mirror in through
   * the child resolver wrapper). The broker's holds everything routed
   * through the conversation in duplex, whichever loop raised it. They
   * overlap for reasoner tool asks, which carry the same askId in both, and
   * each holds asks the other never sees.
   *
   * This used to append only the broker's `network` asks, on the reasoning
   * that a loop registry covers everything else. It does not. A quick-lookup
   * loop is built through `AgentLoop.create`, not `createChildAgent`, so
   * there is no mirror into the reasoner, and its asks are `tool` kind, so
   * the network filter dropped them too: a blocked lookup was invisible on
   * every consumer surface while its resolver sat waiting. Taking the union
   * fixes that without a third special case, and it is what the method name
   * has always claimed.
   *
   * Lookup asks are deliberately NOT mirrored into the reasoner's registry
   * the way sub-agent asks are. A lookup is not in the reasoner's subtree:
   * it is a facade-owned peer on the conversation side (D13) with its own
   * pool, its own wall-clock timeout, and cancellation by a *conversation*
   * abort. Mirroring would make `reasoner.waitForAskSettlement()` block on
   * something the reasoner cannot influence and its registry claim work it
   * does not own.
   */
  getPendingAsks(): PendingAsk[] {
    const asks = this.reasoner.getPendingAsks();
    const broker = this.router?.permissionBroker;
    if (!broker) return asks;
    const mirrored = new Set(asks.map((ask) => ask.askId));
    const brokerOnly = broker.getPendingAsks()
      .filter((ask) => !mirrored.has(ask.askId))
      .map(({ kind: _kind, ...ask }) => ask);
    return [...asks, ...brokerOnly];
  }

  markAskVoiced(askId: string): boolean {
    return this.reasoner.markAskVoiced(askId);
  }

  /**
   * The network egress decision function this agent actually enforces: in
   * duplex it is the broker-routed wrapper (a consumer `ask` becomes a
   * voiced conversation ask), in passthrough the consumer's own function
   * unchanged, undefined when none was configured. Wire THIS function, not
   * the raw one from config, into the SandboxProvider's ask callback
   * (provider `onNetworkRequest`) with `via: 'shell'`, so shell
   * egress asks flow through the same broker pipeline as WebFetch instead
   * of blocking a loop invisibly.
   */
  getNetworkAccessResolver(): ResolveNetworkAccess | undefined {
    this.networkResolverHandedOut = true;
    return this.networkResolver ?? undefined;
  }

  /**
   * Record, once, that this agent brokered an egress resolver that nobody
   * ever took to wire into the sandbox, so shell egress asks cannot become
   * conversation the way WebFetch's do.
   *
   * The one resolution note that is not an assembly fact. It cannot be: a
   * consumer wires the resolver on the line after create() returns, so the
   * only honest moment to look is the first prompt.
   *
   * **Duplex only, and the gate is the correctness fix rather than a
   * narrowing.** In passthrough there is no broker: getNetworkAccessResolver()
   * hands back the consumer's own function unchanged, so calling it would
   * change nothing and never calling it proves nothing. The check has no
   * information content there, and it fired anyway, telling the first real
   * consumer that its egress was broken when that consumer had wired the
   * sandbox to its own decision function and was answering every ask through
   * its own UI. Both call sites still call in; this guard is the single
   * statement of the rule.
   */
  private noteUnwiredNetworkResolver(): void {
    if (this.mode !== 'duplex') return;
    if (this.unwiredNetworkResolverWarned) return;
    if (this.networkResolverHandedOut) return;
    if (!this.sandboxConfigured || this.networkResolver === null) return;
    this.unwiredNetworkResolverWarned = true;
    this.recordResolutionNote(networkResolverUnwiredNote());
  }

  // The pi queue surface targets the conversation loop: the single
  // reasoner in passthrough, the talker in duplex (directives reach the
  // duplex reasoner through the router, never through these).

  /** Queue a follow-up that drains at the run's would-stop point. */
  followUp(message: string): void {
    this.conversationLoop.followUp(message);
  }

  setSteeringQueueMode(mode: QueueDrainMode): void {
    this.conversationLoop.setSteeringQueueMode(mode);
  }

  setFollowUpQueueMode(mode: QueueDrainMode): void {
    this.conversationLoop.setFollowUpQueueMode(mode);
  }

  clearSteeringQueue(): void {
    this.conversationLoop.clearSteeringQueue();
  }

  clearFollowUpQueue(): void {
    this.conversationLoop.clearFollowUpQueue();
  }

  get queuedDeliveryCount(): number {
    return this.conversationLoop.queuedDeliveryCount;
  }

  get pendingWakeDeliveryCount(): number {
    return this.conversationLoop.pendingWakeDeliveryCount;
  }

  clearQueuedDeliveries(): string[] {
    return this.conversationLoop.clearQueuedDeliveries();
  }

  getDeadLetteredBackgroundResults(): DeadLetteredBackgroundResult[] {
    return this.reasoner.getDeadLetteredBackgroundResults();
  }

  /**
   * Feed a consumer-built headline block into the loop's context (view
   * injection outside the cache boundary). The facade takes headline
   * ownership only in duplex (2b builds the live-status block from
   * event-bridge activity, log-and-context.md); forwarding keeps the
   * consumer capability intact in passthrough.
   */
  setHeadlineProvider(
    provider: (() => string | null) | null,
    options?: { maxTokens?: number },
  ): void {
    this.reasoner.setHeadlineProvider(provider, options);
  }

  // History, memory, digestion ---------------------------------------------

  /**
   * The CONVERSATION loop's post-slot transcript: the talker in duplex, the
   * reasoner in passthrough.
   *
   * The name is the contract. In duplex the reasoner's transcript is the
   * WORK transcript, in which the user's own words appear only as
   * `<conversation-context>` fragments quoted inside dispatch messages, so a
   * consumer rendering or exporting "the conversation" from it got dispatch
   * scaffolding and directives instead of the dialogue. Both transcripts,
   * plus the log and per-loop usage, are on {@link getState}.
   */
  getConversationHistory(): AgentMessage[] {
    return this.conversationLoop.getConversationHistory();
  }

  /**
   * The REASONER's observational state, in both modes.
   *
   * Deliberately not the conversation loop's, unlike
   * {@link getConversationHistory} above: observational memory is what the
   * agent learned while working, and the reasoner is the loop that works.
   * The consequence to know about is that in duplex these two reads are no
   * longer an order-coupled pair, so they must not be assembled into a v1
   * artifact together (the watermark would align to the wrong history).
   * {@link getState} is the coherent composite and the only supported
   * persistence surface.
   */
  getObservationalMemoryState(): ObservationalMemoryState | null {
    return this.reasoner.getObservationalMemoryState();
  }

  async digestIdle(options?: IdleDigestionOptions): Promise<IdleDigestionResult> {
    return this.reasoner.digestIdle(options);
  }

  async checkAndRunCompaction(): Promise<CompactionResult | null> {
    return this.reasoner.checkAndRunCompaction();
  }

  async triggerObservation(): Promise<void> {
    return this.reasoner.triggerObservation();
  }

  /**
   * The compaction manager. Each loop runs its own manager in duplex
   * (CONFIG_ROUTING compaction: both-loops); 2b decides how the composite
   * exposes the pair. Passthrough returns the reasoner's.
   */
  getCompactionManager(): CompactionManager {
    return this.reasoner.getCompactionManager();
  }

  // State reads -------------------------------------------------------------

  get isRunning(): boolean {
    return this.reasoner.isRunning || (this.talker?.isRunning ?? false);
  }

  /**
   * True while a logical turn is in flight on any resident loop. Narrower
   * than the settlement predicates: it reads idle while gate tasks are
   * still queued, so prefer conversationIdle / workSettled for settlement
   * decisions.
   */
  get isPrompting(): boolean {
    return this.reasoner.isPrompting || (this.talker?.isPrompting ?? false);
  }

  get state(): CortexLifecycleState {
    return this.reasoner.state;
  }

  getEnvOverrides(): Record<string, string> | undefined {
    return this.reasoner.getEnvOverrides();
  }

  get isWorkingTagsEnabled(): boolean {
    return this.reasoner.isWorkingTagsEnabled;
  }

  // Working tags route to both loops (CONFIG_ROUTING workingTags:
  // both-loops); the talker relies on them to separate thinking from
  // speech.
  setWorkingTagsEnabled(enabled: boolean): void {
    this.reasoner.setWorkingTagsEnabled(enabled);
    this.talker?.setWorkingTagsEnabled(enabled);
  }

  setLastInteractionTime(timestamp: number): void {
    this.reasoner.setLastInteractionTime(timestamp);
    this.talker?.setLastInteractionTime(timestamp);
  }

  // Callback registration. In passthrough these delegate to the single
  // loop; in duplex, loop-lifecycle and compaction callbacks register on
  // BOTH resident loops, while sub-agent callbacks stay on the reasoner
  // (the only loop that spawns).
  //
  // EVERY fan-out callback takes a trailing LoopOriginContext, so a consumer
  // receiving one can tell which loop produced it. That is not decoration:
  // the fan-out is correct (both loops really do complete turns, retry, and
  // compact), so without the label a duplex consumer renders two retry
  // countdowns for one provider hiccup and two compaction notifications for
  // one compaction, with no way to collapse or attribute them. onError and
  // onTurnComplete carried origin from the start; the rest were the defect.
  // onTurnComplete is also the one deliberate non-fan-out: see its comment.

  /** Every resident loop, for handlers that fan out in duplex. */
  private get residentLoops(): AgentLoop[] {
    return this.talker ? [this.reasoner, this.talker] : [this.reasoner];
  }

  onLoopComplete(handler: (origin: LoopOriginContext) => void): void {
    for (const loop of this.residentLoops) loop.onLoopComplete(handler);
  }

  onError(handler: (error: ClassifiedError, origin: LoopOriginContext) => void): void {
    for (const loop of this.residentLoops) loop.onError(handler);
  }

  /**
   * The CONVERSATION loop only, unlike its neighbours here.
   *
   * onTurnComplete is not a diagnostic: it is the "the assistant finished
   * saying something" signal consumers build user-visible output on (a TUI
   * finalizes the assistant bubble, a voice app speaks the text). In duplex
   * the reasoner's assistant text is internal working prose that reaches the
   * user only after the talker performs a delivery, so fanning out fires
   * twice per exchange and the reasoner's private text is one of the two.
   * The facade's own log producer already draws `reply` entries from the
   * talker alone; this is the same rule on the consumer surface.
   *
   * Diagnostics (onError, onRetryScheduled, the merged event bridge) stay
   * fanned out and loopPath-labeled: a consumer WANTS to see a reasoner
   * failure, and those surfaces carry the origin needed to tell the loops
   * apart. Passthrough is unchanged (the conversation loop is the reasoner).
   */
  onTurnComplete(handler: (output: AgentTextOutput, origin: LoopOriginContext) => void): void {
    this.conversationLoop.onTurnComplete(handler);
  }

  onRetryScheduled(
    handler: (info: RetryScheduledInfo, origin: LoopOriginContext) => void,
  ): void {
    for (const loop of this.residentLoops) loop.onRetryScheduled(handler);
  }

  onRetrySucceeded(
    handler: (info: RetrySucceededInfo, origin: LoopOriginContext) => void,
  ): void {
    for (const loop of this.residentLoops) loop.onRetrySucceeded(handler);
  }

  onRetryExhausted(
    handler: (info: RetryExhaustedInfo, origin: LoopOriginContext) => void,
  ): void {
    for (const loop of this.residentLoops) loop.onRetryExhausted(handler);
  }

  onBeforeCompaction(
    handler: (target: CompactionTarget, origin: LoopOriginContext) => Promise<void>,
  ): void {
    for (const loop of this.residentLoops) loop.onBeforeCompaction(handler);
  }

  onPostCompaction(
    handler: (result: CompactionResult, origin: LoopOriginContext) => void,
  ): void {
    for (const loop of this.residentLoops) loop.onPostCompaction(handler);
  }

  onCompactionError(
    handler: (error: Error, origin: LoopOriginContext) => void,
  ): void {
    for (const loop of this.residentLoops) loop.onCompactionError(handler);
  }

  onCompactionDegraded(
    handler: (info: CompactionDegradedInfo, origin: LoopOriginContext) => void,
  ): void {
    for (const loop of this.residentLoops) loop.onCompactionDegraded(handler);
  }

  onCompactionExhausted(
    handler: (info: CompactionExhaustedInfo, origin: LoopOriginContext) => void,
  ): void {
    for (const loop of this.residentLoops) loop.onCompactionExhausted(handler);
  }

  onSubAgentSpawned(handler: (taskId: string, instructions: string, background: boolean) => void): void {
    this.reasoner.onSubAgentSpawned(handler);
  }

  onSubAgentCompleted(
    handler: (taskId: string, result: string, status: string, usage: unknown) => void,
  ): void {
    this.reasoner.onSubAgentCompleted(handler);
  }

  onSubAgentFailed(handler: (taskId: string, error: string) => void): void {
    this.reasoner.onSubAgentFailed(handler);
  }

  onBackgroundResultDelivery(handler: (taskIds: string[]) => void): void {
    this.reasoner.onBackgroundResultDelivery(handler);
  }

  onBackgroundResultDeadLettered(
    handler: (result: DeadLetteredBackgroundResult) => void,
  ): void {
    this.reasoner.onBackgroundResultDeadLettered(handler);
  }

  onObservation(
    handler: (event: ObservationEvent, origin: LoopOriginContext) => void,
  ): void {
    for (const loop of this.residentLoops) loop.onObservation(handler);
  }

  onReflection(
    handler: (event: ReflectionEvent, origin: LoopOriginContext) => void,
  ): void {
    for (const loop of this.residentLoops) loop.onReflection(handler);
  }
}
