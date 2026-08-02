import { describe, it, expect, vi } from 'vitest';
import { CortexAgent } from '../../src/cortex-agent.js';
import type { PiAgent, PiModel } from '../../src/cortex-agent.js';
import type { CortexAgentConfig } from '../../src/types.js';
import { wrapModel } from '../../src/model-wrapper.js';
import { EventBridge } from '../../src/event-bridge.js';
import type { CortexEvent, PiEvent } from '../../src/event-bridge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TestCortexAgentConstructor = new (
  agent: PiAgent,
  config: CortexAgentConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => CortexAgent;

function makeModel(raw: PiModel) {
  return wrapModel(raw, raw.provider, raw.name, raw.contextWindow);
}

function createMockPiAgent(): PiAgent {
  return {
    state: { messages: [], systemPrompt: '', tools: [] },
    subscribe() { return () => {}; },
    async prompt() { return { content: 'ok' }; },
    abort() {},
    async waitForIdle() {},
    reset() { this.state.messages = []; },
    steer() {},
  } as unknown as PiAgent;
}

function createTestCortexAgent(
  config?: Partial<CortexAgentConfig>,
  piAgent?: PiAgent,
): CortexAgent {
  const Ctor = CortexAgent as unknown as TestCortexAgentConstructor;
  return new Ctor(
    piAgent ?? createMockPiAgent(),
    {
      model: makeModel({
        provider: 'anthropic',
        name: 'claude-sonnet-4-20250514',
        contextWindow: 200_000,
      } as PiModel),
      workingDirectory: '/tmp/test-workspace',
      initialBasePrompt: 'Test prompt',
      slots: [],
      ...config,
    },
    [],
    { enableSubAgentTool: false, enableLoadSkillTool: false },
  );
}

interface SpawnInternals {
  createChildAgent: (params: unknown) => Promise<unknown>;
  spawnForegroundSubAgentInternal: (params: {
    instructions: string;
  }) => Promise<{ taskId: string; status: string }>;
  spawnBackgroundSubAgentInternal: (params: {
    instructions: string;
  }) => Promise<{ taskId: string }>;
}

/**
 * Replace createChildAgent with a stub so spawn-path tests observe child
 * lifecycle without constructing a real child agent.
 */
