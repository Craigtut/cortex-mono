/**
 * CortexAgent: the composite facade over the AgentLoop primitive
 * (docs/cortex/duplex/facade-api.md, architecture.md).
 *
 * Consumers interact with one CortexAgent. Internally it owns the resident
 * loop(s), the session log, the duplex router, settlement predicates, and
 * composite persistence. Two modes:
 *
 * - `passthrough` (the default until Phase 3 flips it): a single reasoner
 *   loop, reproducing direct AgentLoop behavior exactly. This is the
 *   consumer opt-out and the parity baseline for tests.
 * - `duplex`: a fast talker loop fronting the persistent reasoner. The
 *   talker carries the fixed control toolset only; the reasoner does all
 *   real work and reports back through the router's wake policy.
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
  UtilityUsageBucket,
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
  SessionLogSubscriber,
  WakeClass,
} from './session-log.js';
import { NOOP_LOGGER } from './noop-logger.js';
import { stripWorkingTags, WorkingTagStreamFilter } from './working-tags.js';
import { TOOL_NAMES } from './tools/index.js';
import { DuplexRouter } from './duplex/router.js';
import type { DuplexRouterOptions, DuplexRouterPorts } from './duplex/router.js';
import { collectCauseTags, latestCauseSeq } from './duplex/cause-tags.js';
import { FanOutContextManager } from './duplex/fanout-context-manager.js';
import { DuplexHeadlines } from './duplex/headlines.js';
import type { CauseTag } from './duplex/cause-tags.js';
import { buildControlTools, isControlToolName } from './duplex/control-tools.js';
import {
  buildBrokeredNetworkResolver,
  buildBrokeredPermissionResolver,
} from './duplex/permission-broker.js';
import type { PermissionBroker } from './duplex/permission-broker.js';
import type { ResolveNetworkAccess } from './sandbox/types.js';
import { buildDeliverTool, buildSteerSubAgentTool } from './duplex/reasoner-tools.js';
import { QuickLookupManager } from './duplex/quick-lookups.js';
import type { QuickLookupOutcome } from './duplex/quick-lookups.js';
import {
  buildQuickLookupPrompt,
  REASONER_ROLE_PROMPT,
  SPEAK_NOW_APPENDIX,
  TALKER_ROLE_PROMPT,
  TALKER_TRUNCATION_REPAIR_MESSAGE,
} from './duplex/prompts.js';

// ---------------------------------------------------------------------------
// Modes and config
// ---------------------------------------------------------------------------

/**
 * Facade mode. `passthrough` routes everything to the single reasoner loop
 * and reproduces direct AgentLoop behavior exactly. `duplex` (talker +
 * reasoner) becomes the default at the Phase 3 flip (decisions.md D14).
 */
export type CortexAgentMode = 'passthrough' | 'duplex';

/** Scope for {@link CortexAgent.abort} (facade-api.md abort table). */
export type CortexAbortScope = 'conversation' | 'work' | 'all';

/** Talker-loop overrides (duplex mode). */
export interface TalkerConfig {
  /**
   * Talker model. Default: the fast tier resolved from the primary
   * provider (the reasoner's auto-resolved utility model). The talker's
   * toolset is fixed (control tools only, decisions.md D5/D8); consumer
   * tools never route to it.
   */
  model?: CortexModel;
}

/**
 * Duplex tuning: router backpressure and scheduling knobs plus the facade's
 * idle-digestion delay. Every field has a production default; the talker's
 * hard maxTurns is deliberately NOT here (consumer config cannot raise it,
 * decisions.md D17).
 */
