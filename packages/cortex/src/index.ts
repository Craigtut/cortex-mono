/**
 * @animus-labs/cortex
 *
 * Production-grade agent wrapper for pi-agent-core.
 * Provides context management, MCP tool support, tool permissions,
 * budget guards, compaction, skill system, and event logging.
 *
 * Phase 1A exports: types and pure utility modules.
 * Phase 1B exports: AgentLoop, ContextManager, EventBridge, BudgetGuard.
 * Phase 1C exports: Built-in tools (Read, Write, Edit, Glob, Grep, Bash, TaskOutput, WebFetch).
 * Phase 1D exports: ProviderManager, model wrapper, provider registry.
 */

// Types
export type {
  CortexLogger,
  CortexUsage,
  SessionUsage,
  UtilityUsageBucket,
  UtilityUsagePayload,
  CortexLifecycleState,
  CortexToolPermissionDecision,
  CortexToolPermissionResult,
  ToolPermissionRequestContext,
  PendingAsk,
  LoopOriginContext,
  AgentLoopConfig,
  CortexDiagnosticsConfig,
  ContextManagerConfig,
  ErrorCategory,
  ErrorSeverity,
  ClassifiedError,
  RetryPolicy,
  RetryScheduledInfo,
  RetrySucceededInfo,
  RetryExhaustedInfo,
  AgentTextOutput,
  ToolContentDetails,
  BudgetGuardConfig,
  BudgetScope,
  ToolCategory,
  MicrocompactionConfig,
  CompactionConfig,
  FailsafeConfig,
  AdaptiveThresholdConfig,
  CortexCompactionConfig,
  CompactionTarget,
  CompactionResult,
  CompactionDegradedInfo,
  CompactionExhaustedInfo,
  PersistResultFn,
  CortexEvents,
  UtilityModelDefaults,
  McpTransportConfig,
  McpStdioConfig,
  McpHttpConfig,
  McpConnectionState,
  McpRedactedTransportConfig,
  McpRedactedStdioConfig,
  McpRedactedHttpConfig,
  McpToolCallProgress,
  SkillConfig,
  SkillEntry,
  LoadedSkill,
  CortexScriptContext,
  SubAgentSpawnConfig,
  SubAgentSpawnRequest,
  SubAgentSpawnAugmentation,
  SubAgentSnapshot,
  SubAgentResult,
  SubAgentHandle,
  SubAgentBudgetView,
  DeadLetteredBackgroundResult,
  TrackedSubAgent,
  ThinkingLevel,
  ModelThinkingCapabilities,
  ToolExecuteContext,
  ToolCallStartPayload,
  ToolCallUpdatePayload,
  ToolCallEndPayload,
  PromptWatchdogDiagnosticsConfig,
} from './types.js';

// Logger
export { NOOP_LOGGER } from './noop-logger.js';

// Schema Converter
export { zodToTypebox } from './schema-converter.js';

// Token Estimator
export { estimateTokens } from './token-estimator.js';

// Working Tags Parser
export {
  stripWorkingTags,
  extractWorkingContent,
  parseWorkingTags,
} from './working-tags.js';

// Error Classifier
export { classifyError, extractCauseDetail } from './error-classifier.js';
export type { ClassifyErrorOptions } from './error-classifier.js';

// Retry Policy
export {
  DEFAULT_RETRY_POLICY,
  resolveRetryPolicy,
  backoffForAttempt,
  shouldRetry,
  isRetryableCategory,
} from './retry-policy.js';
export type { RetryDecisionContext } from './retry-policy.js';

// Context Manager (Phase 1B)
export { ContextManager } from './context-manager.js';
export type {
  AgentMessage,
  AgentStateAccessor,
  AgentContext,
} from './context-manager.js';

// Cache Breakpoints (shared by the agentic loop and direct completions)
export {
  computeCacheBreakpointIndices,
  applyCacheBreakpoints,
  addCacheControlToMessage,
  resolveDirectCompletionContext,
} from './cache-breakpoints.js';
export type {
  CacheBreakpointIndices,
  CacheBreakpointRegions,
  RawCompletionContext,
  StructuredCompletionContext,
  DirectCompletionContext,
  ResolvedCompletionContext,
} from './cache-breakpoints.js';

