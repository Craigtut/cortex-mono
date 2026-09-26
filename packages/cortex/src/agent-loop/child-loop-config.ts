/**
 * How a sub-agent's loop is configured from its parent: the parent's
 * model, tool tuning, sandbox, egress gate, credentials, and persistence
 * carry over; budgets can tighten but never loosen; the consumer's
 * onBeforeSubAgentSpawn hook can curate the child's prompt, tools, and a
 * background seed before the child is built.
 */

import type { CortexModel } from '../model-wrapper.js';
import type {
  AgentLoopConfig,
  CortexCompactionConfig,
  CortexLogger,
  PersistResultFn,
  SubAgentSpawnAugmentation,
  ThinkingLevel,
} from '../types.js';
import { errorMessageOf } from '../error-classifier.js';
import type { ManagedLoopParams, RegisteredTool } from './pi-agent.js';

/** Leading context slot used to seed a sub-agent with background context. */
export const CHILD_SEED_CONTEXT_SLOT = '_seed_context';

type PermissionResolver = NonNullable<AgentLoopConfig['resolvePermission']>;

/** What a spawn asks of its child loop. */
export interface ChildLoopParams {
  taskId: string;
  instructions: string;
  tools?: string[];
  systemPrompt?: string;
  maxTurns?: number;
  maxCost?: number;
  model?: CortexModel;
  thinkingLevel?: ThinkingLevel;
  compaction?: Partial<CortexCompactionConfig>;
  background?: boolean;
}

/** The parent state a child's configuration derives from. */
export interface ChildLoopParent {
  config: AgentLoopConfig;
  model: CortexModel;
  workingTagsEnabled: boolean;
  contextWindowLimit: number | null;
  loopPath: string;
  prompt: { base: string | null; current: string };
  rawPersistResult: PersistResultFn | undefined;
  resultThresholds: Record<string, number> | undefined;
  inheritableTools(requested?: string[]): RegisteredTool[];
  /** The resolver the child consults, or undefined when the parent has none. */
  childResolver(taskId: string): PermissionResolver | undefined;
  logger: CortexLogger;
}

/**
 * Everything the managed factory needs to build the child, plus the
 * background seed to place in its leading slot once built.
 */
export async function prepareChildLoop(
  parent: ChildLoopParent,
  params: ChildLoopParams,
): Promise<{ createParams: ManagedLoopParams; seedContext: string | undefined }> {
  // Pre-spawn hook: lets the consumer record the spawn and curate the
  // child's starting context (system prompt, tools, background seed) before
  // the child is built. Purely additive; errors are swallowed.
  let augmentation: SubAgentSpawnAugmentation | void = undefined;
  if (parent.config.onBeforeSubAgentSpawn) {
    try {
      augmentation = await parent.config.onBeforeSubAgentSpawn({
        taskId: params.taskId,
        instructions: params.instructions,
        background: params.background ?? false,
        ...(params.tools ? { requestedTools: params.tools } : {}),
        ...(params.systemPrompt ? { requestedSystemPrompt: params.systemPrompt } : {}),
      });
    } catch (err) {
      parent.logger.error('onBeforeSubAgentSpawn handler threw', {
        taskId: params.taskId,
        error: errorMessageOf(err),
      });
    }
  }
  const effectiveSystemPrompt = augmentation?.systemPrompt ?? params.systemPrompt;
  const effectiveTools = augmentation?.tools ?? params.tools;
  const seedContext = augmentation?.seedContext;
  const promptSeed = resolveChildPromptSeed(parent.prompt, effectiveSystemPrompt);

  const createParams: ManagedLoopParams = {
    cortexConfig: buildChildLoopConfig(parent, params, Boolean(seedContext)),
    tools: parent.inheritableTools(effectiveTools),
    constructorOptions: {
      enableSubAgentTool: false,
      enableLoadSkillTool: false,
    },
    missingDependencyMessage:
      'Sub-agent spawning requires @earendil-works/pi-agent-core to be installed.',
  };
  if (promptSeed.initialBasePrompt !== undefined) {
    createParams.initialBasePrompt = promptSeed.initialBasePrompt;
  }
  if (promptSeed.initialSystemPrompt !== undefined) {
    createParams.initialSystemPrompt = promptSeed.initialSystemPrompt;
  }
  return { createParams, seedContext: seedContext || undefined };
}