function stubChildAgent(agent: CortexAgent): {
  destroySpy: ReturnType<typeof vi.fn>;
  createSpy: ReturnType<typeof vi.fn>;
} {
  const destroySpy = vi.fn().mockResolvedValue(undefined);
  const createSpy = vi.fn().mockResolvedValue({ destroy: destroySpy });
  (agent as unknown as SpawnInternals).createChildAgent = createSpy;
  return { destroySpy, createSpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CortexAgent spawn-path lifecycle', () => {
  describe('foreground spawn at the concurrency cap', () => {
    it('destroys the just-created child when track() fails', async () => {
      const agent = createTestCortexAgent({ maxConcurrentSubAgents: 0 });
      const { destroySpy } = stubChildAgent(agent);
      const internal = agent as unknown as SpawnInternals;

      const result = await internal.spawnForegroundSubAgentInternal({
        instructions: 'do something',
      });

      expect(result.status).toBe('failed');
      expect(destroySpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('background spawn at the concurrency cap', () => {
    it('destroys the just-created child when track() fails', async () => {
      const agent = createTestCortexAgent({ maxConcurrentSubAgents: 0 });
      const { destroySpy } = stubChildAgent(agent);
      const internal = agent as unknown as SpawnInternals;

      await expect(
        internal.spawnBackgroundSubAgentInternal({ instructions: 'do something' }),
      ).rejects.toThrow('Concurrency limit reached');
      expect(destroySpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('public spawnBackgroundSubAgent cap pre-check', () => {
    it('rejects before building a child agent when at the cap', async () => {
      const agent = createTestCortexAgent({ maxConcurrentSubAgents: 0 });
      const { createSpy } = stubChildAgent(agent);

      await expect(
        agent.spawnBackgroundSubAgent({ instructions: 'do something' }),
      ).rejects.toThrow(/concurrency limit reached \(0\/0 active\)/);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('spawns normally when under the cap', async () => {
      const agent = createTestCortexAgent({ maxConcurrentSubAgents: 2 });
      // The background runner prompts the stub child; hold the prompt open
      // so the tracked entry is observable before the child completes.
      let releasePrompt!: () => void;
      const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
      const child = {
        destroy: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockReturnValue(promptGate),
        getConversationHistory: () => [{ role: 'assistant', content: 'done' }],
        getBudgetGuard: () => ({ getTurnCount: () => 1, getTotalCost: () => 0 }),
        getEventBridge: () => new EventBridge(false),
        currentContextTokenCount: 0,
      };
      const internal = agent as unknown as SpawnInternals;
      internal.createChildAgent = vi.fn().mockResolvedValue(child);

      const { taskId } = await agent.spawnBackgroundSubAgent({ instructions: 'do something' });
      expect(taskId).toBeTruthy();
      expect(agent.getSubAgentManager().get(taskId)).toBeDefined();

      releasePrompt();
      await agent.getSubAgentManager().get(taskId)?.completion;
    });
  });

  describe('cancelSubAgent', () => {
    interface DeliveryInternals {
      pendingBackgroundResults: Array<Record<string, unknown>>;
      drainPendingBackgroundResults: () => Promise<void>;
    }

    /** A child stub whose prompt hangs until destroy() rejects it (like a real abort). */
    function createHangingChild() {
      let rejectPrompt!: (err: Error) => void;
      const promptGate = new Promise<never>((_, reject) => { rejectPrompt = reject; });
      // Swallow the rejection when nothing has picked the promise up yet.
      promptGate.catch(() => {});
      return {
        destroy: vi.fn().mockImplementation(async () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          rejectPrompt(err);
        }),
        prompt: vi.fn().mockReturnValue(promptGate),
        getConversationHistory: () => [],
        getBudgetGuard: () => ({ getTurnCount: () => 0, getTotalCost: () => 0 }),
        getEventBridge: () => new EventBridge(false),
        currentContextTokenCount: 0,
      };
    }

    it('destroys the child, resolves the completion as cancelled, and drops the late result', async () => {
      const piAgent = createMockPiAgent();
      const promptSpy = vi.spyOn(piAgent, 'prompt');
      const agent = createTestCortexAgent({}, piAgent);
      const child = createHangingChild();
      (agent as unknown as SpawnInternals).createChildAgent = vi.fn().mockResolvedValue(child);

      const { taskId } = await agent.spawnBackgroundSubAgent({ instructions: 'long task' });
      const completion = agent.getSubAgentManager().get(taskId)!.completion;

      const cancelled = await agent.cancelSubAgent(taskId);

      expect(cancelled).toBe(true);
      expect(child.destroy).toHaveBeenCalled();
      expect(agent.getSubAgentManager().get(taskId)).toBeUndefined();
      await expect(completion).resolves.toMatchObject({ status: 'cancelled' });

      // Let the child's completion continuation settle: its failed result
      // must be discarded, never delivered as a background completion.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(promptSpy).not.toHaveBeenCalled();
    });

    it('returns false for an unknown task ID', async () => {
      const agent = createTestCortexAgent();
      await expect(agent.cancelSubAgent('nope')).resolves.toBe(false);
    });

    it('purges a queued pending result for the cancelled task', async () => {
      const agent = createTestCortexAgent();
      const internal = agent as unknown as DeliveryInternals;
      const manager = agent.getSubAgentManager();

      const child = createHangingChild();
      manager.track({
        taskId: 'queued-task',
        agent: child,
        instructions: 'work',
        background: true,
        spawnedAt: Date.now(),
        completion: Promise.resolve({
          output: '',
          status: 'cancelled',
          usage: { turns: 0, cost: 0, durationMs: 0, contextTokens: 0 },
        }),
        resolve: () => {},
        toolCount: 0,
        lastToolName: null,
        lastToolSummary: null,
        lastToolStartedAt: null,
        pendingPermission: null,
      });
      internal.pendingBackgroundResults.push({
        kind: 'subagent',
        taskId: 'queued-task',
        result: {
          output: 'finished before cancel',
          status: 'completed',
          usage: { turns: 1, cost: 0, durationMs: 10, contextTokens: 0 },
        },
      });

      await agent.cancelSubAgent('queued-task');
      expect(internal.pendingBackgroundResults).toHaveLength(0);
    });

    it('drops a cancelled task result at drain time', async () => {
      const piAgent = createMockPiAgent();
      const promptSpy = vi.spyOn(piAgent, 'prompt');
      const agent = createTestCortexAgent({}, piAgent);
      const internal = agent as unknown as DeliveryInternals;
      const manager = agent.getSubAgentManager();

      // Cancel directly through the manager (bypassing cancelSubAgent's
      // queue purge) so the drain-level check is what drops the item.
      manager.track({
        taskId: 'late-task',
        agent: {},
        instructions: 'work',
        background: true,
        spawnedAt: Date.now(),
        completion: Promise.resolve({
          output: '',
          status: 'cancelled',
          usage: { turns: 0, cost: 0, durationMs: 0, contextTokens: 0 },
        }),
        resolve: () => {},
        toolCount: 0,
        lastToolName: null,
        lastToolSummary: null,
        lastToolStartedAt: null,
        pendingPermission: null,
      });
      await manager.cancel('late-task', async () => {});

      internal.pendingBackgroundResults.push({
        kind: 'subagent',
        taskId: 'late-task',
        result: {
          output: 'late output',
          status: 'completed',
          usage: { turns: 1, cost: 0, durationMs: 10, contextTokens: 0 },
        },
      });
      await internal.drainPendingBackgroundResults();

      expect(promptSpy).not.toHaveBeenCalled();
      expect(internal.pendingBackgroundResults).toHaveLength(0);
    });
  });

  describe('background child event forwarding', () => {
    /**
     * A child stub carrying a real EventBridge so the test can emit pi-shaped
     * events "from the child" and observe them on the parent's bridge.
     */
    function createForwardingChild() {
      const childBridge = new EventBridge(false);
      let emitPi!: (event: PiEvent) => void;
      childBridge.wire({
        subscribe(handler) {
          emitPi = handler;
          return () => {};
        },
      });

      let releasePrompt!: () => void;
      const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
      const child = {
        getEventBridge: () => childBridge,
        destroy: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockReturnValue(promptGate),
        getConversationHistory: () => [{ role: 'assistant', content: 'done' }],
        getBudgetGuard: () => ({ getTurnCount: () => 1, getTotalCost: () => 0.01 }),
        currentContextTokenCount: 0,
      };
      return { child, emit: (event: PiEvent) => emitPi(event), releasePrompt };
    }

    async function settle(): Promise<void> {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    }

    it('forwards background child events to the parent bridge with childTaskId set', async () => {
      const agent = createTestCortexAgent();
      const { child, emit, releasePrompt } = createForwardingChild();
      (agent as unknown as SpawnInternals).createChildAgent = vi.fn().mockResolvedValue(child);

      const seen: CortexEvent[] = [];
      agent.getEventBridge().on('tool_call_start', (event) => seen.push(event));

      const { taskId } = await agent.spawnBackgroundSubAgent({ instructions: 'bg work' });
      emit({
        type: 'tool_execution_start',
        toolCallId: 'tc1',
        toolName: 'Bash',
        args: { command: 'npm test' },
      } as PiEvent);

      expect(seen).toHaveLength(1);
      expect(seen[0]!.childTaskId).toBe(taskId);

      // Forwarding also drives live tool activity for the headline block.
      const snapshot = agent.getActiveSubAgents();
      expect(snapshot[0]).toMatchObject({
        taskId,
        toolCount: 1,
        lastToolName: 'Bash',
        lastToolSummary: 'npm test',
      });

      releasePrompt();
      await settle();
    });

    it('accumulates background child usage into session usage', async () => {
      const agent = createTestCortexAgent();
      const { child, emit, releasePrompt } = createForwardingChild();
      (agent as unknown as SpawnInternals).createChildAgent = vi.fn().mockResolvedValue(child);

      await agent.spawnBackgroundSubAgent({ instructions: 'bg work' });
      emit({
        type: 'turn_end',
        message: {
          role: 'assistant',
          content: [],
          usage: {
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 150,
            cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
          },
        },
      } as unknown as PiEvent);

      const usage = agent.getSessionUsage();
      expect(usage.totalCost).toBeCloseTo(0.003, 10);
      expect(usage.tokens.input).toBe(100);
      expect(usage.tokens.output).toBe(50);

      releasePrompt();
      await settle();
    });

    it('stops forwarding once the child completes (no listener leak per task)', async () => {
      const agent = createTestCortexAgent();
      const { child, emit, releasePrompt } = createForwardingChild();
      (agent as unknown as SpawnInternals).createChildAgent = vi.fn().mockResolvedValue(child);

      const seen: CortexEvent[] = [];
      agent.getEventBridge().on('tool_call_start', (event) => seen.push(event));

      const { taskId } = await agent.spawnBackgroundSubAgent({ instructions: 'bg work' });
      const completion = agent.getSubAgentManager().get(taskId)!.completion;
      emit({
        type: 'tool_execution_start',
        toolCallId: 'tc1',
        toolName: 'Bash',
        args: { command: 'ls' },
      } as PiEvent);
      expect(seen).toHaveLength(1);

      releasePrompt();
      await completion;
      await settle();

      // Events emitted after completion no longer reach the parent.
      emit({
        type: 'tool_execution_start',
        toolCallId: 'tc2',
        toolName: 'Bash',
        args: { command: 'ls again' },
      } as PiEvent);
      expect(seen).toHaveLength(1);
    });
  });

  describe('destroy cascading to children', () => {
    it('destroys tracked children via cancelAll', async () => {
      const agent = createTestCortexAgent();
      const manager = agent.getSubAgentManager();
      const childDestroy = vi.fn().mockResolvedValue(undefined);

      manager.track({
        taskId: 'child-1',
        agent: { destroy: childDestroy },
        instructions: 'work',
        background: true,
        spawnedAt: Date.now(),
        completion: Promise.resolve({
          output: '',
          status: 'cancelled',
          usage: { turns: 0, cost: 0, durationMs: 0, contextTokens: 0 },
        }),
        resolve: () => {},
        toolCount: 0,
        lastToolName: null,
        lastToolSummary: null,
        lastToolStartedAt: null,
        pendingPermission: null,
      });

      await agent.destroy();
      expect(childDestroy).toHaveBeenCalledTimes(1);
    });
  });
});