// Event Bridge (Phase 1B)
export { EventBridge } from './event-bridge.js';
export type {
  CortexEventType,
  CortexEvent,
  CortexEventListener,
  PiEventType,
  PiEvent,
  PiEventSource,
} from './event-bridge.js';

// Budget Guard (Phase 1B)
export { BudgetGuard } from './budget-guard.js';

// AgentLoop (Phase 1B)
export { AgentLoop, MINIMUM_CONTEXT_WINDOW, TOOL_RESULT_WORKING_TAGS_REMINDER } from './agent-loop.js';
export type {
  PiAgent,
  PiModel,
  DirectCompletionOptions,
  DeliverOptions,
  DeliverOutcome,
  DeliverResult,
  IdleDigestionResult,
  QueueDrainMode,
} from './agent-loop.js';

// Tool Contracts
export { fromPiAgentTool, assertValidCortexTool } from './tool-contract.js';
export type { CortexTool, PiAgentTool } from './tool-contract.js';

// MCP Client Manager (Phase 3)
export { McpClientManager } from './mcp-client.js';
export type { AgentTool } from './mcp-client.js';

// Built-in Tools (Phase 1C)
export {
  ReadRegistry,
  CwdTracker,
  CortexToolRuntime,
  BackgroundTaskStore,
  WebFetchRuntimeState,
  globalBackgroundTaskStore,
  attachRuntimeAwareTool,
  getRuntimeAwareToolMetadata,
  cloneRuntimeAwareTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createBashTool,
  BASH_ESCALATION_PERMISSION_NAME,
  isBashEscalationRequest,
  createTaskOutputTool,
  createWebFetchTool,
  WebFetchCache,
  getBackgroundTask,
  getAllBackgroundTasks,
  buildSafeEnv,
  isCriticalPath,
  classifyCommand,
  checkObfuscation,
  stripInvisibleChars,
  checkScriptPreflight,
  checkAutoModeClassifier,
  runSafetyChecks,
  validateWritePaths,
  extractWritePaths,
  findCatastrophicCommand,
  splitBashCommand,
  isCompoundBash,
  isPathSameOrDescendant,
  realpathIfExists,
  resolveThroughExistingAncestor,
  resolveThroughExistingAncestorSync,
  TOOL_NAMES,
} from './tools/index.js';
export type {
  ReadDetails,
  ReadParamsType,
  ReadToolConfig,
  WriteDetails,
  WriteParamsType,
  WriteToolConfig,
  DiffHunk,
  EditDetails,
  EditParamsType,
  EditToolConfig,
  GlobDetails,
  GlobParamsType,
  GlobToolConfig,
  GrepDetails,
  GrepParamsType,
  GrepToolConfig,
  BashDetails,
  BashStreamUpdate,
  BashParamsType,
  BashToolConfig,
  BackgroundTask,
  TaskOutputDetails,
  TaskOutputParamsType,
  TaskOutputToolConfig,
  WebFetchDetails,
  WebFetchParamsType,
  WebFetchToolConfig,
  CacheEntry,
  CommandClassification,
  SafetyCheckResult,
  CatastrophicCategory,
  CatastrophicContext,
  CatastrophicFinding,
  SplitBashOptions,
  BuiltInToolName,
  SubAgentToolConfig,
  SubAgentDetails,
  SubAgentParamsType,
} from './tools/index.js';

// Skill System (Phase 4)
export { SkillRegistry, parseFrontmatter } from './skill-registry.js';
export { preprocessSkillBody, substituteVariables, executeShellCommand, executeScript } from './skill-preprocessor.js';
export { createLoadSkillTool, buildLoadSkillDescription, LOAD_SKILL_TOOL_NAME } from './skill-tool.js';
export type { LoadSkillToolConfig, LoadSkillParamsType } from './skill-tool.js';
export { LoadSkillParams } from './skill-tool.js';

// Sub-Agent Manager (Phase 4)
export { SubAgentManager } from './sub-agent-manager.js';
export type { SubAgentManagerConfig, SubAgentLifecycleHooks } from './sub-agent-manager.js';

