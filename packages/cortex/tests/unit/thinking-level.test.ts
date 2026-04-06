import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CortexAgent } from '../../src/cortex-agent.js';
import type { PiAgent, PiModel } from '../../src/cortex-agent.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type { CortexAgentConfig, ThinkingLevel } from '../../src/types.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { CortexModel } from '../../src/model-wrapper.js';

// ---------------------------------------------------------------------------
// Mock pi-ai module
// ---------------------------------------------------------------------------

const mockSupportsXhigh = vi.fn();

vi.mock('@mariozechner/pi-ai', () => ({
  supportsXhigh: (...args: unknown[]) => mockSupportsXhigh(...args),
}));

// ---------------------------------------------------------------------------
// Mock PiAgent factory (minimal, focused on thinking level)
// ---------------------------------------------------------------------------

interface MockPiAgent extends PiAgent {
  emitEvent: (event: PiEvent) => void;
  setThinkingLevelCalls: string[];
}

function createMockPiAgent(): MockPiAgent {
  let eventHandler: ((event: PiEvent) => void) | null = null;

  const agent: MockPiAgent = {
    state: {
      messages: [],
      systemPrompt: '',
      tools: [],
    },
    setThinkingLevelCalls: [],

    subscribe(handler: (event: PiEvent) => void): () => void {
      eventHandler = handler;
      return () => { eventHandler = null; };
    },

    emitEvent(event: PiEvent): void {
      if (eventHandler) eventHandler(event);
    },

    async prompt(): Promise<unknown> {
      agent.emitEvent({ type: 'agent_start' });
      agent.emitEvent({ type: 'turn_start' });
      agent.emitEvent({ type: 'turn_end', text: 'Mock response' });
      agent.emitEvent({ type: 'agent_end' });
      return { content: 'Mock response' };
    },

    abort(): void { /* no-op */ },
    async waitForIdle(): Promise<void> { /* no-op */ },
    reset(): void { agent.state.messages = []; },
    steer(): void { /* no-op */ },

    setThinkingLevel(level: string): void {
      agent.setThinkingLevelCalls.push(level);
      (agent.state as Record<string, unknown>).thinkingLevel = level;
    },
  };

  return agent;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TestCortexAgentConstructor = new (
  agent: PiAgent,
  config: CortexAgentConfig,
) => CortexAgent;

function createTestCortexAgent(agent: PiAgent, config: CortexAgentConfig): CortexAgent {
  const CortexAgentCtor = CortexAgent as unknown as TestCortexAgentConstructor;
  return new CortexAgentCtor(agent, config);
}

function makeModel(raw: PiModel): CortexModel {
  const rawRecord = raw as Record<string, unknown>;
  const modelId = typeof rawRecord['id'] === 'string'
    ? rawRecord['id']
    : typeof raw.name === 'string'
      ? raw.name
      : 'test-model';
  const contextWindow = typeof raw.contextWindow === 'number' ? raw.contextWindow : undefined;
  return wrapModel(raw, raw.provider, modelId, contextWindow);
}

function createDefaultConfig(overrides?: Partial<CortexAgentConfig>): CortexAgentConfig {
  return {
    model: makeModel({ provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test prompt',
    slots: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThinkingLevel', () => {
  let piAgent: MockPiAgent;
  let agent: CortexAgent;

  beforeEach(() => {
    piAgent = createMockPiAgent();
    agent = createTestCortexAgent(piAgent, createDefaultConfig());
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('setThinkingLevel', () => {
    it('maps "max" to "xhigh" when delegating to pi-agent-core', () => {
      agent.setThinkingLevel('max');
      expect(piAgent.setThinkingLevelCalls).toEqual(['xhigh']);
    });

    it('passes through "high" unchanged', () => {
      agent.setThinkingLevel('high');
      expect(piAgent.setThinkingLevelCalls).toEqual(['high']);
    });

    it('passes through "medium" unchanged', () => {
      agent.setThinkingLevel('medium');
      expect(piAgent.setThinkingLevelCalls).toEqual(['medium']);
    });

    it('passes through "low" unchanged', () => {
      agent.setThinkingLevel('low');
      expect(piAgent.setThinkingLevelCalls).toEqual(['low']);
    });

    it('passes through "minimal" unchanged', () => {
      agent.setThinkingLevel('minimal');
      expect(piAgent.setThinkingLevelCalls).toEqual(['minimal']);
    });

    it('passes through "off" unchanged', () => {
      agent.setThinkingLevel('off');
      expect(piAgent.setThinkingLevelCalls).toEqual(['off']);
    });
  });

  describe('getThinkingLevel', () => {
    it('returns "max" when pi-agent state has "xhigh"', () => {
      (piAgent.state as Record<string, unknown>).thinkingLevel = 'xhigh';
      expect(agent.getThinkingLevel()).toBe('max');
    });

    it('returns "high" when pi-agent state has "high"', () => {
      (piAgent.state as Record<string, unknown>).thinkingLevel = 'high';
      expect(agent.getThinkingLevel()).toBe('high');
    });

    it('returns "medium" when pi-agent state has "medium"', () => {
      (piAgent.state as Record<string, unknown>).thinkingLevel = 'medium';
      expect(agent.getThinkingLevel()).toBe('medium');
    });

    it('returns "off" when pi-agent state has "off"', () => {
      (piAgent.state as Record<string, unknown>).thinkingLevel = 'off';
      expect(agent.getThinkingLevel()).toBe('off');
    });

    it('defaults to "medium" when thinkingLevel is not set', () => {
      expect(agent.getThinkingLevel()).toBe('medium');
    });

    it('defaults to "medium" when thinkingLevel is not a string', () => {
      (piAgent.state as Record<string, unknown>).thinkingLevel = 42;
      expect(agent.getThinkingLevel()).toBe('medium');
    });
  });

  describe('round-trip mapping', () => {
    const levels: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'max'];

    for (const level of levels) {
      it(`round-trips "${level}" through set and get`, () => {
        agent.setThinkingLevel(level);
        expect(agent.getThinkingLevel()).toBe(level);
      });
    }
  });

  describe('getModelThinkingCapabilities', () => {
    it('returns supportsThinking: false for non-reasoning models', async () => {
      const model = { provider: 'anthropic', name: 'claude-haiku', reasoning: false } as PiModel;
      const cortexModel = makeModel(model);
      const testAgent = createTestCortexAgent(piAgent, createDefaultConfig({ model: cortexModel }));

      const caps = await testAgent.getModelThinkingCapabilities();
      expect(caps).toEqual({ supportsThinking: false, supportsMax: false });
      expect(mockSupportsXhigh).not.toHaveBeenCalled();
    });

    it('returns supportsMax: true for xhigh-capable reasoning models', async () => {
      const model = { provider: 'anthropic', name: 'claude-opus-4-6', id: 'claude-opus-4-6', reasoning: true } as PiModel;
      const cortexModel = makeModel(model);
      const testAgent = createTestCortexAgent(piAgent, createDefaultConfig({ model: cortexModel }));
      mockSupportsXhigh.mockReturnValue(true);

      const caps = await testAgent.getModelThinkingCapabilities();
      expect(caps).toEqual({ supportsThinking: true, supportsMax: true });
      expect(mockSupportsXhigh).toHaveBeenCalled();
    });

    it('returns supportsMax: false for standard reasoning models', async () => {
      const model = { provider: 'anthropic', name: 'claude-sonnet-4-6', id: 'claude-sonnet-4-6', reasoning: true } as PiModel;
      const cortexModel = makeModel(model);
      const testAgent = createTestCortexAgent(piAgent, createDefaultConfig({ model: cortexModel }));
      mockSupportsXhigh.mockReturnValue(false);

      const caps = await testAgent.getModelThinkingCapabilities();
      expect(caps).toEqual({ supportsThinking: true, supportsMax: false });
    });
  });
});
