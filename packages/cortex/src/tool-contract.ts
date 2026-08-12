import type { ToolExecuteContext } from './types.js';

/**
 * Cortex's canonical in-process tool contract.
 *
 * All tools registered with AgentLoop are normalized to this signature.
 * Cortex adapts this shape to pi-agent-core's execute signature at the
 * registration boundary.
 */
export interface CortexTool<TParams = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: unknown;
  execute: (params: TParams, context?: ToolExecuteContext) => Promise<TResult>;

  /**
   * Marks this tool as eligible for deferred loading. When the agent has
   * `deferredTools.enabled = true`, deferred tools are NOT included in the
   * `tools` array sent to the model on every turn. Instead, only their names
   * appear in the `_available_tools` slot, and the model uses ToolSearch to
   * load full schemas on demand.
   *
   * MCP tools get `isMcp: true` set automatically by the MCP client and are
   * deferred when `deferredTools.deferMcp` is true (default). Built-in or
   * consumer-supplied tools can opt in via `shouldDefer: true`.
   */
  shouldDefer?: boolean;

  /**
   * Forces this tool to always be sent in the `tools` array, even if it
   * matches deferral criteria (e.g., an MCP tool the consumer wants always
   * available). Overrides `shouldDefer` and the `deferMcp` config.
   */
  alwaysLoad?: boolean;

  /**
   * Marker indicating this tool was wrapped from an MCP server. Set
   * automatically by the MCP client. Consumers should not set this manually.
   */
  isMcp?: boolean;

  /**
   * Exempts this tool from the consumer permission gate: `beforeToolCall`
   * never consults `resolvePermission` for it.
   *
   * This is the marker for Cortex-internal orchestration tools, calls that
   * dispatch inside the process and have no side effects a consumer could
   * meaningfully gate: SubAgent, the duplex Deliver/SteerSubAgent pair, the
   * talker's control tools, recall, load_skill, ToolSearch. Gating one of
   * these asks the user for permission to run Cortex's own plumbing (a live
   * defect: a reasoner's Deliver was prompted as "Permission Required",
   * blocking the delivery of the very answer being asked about).
   *
   * Consumers may set it on their own tools when a tool is equally internal
   * (a pure in-process dispatch with nothing to approve). Never set it on a
   * tool that touches files, network, processes, or anything else a user
   * would expect a say over.
   *
   * Ignored for MCP tools: the exemption lookup refuses `isMcp` tools, so a
   * remote server cannot self-exempt by declaring the field.
   */
  permissionExempt?: boolean;

  /**
   * Optional pi-agent-core execution hint. Use "sequential" for tools that
   * must update shared agent state before later tool calls in the same batch.
   */
  executionMode?: 'sequential' | 'parallel';
}

/**
 * Raw pi-agent-core tool contract.
 *
 * Use fromPiAgentTool() to explicitly adapt a tool with this signature into
 * Cortex's canonical CortexTool shape.
 */
export interface PiAgentTool<TParams = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: unknown;
  executionMode?: 'sequential' | 'parallel';
  execute: (
    toolCallId: string,
    params: TParams,
    signal?: AbortSignal,
    onUpdate?: (partialResult: unknown) => void,
  ) => Promise<TResult>;
}

/**
 * Explicitly adapt a pi-agent-core-style tool into Cortex's canonical tool contract.
 */
export function fromPiAgentTool<TParams = unknown, TResult = unknown>(
  tool: PiAgentTool<TParams, TResult>,
): CortexTool<TParams, TResult> {
  const cortexTool: CortexTool<TParams, TResult> = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: (params: TParams, context?: ToolExecuteContext) => {
      return tool.execute(
        context?.toolCallId ?? `${tool.name}-direct`,
        params,
        context?.signal,
        context?.onUpdate as ((partialResult: unknown) => void) | undefined,
      );
    },
  };
  if (tool.executionMode) {
    cortexTool.executionMode = tool.executionMode;
  }
  return cortexTool;
}

/**
 * Validate that a tool matches Cortex's canonical execute signature.
 *
 * Cortex does not infer tool execution contracts from function arity. Tools
 * that already use pi-agent-core's raw execute signature must be adapted
 * explicitly with fromPiAgentTool().
 */
export function assertValidCortexTool(tool: CortexTool): CortexTool {
  if (typeof tool.execute !== 'function') {
    throw new Error(`Tool "${tool.name}" is missing an execute() function.`);
  }

  if (tool.execute.length > 2) {
    throw new Error(
      `Tool "${tool.name}" does not use Cortex's execute(params, context?) contract. ` +
      'Wrap raw pi-agent-core tools with fromPiAgentTool() before passing them to AgentLoop.create().',
    );
  }

  return tool;
}
