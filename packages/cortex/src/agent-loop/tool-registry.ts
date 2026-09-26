/**
 * The loop's tool set: registered tools (built-ins, consumer tools, and
 * Cortex's own orchestration tools) plus MCP tools, adapted to pi's
 * execute signature with result persistence applied at the execution
 * boundary, and partitioned into loaded and deferred sets when deferred
 * loading is on (ToolSearch loads the deferred ones on demand).
 */

import type { ContextManager } from '../context-manager.js';
import { processToolResult } from '../tool-result-persistence.js';
import { assertValidCortexTool } from '../tool-contract.js';
import type { CortexTool } from '../tool-contract.js';
import { toolCallSubject } from '../tools/tool-call-subject.js';
import { TOOL_NAMES } from '../tools/tool-names.js';
import { cloneRuntimeAwareTool, CortexToolRuntime } from '../tools/runtime.js';
import { SUB_AGENT_TOOL_NAME } from '../tools/sub-agent.js';
import { DeferredToolRegistry } from '../tools/tool-search/registry.js';
import { LOAD_SKILL_TOOL_NAME } from '../skill-tool.js';
import type {
  AgentLoopConfig,
  CortexLogger,
  PersistResultFn,
  ToolCategory,
  ToolExecuteContext,
} from '../types.js';
import type { RegisteredTool } from './pi-agent.js';

export interface ToolRegistryPorts {
  mcpTools(): CortexTool[];
  /** Hand pi the adapted tool list. */
  writeAgentTools(tools: unknown[]): void;
  /** The tool set changed (the system prompt names the tools it has). */
  onToolsChanged(): void;
  /** The loop's refreshTools(), so a spy on it sees every re-sync. */
  refreshTools(): void;
  slots: Pick<ContextManager, 'getSlot' | 'setSlot'>;
  logger: CortexLogger;
  loopPath: string;
}

/** The microcompaction settings persistence is shared with. */
interface MicrocompactionSettings {
  persistResult?: PersistResultFn;
  toolCategories?: Record<string, ToolCategory>;
}

export class ToolRegistry {
  readonly runtime: CortexToolRuntime;
  readonly deferredRegistry = new DeferredToolRegistry();
  readonly deferredEnabled: boolean;
  private readonly deferMcp: boolean;
  private readonly deferredAlwaysLoad: ReadonlySet<string>;
  private readonly tools: RegisteredTool[] = [];
  private currentPiTools: unknown[] = [];

  // Tool result persistence (proactive, at execution boundary). The same
  // callback flows to compaction (reactive) via the microcompaction config.
  // `persistResult` is the consumer callback wrapped to stamp this loop's
  // identity into metadata; `rawPersistResult` is the unwrapped consumer
  // callback, inherited by child loops so they stamp their own path.
  private persistResult?: PersistResultFn;
  private persistResultRaw?: PersistResultFn;
  private toolCategories?: Record<string, ToolCategory>;
  private thresholds?: Record<string, number>;

  constructor(
    config: AgentLoopConfig,
    private readonly ports: ToolRegistryPorts,
  ) {
    this.runtime = new CortexToolRuntime(config.workingDirectory);
    this.deferredEnabled = config.deferredTools?.enabled ?? false;
    this.deferMcp = config.deferredTools?.deferMcp ?? true;
    this.deferredAlwaysLoad = new Set(config.deferredTools?.alwaysLoad ?? []);
  }

  /**
   * Adopt the loop's result-persistence settings. Top-level
   * config.persistResult wins over the compaction config's, and the
   * (identity-stamped) callback is written back into the microcompaction
   * settings so the reactive paths (compaction trim, aggregate budget
   * enforcement) and the proactive interceptor share it.
   */
  bindPersistence(config: AgentLoopConfig, microcompaction: MicrocompactionSettings): void {
    if (config.persistResult && microcompaction.persistResult
      && microcompaction.persistResult !== config.persistResult) {
      this.ports.logger.debug('top-level persistResult overrides compaction.microcompaction.persistResult');
    }
    // Backwards compatibility: a callback set only on the compaction config
    // is used for the proactive interceptor as well.
    const consumerPersistResult = config.persistResult ?? microcompaction.persistResult;
    if (consumerPersistResult) {
      this.persistResultRaw = consumerPersistResult;
      this.persistResult = (content, metadata) =>
        consumerPersistResult(content, { ...metadata, loopPath: this.ports.loopPath });
      microcompaction.persistResult = this.persistResult;
    }
    if (microcompaction.toolCategories) {
      this.toolCategories = microcompaction.toolCategories;
    }
    if (config.toolResultThresholds) {
      this.thresholds = config.toolResultThresholds;
    }
  }

  /** The consumer's unwrapped persistence callback, for child loops. */
  get rawPersistResult(): PersistResultFn | undefined {
    return this.persistResultRaw;
  }

