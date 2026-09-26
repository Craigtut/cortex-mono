/**
 * The built-in tools (Read, Write, Edit, UndoEdit, Glob, Grep, Bash,
 * TaskOutput, WebFetch, plus ToolSearch when deferred loading is on),
 * minus the ones the consumer disabled, bound to one loop's runtime.
 */

import type { ProcessTracker } from './process-tracker.js';
import type { RegisteredTool } from './pi-agent.js';
import type { AgentLoopConfig } from '../types.js';
import type { CortexToolRuntime } from '../tools/runtime.js';
import type { DeferredToolRegistry } from '../tools/tool-search/registry.js';
import { TOOL_NAMES } from '../tools/tool-names.js';
import { createReadTool } from '../tools/read.js';
import { createWriteTool } from '../tools/write.js';
import { createEditTool } from '../tools/edit.js';
import { createUndoEditTool } from '../tools/undo-edit.js';
import { createGlobTool } from '../tools/glob.js';
import { createGrepTool } from '../tools/grep.js';
import { createBashTool } from '../tools/bash/index.js';
import { createTaskOutputTool } from '../tools/task-output.js';
import { createWebFetchTool } from '../tools/web-fetch/index.js';
import { createToolSearchTool } from '../tools/tool-search/index.js';

type UtilityContext = { systemPrompt: string; messages: Array<{ role: string; content: string }> };

export interface BuiltinToolDeps {
  workingDirectory: string;
  runtime: CortexToolRuntime;
  config: Pick<
    AgentLoopConfig,
    | 'readPathAllowlist'
    | 'sandbox'
    | 'isAutoApprove'
    | 'resolvePermission'
    | 'bash'
    | 'resolveNetworkAccess'
    | 'webFetch'
  >;
  /**
   * The loop's utility completion, resolved at call time so it follows the
   * current utility model (which may change at runtime via setModel).
   */
  utilityComplete(context: UtilityContext, usageCategory: string): Promise<string>;
  processes: Pick<ProcessTracker, 'track' | 'untrack'>;
  onBackgroundTaskComplete(taskId: string): void;
  /** Present when deferred tool loading is on: ToolSearch loads from it. */
  deferred?: { registry: DeferredToolRegistry; onAfterDiscovery(): void };
}

export function createBuiltinTools(deps: BuiltinToolDeps, disabled: ReadonlySet<string>): RegisteredTool[] {
  const { config } = deps;
  const tools: RegisteredTool[] = [];
  const cwd = deps.workingDirectory;
  const runtime = deps.runtime;
  // In-tool path allowlist for the read-surface tools (Read, Glob, Grep).
  // Enforced in the tools themselves, never by prompt: restricted loops
  // (duplex quick lookups) speak their answers, so an out-of-scope read is
  // an exfiltration path regardless of what the model was told.
  const allowedRoots = config.readPathAllowlist;

  if (!disabled.has(TOOL_NAMES.Read)) {
    tools.push(createReadTool({ runtime, allowedRoots }) as RegisteredTool);
  }
  if (!disabled.has(TOOL_NAMES.Write)) {
    tools.push(createWriteTool({ runtime }) as RegisteredTool);
  }
  if (!disabled.has(TOOL_NAMES.Edit)) {
    tools.push(createEditTool({ runtime }) as RegisteredTool);
  }
  if (!disabled.has(TOOL_NAMES.UndoEdit)) {
    tools.push(createUndoEditTool({ runtime }) as RegisteredTool);
  }
  if (!disabled.has(TOOL_NAMES.Glob)) {
    tools.push(createGlobTool({ defaultCwd: cwd, allowedRoots }) as RegisteredTool);
  }
  if (!disabled.has(TOOL_NAMES.Grep)) {
    // Thread the sandbox so ripgrep content search runs inside the same OS
    // boundary as shell commands (enforces denyRead over secrets). No-op when
    // no provider is configured.
    tools.push(createGrepTool({
      defaultCwd: cwd,
      sandbox: config.sandbox,
      allowedRoots,
    }) as RegisteredTool);
  }
  if (!disabled.has(TOOL_NAMES.Bash)) {
    tools.push(createBashTool({
      runtime,
      utilityComplete: (context) => deps.utilityComplete(context as UtilityContext, 'bash_utility'),
      isAutoApprove: () => config.isAutoApprove?.() ?? false,
      // Track spawned shell PIDs so destroy()'s force-kill deadline and
      // the process-exit safety net cover background/auto-yielded
      // commands, not just MCP subprocesses.
      onProcessSpawned: (pid) => {
        deps.processes.track(pid);
      },
      onProcessExited: (pid) => {
        deps.processes.untrack(pid);
      },
      onBackgroundTaskComplete: (taskId) => deps.onBackgroundTaskComplete(taskId),
      sandbox: config.sandbox,
      // The resolvePermission adaptation (beforeToolCall) screens every call
      // before execute(), presenting escalation requests under a distinct
      // name. That gate is what authorizes escalateOutsideSandbox; without a
      // resolver the tool refuses escalation (fail closed).
      permissionGated: config.resolvePermission !== undefined,
      // Consumer tool tuning (AgentLoopConfig.bash).
      shellPath: config.bash?.shellPath,
      autoYieldThreshold: config.bash?.autoYieldThreshold,
    }) as RegisteredTool);
  }
  if (!disabled.has(TOOL_NAMES.TaskOutput)) {
    tools.push(createTaskOutputTool() as RegisteredTool);
  }
  if (!disabled.has(TOOL_NAMES.WebFetch)) {
    tools.push(createWebFetchTool({
      runtime,
      // Wire the utility model for WebFetch summarization.
      // Uses a lazy callback so it resolves against the current utility model
      // (which may change at runtime via setModel).
      utilityComplete: (context) => deps.utilityComplete(context as UtilityContext, 'webfetch'),
      // The consumer's unified egress gate, shared with sandboxed shell
      // egress. Undefined = ungated, exactly as before.
      resolveNetworkAccess: config.resolveNetworkAccess,
      // Consumer tool tuning (AgentLoopConfig.webFetch).
      maxPerLoop: config.webFetch?.maxPerLoop,
    }) as RegisteredTool);
  }
  // ToolSearch is auto-registered when deferred tools are enabled. The
  // consumer cannot disable it via disableTools (the agent has no other way
  // to load deferred tool schemas).
  if (deps.deferred) {
    tools.push(createToolSearchTool({
      registry: deps.deferred.registry,
      onAfterDiscovery: () => deps.deferred!.onAfterDiscovery(),
    }) as RegisteredTool);
  }

  return tools;
}
