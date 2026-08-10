/**
 * Per-agent runtime state for mutable built-in tool behavior.
 *
 * Cortex clones runtime-aware built-in tools into a fresh runtime for each
 * agent so parent and child agents do not share mutable closures.
 */

import type * as child_process from 'node:child_process';
import { CwdTracker } from './shared/cwd-tracker.js';
import { EditHistory } from './shared/edit-history.js';
import { FileMutationLock } from './shared/file-mutation-lock.js';
import { killProcessTree } from './shared/process-tree.js';
import { ReadRegistry } from './shared/read-registry.js';
import { WebFetchCache } from './web-fetch/cache.js';

// ---------------------------------------------------------------------------
// Background task state
// ---------------------------------------------------------------------------

export interface BackgroundTask {
  id: string;
  /** The command that was executed (for status display). */
  command: string;
  process: child_process.ChildProcess;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  completed: boolean;
  /**
   * Whether the agent has already been informed of this task's terminal state:
   * delivered via a completion wake-up, observed through a TaskOutput poll that
   * returned completed/failed, or deliberately killed. Guards against delivering
   * the same completion twice.
   */
  notified: boolean;
  startTime: number;
}

export class BackgroundTaskStore {
  private readonly tasks = new Map<string, BackgroundTask>();
  private taskIdCounter = 0;

  nextTaskId(): string {
    this.taskIdCounter += 1;
    return `task_${this.taskIdCounter}`;
  }

  set(task: BackgroundTask): void {
    this.tasks.set(task.id, task);
  }

  get(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  getAll(): Map<string, BackgroundTask> {
    return this.tasks;
  }

  cleanupCompletedTasks(maxAgeMs = 30 * 60 * 1000): void {
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (task.completed && now - task.startTime > maxAgeMs) {
        this.tasks.delete(id);
      }
    }
  }

  /**
   * Kill the process tree of every task that has not completed, then drop
   * all entries. Bash spawns detached on Unix, so without the group kill
   * backgrounded and auto-yielded commands would outlive the agent.
   */
  killIncompleteAndClear(): void {
    for (const task of this.tasks.values()) {
      if (!task.completed) {
        task.notified = true;
        killProcessTree(task.process);
      }
    }
    this.tasks.clear();
  }

  clear(): void {
    this.tasks.clear();
  }
}

export const globalBackgroundTaskStore = new BackgroundTaskStore();

// ---------------------------------------------------------------------------
// WebFetch runtime state
// ---------------------------------------------------------------------------

export class WebFetchRuntimeState {
  private readonly cache = new WebFetchCache();
  private fetchesThisLoop = 0;

  getCache(): WebFetchCache {
    return this.cache;
  }

  get fetchCount(): number {
    return this.fetchesThisLoop;
  }

  incrementFetchCount(): void {
    this.fetchesThisLoop += 1;
  }

  resetLoop(): void {
    this.fetchesThisLoop = 0;
  }

  destroy(): void {
    this.cache.destroy();
  }
}

// ---------------------------------------------------------------------------
// Per-agent runtime container
// ---------------------------------------------------------------------------

export class CortexToolRuntime {
  readonly cwdTracker: CwdTracker;
  readonly readRegistry: ReadRegistry;
  readonly fileMutationLock: FileMutationLock;
  readonly editHistory: EditHistory;
  readonly backgroundTasks: BackgroundTaskStore;
  readonly webFetch: WebFetchRuntimeState;

  constructor(workingDirectory: string) {
    this.cwdTracker = new CwdTracker(workingDirectory);
    this.readRegistry = new ReadRegistry();
    this.fileMutationLock = new FileMutationLock();
    this.editHistory = new EditHistory();
    this.backgroundTasks = new BackgroundTaskStore();
    this.webFetch = new WebFetchRuntimeState();
  }

  /**
   * Reset per-loop state at prompt start.
   *
   * `preserveWorkspaceState` is the long-lived (persistent runtime) mode: a
   * loop woken repeatedly by deliveries keeps its working directory,
   * read-before-edit registry, and undo history across prompts. Transient
   * per-loop state always resets regardless: the mutation lock is a safety
   * net against a crashed tool holding a lock forever, and the WebFetch
   * counter implements a per-loop rate limit, not workspace state.
   */
  resetForLoop(options?: { preserveWorkspaceState?: boolean }): void {
    this.fileMutationLock.clear();
    this.webFetch.resetLoop();
    if (options?.preserveWorkspaceState) return;
    this.cwdTracker.reset();
    this.readRegistry.clear();
    this.editHistory.clear();
  }

  destroy(): void {
    this.readRegistry.clear();
    this.fileMutationLock.clear();
    this.editHistory.clear();
    this.backgroundTasks.killIncompleteAndClear();
    this.webFetch.destroy();
  }
}

// ---------------------------------------------------------------------------
// Runtime-aware tool metadata
// ---------------------------------------------------------------------------

export interface RuntimeAwareToolMetadata<TTool> {
  readonly toolKind: string;
  cloneForRuntime: (runtime: CortexToolRuntime) => TTool;
}

const RUNTIME_AWARE_TOOL = Symbol.for('cortex.runtimeAwareTool');

export function attachRuntimeAwareTool<TTool extends object>(
  tool: TTool,
  metadata: RuntimeAwareToolMetadata<TTool>,
): TTool {
  Object.defineProperty(tool, RUNTIME_AWARE_TOOL, {
    value: metadata,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return tool;
}

export function getRuntimeAwareToolMetadata<TTool>(
  tool: TTool,
): RuntimeAwareToolMetadata<TTool> | undefined {
  if (!tool || typeof tool !== 'object') return undefined;
  const record = tool as Record<string | symbol, unknown>;
  return record[RUNTIME_AWARE_TOOL] as RuntimeAwareToolMetadata<TTool> | undefined;
}

export function cloneRuntimeAwareTool<TTool>(
  tool: TTool,
  runtime: CortexToolRuntime,
): TTool | null {
  const metadata = getRuntimeAwareToolMetadata(tool);
  return metadata ? metadata.cloneForRuntime(runtime) : null;
}
