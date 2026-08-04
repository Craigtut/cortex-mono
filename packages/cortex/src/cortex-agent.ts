/**
 * CortexAgent: the composite facade over the AgentLoop primitive
 * (docs/cortex/duplex/facade-api.md, architecture.md).
 *
 * Consumers interact with one CortexAgent. Internally it owns the resident
 * loop(s), the session log, settlement predicates, and composite
 * persistence. Two modes:
 *
 * - `passthrough` (the default until Phase 2b lands): a single reasoner
 *   loop, reproducing direct AgentLoop behavior exactly. This is the
 *   consumer opt-out and the parity baseline for tests.
 * - `duplex`: a fast talker loop fronting the reasoner. NOT IMPLEMENTED
 *   YET; constructing with it throws until Phase 2b.
 *
 * The talker/reasoner split is never exposed in this API; consumer config
 * is routed internally per the routing table below.
 */

import { AgentLoop } from './agent-loop.js';
import type {
  DeliverResult,
  DirectCompletionOptions,
  IdleDigestionOptions,
  IdleDigestionResult,
  QueueDrainMode,
} from './agent-loop.js';
import type { McpClientManager } from './mcp-client.js';
import type { CompactionManager } from './compaction/index.js';
import type { DirectCompletionContext } from './cache-breakpoints.js';
import type {
  AgentLoopConfig,
  AgentTextOutput,
  ClassifiedError,
  CompactionDegradedInfo,
  CompactionExhaustedInfo,
  CompactionResult,
  CompactionTarget,
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
  RetryScheduledInfo,
  RetrySucceededInfo,
  SessionUsage,
  UtilityUsageBucket,
  SubAgentSnapshot,
  SubAgentSpawnConfig,
  ThinkingLevel,
} from './types.js';
import type { CortexTool } from './tool-contract.js';
import type { CortexModel } from './model-wrapper.js';
import type { AgentMessage } from './context-manager.js';
import type { ContextManager } from './context-manager.js';
import type { EventBridge } from './event-bridge.js';
import type { BudgetGuard } from './budget-guard.js';
import type { SkillRegistry } from './skill-registry.js';
import type {
  ObservationEvent,
  ObservationalMemoryState,
  ReflectionEvent,
} from './compaction/index.js';
import { SessionLog } from './session-log.js';
import type { SessionLogEntry, SessionLogSubscriber } from './session-log.js';
import { NOOP_LOGGER } from './noop-logger.js';

// ---------------------------------------------------------------------------
// Modes and config
// ---------------------------------------------------------------------------

/**
 * Facade mode. `passthrough` routes everything to the single reasoner loop
 * and reproduces direct AgentLoop behavior exactly. `duplex` (talker +
 * reasoner) is the planned default once Phase 2b lands (decisions.md D14);
 * until then requesting it throws rather than silently degrading to
 * passthrough.
 */
export type CortexAgentMode = 'passthrough' | 'duplex';

/** Scope for {@link CortexAgent.abort} (facade-api.md abort table). */
export type CortexAbortScope = 'conversation' | 'work' | 'all';

/** Talker-loop overrides (consumed in duplex mode, Phase 2b). */
export interface TalkerConfig {
  /**
   * Talker model. Default: a fast tier resolved from the primary provider.
   * The talker's toolset is fixed (control tools only, decisions.md D5/D8);
   * consumer tools never route to it.
   */
  model?: CortexModel;
}

/** Session log tuning (retention and subscriber buffering). */
export interface CortexSessionLogConfig {
  /** Retention cap on held entries (see SessionLogOptions.maxEntries). */
  maxEntries?: number;
  /** Per-subscriber buffer bound (see SessionLogOptions.maxSubscriberBuffer). */
  maxSubscriberBuffer?: number;
}

/**
 * Configuration for CortexAgent.create(). Everything AgentLoopConfig has,
 * plus the facade's own keys, routed per {@link CONFIG_ROUTING}.
 */
export interface CortexAgentConfig extends AgentLoopConfig {
  /** Consumer tools. Routed to the reasoner only (decisions.md D5). */
  tools?: CortexTool[];
  /** Facade mode. Default: 'passthrough' until Phase 2b. */
  mode?: CortexAgentMode;
  /** Talker overrides (duplex mode, Phase 2b). */
  talker?: TalkerConfig;
  /**
   * Consumer idle signal for the wake policy (duplex mode, Phase 2b): is
   * the user/channel idle right now? Advisory; the facade enforces its own
   * minimum inter-delivery spacing.
   */
  idleSignal?: () => boolean;
  /** Session log retention and subscription tuning. */
  sessionLog?: CortexSessionLogConfig;
  /**
   * Debounce for the onStateChanged persistence trigger, in ms.
   * Default: 500.
   */
  stateChangeDebounceMs?: number;
}