export interface DuplexTuningConfig extends Omit<DuplexRouterOptions, 'now'> {
  /**
   * Quiet time after a run completes before the facade digests both loops
   * (pending observation buffers, threshold compaction) outside a prompt.
   * Default: 10000.
   */
  idleDigestionDelayMs?: number;
  /**
   * Concurrent quick-lookup cap: the separate small pool (D13), so a busy
   * task fleet can never starve lookups and vice versa. Default: 2.
   */
  maxConcurrentLookups?: number;
  /**
   * Wall-clock timeout per quick lookup in ms; on expiry the lookup aborts
   * and reports timed_out (visibly, never silently). Default: 30000.
   */
  lookupTimeoutMs?: number;
  /**
   * Aggregate lifetime cost cap in USD across both resident loops, every
   * sub-agent, and utility spend (observer/reflector/summarization).
   * Deliberately its own key: `budgetGuard.maxCost` keeps its per-prompt
   * meaning on the reasoner, and silently reinterpreting that number as a
   * whole-session cap would make the same config mean two different
   * things. Default: Infinity (the aggregate accumulates but never
   * aborts).
   */
  maxTotalCost?: number;
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
  /** Facade mode. Default: 'passthrough' until the Phase 3 flip. */
  mode?: CortexAgentMode;
  /** Talker overrides (duplex mode). */
  talker?: TalkerConfig;
  /**
   * Consumer idle signal for the wake policy (duplex mode): is the
   * user/channel idle right now? Advisory; the facade enforces its own
   * minimum inter-delivery spacing, and a held when_idle delivery degrades
   * to interrupt after a configurable delay.
   */
  idleSignal?: () => boolean;
  /** Duplex router and scheduling tuning (duplex mode). */
  duplex?: DuplexTuningConfig;
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
  // Reasoner and sub-agents (the talker has no read tools). The facade's
  // quick-lookup loops get their own facade-set allowlist regardless.
  readPathAllowlist: 'reasoner',
  // MCP projects to the reasoner (and its sub-agents via tool closures),
  // never the talker. In duplex the facade supplies a shared manager here
  // when the consumer did not: one connection per server total.
  mcpClientManager: 'reasoner',
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
  duplex: 'facade',
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
  switch (toolName) {
    case 'Bash': return str(args['command'])?.slice(0, 120) ?? null;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'UndoEdit': return str(args['file_path']);
    case 'Glob':
    case 'Grep': return str(args['pattern']);
    case 'WebFetch': return str(args['url']);
    default: return null;
  }
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
  config: CortexAgentConfig,
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
  config: CortexAgentConfig,
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
  config: CortexAgentConfig,
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
  config: CortexAgentConfig,
  getBroker: () => PermissionBroker | null,
): CortexAgentConfig {
  if (!config.resolvePermission && !config.resolveNetworkAccess) return config;
  const brokered: CortexAgentConfig = { ...config };
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
  // Asks and headlines.
  getPendingAsks: 'forwarded',
  markAskVoiced: 'forwarded',
  setHeadlineProvider: 'forwarded',
  // Withheld: the facade owns this hook in duplex (the control-tool
  // terminate guards install through it, D17); exposing it would let a
  // consumer displace those guards. Direct AgentLoop users keep it.
  setToolResultInterceptor: 'withheld',
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
  // Withheld: internal causation plumbing (the facade stamps log-entry
  // causedBy from it); the log's causedBy field is the consumer surface.
  activeRunCauseTags: 'withheld',
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

function isZeroUsage(usage: SessionUsage): boolean {
  return (
    usage.totalCost === 0 &&
    usage.totalTurns === 0 &&
    usage.tokens.input === 0 &&
    usage.tokens.output === 0 &&
    usage.tokens.cacheRead === 0 &&
    usage.tokens.cacheWrite === 0 &&
    (usage.utility === undefined || Object.keys(usage.utility).length === 0)
  );
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

/** One macrotask yield: lets pending microtask cascades finish. */
function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * User-facing text of a pi assistant message: text blocks joined, working
 * tags stripped, trimmed. Empty means the message spoke nothing.
 */
function extractSpokenText(assistantMessage: unknown): string {
  const content = (assistantMessage as { content?: unknown } | null | undefined)?.content;
  let raw = '';
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    raw = content
      .filter((block): block is { type: string; text: string } =>
        (block as { type?: string } | null)?.type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string')
      .map((block) => block.text)
      .join('');
  }
  if (raw.length === 0) return '';
  return stripWorkingTags(raw).trim();
}

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
  /** Whether the current reasoner run called Deliver (implicit-delivery guard). */
  private reasonerDeliverCalledThisRun = false;
  /** One truncation repair per streak (D17 stop-reason audit). */
  private talkerRepairPending = false;
  /** The consumer's base prompt without the appended role prompts. */
  private consumerBasePrompt: string | null = null;
  /**
   * The network egress decision function the facade actually enforces: the
   * broker-routed wrapper in duplex, the consumer's own function in
   * passthrough. Exposed via getNetworkAccessResolver() for the sandbox
   * ask-callback wiring.
   */
  private readonly networkResolver: ResolveNetworkAccess | null;
  /** Lazily-built D6 fan-out view over both loops' context managers. */
  private fanOutContextManager: FanOutContextManager | null = null;
  private digestionTimer: ReturnType<typeof setTimeout> | null = null;
  private idleDigestionDelayMs = 10_000;

  /** Serializes facade prompt() calls (concurrent prompts queue, never throw). */
  private promptChain: Promise<void> = Promise.resolve();
  /** Facade prompts accepted but not yet settled (chain-queued or running). */
  private pendingFacadePrompts = 0;
  /** Waiters released whenever pendingFacadePrompts returns to zero. */
  private promptSettlers: Array<() => void> = [];

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
  private retainedTalkerMemory: ObservationalMemoryState | null = null;

  private readonly stateChangedHandlers: Array<(state: CortexAgentStateV2) => void> = [];
  private readonly stateDebounceMs: number;
  private stateDirty = false;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private emittingState = false;

  private destroyPromise: Promise<void> | null = null;
  private destroyed = false;

  private constructor(reasoner: AgentLoop, config: CortexAgentConfig, talker?: AgentLoop) {
    this.mode = config.mode ?? 'passthrough';
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

    if (this.mode === 'duplex') {
      this.wireDuplex(config);
    } else {
      this.wireLogProducers();
    }
    this.wireStateTriggers();
  }

  /**
   * Create a CortexAgent. Routes consumer config per {@link CONFIG_ROUTING}
   * and constructs the resident loop(s): the reasoner alone in passthrough
   * (reproducing direct AgentLoop behavior exactly), or the talker plus the
   * persistent reasoner in duplex.
   */
  static async create(config: CortexAgentConfig): Promise<CortexAgent> {
    if ((config.mode ?? 'passthrough') === 'duplex') {
      // Broker the blocking permission surfaces before the loop configs are
      // built: the loops capture the resolver closures at creation, so the
      // broker reference is late-bound through a box that is filled
      // synchronously below, before create() returns and before any tool
      // call can run. Allow/block/deny decisions pass through untouched;
      // only `ask` routes through the conversation (D16).
      const brokerBox: { broker: PermissionBroker | null } = { broker: null };
      let brokered = withBrokeredPermissions(config, () => brokerBox.broker);
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
        // auto-resolution computes.
        const talkerModel = brokered.talker?.model ?? reasoner.getAutoResolvedUtilityModel();
        talker = await AgentLoop.create(buildTalkerConfig(brokered, talkerModel));
      } catch (err) {
        // A half-assembled duplex must not leak a live reasoner.
        await reasoner.destroy().catch(() => {});
        if (facadeMintedMcp) await sharedMcp.closeAll().catch(() => {});
        throw err;
      }
      const agent = new CortexAgent(reasoner, brokered, talker);
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

  private wireDuplex(config: CortexAgentConfig): void {
    const talker = this.talker!;
    const routerOptions: DuplexRouterOptions = {};
    const tuning = config.duplex;
    if (tuning) {
      for (const key of [
        'minDeliverySpacingMs', 'whenIdleDegradeMs', 'idlePollMs',
        'interruptBucketCapacity', 'interruptRefillMs',
        'deliveryDedupWindowMs', 'deliveryDedupMaxEntries',
        'maxDispatchesPerTurn', 'maxDispatchesPerExchange',
        'watchdogIntervalMs', 'deltaBufferMaxChars',
        'askTimeoutMs', 'escalationAskTimeoutMs', 'settleVoiceDelayMs',
      ] as const) {
        if (tuning[key] !== undefined) {
          (routerOptions as Record<string, unknown>)[key] = tuning[key];
        }
      }
    }

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
        talker.deliver(content, { wake });
      },
      talkerIdle: () => !talker.isLoopActive,
      spawnLookup: (question, causeSeq) => lookups.request(question, causeSeq),
      dispatchToReasoner: (message, causeSeq) => this.dispatchToReasoner(message, causeSeq),
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
      currentReasonerCauseSeq: () => latestCauseSeq(this.reasoner.activeRunCauseTags),
      // The broker's ask lane: a real wake delivery carrying the ask-kind
      // cause tag, so the run that voices the request is identifiable to
      // the consent check (an answer from that same run cannot bind).
      voiceAskToTalker: (content, causeTag) => {
        talker.deliver(content, { wake: true, causeTag });
      },
      // Keep the loop registry's voiced flag truthful for tool asks so
      // headline and consumer surfaces show what has been read out.
      markAskVoiced: (askId) => {
        this.reasoner.markAskVoiced(askId);
      },
      idleSignal: config.idleSignal,
      logger: this.logger,
      talkerLoopPath: talker.loopPath,
      reasonerLoopPath: this.reasoner.loopPath,
    };
    const router = new DuplexRouter(ports, routerOptions);
    this.router = router;

    // The talker carries exactly the control toolset (D5/D8); the reasoner
    // gains Deliver (F1) and SteerSubAgent (D12).
    for (const tool of buildControlTools(router)) {
      talker.addConsumerTool(tool);
    }
    this.reasoner.addConsumerTool(buildDeliverTool({
      deliverFromReasoner: (content, wake, meta) => {
        // An explicit Deliver this run suppresses the implicit final-text
        // delivery for the same run.
        this.reasonerDeliverCalledThisRun = true;
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
      router.noteTalkerReply(output.userFacing);
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
      // The merged surface: loop-registry asks plus broker-minted network
      // asks, so a blocked egress wait is visible in the status block too.
      pendingAsks: () => this.getPendingAsks(),
    });
    this.headlines = headlines;
    talker.setHeadlineProvider(() => headlines.build(), {
      maxTokens: TALKER_HEADLINE_MAX_TOKENS,
    });

    // Run tracking: implicit deliveries, the liveness watchdog, the
    // per-turn dispatch cap, the stop-reason audit, and the headline feed.
    const reasonerBridge = this.reasoner.getEventBridge();
    reasonerBridge.on('loop_start', (event) => {
      if (event.childTaskId) return;
      this.reasonerDeliverCalledThisRun = false;
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
  private dispatchToReasoner(message: string, causeSeq: number | null): void {
    this.reasoner.deliver(
      message,
      causeSeq !== null
        ? { causeTag: { kind: 'directive', seq: causeSeq } satisfies CauseTag }
        : undefined,
    );
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
    const spoken = extractSpokenText(info.assistantMessage);
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
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return;
    }
    this.talkerRepairPending = false;
  }

  /**
   * A reasoner run ended: if it never called Deliver and its final
   * assistant text is user-facing, deliver that text as an implicit
   * when_idle delivery so results always surface (review-findings F1).
   */
  private handleReasonerRunEnd(event: CortexEvent): void {
    this.router?.noteReasonerRunEnd();
    if (this.reasonerDeliverCalledThisRun) return;
    const messages = (event.data as { messages?: unknown[] } | undefined)?.messages;
    if (!Array.isArray(messages)) return;
    let last: { stopReason?: unknown; content?: unknown } | null = null;
    for (const message of messages) {
      if ((message as { role?: string } | null)?.role === 'assistant') {
        last = message as { stopReason?: unknown; content?: unknown };
      }
    }
    if (!last) return;
    if (last.stopReason === 'error' || last.stopReason === 'aborted') return;
    const spoken = extractSpokenText(last);
    if (spoken.length === 0) return;
    this.router?.deliverFromReasoner(spoken, 'when_idle', { implicit: true });
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
        error: err instanceof Error ? err.message : String(err),
      });
    };
    if (this.talker) void this.talker.abort().catch(swallow);
    void this.reasoner.abort().catch(swallow);
    for (const taskId of this.reasoner.getSubAgentManager().getActiveTaskIds()) {
      void this.reasoner.cancelSubAgent(taskId).catch(swallow);
    }
    if (this.lookups) void this.lookups.cancelAll().catch(swallow);
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
    try {
      if (!this.talker.isLoopActive) await this.talker.digestIdle();
    } catch (err) {
      this.logger.warn('talker idle digestion failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (this.destroyed) return;
    try {
      if (!this.reasoner.isLoopActive && this.reasoner.getSubAgentManager().activeCount === 0) {
        await this.reasoner.digestIdle();
      }
    } catch (err) {
      this.logger.warn('reasoner idle digestion failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
    return entry;
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
    // Wake deliveries carry a cause tag (a no-wake delivery is silent
    // context and carries no causation). Only a 'user' speaker mints the
    // consent-qualifying kind: a consumer notification spoken on this
    // surface must never be able to satisfy a pending permission ask.
    return talker.deliver(content, {
      ...(options?.wake !== undefined ? { wake: options.wake } : {}),
      ...(options?.wake !== false
        ? { causeTag: { kind: causeKind, seq: entry.seq } satisfies CauseTag }
        : {}),
    });
  }

  /**
   * Queue a steering message into the running turn (drained at the next
   * turn boundary). No-op while idle, exactly like AgentLoop.steer().
   * Duplex: the conversation surface (the talker) is what a consumer
   * steers; directives reach the reasoner through the router.
   */
  steer(message: string): void {
    this.assertNotDestroyed();
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
   */
  async abort(scope: CortexAbortScope = 'all'): Promise<void> {
    this.assertNotDestroyed();
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
        work.push(this.reasoner.abort());
        for (const taskId of this.reasoner.getSubAgentManager().getActiveTaskIds()) {
          work.push(this.reasoner.cancelSubAgent(taskId));
        }
        // Pending asks belong to the stopped work and settle as deny: tool
        // asks through each aborted run's own signal race, network asks
        // (which carry no signal) here. Double settlement is guarded.
        this.router!.permissionBroker.settleAll('abort');
      }
      await Promise.all(work);
      if (scope === 'conversation') {
        // The work loops kept running, so a voiced ask is still pending,
        // but its voicing delivery was destroyed with the talker's queues
        // (clearAllQueues takes it before the loop's own dead-letter path
        // can report it). Treat it as unheard: withdraw the anchor and read
        // it out again.
        this.router!.permissionBroker.noteVoicingLost();
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
        await Promise.all(teardowns);
      } finally {
        // After the loops detach their listeners: the shared connections
        // (and stdio subprocesses) are facade-owned, so the loops never
        // close them.
        if (this.ownedMcpManager) {
          await this.ownedMcpManager.closeAll().catch(() => {});
        }
        this.mergedBridge?.destroy();
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
    this.assertNotDestroyed();
    return this.log.getLog(fromSeq);
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
    if (talkerUsage) total = addUsage(total, talkerUsage);
    if (lookupUsage) total = addUsage(total, lookupUsage);
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
   * Talker usage under the same model. Null only when no talker loop
   * exists and no restored baseline carries a talker side.
   */
  private talkerUsageWithBaseline(): SessionUsage | null {
    if (!this.talker) {
      return this.usageBaseline?.talker ? cloneUsage(this.usageBaseline.talker) : null;
    }
    const live = this.talker.getSessionUsage();
    if (!this.usageBaseline) return live;
    const delta = this.talkerUsageAtRestore ? diffUsage(live, this.talkerUsageAtRestore) : live;
    const baseline = this.usageBaseline.talker;
    return baseline ? addUsage(baseline, delta) : delta;
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
      return baseline ? cloneUsage(baseline) : null;
    }
    const live = this.lookups.getSettledUsage();
    const delta = this.lookupUsageAtRestore ? diffUsage(live, this.lookupUsageAtRestore) : live;
    const combined = baseline ? addUsage(baseline, delta) : delta;
    return isZeroUsage(combined) ? null : combined;
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
      talker: v2.usage.perLoop.talker ? cloneUsage(v2.usage.perLoop.talker) : null,
      reasoner: cloneUsage(v2.usage.perLoop.reasoner),
      lookups: v2.usage.perLoop.lookups ? cloneUsage(v2.usage.perLoop.lookups) : null,
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
    // the replaced session too.
    this.router?.resetForRestore();
    // The aggregate guard's counters describe the replaced session's spend;
    // without a reset a lifetime breach would keep aborting the restored
    // session forever and re-log a breach against a pre-restore total.
    this.aggregateGuard?.reset();
    this.aggregateBreachLogged = false;
    this.talkerRepairPending = false;
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
          error: err instanceof Error ? err.message : String(err),
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
    return this.pendingFacadePrompts === 0 && !this.conversationLoop.isLoopActive;
  }

  /**
   * Whether all work has settled: conversation idle, reasoner gate empty,
   * no active sub-agents or quick lookups, no parked wake deliveries on
   * either loop, no router-held deliveries, no pending permission asks.
   * Queued silent deliveries do not count: silent content deliberately
   * waits for the next prompt.
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
      this.reasoner.getPendingAsks().length === 0
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
   * The budget guard with composite meaning: the facade's aggregate guard
   * in duplex (lifetime scope over both loops, children, and utility
   * spend), the reasoner's own guard in passthrough.
   */
  getBudgetGuard(): BudgetGuard {
    return this.aggregateGuard ?? this.reasoner.getBudgetGuard();
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

  /**
   * Set the cache session id. Duplex derives the talker's stable id from
   * the same value (distinct per-loop prefix caches, log-and-context.md);
   * the reasoner keeps the bare id so mode flips keep its cache warm.
   */
  setSessionId(value: string | null): void {
    this.reasoner.setSessionId(value);
    this.talker?.setSessionId(value === null ? null : `${value}:talker`);
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
   * Accumulated session usage: the composite aggregate across both loops
   * and settled quick lookups (children counted once via each loop's own
   * accounting), under the baseline-plus-delta restore model, so totals
   * survive restores without double-counting.
   */
  getSessionUsage(): SessionUsage {
    let total = this.reasonerUsageWithBaseline();
    const talker = this.talkerUsageWithBaseline();
    if (talker) total = addUsage(total, talker);
    const lookups = this.lookupUsageWithBaseline();
    if (lookups) total = addUsage(total, lookups);
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
   * Permission asks currently blocked on a decision. Tool and escalation
   * asks come from the reasoner's registry (its sub-agents mirror in); in
   * duplex, broker-minted network egress asks are appended, since those
   * never enter a loop registry. Ids never overlap between the two sources.
   */
  getPendingAsks(): PendingAsk[] {
    const asks = this.reasoner.getPendingAsks();
    const broker = this.router?.permissionBroker;
    if (!broker) return asks;
    const networkAsks = broker.getPendingAsks()
      .filter((ask) => ask.kind === 'network')
      .map(({ kind: _kind, ...ask }) => ask);
    return [...asks, ...networkAsks];
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
   * (cortex-sandbox `onNetworkRequest`) with `via: 'shell'`, so shell
   * egress asks flow through the same broker pipeline as WebFetch instead
   * of blocking a loop invisibly.
   */
  getNetworkAccessResolver(): ResolveNetworkAccess | undefined {
    return this.networkResolver ?? undefined;
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
  // BOTH resident loops (origin context distinguishes them), while
  // sub-agent callbacks stay on the reasoner (the only loop that spawns).

  /** Every resident loop, for handlers that fan out in duplex. */
  private get residentLoops(): AgentLoop[] {
    return this.talker ? [this.reasoner, this.talker] : [this.reasoner];
  }

  onLoopComplete(handler: () => void): void {
    for (const loop of this.residentLoops) loop.onLoopComplete(handler);
  }

  onError(handler: (error: ClassifiedError, origin: LoopOriginContext) => void): void {
    for (const loop of this.residentLoops) loop.onError(handler);
  }

  onTurnComplete(handler: (output: AgentTextOutput, origin: LoopOriginContext) => void): void {
    for (const loop of this.residentLoops) loop.onTurnComplete(handler);
  }

  onRetryScheduled(handler: (info: RetryScheduledInfo) => void): void {
    for (const loop of this.residentLoops) loop.onRetryScheduled(handler);
  }

  onRetrySucceeded(handler: (info: RetrySucceededInfo) => void): void {
    for (const loop of this.residentLoops) loop.onRetrySucceeded(handler);
  }

  onRetryExhausted(handler: (info: RetryExhaustedInfo) => void): void {
    for (const loop of this.residentLoops) loop.onRetryExhausted(handler);
  }

  onBeforeCompaction(handler: (target: CompactionTarget) => Promise<void>): void {
    for (const loop of this.residentLoops) loop.onBeforeCompaction(handler);
  }

  onPostCompaction(handler: (result: CompactionResult) => void): void {
    for (const loop of this.residentLoops) loop.onPostCompaction(handler);
  }

  onCompactionError(handler: (error: Error) => void): void {
    for (const loop of this.residentLoops) loop.onCompactionError(handler);
  }

  onCompactionDegraded(handler: (info: CompactionDegradedInfo) => void): void {
    for (const loop of this.residentLoops) loop.onCompactionDegraded(handler);
  }

  onCompactionExhausted(handler: (info: CompactionExhaustedInfo) => void): void {
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

  onObservation(handler: (event: ObservationEvent) => void): void {
    for (const loop of this.residentLoops) loop.onObservation(handler);
  }

  onReflection(handler: (event: ReflectionEvent) => void): void {
    for (const loop of this.residentLoops) loop.onReflection(handler);
  }
}
