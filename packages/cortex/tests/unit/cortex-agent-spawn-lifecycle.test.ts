import { describe, it, expect, vi } from 'vitest';
import { CortexAgent } from '../../src/cortex-agent.js';
import type { PiAgent, PiModel } from '../../src/cortex-agent.js';
import type { CortexAgentConfig } from '../../src/types.js';
import { wrapModel } from '../../src/model-wrapper.js';

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

function createTestCortexAgent(config?: Partial<CortexAgentConfig>): CortexAgent {
  const Ctor = CortexAgent as unknown as TestCortexAgentConstructor;
  return new Ctor(
    createMockPiAgent(),
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
});