// ---------------------------------------------------------------------------
// Config routing
// ---------------------------------------------------------------------------

/**
 * Where a config key lands (docs/cortex/duplex/facade-api.md). In
 * passthrough mode every non-facade destination resolves to the reasoner
 * (it is the only loop); the distinctions below describe what Phase 2b's
 * duplex assembly does with the same key.
 *
 * - `reasoner`: the reasoner loop only; never the talker.
 * - `both-loops`: both resident loops, identical content.
 * - `per-loop`: each loop gets its own value derived from this one.
 * - `shared`: passed to every loop verbatim (environment-level).
 * - `facade`: consumed by the facade itself; never reaches a loop config.
 */
export type ConfigDestination =
  | 'reasoner'
  | 'both-loops'
  | 'per-loop'
  | 'shared'
  | 'facade';

/**
 * The complete config routing table, key by key. This mapped object is the
 * contract: adding a key to AgentLoopConfig or CortexAgentConfig without
 * routing it here is a compile error, so no key can silently diverge
 * (review-findings.md F18). Runtime routing derives from it: 'facade' keys
 * are stripped before the loop config is built.
 */
export const CONFIG_ROUTING: { [K in keyof Required<CortexAgentConfig>]: ConfigDestination } = {
  // Reasoner-only: the talker has its own dial (talker.model + a facade
  // thinking default) in 2b.
  model: 'reasoner',
  thinkingLevel: 'reasoner',
  // Consumer tools are wired to the reasoner only (D5); the talker's
  // toolset is the fixed control tools.
  tools: 'reasoner',
  // Both loops, identical content, no per-slot routing (D6).
  slots: 'both-loops',
  // Both loops in full; the talker's role prompt is appended to it in 2b.
  initialBasePrompt: 'both-loops',
  // Both loops run independent compaction managers in 2b; the talker is
  // forced to a non-blocking posture internally.
  compaction: 'both-loops',
  // Reasoner (and sub-agents by inheritance). In 2b the facade adds an
  // aggregate guard across every loop, and the talker gets a facade-set
  // hard maxTurns that consumer config cannot raise. Not added in
  // passthrough: a facade-level guard on a single loop would double-guard
  // today's behavior and break parity.
  budgetGuard: 'reasoner',
  // Reasoner and sub-agents; the talker gets fail-fast defaults in 2b so a
  // transient error never becomes minutes of silence.
  retryPolicy: 'reasoner',
  // Direct passthrough today; the facade permission broker owns it in
  // duplex (2b), and the talker loop receives no resolver at all.
  resolvePermission: 'reasoner',
  // Same broker pipeline as resolvePermission in 2b.
  resolveNetworkAccess: 'reasoner',
  // Facade broker input in 2b (bypasses voicing when set); reasoner today.
  isAutoApprove: 'reasoner',
  // Reasoner and sub-agents.
  toolExecution: 'reasoner',
  disableTools: 'reasoner',
  deferredTools: 'reasoner',
  toolResultThresholds: 'reasoner',
  webFetch: 'reasoner',
  bash: 'reasoner',
  // Both loops (the talker uses working tags to separate thinking from
  // speech in 2b).
  workingTags: 'both-loops',
  // Per loop, derived from each loop's model in 2b.
  contextWindowLimit: 'per-loop',
  // Per loop in 2b (the same-provider constraint is enforced per loop).
  utilityModel: 'per-loop',
  // Reasoner pool config; quick lookups get a separate facade-owned pool
  // in 2b.
  maxConcurrentSubAgents: 'reasoner',
  subAgentPools: 'reasoner',
  onBeforeSubAgentSpawn: 'reasoner',
  canSpawnSubAgent: 'reasoner',
  // Long-lived loop posture. Consumer value applies to the reasoner; the
  // facade sets the talker's own posture in 2b.
  persistentRuntime: 'reasoner',
  // Shared environment-level wiring, passed to every loop verbatim.
  getApiKey: 'shared',
  sandbox: 'shared',
  envOverrides: 'shared',
  logger: 'shared',
  workingDirectory: 'shared',
  diagnostics: 'shared',
  // Shared; the loop stamps origin (loopPath) into persistence metadata.
  persistResult: 'shared',
  // The facade derives distinct stable per-loop cache ids from it in 2b.
  // The reasoner keeps the bare consumer id in both modes, so a session
  // that flips modes keeps its reasoner prefix cache warm.
  sessionId: 'per-loop',
  // Passthrough keeps the consumer's loop path (default 'main') so origin
  // context matches direct AgentLoop use exactly; the 2b duplex assembly
  // overrides per loop ('talker' / 'reasoner').
  loopPath: 'per-loop',
  // Facade-owned keys, never part of a loop config.
  mode: 'facade',
  talker: 'facade',
  idleSignal: 'facade',
  sessionLog: 'facade',
  stateChangeDebounceMs: 'facade',
};