  get resultThresholds(): Record<string, number> | undefined {
    return this.thresholds;
  }

  /** The registered tools (live; MCP tools excluded). */
  get registered(): RegisteredTool[] {
    return this.tools;
  }

  has(name: string): boolean {
    return this.tools.some((tool) => tool.name === name);
  }

  /** Normalize and register tools without re-syncing pi (construction). */
  register(tools: RegisteredTool[]): void {
    this.tools.push(...this.normalize(tools));
  }

  /** Register a tool this loop built for itself, as is (no re-sync). */
  registerInternal(tool: RegisteredTool): void {
    this.tools.push(tool);
  }

  /**
   * Normalize registered tools so this agent owns fresh mutable state and
   * everything stored internally uses Cortex's canonical tool contract.
   */
  normalize(tools: RegisteredTool[]): RegisteredTool[] {
    return tools.map((tool) => {
      const runtimeOwnedTool = cloneRuntimeAwareTool(tool, this.runtime) ?? tool;
      return assertValidCortexTool(runtimeOwnedTool);
    });
  }

  /**
   * Process a tool result through the result-persistence interceptor.
   * Delegates to the shared `processToolResult` helper, supplying instance
   * state (persistResult callback, tool categories, threshold overrides).
   */
  private applyPersistence(
    toolName: string,
    toolCallId: string,
    result: unknown,
  ): Promise<unknown> {
    return processToolResult(result, {
      toolName,
      toolCallId,
      persistResult: this.persistResult,
      toolCategories: this.toolCategories,
      thresholds: this.thresholds,
    });
  }

  /**
   * Pi 0.74 snapshots the agent state when prompt() starts. When ToolSearch
   * loads deferred tools mid-run, keep the active loop context in sync so the
   * next automatic provider call sees the newly loaded schemas.
   */
  syncActiveLoopTools(ctx: unknown): void {
    if (!this.deferredEnabled) return;
    if (!ctx || typeof ctx !== 'object') return;
    const context = (ctx as { context?: { tools?: unknown[] } }).context;
    if (!context || !Array.isArray(context.tools)) return;
    context.tools = [...this.currentPiTools];
  }

