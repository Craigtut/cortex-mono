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
  /** Resolved at call time, so it follows setModel changes to the utility model. */
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
  // Read-surface path allowlist, enforced in the tools, never by prompt:
  // an out-of-scope read is an exfiltration path whatever the model was told.
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
    // ripgrep runs inside the same OS sandbox as shell commands (denyRead over secrets).
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
      // So destroy()'s force-kill and the exit safety net cover background shells.
      onProcessSpawned: (pid) => {
        deps.processes.track(pid);
      },
      onProcessExited: (pid) => {
        deps.processes.untrack(pid);
      },
      onBackgroundTaskComplete: (taskId) => deps.onBackgroundTaskComplete(taskId),
      sandbox: config.sandbox,
      // Escalation is authorized only by the permission gate; without a
      // resolver the tool refuses it (fail closed).
      permissionGated: config.resolvePermission !== undefined,
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
      utilityComplete: (context) => deps.utilityComplete(context as UtilityContext, 'webfetch'),
      // Shared with sandboxed shell egress; undefined means ungated.
      resolveNetworkAccess: config.resolveNetworkAccess,
      maxPerLoop: config.webFetch?.maxPerLoop,
    }) as RegisteredTool);
  }
  // disableTools cannot remove ToolSearch: it is the only way to load deferred schemas.
  if (deps.deferred) {
    tools.push(createToolSearchTool({
      registry: deps.deferred.registry,
      onAfterDiscovery: () => deps.deferred!.onAfterDiscovery(),
    }) as RegisteredTool);
  }

  return tools;
}