/**
 * Build the reasoner's AgentLoop config from consumer config by dropping
 * the facade-owned keys. Every other key flows through unchanged: in
 * passthrough the reasoner is the only loop, so 'both-loops', 'per-loop',
 * and 'shared' destinations all resolve to it. Exported for tests.
 */
export function buildReasonerConfig(
  config: CortexAgentConfig,
): AgentLoopConfig & { tools?: CortexTool[] } {
  const routed: Record<string, unknown> = {};
  for (const key of Object.keys(CONFIG_ROUTING) as Array<keyof CortexAgentConfig>) {
    if (CONFIG_ROUTING[key] === 'facade') continue;
    if (key in config) {
      routed[key] = config[key];
    }
  }
  return routed as unknown as AgentLoopConfig & { tools?: CortexTool[] };
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
  // Subsumed: facade abort() clears every queue per the abort-table scope
  // semantics (facade-api.md); a bare clear-everything without an abort has
  // no composite meaning once queues span loops.
  clearAllQueues: 'subsumed',
  // Asks and headlines.
  getPendingAsks: 'forwarded',
  markAskVoiced: 'forwarded',
  setHeadlineProvider: 'forwarded',
  // Prompt and model surface.
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
  // Withheld: cache-breakpoint internal (the boundary between cacheable
  // history and tick content); meaningless as a composite value.
  prePromptMessageCount: 'withheld',
  // Withheld: context-composition internals; the hook is wiring between the
  // loop and pi, not a consumer surface.
  getTransformContextHook: 'withheld',
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

/** The keys the table marks 'forwarded'. */
type ForwardedLoopMember = {
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
  memory?: ObservationalMemoryState | null;
  usage?: SessionUsage;
}

/**
 * What restore() accepts: a versioned artifact, or a bare message array
 * (today's rawest persistence shape, treated as v1 history).
 */
export type CortexAgentPersistedState =
  | CortexAgentStateV2
  | CortexAgentStateV1
  | AgentMessage[];

// ---------------------------------------------------------------------------
// Usage arithmetic (baseline-plus-delta restore model)
// ---------------------------------------------------------------------------

function zeroUsage(): SessionUsage {
  return {
    totalCost: 0,
    totalTurns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function cloneUsage(usage: SessionUsage): SessionUsage {
  const copy: SessionUsage = {
    totalCost: usage.totalCost,
    totalTurns: usage.totalTurns,
    tokens: { ...usage.tokens },
  };
  if (usage.utility) {
    copy.utility = Object.fromEntries(
      Object.entries(usage.utility).map(([category, bucket]) => [
        category,
        { ...bucket, tokens: { ...bucket.tokens } },
      ]),
    );
  }
  return copy;
}

function addUsage(a: SessionUsage, b: SessionUsage): SessionUsage {
  const sum = cloneUsage(a);
  sum.totalCost += b.totalCost;
  sum.totalTurns += b.totalTurns;
  sum.tokens.input += b.tokens.input;
  sum.tokens.output += b.tokens.output;
  sum.tokens.cacheRead += b.tokens.cacheRead;
  sum.tokens.cacheWrite += b.tokens.cacheWrite;
  if (b.utility) {
    sum.utility ??= {};
    for (const [category, bucket] of Object.entries(b.utility)) {
      const target: UtilityUsageBucket = sum.utility[category] ?? {
        calls: 0,
        cost: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      sum.utility[category] = {
        calls: target.calls + bucket.calls,
        cost: target.cost + bucket.cost,
        tokens: {
          input: target.tokens.input + bucket.tokens.input,
          output: target.tokens.output + bucket.tokens.output,
          cacheRead: target.tokens.cacheRead + bucket.tokens.cacheRead,
          cacheWrite: target.tokens.cacheWrite + bucket.tokens.cacheWrite,
        },
      };
    }
  }
  return sum;
}

/**
 * live minus baseline, per counter. Both reads come from the same loop's
 * monotonically growing counters (baseline taken at restore time), so
 * every difference is non-negative by construction.
 */
function diffUsage(live: SessionUsage, baseline: SessionUsage): SessionUsage {
  const delta: SessionUsage = {
    totalCost: live.totalCost - baseline.totalCost,
    totalTurns: live.totalTurns - baseline.totalTurns,
    tokens: {
      input: live.tokens.input - baseline.tokens.input,
      output: live.tokens.output - baseline.tokens.output,
      cacheRead: live.tokens.cacheRead - baseline.tokens.cacheRead,
      cacheWrite: live.tokens.cacheWrite - baseline.tokens.cacheWrite,
    },
  };
  if (live.utility) {
    delta.utility = {};
    for (const [category, bucket] of Object.entries(live.utility)) {
      const base = baseline.utility?.[category];
      delta.utility[category] = {
        calls: bucket.calls - (base?.calls ?? 0),
        cost: bucket.cost - (base?.cost ?? 0),
        tokens: {
          input: bucket.tokens.input - (base?.tokens.input ?? 0),
          output: bucket.tokens.output - (base?.tokens.output ?? 0),
          cacheRead: bucket.tokens.cacheRead - (base?.tokens.cacheRead ?? 0),
          cacheWrite: bucket.tokens.cacheWrite - (base?.tokens.cacheWrite ?? 0),
        },
      };
    }
  }
  return delta;
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
  const usage = state.usage ? cloneUsage(state.usage) : zeroUsage();
  return {
    version: 2,
    log: [],
    talkerHistory: [],
    reasonerHistory: state.history,
    talkerMemory: null,
    reasonerMemory: state.memory ?? null,
    usage: {
      total: cloneUsage(usage),
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
}

// ---------------------------------------------------------------------------
// CortexAgent
// ---------------------------------------------------------------------------

const DEFAULT_STATE_DEBOUNCE_MS = 500;

/** One macrotask yield: lets pending microtask cascades finish. */
function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class CortexAgent {
  private readonly reasoner: AgentLoop;
  private readonly mode: CortexAgentMode;
  private readonly log: SessionLog;
  private readonly logger: CortexLogger;

  /** Serializes facade prompt() calls (concurrent prompts queue, never throw). */
  private promptChain: Promise<void> = Promise.resolve();
  /** Facade prompts accepted but not yet settled (chain-queued or running). */
  private pendingFacadePrompts = 0;

  /**
   * Seq of the utterance whose facade-initiated run is currently live.
   * Entries produced by that run (replies, errors, spawn lifecycle) carry
   * it as their causation stamp. Null while no facade-initiated run is
   * live; entries produced then (e.g. by a background delivery run) carry
   * no stamp rather than a guessed one.
   */
  private activeCauseSeq: number | null = null;
  /** Spawn lifecycle seq per live task, for completion causation. */
  private readonly spawnSeqByTaskId = new Map<string, number>();

  // Baseline-plus-delta usage model: loops restart at zero after a
  // restore, so the composite aggregate is restoredBaseline + live deltas
  // rather than an additive merge into live counters (which would
  // double-count on repeated restores).
  private usageBaseline: { talker: SessionUsage | null; reasoner: SessionUsage } | null = null;
  /** Reasoner live counters at the moment of the last restore. */
  private usageAtRestore: SessionUsage | null = null;
  /**
   * Talker-side artifact content carried through a passthrough session
   * opaquely: passthrough has no talker loop to hydrate, but a restored
   * duplex artifact must round-trip getState() without losing that side.
   */
  private retainedTalkerHistory: AgentMessage[] = [];
  private retainedTalkerMemory: ObservationalMemoryState | null = null;

  private readonly stateChangedHandlers: Array<(state: CortexAgentStateV2) => void> = [];
  private readonly stateDebounceMs: number;
  private stateDirty = false;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private emittingState = false;

  private destroyPromise: Promise<void> | null = null;
  private destroyed = false;

  private constructor(reasoner: AgentLoop, config: CortexAgentConfig) {
    this.mode = config.mode ?? 'passthrough';
    if (this.mode === 'duplex') {
      throw new Error(
        'CortexAgent duplex mode is not implemented yet (Phase 2b). ' +
        "Use mode: 'passthrough' (the current default).",
      );
    }
    this.reasoner = reasoner;
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

    this.wireLogProducers();
    this.wireStateTriggers();
  }

  /**
   * Create a CortexAgent. Routes consumer config per {@link CONFIG_ROUTING}
   * and constructs the reasoner loop. `mode: 'duplex'` throws until Phase
   * 2b lands; passthrough reproduces direct AgentLoop behavior exactly.
   */
  static async create(config: CortexAgentConfig): Promise<CortexAgent> {
    if ((config.mode ?? 'passthrough') === 'duplex') {
      // Checked before any loop is constructed so a rejected mode cannot
      // leak a live AgentLoop.
      throw new Error(
        'CortexAgent duplex mode is not implemented yet (Phase 2b). ' +
        "Use mode: 'passthrough' (the current default).",
      );
    }
    const reasoner = await AgentLoop.create(buildReasonerConfig(config));
    return new CortexAgent(reasoner, config);
  }

  // -------------------------------------------------------------------------
  // Log producers
  // -------------------------------------------------------------------------

  /**
   * Register the facade's own handlers on the reasoner. All registrations
   * are additive (the loop keeps handler arrays), so consumer handlers and
   * their signatures are untouched; passthrough parity holds.
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

    this.reasoner.onError((error: ClassifiedError, origin: LoopOriginContext) => {
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

    this.reasoner.onRetryScheduled((info: RetryScheduledInfo) => {
      this.appendEntry({
        type: 'retrying',
        loopPath: this.reasoner.loopPath,
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
      this.appendEntry({
        type: 'lifecycle',
        loopPath: this.reasoner.loopPath,
        content: `Sub-agent ${taskId} failed: ${error}`,
        data: { event: 'sub_agent_failed', taskId, error },
        ...(spawnSeq !== undefined ? { causedBy: spawnSeq } : {}),
      });
    });

    this.reasoner.onBackgroundResultDeadLettered((result: DeadLetteredBackgroundResult) => {
      this.appendEntry({
        type: 'lifecycle',
        loopPath: this.reasoner.loopPath,
        content: `Background ${result.kind} ${result.taskId} delivery dead-lettered after ${result.attempts} attempts`,
        data: {
          event: 'delivery_dead_lettered',
          kind: result.kind,
          taskId: result.taskId,
          attempts: result.attempts,
          lastError: result.lastError,
        },
      });
    });
  }

  /**
   * History can change without a log entry (compaction rewrites,
   * observation activation trims, a run completing); these mark the
   * composite state dirty so onStateChanged fires for them too. Log
   * appends mark it in appendEntry.
   */
  private wireStateTriggers(): void {
    this.reasoner.onLoopComplete(() => this.markStateDirty());
    this.reasoner.onPostCompaction(() => this.markStateDirty());
    this.reasoner.onObservation(() => this.markStateDirty());
    this.reasoner.onReflection(() => this.markStateDirty());
  }

  /**
   * Append a log entry, stamping causation from the live facade-initiated
   * run unless the caller supplies (or suppresses, with null) its own.
   */
  private appendEntry(input: {
    type: SessionLogEntry['type'];
    loopPath: string;
    content: string;
    causedBy?: number | null;
    data?: Record<string, unknown>;
  }): SessionLogEntry {
    const causedBy = input.causedBy === null
      ? undefined
      : input.causedBy ?? this.activeCauseSeq ?? undefined;
    const entry = this.log.append({
      type: input.type,
      loopPath: input.loopPath,
      content: input.content,
      ...(causedBy !== undefined ? { causedBy } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    });
    this.markStateDirty();
    return entry;
  }

  /** Spill retention-evicted entries through persistResult when configured. */
  private spillEvictedEntries(evicted: SessionLogEntry[], config: CortexAgentConfig): void {
    const persist = config.persistResult;
    if (!persist) return;
    const payload = evicted.map((entry) => JSON.stringify(entry)).join('\n');
    void persist(payload, {
      toolName: '_session_log',
      category: 'non-reproducible',
      loopPath: this.reasoner.loopPath,
    }).catch((err: unknown) => {
      this.logger.warn('session log spill failed', {
        error: err instanceof Error ? err.message : String(err),
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
    const loopState = this.reasoner.state;
    if (loopState === 'destroying') {
      throw new Error('Agent is being destroyed');
    }
    if (loopState === 'destroyed') {
      throw new Error('Agent has been destroyed');
    }
    if (this.reasoner.getCurrentSystemPrompt().trim().length === 0) {
      throw new Error(
        `CortexAgent prompt is not configured. Call setBasePrompt() before ${action}(), ` +
        'or provide initialBasePrompt during creation.',
      );
    }
  }

  /**
   * Prompt the agent. Routes to the reasoner (passthrough) or the talker
   * (duplex, 2b). Never throws on a busy loop: concurrent calls are
   * serialized by the facade, each resolving against the turn that carries
   * its input. The utterance is appended to the log when its run starts
   * (append-then-emit still holds: the entry lands before any event of the
   * run), so log order always matches execution order even when a deliver()
   * issued in the same tick starts its run ahead of a queued prompt().
   */
  async prompt(input: string, options?: DirectCompletionOptions): Promise<unknown> {
    this.assertPromptable('prompt');

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
    };
    this.promptChain = run.then(settle, settle);
    return run;
  }

  /**
   * Fire-and-forget input, with the same non-throwing guarantee as
   * prompt(): the loop's own deliver() state machine decides whether the
   * content starts a turn now ('prompted'), opens the next run ('parked'),
   * or waits silently for the next real prompt ('queued').
   */
  deliver(content: string, options?: CortexDeliverOptions): DeliverResult {
    // Mirror AgentLoop.deliver's synchronous validation before appending,
    // so the log never records an utterance the loop rejected.
    this.assertPromptable('deliver');
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('deliver() requires non-whitespace string content');
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
   * Queue a steering message into the running turn (drained at the next
   * turn boundary). No-op while idle, exactly like AgentLoop.steer().
   */
  steer(message: string): void {
    this.reasoner.steer(message);
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
   */
  async abort(scope: CortexAbortScope = 'all'): Promise<void> {
    this.appendEntry({
      type: 'lifecycle',
      loopPath: this.reasoner.loopPath,
      content: `Abort requested (scope: ${scope})`,
      data: { event: 'abort', scope },
      causedBy: null,
    });
    // Dropped queued content: silent deliveries, parked wake deliveries
    // (abort() drops those itself too), and pi's steering/follow-up queues.
    this.reasoner.clearAllQueues();

    const work: Array<Promise<unknown>> = [this.reasoner.abort()];
    if (scope !== 'conversation') {
      for (const taskId of this.reasoner.getSubAgentManager().getActiveTaskIds()) {
        work.push(this.reasoner.cancelSubAgent(taskId));
      }
    }
    await Promise.all(work);
  }

  /** Tear down the facade and its loops. Idempotent; shares one teardown. */
  async destroy(timeoutMs?: number): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;
    if (this.stateTimer !== null) {
      clearTimeout(this.stateTimer);
      this.stateTimer = null;
    }
    this.destroyPromise = (async () => {
      try {
        await this.reasoner.destroy(timeoutMs);
      } finally {
        this.log.clearSubscribers();
      }
    })();
    return this.destroyPromise;
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error('CortexAgent has been destroyed');
    }
  }

  // -------------------------------------------------------------------------
  // Session log surface
  // -------------------------------------------------------------------------

  /**
   * Snapshot copy (never a live reference) of log entries with
   * seq >= fromSeq (all retained entries when omitted).
   */
  getLog(fromSeq?: number): SessionLogEntry[] {
    return this.log.getLog(fromSeq);
  }

  /**
   * Subscribe to log events with replay from a seq, so a reconnecting UI
   * can ask for everything since it last saw. Slow subscribers are
   * buffered to a bound and then dropped with a gap marker rather than
   * applying backpressure to the loops. Returns an idempotent unsubscribe.
   */
  subscribeLog(cb: SessionLogSubscriber, fromSeq?: number): () => void {
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
    for (;;) {
      await this.reasoner.waitForLoopIdle();
      if (!this.reasoner.isLoopActive) {
        return this.captureStateInFrame();
      }
    }
  }

  /** Synchronous composite snapshot; caller guarantees gate quiescence. */
  private captureStateInFrame(): CortexAgentStateV2 {
    const reasonerUsage = this.reasonerUsageWithBaseline();
    const talkerUsage = this.usageBaseline?.talker
      ? cloneUsage(this.usageBaseline.talker)
      : null;
    return {
      version: 2,
      log: this.log.getLog(),
      // Passthrough has no talker loop; a restored duplex artifact's talker
      // side is carried through unchanged so nothing is lost on round trip.
      // Copied like getLog(): a persistence layer that normalizes the
      // snapshot in place must never mutate live facade state (and becomes
      // load-bearing when talkerHistory is a live loop's history in 2b).
      talkerHistory: structuredClone(this.retainedTalkerHistory),
      reasonerHistory: this.reasoner.getConversationHistory(),
      talkerMemory: structuredClone(this.retainedTalkerMemory),
      reasonerMemory: this.reasoner.getObservationalMemoryState(),
      usage: {
        total: talkerUsage ? addUsage(reasonerUsage, talkerUsage) : reasonerUsage,
        perLoop: { talker: talkerUsage, reasoner: reasonerUsage },
      },
    };
  }

  /** Reasoner usage under the baseline-plus-delta model. */
  private reasonerUsageWithBaseline(): SessionUsage {
    const live = this.reasoner.getSessionUsage();
    if (!this.usageBaseline) return live;
    const delta = this.usageAtRestore ? diffUsage(live, this.usageAtRestore) : live;
    return addUsage(this.usageBaseline.reasoner, delta);
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
   */
  restore(state: CortexAgentPersistedState): void {
    this.assertNotDestroyed();
    if (
      this.reasoner.isLoopActive ||
      this.pendingFacadePrompts > 0 ||
      this.reasoner.getSubAgentManager().activeCount > 0
    ) {
      throw new Error(
        'CortexAgent.restore() rejected: a loop is running. Await workSettled before restoring.',
      );
    }
    const v2 = normalizePersistedState(state);

    // History before observational state (restore ordering).
    this.reasoner.restoreConversationHistory(v2.reasonerHistory);
    if (v2.reasonerMemory) {
      this.reasoner.restoreObservationalMemoryState(v2.reasonerMemory);
    }
    // Deep copies: the caller's artifact stays the caller's (a later
    // in-place mutation of it must never reach live facade state).
    this.retainedTalkerHistory = structuredClone(v2.talkerHistory);
    this.retainedTalkerMemory = structuredClone(v2.talkerMemory);
    this.log.restore(v2.log);

    this.usageBaseline = {
      talker: v2.usage.perLoop.talker ? cloneUsage(v2.usage.perLoop.talker) : null,
      reasoner: cloneUsage(v2.usage.perLoop.reasoner),
    };
    this.usageAtRestore = this.reasoner.getSessionUsage();
    this.spawnSeqByTaskId.clear();
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
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      void this.emitStateChanged();
    }, this.stateDebounceMs);
  }

  private async emitStateChanged(): Promise<void> {
    if (this.destroyed || this.stateChangedHandlers.length === 0) return;
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
            error: err instanceof Error ? err.message : String(err),
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
    return this.pendingFacadePrompts === 0 && !this.reasoner.isLoopActive;
  }

  /**
   * Whether all work has settled: conversation idle, reasoner gate empty,
   * no active sub-agents (or quick lookups, 2b), no parked wake
   * deliveries, no pending permission asks. Queued silent deliveries do
   * not count: silent content deliberately waits for the next prompt.
   */
  get workSettled(): boolean {
    return (
      this.conversationIdle &&
      this.reasoner.getSubAgentManager().activeCount === 0 &&
      this.reasoner.pendingWakeDeliveryCount === 0 &&
      this.reasoner.getPendingAsks().length === 0
    );
  }

  /** Resolve once {@link conversationIdle} holds. */
  async waitForConversationIdle(): Promise<void> {
    for (;;) {
      if (this.pendingFacadePrompts > 0) {
        await this.promptChain;
        continue;
      }
      await this.reasoner.waitForLoopIdle();
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
        await this.promptChain;
        continue;
      }
      await this.reasoner.waitForLoopIdle();

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

      // Pending asks block on the loop's settlement signal, never on a
      // polling yield: an ask can outlive the child that raised it, and a
      // setImmediate spin would otherwise run hot for as long as it stays
      // unanswered.
      if (this.reasoner.getPendingAsks().length > 0) {
        await this.reasoner.waitForAskSettlement();
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
   * exactly; 2b labels every event with a loop path.
   */
  getEventBridge(): EventBridge {
    return this.reasoner.getEventBridge();
  }

  getContextManager(): ContextManager {
    return this.reasoner.getContextManager();
  }

  getBudgetGuard(): BudgetGuard {
    return this.reasoner.getBudgetGuard();
  }

  getSkillRegistry(): SkillRegistry {
    return this.reasoner.getSkillRegistry();
  }

  // Prompt and model surface -----------------------------------------------

  setBasePrompt(basePrompt: string): string {
    return this.reasoner.setBasePrompt(basePrompt);
  }

  getBasePrompt(): string {
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

  setModel(model: CortexModel): void {
    this.reasoner.setModel(model);
  }

  getUtilityModel(): CortexModel {
    return this.reasoner.getUtilityModel();
  }

  setUtilityModel(model: CortexModel): void {
    this.reasoner.setUtilityModel(model);
  }

  resetUtilityModel(): void {
    this.reasoner.resetUtilityModel();
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

  setCacheRetention(value: 'none' | 'short' | 'long'): void {
    this.reasoner.setCacheRetention(value);
  }

  getCacheRetention(): 'none' | 'short' | 'long' | null {
    return this.reasoner.getCacheRetention();
  }

  setSessionId(value: string | null): void {
    this.reasoner.setSessionId(value);
  }

  getSessionId(): string | null {
    return this.reasoner.getSessionId();
  }

  setContextWindowLimit(limit: number | null): void {
    this.reasoner.setContextWindowLimit(limit);
  }

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
   * Accumulated session usage: the composite aggregate. Without a restore
   * this is the reasoner's live counters verbatim; after one it is the
   * restored baseline plus live deltas (loops restart at zero), including
   * any restored talker-side spend, so totals survive restores without
   * double-counting.
   */
  getSessionUsage(): SessionUsage {
    const reasoner = this.reasonerUsageWithBaseline();
    const talkerBaseline = this.usageBaseline?.talker;
    return talkerBaseline ? addUsage(reasoner, talkerBaseline) : reasoner;
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

  getPendingAsks(): PendingAsk[] {
    return this.reasoner.getPendingAsks();
  }

  markAskVoiced(askId: string): boolean {
    return this.reasoner.markAskVoiced(askId);
  }

  // The pi queue surface targets the single reasoner in passthrough; 2b
  // decides which loop each of these addresses in duplex (the conversation
  // surface holds the talker's queues, directives ride the router).

  /** Queue a follow-up that drains at the run's would-stop point. */
  followUp(message: string): void {
    this.reasoner.followUp(message);
  }

  setSteeringQueueMode(mode: QueueDrainMode): void {
    this.reasoner.setSteeringQueueMode(mode);
  }

  setFollowUpQueueMode(mode: QueueDrainMode): void {
    this.reasoner.setFollowUpQueueMode(mode);
  }

  clearSteeringQueue(): void {
    this.reasoner.clearSteeringQueue();
  }

  clearFollowUpQueue(): void {
    this.reasoner.clearFollowUpQueue();
  }

  get queuedDeliveryCount(): number {
    return this.reasoner.queuedDeliveryCount;
  }

  get pendingWakeDeliveryCount(): number {
    return this.reasoner.pendingWakeDeliveryCount;
  }

  clearQueuedDeliveries(): string[] {
    return this.reasoner.clearQueuedDeliveries();
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

  getConversationHistory(): AgentMessage[] {
    return this.reasoner.getConversationHistory();
  }

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
    return this.reasoner.isRunning;
  }

  /**
   * True while a logical turn is in flight on the loop. Narrower than the
   * settlement predicates: it reads idle while gate tasks are still queued,
   * so prefer conversationIdle / workSettled for settlement decisions.
   */
  get isPrompting(): boolean {
    return this.reasoner.isPrompting;
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

  setWorkingTagsEnabled(enabled: boolean): void {
    this.reasoner.setWorkingTagsEnabled(enabled);
  }

  setLastInteractionTime(timestamp: number): void {
    this.reasoner.setLastInteractionTime(timestamp);
  }

  // Callback registration (facade-level fan-in with origin context in 2b;
  // direct delegation to the single loop in passthrough) -------------------

  onLoopComplete(handler: () => void): void {
    this.reasoner.onLoopComplete(handler);
  }

  onError(handler: (error: ClassifiedError, origin: LoopOriginContext) => void): void {
    this.reasoner.onError(handler);
  }

  onTurnComplete(handler: (output: AgentTextOutput, origin: LoopOriginContext) => void): void {
    this.reasoner.onTurnComplete(handler);
  }

  onRetryScheduled(handler: (info: RetryScheduledInfo) => void): void {
    this.reasoner.onRetryScheduled(handler);
  }

  onRetrySucceeded(handler: (info: RetrySucceededInfo) => void): void {
    this.reasoner.onRetrySucceeded(handler);
  }

  onRetryExhausted(handler: (info: RetryExhaustedInfo) => void): void {
    this.reasoner.onRetryExhausted(handler);
  }

  onBeforeCompaction(handler: (target: CompactionTarget) => Promise<void>): void {
    this.reasoner.onBeforeCompaction(handler);
  }

  onPostCompaction(handler: (result: CompactionResult) => void): void {
    this.reasoner.onPostCompaction(handler);
  }

  onCompactionError(handler: (error: Error) => void): void {
    this.reasoner.onCompactionError(handler);
  }

  onCompactionDegraded(handler: (info: CompactionDegradedInfo) => void): void {
    this.reasoner.onCompactionDegraded(handler);
  }

  onCompactionExhausted(handler: (info: CompactionExhaustedInfo) => void): void {
    this.reasoner.onCompactionExhausted(handler);
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

  onObservation(handler: (event: ObservationEvent) => void): void {
    this.reasoner.onObservation(handler);
  }

  onReflection(handler: (event: ReflectionEvent) => void): void {
    this.reasoner.onReflection(handler);
  }
}