  /**
   * Update the agent's tool set by adapting Cortex's canonical in-process
   * tool contract to pi-agent-core's raw execute signature.
   *
   * When deferred tools are enabled, this also partitions the union of
   * registered + MCP tools into a "loaded" set (sent to the API) and a
   * "deferred" set (announced by name in the `_available_tools` slot).
   */
  refresh(): void {
    const mcpTools = this.ports.mcpTools();
    const candidateTools: CortexTool[] = [...this.tools, ...mcpTools];

    const { loaded, deferred } = this.deferredEnabled
      ? this.partitionDeferredTools(candidateTools)
      : { loaded: candidateTools, deferred: [] as CortexTool[] };

    if (this.deferredEnabled) {
      this.deferredRegistry.setDeferredPool(deferred);
      this.updateAvailableToolsSlot();
    }

    const allTools = loaded.map(tool => {
      const toolWithOptionalLabel = tool as unknown as { label?: unknown; name: string };
      const label = typeof toolWithOptionalLabel.label === 'string'
        ? toolWithOptionalLabel.label
        : tool.name;

      return {
        ...tool,
        label,
        execute: async (
          toolCallId: string,
          params: unknown,
          signal?: AbortSignal,
          onUpdate?: (partialResult: unknown) => void,
        ) => {
          const context: ToolExecuteContext = { toolCallId };
          if (signal) context.signal = signal;
          if (onUpdate) context.onUpdate = onUpdate;
          const toolStartMs = Date.now();
          const result = await tool.execute(params, context);
          this.ports.logger.debug('[Tool] executed', {
            name: tool.name,
            durationMs: Date.now() - toolStartMs,
            ...summarizeToolArgsForLog(tool.name, params),
          });
          // Already correct format: must have content as a non-empty array
          if (result && typeof result === 'object' && 'content' in (result as Record<string, unknown>)) {
            const asObj = result as Record<string, unknown>;
            if (Array.isArray(asObj['content']) && asObj['content'].length > 0) {
              return await this.applyPersistence(tool.name, toolCallId, result);
            }
            // Has 'content' key but it's undefined, null, empty, or non-array.
            // Fall through to wrap as text.
          }
          // Wrap string/primitive return values
          const wrapped = {
            content: [{ type: 'text', text: typeof result === 'string' ? result : String(result ?? '') }],
            details: {},
          };
          return await this.applyPersistence(tool.name, toolCallId, wrapped);
        },
      };
    });
    this.currentPiTools = allTools;
    this.ports.writeAgentTools(allTools);
    this.ports.onToolsChanged();
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
  isPermissionExempt(toolName: string): boolean {
    if (toolName === SUB_AGENT_TOOL_NAME) return true;
    const tool = this.tools.find((t) => t.name === toolName);
    return tool !== undefined && tool.permissionExempt === true && tool.isMcp !== true;
  }

  /**
   * Register an additional consumer-provided tool at runtime.
   * Useful for dynamic tool management (e.g., enabling a tool after agent
   * creation based on user permission changes).
   */
  add(tool: CortexTool): void {
    const normalized = this.normalize([tool]);
    if (normalized.length === 0) return;
    const existing = this.tools.findIndex(t => t.name === tool.name);
    if (existing >= 0) {
      this.tools[existing] = normalized[0]!;
    } else {
      this.tools.push(normalized[0]!);
    }
    this.ports.refreshTools();
  }

  /**
   * Remove a consumer-provided tool by name at runtime.
   * Built-in tools cannot be removed.
   */
  remove(toolName: string): void {
    const idx = this.tools.findIndex(t => t.name === toolName);
    if (idx >= 0) {
      this.tools.splice(idx, 1);
      this.ports.refreshTools();
    }
  }

  /**
   * Partition candidate tools into "loaded" (sent on every turn) and
   * "deferred" (announced by name in the `_available_tools` slot).
   *
   * A tool is deferred when:
   *   - It is not in the consumer's `alwaysLoad` allowlist, AND
   *   - Its `alwaysLoad` field is not true, AND
   *   - It has not been discovered via ToolSearch this session, AND
   *   - Either `tool.shouldDefer === true` OR
   *     (`tool.isMcp === true` AND `_deferMcp` is true)
   */
  private partitionDeferredTools(
    candidates: readonly CortexTool[],
  ): { loaded: CortexTool[]; deferred: CortexTool[] } {
    const discovered = this.deferredRegistry.getDiscovered();
    const loaded: CortexTool[] = [];
    const deferred: CortexTool[] = [];

    for (const tool of candidates) {
      if (this.shouldDeferTool(tool, discovered)) {
        deferred.push(tool);
      } else {
        loaded.push(tool);
      }
    }
    return { loaded, deferred };
  }

  private shouldDeferTool(tool: CortexTool, discovered: ReadonlySet<string>): boolean {
    if (tool.alwaysLoad === true) return false;
    if (this.deferredAlwaysLoad.has(tool.name)) return false;
    if (discovered.has(tool.name)) return false;
    if (tool.shouldDefer === true) return true;
    if (tool.isMcp === true && this.deferMcp) return true;
    return false;
  }

  /**
   * Update the `_available_tools` slot if its content has actually changed.
   * Skipping no-op writes preserves the prompt cache: identical bytes mean
   * the cached prefix stays valid for the next API call.
   */
  private updateAvailableToolsSlot(): void {
    const newContent = this.deferredRegistry.formatSlotContent();
    const current = this.ports.slots.getSlot('_available_tools');
    if (newContent !== current) {
      this.ports.slots.setSlot('_available_tools', newContent);
    }
  }

  /**
   * Build the tool set for a child agent.
   * SubAgent and load_skill are always excluded from child agents.
   */
  childInheritable(
    requestedTools?: string[],
  ): RegisteredTool[] {
    const parentTools = [...this.tools, ...this.ports.mcpTools()];
    // Exclude SubAgent, LoadSkill (disabled for children), and all built-in
    // tools (the child's constructor creates its own built-in instances).
    const builtInNames = new Set(Object.values(TOOL_NAMES));
    const excludedNames = new Set([
      SUB_AGENT_TOOL_NAME,
      LOAD_SKILL_TOOL_NAME,
      ...builtInNames,
    ]);

    let filteredTools: typeof parentTools;

    if (requestedTools && requestedTools.length > 0) {
      // Filter to only requested non-built-in tools
      const requested = new Set(requestedTools);
      filteredTools = parentTools.filter(
        t => requested.has(t.name) && !excludedNames.has(t.name),
      );
    } else {
      // Inherit non-built-in parent tools (e.g., MCP tools)
      filteredTools = parentTools.filter(t => !excludedNames.has(t.name));
    }

    return filteredTools;
  }
}

/**
 * Extract safe, identifying fields from tool args for logging.
 * Returns paths, commands, and patterns without content or results.
 */
function summarizeToolArgsForLog(name: string, params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object') return {};
  const subject = toolCallSubject(name, params);
  if ('command' in subject) return { command: String(subject.command ?? '').slice(0, 200) };
  if ('path' in subject) return { path: subject.path };
  if ('pattern' in subject) return { pattern: subject.pattern, path: subject.scope };
  if ('url' in subject) return { url: subject.url };
  if ('taskId' in subject) return { taskId: subject.taskId };
  return {};
}