// Deferred Tool Loading / ToolSearch
export { DeferredToolRegistry } from './tools/tool-search/registry.js';
export type { ToolSearchResult } from './tools/tool-search/registry.js';
export {
  createToolSearchTool,
  TOOL_SEARCH_TOOL_NAME,
  ToolSearchParams,
} from './tools/tool-search/index.js';
export type {
  ToolSearchToolConfig,
  ToolSearchDetails,
  ToolSearchParamsType,
} from './tools/tool-search/index.js';
export type { DeferredToolsConfig } from './types.js';

// Sandbox seam (types + provider contract; enforcement is consumer-supplied)
export type {
  SandboxRung,
  SandboxFilesystemPolicy,
  SandboxNetworkMode,
  SandboxNetworkPolicy,
  SandboxPolicy,
  SandboxEnforcement,
  SandboxBackend,
  SandboxStatus,
  SandboxSpawnSpec,
  SandboxExecSpec,
  WrappedSpawn,
  SandboxDenial,
  SandboxCommandFailure,
  SandboxProvider,
  NetworkAccessRequest,
  NetworkAccessScope,
  NetworkAccessDecision,
  ResolveNetworkAccess,
} from './sandbox/index.js';

// Compaction (Phase 5)
export {
  CompactionManager,
  buildCompactionConfig,
  DEFAULT_COMPACTION_CONFIG,
  ADAPTIVE_DEFAULTS,
  computeAdaptiveThreshold,
  MicrocompactionEngine,
  capToolResult,
  runCompaction,
  shouldCompact,
  partitionHistory,
  buildSummaryMessage,
  emergencyTruncate,
  shouldTruncate,
  isContextOverflow,
} from './compaction/index.js';

// Tool Result Persistence (proactive interceptor at the tool execution boundary)
export {
  applyResultPersistence,
  processToolResult,
  resolveThreshold,
  MAX_RESULT_TOKENS,
  BOOKEND_CHARS,
  SKIP_RESULT_PERSISTENCE,
  DEFAULT_TOOL_THRESHOLDS,
} from './tool-result-persistence.js';
export type {
  ApplyPersistenceOptions,
  ProcessResultOptions,
} from './tool-result-persistence.js';
export type {
  TrimAction,
  TrimState,
  CompleteFn,
  FailsafeTruncationResult,
  ObservationalMemoryConfig,
  ObservationalMemoryState,
  ObservationEvent,
  ReflectionEvent,
  RecallConfig,
  RecallResult,
} from './compaction/index.js';

// Model Wrapper (Phase 1D)
export { wrapModel, unwrapModel, isCortexModel } from './model-wrapper.js';
export type { CortexModel } from './model-wrapper.js';
export { inferUtilityModel, inferUtilityModelId } from './utility-model-inference.js';

// Provider Registry (Phase 1D)
export {
  PROVIDER_REGISTRY,
  OAUTH_PROVIDER_IDS,
  UTILITY_MODEL_OVERRIDES,
  UTILITY_MODEL_DEFAULTS,
  PRIMARY_MODEL_DEFAULTS,
  PROVIDER_CACHE_CONFIG,
  resolveCacheRetention,
} from './provider-registry.js';
export type {
  AuthMethod,
  ProviderInfo,
  ModelInfo,
  ProviderCacheConfig,
  CacheRetention,
} from './provider-registry.js';

// Provider Manager (Phase 1D)
export { ProviderManager, OAuthError } from './provider-manager.js';
export type {
  OAuthErrorCode,
  IProviderManager,
  ProviderManagerOptions,
  OAuthCallbackRoute,
  OAuthCallbacks,
  OAuthAuthInfo,
  OAuthFlowType,
  OAuthPromptInfo,
  OAuthCallbackPageContext,
  OAuthCallbackPageRenderer,
  OAuthCallbackPageStatus,
  OAuthMeta,
  OAuthResult,
  OAuthRefreshResult,
  CustomModelConfig,
  ApiKeyValidationStatus,
  ApiKeyValidationResult,
} from './provider-manager.js';