/** The child's AgentLoopConfig, derived from its parent's. */
export function buildChildLoopConfig(
  parent: ChildLoopParent,
  params: ChildLoopParams,
  seeded: boolean,
): AgentLoopConfig {
  const { config } = parent;
  const budget = clampChildBudget(config.budgetGuard, params);
  const childCortexConfig: AgentLoopConfig = {
    // Per-spawn model override; the child's utility model re-resolves from
    // this model's provider, so a fast-model spawn stays fast end to end.
    model: params.model ?? parent.model,
    workingDirectory: config.workingDirectory,
    workingTags: { enabled: parent.workingTagsEnabled },
    budgetGuard: {
      maxTurns: budget.maxTurns,
      maxCost: budget.maxCost,
    },
    contextWindowLimit: parent.contextWindowLimit,
    // Each sub-agent is its own logical session for prefix-cache routing.
    sessionId: params.taskId,
    // The child's identity extends this loop's path, so its asks, errors,
    // and log lines are attributable through the spawn chain.
    loopPath: `${parent.loopPath}/${params.taskId}`,
  };
  if (params.thinkingLevel !== undefined) {
    childCortexConfig.thinkingLevel = params.thinkingLevel;
  }
  if (params.compaction !== undefined) {
    childCortexConfig.compaction = params.compaction;
  }
  if (seeded) {
    childCortexConfig.slots = [CHILD_SEED_CONTEXT_SLOT];
  }
  if (config.logger) childCortexConfig.logger = config.logger;
  if (config.envOverrides) childCortexConfig.envOverrides = config.envOverrides;
  // Inherit tool tuning so a child's Bash and WebFetch behave like the
  // parent's (shell override, auto-yield timing, fetch rate limit).
  if (config.bash) childCortexConfig.bash = config.bash;
  if (config.webFetch) childCortexConfig.webFetch = config.webFetch;
  // Share the parent's sandbox provider so a sub-agent's shell commands are
  // contained by the same OS boundary. Sharing the instance (not cloning) is
  // correct: the underlying SandboxManager is a process-global singleton.
  if (config.sandbox) childCortexConfig.sandbox = config.sandbox;
  // A read-restricted parent must not spawn read-unrestricted children.
  if (config.readPathAllowlist) {
    childCortexConfig.readPathAllowlist = config.readPathAllowlist;
  }
  // Share the egress gate so a sub-agent's WebFetch answers to the same
  // network policy and grant set as the parent's.
  if (config.resolveNetworkAccess) {
    childCortexConfig.resolveNetworkAccess = config.resolveNetworkAccess;
  }
  if (config.getApiKey) childCortexConfig.getApiKey = config.getApiKey;
  // Inherit tool result persistence so child tool calls (Bash, Grep, WebFetch
  // inside a sub-agent doing research) get the same protection as the parent.
  // The raw consumer callback, so the child stamps its own loopPath.
  if (parent.rawPersistResult) childCortexConfig.persistResult = parent.rawPersistResult;
  if (parent.resultThresholds) childCortexConfig.toolResultThresholds = parent.resultThresholds;
  const resolvePermission = parent.childResolver(params.taskId);
  if (resolvePermission) childCortexConfig.resolvePermission = resolvePermission;

  return childCortexConfig;
}

/** A child's budget limits: a spawn can tighten the parent's, never loosen them. */
export function clampChildBudget(
  parentBudget: AgentLoopConfig['budgetGuard'],
  params: {
    maxTurns?: number;
    maxCost?: number;
  },
): { maxTurns: number; maxCost: number } {
  const parentMaxTurns = parentBudget?.maxTurns ?? Infinity;
  const parentMaxCost = parentBudget?.maxCost ?? Infinity;

  return {
    maxTurns: params.maxTurns
      ? Math.min(params.maxTurns, parentMaxTurns)
      : parentMaxTurns,
    maxCost: params.maxCost
      ? Math.min(params.maxCost, parentMaxCost)
      : parentMaxCost,
  };
}

/**
 * The child's starting prompt: the spawn's own system prompt as its base,
 * else the parent's base prompt, else the parent's assembled prompt as is.
 */
export function resolveChildPromptSeed(
  parentPrompt: { base: string | null; current: string },
  systemPrompt?: string,
): {
  initialBasePrompt?: string;
  initialSystemPrompt?: string;
} {
  if (typeof systemPrompt === 'string') {
    return { initialBasePrompt: systemPrompt };
  }
  const base = parentPrompt.base;
  if (base !== null) {
    return { initialBasePrompt: base };
  }
  return { initialSystemPrompt: parentPrompt.current };
}
