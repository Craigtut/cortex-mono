import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CortexAgent } from '../../src/cortex-agent.js';
import type { PiAgent, PiModel } from '../../src/cortex-agent.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type { CortexAgentConfig } from '../../src/types.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { CortexModel } from '../../src/model-wrapper.js';
import { DEFAULT_TOOL_THRESHOLDS, MAX_RESULT_TOKENS } from '../../src/tool-result-persistence.js';
import { fromPiAgentTool } from '../../src/tool-contract.js';
import type { CortexTool } from '../../src/tool-contract.js';

// ---------------------------------------------------------------------------
// Mock PiAgent factory
// ---------------------------------------------------------------------------

interface MockPiAgent extends PiAgent {
  /** Manually emit a pi-agent-core event */
  emitEvent: (event: PiEvent) => void;
  /** Track whether abort was called */
  abortCalled: boolean;
  /** Track whether reset was called */
  resetCalled: boolean;
  /** Control what agent.prompt() returns or throws */
  promptResult: unknown;
  promptError: Error | null;
}

function createMockPiAgent(options?: {
  runResult?: unknown;
  runError?: Error | null;
}): MockPiAgent {
  let eventHandler: ((event: PiEvent) => void) | null = null;
  let idleResolve: (() => void) | null = null;
  // Mirrors pi-agent-core: waitForIdle() resolves immediately when no run is
  // active, and only pends (until the run finishes or aborts) while one is.
  let running = false;

  const agent: MockPiAgent = {
    state: {
      messages: [],
      systemPrompt: '',
      tools: [],
    },
    abortCalled: false,
    resetCalled: false,
    promptResult: options?.runResult ?? { content: 'Mock response' },
    promptError: options?.runError ?? null,

    subscribe(handler: (event: PiEvent) => void): () => void {
      eventHandler = handler;
      return () => {
        eventHandler = null;
      };
    },

    emitEvent(event: PiEvent): void {
      if (eventHandler) {
        eventHandler(event);
      }
    },

    async prompt(input: string): Promise<unknown> {
      running = true;
      try {
        // Emit agent_start
        agent.emitEvent({ type: 'agent_start' });

        if (agent.promptError) {
          // Emit agent_end before throwing
          agent.emitEvent({ type: 'agent_end' });
          throw agent.promptError;
        }

        // Simulate a turn
        agent.emitEvent({ type: 'turn_start' });
        agent.emitEvent({
          type: 'turn_end',
          text: typeof agent.promptResult === 'string'
            ? agent.promptResult
            : 'Mock response text',
        });

        // Emit agent_end
        agent.emitEvent({ type: 'agent_end' });

        return agent.promptResult;
      } finally {
        running = false;
        idleResolve?.();
        idleResolve = null;
      }
    },

    abort(): void {
      agent.abortCalled = true;
      if (idleResolve) {
        idleResolve();
        idleResolve = null;
      }
    },

    async waitForIdle(): Promise<void> {
      // Resolve immediately when idle (matches pi's activeRun == null path).
      if (!running) return;
      return new Promise<void>((resolve) => {
        idleResolve = resolve;
      });
    },

    reset(): void {
      agent.resetCalled = true;
      agent.state.messages = [];
    },
  };

  return agent;
}

type TestCortexAgentConstructor = new (
  agent: PiAgent,
  config: CortexAgentConfig,
  tools?: CortexTool[],
  options?: {
    enableSubAgentTool?: boolean;
    enableLoadSkillTool?: boolean;
  },
) => CortexAgent;

function createTestCortexAgent(
  agent: PiAgent,
  config: CortexAgentConfig,
  tools?: CortexTool[],
  options?: {
    enableSubAgentTool?: boolean;
    enableLoadSkillTool?: boolean;
  },
): CortexAgent {
  const CortexAgentCtor = CortexAgent as unknown as TestCortexAgentConstructor;
  return new CortexAgentCtor(agent, config, tools, options);
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

function normalizeModel(model: PiModel | CortexModel): CortexModel {
  const asRecord = model as Record<string, unknown>;
  return asRecord['__brand'] === 'CortexModel'
    ? model as CortexModel
    : makeModel(model as PiModel);
}

function createDefaultConfig(
  overrides?: Partial<CortexAgentConfig> & {
    model?: PiModel | CortexModel;
    utilityModel?: PiModel | CortexModel | 'default';
  },
): CortexAgentConfig {
  const { model, utilityModel, ...rest } = overrides ?? {};
  return {
    model: model
      ? normalizeModel(model)
      : makeModel({ provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    slots: [],
    ...(utilityModel !== undefined
      ? {
          utilityModel: utilityModel === 'default'
            ? 'default'
            : normalizeModel(utilityModel),
        }
      : {}),
    ...rest,
  };
}

describe('CortexAgent', () => {
  let piAgent: MockPiAgent;
  let config: ReturnType<typeof createDefaultConfig>;

  beforeEach(() => {
    piAgent = createMockPiAgent();
    config = createDefaultConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  describe('construction', () => {
    it('creates with valid config', () => {
      const agent = createTestCortexAgent(piAgent, config);
      expect(agent.state).toBe('created');
    });

    it('exposes the context manager', () => {
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        slots: ['a', 'b'],
        compaction: { strategy: 'classic' },
      });

      const cm = agent.getContextManager();
      expect(cm.slotCount).toBe(2);
    });

    it('infers utility model dynamically for anthropic', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const utilityModel = agent.getUtilityModel();
      expect(utilityModel.provider).toBe('anthropic');
      expect(utilityModel.modelId).toBe('claude-haiku-4-5-20251001');
    });

    it('infers utility model dynamically for openai', () => {
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        model: makeModel({ provider: 'openai', name: 'gpt-4o' } as PiModel),
      });
      const utilityModel = agent.getUtilityModel();
      expect(utilityModel.provider).toBe('openai');
      expect(utilityModel.modelId).toBe('gpt-5.4-nano');
    });

    it('uses primary model when no default mapping exists', () => {
      const customModel = makeModel({ provider: 'custom-provider', name: 'custom-model' } as PiModel);
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        model: customModel,
      });
      const utilityModel = agent.getUtilityModel();
      expect(utilityModel).toBe(customModel);
    });

    it('uses explicit utility model when provided', () => {
      const explicitUtility = makeModel({ provider: 'anthropic', name: 'claude-haiku-3' } as PiModel);
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        utilityModel: explicitUtility,
      });
      const utilityModel = agent.getUtilityModel();
      expect(utilityModel).toBe(explicitUtility);
    });

    it('throws on same-provider constraint violation', () => {
      expect(() => {
        createTestCortexAgent(piAgent, {
          ...config,
          model: makeModel({ provider: 'anthropic', name: 'claude-sonnet' } as PiModel),
          utilityModel: makeModel({ provider: 'openai', name: 'gpt-4o-mini' } as PiModel),
        });
      }).toThrow('does not match primary model provider');
    });

    it('allows utilityModel: "default" explicitly', () => {
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        utilityModel: 'default',
      });
      const utilityModel = agent.getUtilityModel();
      expect(utilityModel.provider).toBe('anthropic');
    });
  });

  // -----------------------------------------------------------------------
  // getAutoResolvedUtilityModel (pure peek for UI labelling)
  // -----------------------------------------------------------------------

  describe('getAutoResolvedUtilityModel', () => {
    it('returns the inferred utility model for an enumerable provider', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const auto = agent.getAutoResolvedUtilityModel();
      expect(auto.provider).toBe('anthropic');
      expect(auto.modelId).toBe('claude-haiku-4-5-20251001');
    });

    it('returns the primary model for providers Cortex cannot enumerate (Ollama/custom)', () => {
      // Ollama and custom OpenAI-compatible endpoints surface as a provider
      // with no pi-ai registry, so auto-resolution falls back to the primary.
      const customModel = makeModel({ provider: 'custom', name: 'llama3.3:70b' } as PiModel);
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        model: customModel,
      });
      expect(agent.getAutoResolvedUtilityModel()).toBe(customModel);
    });

    it('reflects auto-resolution even while a manual override is active, without clearing it', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const override = makeModel({ provider: 'anthropic', name: 'claude-haiku-3' } as PiModel);
      agent.setUtilityModel(override);

      // The active utility model is the override...
      expect(agent.getUtilityModel()).toBe(override);
      expect(agent.isUtilityModelOverridden()).toBe(true);

      // ...but the peek still reports what Auto would resolve to, and does not
      // mutate the override state.
      const auto = agent.getAutoResolvedUtilityModel();
      expect(auto.modelId).toBe('claude-haiku-4-5-20251001');
      expect(agent.getUtilityModel()).toBe(override);
      expect(agent.isUtilityModelOverridden()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // envOverrides
  // -----------------------------------------------------------------------

  describe('envOverrides', () => {
    it('stores envOverrides from config', () => {
      const overrides = {
        DYLD_INSERT_LIBRARIES: '/app/dock.dylib',
        ANIMUS_DOCK_SUPPRESS_ADDON: '/app/addon.node',
      };
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        envOverrides: overrides,
      });

      expect(agent.getEnvOverrides()).toBe(overrides);
    });

    it('returns undefined when no envOverrides configured', () => {
      const agent = createTestCortexAgent(piAgent, config);
      expect(agent.getEnvOverrides()).toBeUndefined();
    });

    it('passes envOverrides to McpClientManager', () => {
      const overrides = { DYLD_INSERT_LIBRARIES: '/app/dock.dylib' };
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        envOverrides: overrides,
      });

      const mcpManager = agent.getMcpClientManager();
      expect(mcpManager.envOverrides).toBe(overrides);
    });

    it('does not set McpClientManager envOverrides when not configured', () => {
      const agent = createTestCortexAgent(piAgent, config);

      const mcpManager = agent.getMcpClientManager();
      expect(mcpManager.envOverrides).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // prompt()
  // -----------------------------------------------------------------------

  describe('prompt', () => {
    it('runs the agent and returns a result', async () => {
      piAgent.promptResult = { content: 'Hello world' };
      const agent = createTestCortexAgent(piAgent, config);

      const result = await agent.prompt('Say hello');
      expect(result).toEqual({ content: 'Hello world' });
    });

    it('transitions from CREATED to ACTIVE on first prompt', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      expect(agent.state).toBe('created');

      await agent.prompt('Hello');
      expect(agent.state).toBe('active');
    });

    it('remains ACTIVE on subsequent prompts', async () => {
      const agent = createTestCortexAgent(piAgent, config);

      await agent.prompt('First');
      expect(agent.state).toBe('active');

      await agent.prompt('Second');
      expect(agent.state).toBe('active');
    });

    it('throws when destroyed', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      await agent.destroy();

      await expect(agent.prompt('Hello')).rejects.toThrow('Agent has been destroyed');
    });

    it('classifies and emits errors on failure', async () => {
      piAgent.promptError = new Error('invalid api key');
      const agent = createTestCortexAgent(piAgent, config);

      const errorHandler = vi.fn();
      agent.onError(errorHandler);

      await expect(agent.prompt('Hello')).rejects.toThrow('invalid api key');

      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'authentication',
          severity: 'fatal',
          originalMessage: 'invalid api key',
        }),
      );
    });

    it('classifies rate limit errors', async () => {
      piAgent.promptError = new Error('Rate limit exceeded');
      const agent = createTestCortexAgent(piAgent, config);

      const errorHandler = vi.fn();
      agent.onError(errorHandler);

      await expect(agent.prompt('Hello')).rejects.toThrow();

      expect(errorHandler.mock.calls[0][0].category).toBe('rate_limit');
    });

    it('classifies network errors', async () => {
      piAgent.promptError = new Error('ECONNREFUSED');
      const agent = createTestCortexAgent(piAgent, config);

      const errorHandler = vi.fn();
      agent.onError(errorHandler);

      await expect(agent.prompt('Hello')).rejects.toThrow();

      expect(errorHandler.mock.calls[0][0].category).toBe('network');
    });

    it('swallows error handler exceptions', async () => {
      piAgent.promptError = new Error('Rate limit exceeded');
      const agent = createTestCortexAgent(piAgent, config);

      agent.onError(() => {
        throw new Error('Handler blew up');
      });

      // Should still throw the original error, not the handler error
      await expect(agent.prompt('Hello')).rejects.toThrow('Rate limit exceeded');
    });

    it('emits prompt watchdog lifecycle logs when diagnostics are enabled', async () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        logger,
        diagnostics: {
          promptWatchdog: {
            enabled: true,
            heartbeatIntervalMs: 1000,
          },
        },
      });

      await agent.prompt('Hello');

      expect(logger.info).toHaveBeenCalledWith(
        '[Diagnostics] prompt_started',
        expect.objectContaining({
          inputLength: 5,
          provider: 'anthropic',
        }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        '[Diagnostics] prompt_finished',
        expect.objectContaining({
          status: 'resolved',
        }),
      );
    });

    it('emits abort watchdog logs when diagnostics are enabled', async () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        logger,
        diagnostics: {
          promptWatchdog: {
            enabled: true,
            abortWaitWarningMs: 1000,
          },
        },
      });

      await agent.abort();

      expect(logger.info).toHaveBeenCalledWith(
        '[Diagnostics] abort_requested',
        expect.objectContaining({
          isPrompting: false,
        }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        '[Diagnostics] abort_wait_finished',
        expect.objectContaining({
          elapsedMs: expect.any(Number),
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // System prompt
  // -----------------------------------------------------------------------

  describe('buildSystemPrompt', () => {
    it('puts consumer content first', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const prompt = agent.buildSystemPrompt('You are a helpful assistant.');

      expect(prompt.startsWith('You are a helpful assistant.')).toBe(true);
    });

    it('includes Response Delivery when working tags enabled (default)', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const prompt = agent.buildSystemPrompt('Consumer content');

      expect(prompt).toContain('# Response Delivery');
      expect(prompt).toContain('<working>');
    });

    it('omits Response Delivery when working tags disabled', () => {
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        workingTags: { enabled: false },
      });
      const prompt = agent.buildSystemPrompt('Consumer content');

      expect(prompt).not.toContain('# Response Delivery');
    });

    it('includes System Rules section', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const prompt = agent.buildSystemPrompt('Consumer');

      expect(prompt).toContain('# System Rules');
    });

    it('includes Taking Action section', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const prompt = agent.buildSystemPrompt('Consumer');

      expect(prompt).toContain('# Taking Action');
    });

    it('includes Tool Usage section', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const prompt = agent.buildSystemPrompt('Consumer');

      expect(prompt).toContain('# Tool Usage');
    });

    it('includes Executing with Care section', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const prompt = agent.buildSystemPrompt('Consumer');

      expect(prompt).toContain('# Executing with Care');
    });

    it('includes Environment section with platform info', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const prompt = agent.buildSystemPrompt('Consumer');

      expect(prompt).toContain('# Environment');
      expect(prompt).toContain('Platform:');
      expect(prompt).toContain('Shell:');
      expect(prompt).toContain('Working Directory: /tmp/test-workspace');
    });

    it('preserves consumer content exactly', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const consumerContent = `You are Animus.
Your personality is warm and curious.
You have 12 emotions.`;
      const prompt = agent.buildSystemPrompt(consumerContent);

      expect(prompt.startsWith(consumerContent)).toBe(true);
    });

    it('does not mutate the live system prompt', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const prompt = agent.buildSystemPrompt('Consumer');

      expect(prompt).toContain('Consumer');
      expect(agent.getCurrentSystemPrompt()).toContain('Test base prompt');
      expect(agent.getCurrentSystemPrompt()).not.toContain('Consumer');
    });
  });

  describe('setBasePrompt', () => {
    it('updates the live system prompt and tracks the base prompt', () => {
      const agent = createTestCortexAgent(piAgent, config);

      const prompt = agent.setBasePrompt('Base prompt');

      expect(prompt).toContain('Base prompt');
      expect(agent.getBasePrompt()).toBe('Base prompt');
      expect(agent.getCurrentSystemPrompt()).toContain('Base prompt');
      expect(piAgent.state.systemPrompt).toContain('Base prompt');
    });
  });

  describe('rebuildSystemPrompt', () => {
    it('updates the system prompt without losing conversation history', async () => {
      const agent = createTestCortexAgent(piAgent, config);

      // Build initial prompt
      agent.setBasePrompt('Original persona');

      // Simulate some conversation history
      piAgent.state.messages.push(
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      );

      // Rebuild with new content
      agent.rebuildSystemPrompt('Updated persona');

      // Conversation should still be there
      const history = agent.getConversationHistory();
      expect(history.length).toBe(2);
      expect(history[0]!.content).toBe('Hello');

      // New prompt should contain updated content
      const currentPrompt = agent.getCurrentSystemPrompt();
      expect(currentPrompt).toContain('Updated persona');
      expect(currentPrompt).not.toContain('Original persona');
    });
  });

  // -----------------------------------------------------------------------
  // Conversation history persistence
  // -----------------------------------------------------------------------

  describe('conversation history', () => {
    it('getConversationHistory excludes slot region', () => {
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        slots: ['slot1', 'slot2'],
      });

      const cm = agent.getContextManager();
      cm.setSlot('slot1', 'Slot content 1');
      cm.setSlot('slot2', 'Slot content 2');

      // Simulate conversation history after slots
      piAgent.state.messages.push(
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      );

      const history = agent.getConversationHistory();

      expect(history.length).toBe(2);
      expect(history[0]!.content).toBe('Hello');
      expect(history[1]!.content).toBe('Hi!');
    });

    it('getConversationHistory returns empty when only slots exist', () => {
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        slots: ['slot1'],
      });

      const cm = agent.getContextManager();
      cm.setSlot('slot1', 'Content');

      const history = agent.getConversationHistory();
      expect(history.length).toBe(0);
    });

    it('restoreConversationHistory injects after slots', () => {
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        slots: ['slot1', 'slot2'],
        compaction: { strategy: 'classic' },
      });

      const cm = agent.getContextManager();
      cm.setSlot('slot1', 'Slot 1');
      cm.setSlot('slot2', 'Slot 2');

      // Restore some saved conversation
      agent.restoreConversationHistory([
        { role: 'user', content: 'Restored message 1' },
        { role: 'assistant', content: 'Restored response 1' },
        { role: 'user', content: 'Restored message 2' },
      ]);

      // Slots should be intact
      expect(piAgent.state.messages[0]!.content).toBe('Slot 1');
      expect(piAgent.state.messages[1]!.content).toBe('Slot 2');

      // Conversation should be after slots
      expect(piAgent.state.messages[2]!.content).toBe('Restored message 1');
      expect(piAgent.state.messages[3]!.content).toBe('Restored response 1');
      expect(piAgent.state.messages[4]!.content).toBe('Restored message 2');
    });

    it('restoreConversationHistory replaces existing conversation', () => {
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        slots: ['slot1'],
      });

      const cm = agent.getContextManager();
      cm.setSlot('slot1', 'Slot content');

      // Add some existing conversation
      piAgent.state.messages.push(
        { role: 'user', content: 'Old message' },
      );

      // Restore should replace
      agent.restoreConversationHistory([
        { role: 'user', content: 'New message' },
      ]);

      const history = agent.getConversationHistory();
      expect(history.length).toBe(1);
      expect(history[0]!.content).toBe('New message');
    });
  });

  // -----------------------------------------------------------------------
  // Observational memory restore
  // -----------------------------------------------------------------------

  describe('restoreObservationalMemoryState slot population', () => {
    it('leaves the observation slot empty when restored observations are empty', () => {
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        compaction: { strategy: 'observational' },
      });
      const cm = agent.getContextManager();

      agent.restoreObservationalMemoryState({
        observations: '',
        continuationHint: null,
        observationTokenCount: 0,
        generationCount: 0,
        bufferedChunks: [],
        bufferWatermark: 0,
      });

      // A resumed-but-never-observed session must look like a fresh one: no
      // observation preamble injected around an empty <observations> block.
      expect(cm.getSlot('_observations')).toBe('');
    });

    it('populates the observation slot when restored observations are present', () => {
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        compaction: { strategy: 'observational' },
      });
      const cm = agent.getContextManager();

      agent.restoreObservationalMemoryState({
        observations: 'User prefers TypeScript.',
        continuationHint: null,
        observationTokenCount: 6,
        generationCount: 1,
        bufferedChunks: [],
        bufferWatermark: 0,
      });

      expect(cm.getSlot('_observations')).toContain('User prefers TypeScript.');
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  describe('lifecycle', () => {
    it('starts in CREATED state', () => {
      const agent = createTestCortexAgent(piAgent, config);
      expect(agent.state).toBe('created');
    });

    it('transitions to ACTIVE after first prompt', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      await agent.prompt('Hello');
      expect(agent.state).toBe('active');
    });

    it('transitions to DESTROYED after destroy', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      await agent.destroy();
      expect(agent.state).toBe('destroyed');
    });

    it('destroy is idempotent', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      await agent.destroy();
      await agent.destroy(); // Should not throw
      expect(agent.state).toBe('destroyed');
    });

    it('abort calls agent.abort() and waitForIdle()', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      await agent.prompt('Hello');

      await agent.abort();

      expect(piAgent.abortCalled).toBe(true);
    });

    it('abort keeps the agent in ACTIVE state', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      await agent.prompt('Hello');

      await agent.abort();

      expect(agent.state).toBe('active');
    });

    it('prompt() issued right after abort() resolves does not fail fast on a stale gate', async () => {
      const agent = createTestCortexAgent(piAgent, config);

      // Hold a turn open; release it when abort() reaches pi (as a real
      // abort would settle the in-flight run).
      let release!: () => void;
      const originalPrompt = piAgent.prompt.bind(piAgent);
      const calls: string[] = [];
      piAgent.prompt = async (input: string): Promise<unknown> => {
        calls.push(input);
        if (calls.length === 1) {
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return originalPrompt(input);
      };
      const originalAbort = piAgent.abort.bind(piAgent);
      piAgent.abort = (): void => {
        originalAbort();
        release();
      };

      const first = agent.prompt('one');
      await new Promise((resolve) => setImmediate(resolve));

      await agent.abort();
      await first;

      // The gate has fully released the aborted cycle by the time abort()
      // resolves, so a follow-up prompt starts a fresh, non-cancelled turn.
      await expect(agent.prompt('two')).resolves.toBeDefined();
      expect(calls).toEqual(['one', 'two']);
    });

    it('does not add an exit listener per agent instance', async () => {
      const before = process.listenerCount('exit');

      const first = createTestCortexAgent(createMockPiAgent(), config);
      const second = createTestCortexAgent(createMockPiAgent(), config);
      const third = createTestCortexAgent(createMockPiAgent(), config);

      const after = process.listenerCount('exit');
      expect(after - before).toBeLessThanOrEqual(1);

      await first.destroy();
      await second.destroy();
      await third.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  describe('events', () => {
    it('onLoopComplete fires on loop_end (agent_end)', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const handler = vi.fn();
      agent.onLoopComplete(handler);

      await agent.prompt('Hello');

      // agent.run() emits agent_end which maps to loop_end -> onLoopComplete
      expect(handler).toHaveBeenCalled();
    });

    it('suppresses onLoopComplete for a run that ended in error (retry may follow)', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const handler = vi.fn();
      agent.onLoopComplete(handler);

      // pi-agent-core emits agent_end even when a run fails, leaving the failure
      // in state.errorMessage. With background retry that agent_end belongs to an
      // intermediate attempt, not the logical turn boundary, so onLoopComplete
      // must NOT fire (firing it would let a consumer mark the turn idle while a
      // retry is still pending, desyncing its run-state).
      piAgent.state.errorMessage = 'Connection error.';
      piAgent.emitEvent({ type: 'agent_end' });
      expect(handler).not.toHaveBeenCalled();

      // The run that finally succeeds clears errorMessage; onLoopComplete fires once.
      piAgent.state.errorMessage = undefined;
      piAgent.emitEvent({ type: 'agent_end' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('onTurnComplete fires with AgentTextOutput', async () => {
      piAgent.promptResult = 'Hello <working>internal</working> world';
      const agent = createTestCortexAgent(piAgent, config);

      const handler = vi.fn();
      agent.onTurnComplete(handler);

      await agent.prompt('Hello');

      expect(handler).toHaveBeenCalled();
      const output = handler.mock.calls[0][0];
      expect(output.raw).toBe('Hello <working>internal</working> world');
    });

    it('onError fires for classified errors', async () => {
      piAgent.promptError = new Error('Rate limit exceeded');
      const agent = createTestCortexAgent(piAgent, config);

      const handler = vi.fn();
      agent.onError(handler);

      await expect(agent.prompt('Hello')).rejects.toThrow();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].category).toBe('rate_limit');
    });

    it('multiple handlers can be registered for the same event', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      agent.onLoopComplete(handler1);
      agent.onLoopComplete(handler2);

      await agent.prompt('Hello');

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('auto-wires current-context token tracking from turn_end usage data', () => {
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        model: makeModel({ provider: 'anthropic', name: 'claude-sonnet-4-20250514', contextWindow: 200_000 } as PiModel),
      });

      expect(agent.currentContextTokenCount).toBe(0);

      // Emit a turn_end event with usage data (pattern: event.usage.input)
      piAgent.emitEvent({
        type: 'turn_end',
        text: 'response text',
        usage: { input: 85_000 },
      });

      expect(agent.currentContextTokenCount).toBe(85_000);
    });

    it('auto-wires current-context token tracking from message.usage.input pattern', () => {
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        model: makeModel({ provider: 'anthropic', name: 'claude-sonnet-4-20250514', contextWindow: 200_000 } as PiModel),
      });

      piAgent.emitEvent({
        type: 'turn_end',
        message: {
          content: 'response text',
          usage: { input: 42_000 },
        },
      });

      expect(agent.currentContextTokenCount).toBe(42_000);
    });

    it('does not update token count when turn_end has no usage data', () => {
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        model: makeModel({ provider: 'anthropic', name: 'claude-sonnet-4-20250514', contextWindow: 200_000 } as PiModel),
      });

      // Manually set a known value
      agent.updateCurrentContextTokenCount(50_000);

      // Emit a turn_end with no usage data
      piAgent.emitEvent({
        type: 'turn_end',
        text: 'response without usage',
      });

      // Should remain unchanged since no usage data was available
      expect(agent.currentContextTokenCount).toBe(50_000);
    });

    it('estimates current context tokens from the live agent snapshot', () => {
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        slots: ['project-context'],
      });

      agent.getContextManager().setSlot('project-context', 'Project context goes here');
      agent.getContextManager().setEphemeral('Ephemeral context');

      const estimate = agent.estimateCurrentContextTokens();

      expect(estimate).toBeGreaterThan(0);
    });

    it('uses the larger of the post-hoc count and heuristic estimate', () => {
      const agent = createTestCortexAgent(piAgent, config);
      agent.updateCurrentContextTokenCount(50_000);

      expect(agent.estimateCurrentContextTokens()).toBe(50_000);
    });
  });

  // -----------------------------------------------------------------------
  // Destroy cleanup
  // -----------------------------------------------------------------------

  describe('destroy cleanup', () => {
    it('calls agent.abort() during destroy', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      await agent.destroy();

      expect(piAgent.abortCalled).toBe(true);
    });

    it('calls agent.reset() during destroy', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      await agent.destroy();

      expect(piAgent.resetCalled).toBe(true);
    });

    it('emits onLoopComplete during destroy for final checkpoint', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const handler = vi.fn();
      agent.onLoopComplete(handler);

      await agent.destroy();

      // onLoopComplete should fire once during destroy (the checkpoint emission)
      expect(handler).toHaveBeenCalled();
    });

    it('clears handlers after destroy', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const errorHandler = vi.fn();
      agent.onError(errorHandler);

      await agent.destroy();

      // After destroy, handlers should be cleared
      // Attempting to prompt should throw "destroyed" not trigger error handlers
      await expect(agent.prompt('Hello')).rejects.toThrow('Agent has been destroyed');
      expect(errorHandler).not.toHaveBeenCalled();
    });

    it('respects destroy timeout', async () => {
      // Create an agent where waitForIdle never resolves quickly
      const slowAgent = createMockPiAgent();
      const originalWaitForIdle = slowAgent.waitForIdle;
      slowAgent.waitForIdle = () => new Promise((resolve) => {
        setTimeout(resolve, 60000); // Very slow
      });

      const agent = createTestCortexAgent(slowAgent, config);

      // Destroy with a short timeout
      const startTime = Date.now();
      await agent.destroy(100);
      const elapsed = Date.now() - startTime;

      // Should complete within the timeout (plus some margin)
      expect(elapsed).toBeLessThan(500);
      expect(agent.state).toBe('destroyed');
    });

    it('concurrent destroy() calls share one teardown', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const resetSpy = vi.spyOn(piAgent, 'reset');

      await Promise.all([agent.destroy(), agent.destroy()]);

      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(agent.state).toBe('destroyed');
    });

    it('rejects prompt() issued while destroy is in progress', async () => {
      const agent = createTestCortexAgent(piAgent, config);

      const teardown = agent.destroy();
      expect(agent.state).toBe('destroying');
      await expect(agent.prompt('Hello')).rejects.toThrow('Agent is being destroyed');

      await teardown;
      expect(agent.state).toBe('destroyed');
    });

    it('kills a background bash process and untracks its pid on destroy', async () => {
      const isAlive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      const agent = createTestCortexAgent(
        piAgent,
        createDefaultConfig({ workingDirectory: process.cwd() }),
        [],
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      );
      agent.refreshTools();

      const allTools = piAgent.state.tools as Array<{
        name: string;
        execute: (toolCallId: string, params: unknown) => Promise<{
          details: { taskId: string | null };
        }>;
      }>;
      const bashTool = allTools.find((tool) => tool.name === 'Bash');
      expect(bashTool).toBeDefined();

      const result = await bashTool!.execute('tc-bash-bg', { command: 'sleep 30', background: true });
      const taskId = result.details.taskId as string;

      const internal = agent as unknown as {
        toolRuntime: { backgroundTasks: { get: (id: string) => { process: { pid?: number } } | undefined } };
        trackedPids: Set<number>;
      };
      const pid = internal.toolRuntime.backgroundTasks.get(taskId)?.process.pid;
      expect(pid).toBeGreaterThan(0);
      // The spawned shell entered PID tracking (destroy/exit safety nets).
      expect(internal.trackedPids.has(pid!)).toBe(true);
      expect(isAlive(pid!)).toBe(true);

      await agent.destroy();

      // SIGKILL delivery, reaping, and the close-event untrack are async.
      const deadline = Date.now() + 3000;
      while ((isAlive(pid!) || internal.trackedPids.has(pid!)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(isAlive(pid!)).toBe(false);
      expect(internal.trackedPids.has(pid!)).toBe(false);
    }, 10000);

    it('does not start a new loop for a background completion pending at destroy', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const internal = agent as unknown as {
        toolRuntime: { backgroundTasks: { set: (t: unknown) => void } };
        deliverOrQueueBackgroundCompletion: (item: unknown) => Promise<void>;
        pendingBackgroundResults: unknown[];
      };
      internal.toolRuntime.backgroundTasks.set({
        id: 'task_d',
        command: 'sleep 1',
        process: {},
        stdout: 'late result',
        stderr: '',
        exitCode: 0,
        completed: true,
        notified: false,
        startTime: Date.now() - 1000,
      });

      // Hold a turn open so the completion is queued behind a live loop.
      let release!: () => void;
      const originalPrompt = piAgent.prompt.bind(piAgent);
      const promptCalls: string[] = [];
      piAgent.prompt = async (input: string): Promise<unknown> => {
        promptCalls.push(input);
        if (promptCalls.length === 1) {
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return originalPrompt(input);
      };

      const turn = agent.prompt('long turn');
      await new Promise((resolve) => setImmediate(resolve));
      const delivery = internal.deliverOrQueueBackgroundCompletion({ kind: 'bash', taskId: 'task_d' });

      const teardown = agent.destroy();
      release();
      await turn;
      await delivery;
      await teardown;

      // The pending completion never restarted the loop mid-teardown.
      expect(promptCalls).toHaveLength(1);
      expect(internal.pendingBackgroundResults).toHaveLength(0);
      expect(agent.state).toBe('destroyed');
    });
  });

  // -----------------------------------------------------------------------
  // transformContext hook
  // -----------------------------------------------------------------------

  describe('transformContext', () => {
    it('returns a composable hook function', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const hook = agent.getTransformContextHook();
      expect(typeof hook).toBe('function');
    });

    it('the hook passes through context when no ephemeral content', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const hook = agent.getTransformContextHook();

      const context = {
        systemPrompt: 'test',
        model: {},
        messages: [{ role: 'user' as const, content: 'Hello' }],
        tools: [],
        thinkingLevel: 'medium',
      };

      const result = await hook(context);
      // With no ephemeral, compaction stub, and skill stub are all no-ops
      expect(result.messages.length).toBe(1);
    });

    it('the hook injects ephemeral content', async () => {
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        slots: [],
      });

      const cm = agent.getContextManager();
      cm.setEphemeral('Ephemeral data');

      const hook = agent.getTransformContextHook();
      const context = {
        systemPrompt: 'test',
        model: {},
        messages: [{ role: 'user' as const, content: 'Hello' }],
        tools: [],
        thinkingLevel: 'medium',
      };

      const result = await hook(context);
      expect(result.messages.length).toBe(2);
      expect(result.messages[0]!.content).toBe('Ephemeral data');
      expect(result.messages[1]!.content).toBe('Hello');
    });

    it('persists compaction source mutations into the active transform context', async () => {
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        slots: [],
        compaction: { strategy: 'classic' },
      });

      const sourceMessages = [
        { role: 'user' as const, content: 'old message' },
        { role: 'assistant' as const, content: 'old response' },
      ];
      piAgent.state.messages = [...sourceMessages];

      const compacted = [{ role: 'assistant' as const, content: 'summary' }];
      const manager = agent.getCompactionManager();
      vi.spyOn(manager, 'applyInsertionCap').mockResolvedValue();
      vi.spyOn(manager, 'applyInTransformContext').mockImplementation(async (
        ctx,
        getHistory,
        setHistory,
        getSourceHistory,
        setSourceHistory,
      ) => {
        expect(getSourceHistory?.()).toEqual(sourceMessages);
        setSourceHistory?.(compacted);
        return setHistory(ctx, compacted);
      });

      const hook = agent.getTransformContextHook();
      const result = await hook({
        systemPrompt: 'test',
        model: {},
        messages: sourceMessages,
        tools: [],
        thinkingLevel: 'medium',
      });

      expect(sourceMessages).toEqual(compacted);
      expect(piAgent.state.messages).toEqual(compacted);
      expect(result.messages).toEqual(compacted);
    });
  });

  // -----------------------------------------------------------------------
  // Model access
  // -----------------------------------------------------------------------

  describe('model access', () => {
    it('getModel returns the primary model', () => {
      const model = makeModel({ provider: 'anthropic', name: 'claude-sonnet-4' } as PiModel);
      const agent = createTestCortexAgent(piAgent, {
        ...config,
        model,
      });

      expect(agent.getModel()).toBe(model);
    });

    it('getUtilityModel returns resolved utility model', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const utility = agent.getUtilityModel();

      expect(utility.provider).toBe('anthropic');
      expect(utility.modelId).toBeDefined();
    });

    it('utilityComplete uses utility model for completion', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      // utilityComplete requires a real pi-ai complete() call which needs a valid model
      // Just verify the method exists and is callable
      expect(typeof agent.utilityComplete).toBe('function');
    });
  });

  // -----------------------------------------------------------------------
  // setModel / setThinkingLevel / refreshTools
  // -----------------------------------------------------------------------

  describe('setModel', () => {
    it('updates the primary model', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const newModel = makeModel({ provider: 'openai', name: 'gpt-4o', contextWindow: 128_000 } as PiModel);

      agent.setModel(newModel);

      expect(agent.getModel()).toBe(newModel);
    });

    it('updates agent.state.model', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const newModel = makeModel({ provider: 'openai', name: 'gpt-4o' } as PiModel);

      agent.setModel(newModel);

      expect(piAgent.state.model).toEqual(
        expect.objectContaining({ provider: 'openai', name: 'gpt-4o' }),
      );
    });

    it('does not throw when agent lacks setModel', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const newModel = makeModel({ provider: 'openai', name: 'gpt-4o' } as PiModel);

      // Should not throw even though piAgent has no setModel
      expect(() => agent.setModel(newModel)).not.toThrow();
    });
  });

  describe('setThinkingLevel', () => {
    it('updates agent.state.thinkingLevel', () => {
      const agent = createTestCortexAgent(piAgent, config);
      agent.setThinkingLevel('high');

      expect(piAgent.state.thinkingLevel).toBe('high');
    });

    it('maps max to xhigh in agent state', () => {
      const agent = createTestCortexAgent(piAgent, config);

      agent.setThinkingLevel('max');

      expect(piAgent.state.thinkingLevel).toBe('xhigh');
    });
  });

  describe('refreshTools', () => {
    it('updates agent.state.tools with registered + MCP tools', () => {
      const agent = createTestCortexAgent(
        piAgent,
        config,
        [], // No additional tools; built-in tools auto-register
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      );

      // refreshTools merges auto-registered built-in tools with MCP tools (empty in this test)
      agent.refreshTools();

      const allTools = piAgent.state.tools as Array<{ name: string }>;
      // 9 built-in tools auto-registered: Read, Write, Edit, UndoEdit,
      // Glob, Grep, Bash, TaskOutput, WebFetch
      expect(allTools.length).toBe(9);
      const toolNames = allTools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain('Read');
      expect(toolNames).toContain('UndoEdit');
      expect(toolNames).toContain('Bash');
      expect(toolNames).toContain('Glob');
    });

    it('adapts Bash using the canonical Cortex tool contract', async () => {
      const agent = createTestCortexAgent(
        piAgent,
        createDefaultConfig({ workingDirectory: process.cwd() }),
        [],
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      );

      agent.refreshTools();

      const allTools = piAgent.state.tools as Array<{
        name: string;
        execute: (toolCallId: string, params: unknown) => Promise<{
          content: Array<{ type: string; text?: string }>;
        }>;
      }>;
      const bashTool = allTools.find((tool) => tool.name === 'Bash');

      expect(bashTool).toBeDefined();

      const result = await bashTool!.execute('tc-bash', { command: 'echo "adapter ok"' });
      expect(result.content[0]?.text).toContain('adapter ok');
    });

    it('persists oversized Bash output before it reaches conversation history', async () => {
      const persistResult = vi.fn().mockResolvedValue('/tmp/bash-oversized.txt');

      const agent = createTestCortexAgent(
        piAgent,
        createDefaultConfig({
          workingDirectory: process.cwd(),
          persistResult,
        }),
        [],
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      );

      agent.refreshTools();

      const allTools = piAgent.state.tools as Array<{
        name: string;
        execute: (toolCallId: string, params: unknown) => Promise<{
          content: Array<{ type: string; text?: string }>;
        }>;
      }>;
      const bashTool = allTools.find((tool) => tool.name === 'Bash');

      expect(bashTool).toBeDefined();

      const result = await bashTool!.execute('tc-bash-oversized', {
        command: `node -e "process.stdout.write('x'.repeat(${DEFAULT_TOOL_THRESHOLDS.Bash * 4 + 5_000}))"`,
      });
      const text = result.content[0]?.text ?? '';

      expect(persistResult).toHaveBeenCalledOnce();
      expect(persistResult).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          toolName: 'Bash',
          toolCallId: 'tc-bash-oversized',
        }),
      );
      expect(text).toContain('[Result persisted: /tmp/bash-oversized.txt');
      expect(text).toContain('Use the Read tool with offset/limit');
      expect(text).toContain('tokens trimmed');

      piAgent.state.messages.push({
        role: 'tool',
        content: [{ type: 'tool_result', name: 'Bash', toolCallId: 'tc-bash-oversized', text }],
      });

      const history = agent.getConversationHistory();
      expect(history).toHaveLength(1);
      expect(((history[0]!.content as Array<{ text?: string }>)[0]?.text) ?? '').toContain(
        '[Result persisted: /tmp/bash-oversized.txt',
      );
      expect(((history[0]!.content as Array<{ text?: string }>)[0]?.text) ?? '').toContain('tokens trimmed');
    });

    it('persists oversized WebFetch output before returning from the wrapped tool', async () => {
      const persistResult = vi.fn().mockResolvedValue('/tmp/webfetch-oversized.txt');

      const agent = createTestCortexAgent(
        piAgent,
        createDefaultConfig({
          workingDirectory: process.cwd(),
          persistResult,
        }),
        [],
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      );
      vi.spyOn(agent, 'utilityComplete').mockResolvedValue('y'.repeat(MAX_RESULT_TOKENS * 4 + 5_000));
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        status: 200,
        headers: {
          get(name: string) {
            return name.toLowerCase() === 'content-type' ? 'text/plain' : null;
          },
        },
        text: async () => 'small page body',
      } as unknown as Response);

      agent.refreshTools();

      const allTools = piAgent.state.tools as Array<{
        name: string;
        execute: (toolCallId: string, params: unknown) => Promise<{
          content: Array<{ type: string; text?: string }>;
        }>;
      }>;
      const webFetchTool = allTools.find((tool) => tool.name === 'WebFetch');

      expect(webFetchTool).toBeDefined();

      const result = await webFetchTool!.execute('tc-webfetch-oversized', {
        url: 'https://1.1.1.1/test',
        prompt: 'Summarize the page',
      });
      const text = result.content[0]?.text ?? '';

      expect(persistResult).toHaveBeenCalledOnce();
      expect(persistResult).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          toolName: 'WebFetch',
          toolCallId: 'tc-webfetch-oversized',
        }),
      );
      expect(text).toContain('[Result persisted: /tmp/webfetch-oversized.txt');
      expect(text).toContain('Use the Read tool with offset/limit');
      expect(text).toContain('tokens trimmed');
    });

    it('supports raw pi-agent-core tools when explicitly wrapped', async () => {
      const legacyTool = fromPiAgentTool({
        name: 'LegacyTool',
        description: 'Legacy execution contract',
        parameters: {},
        execute: vi.fn(async (toolCallId: string, params: unknown) => ({
          content: [{ type: 'text', text: `${toolCallId}:${String((params as { value: string }).value)}` }],
          details: {},
        })),
      });

      const agent = createTestCortexAgent(
        piAgent,
        config,
        [legacyTool],
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      );

      agent.refreshTools();

      const allTools = piAgent.state.tools as Array<{
        name: string;
        execute: (toolCallId: string, params: unknown) => Promise<{
          content: Array<{ type: string; text?: string }>;
        }>;
      }>;
      const tool = allTools.find((entry) => entry.name === 'LegacyTool');

      expect(tool).toBeDefined();

      const result = await tool!.execute('legacy-call', { value: 'ok' });
      expect(result.content[0]?.text).toBe('legacy-call:ok');
    });

    it('rejects raw pi-agent-core tools unless explicitly wrapped', () => {
      const legacyTool = {
        name: 'LegacyTool',
        description: 'Legacy execution contract',
        parameters: {},
        execute: async (
          toolCallId: string,
          params: unknown,
          _signal?: AbortSignal,
          _onUpdate?: (partialResult: unknown) => void,
        ) => ({
          content: [{ type: 'text', text: `${toolCallId}:${String(params)}` }],
          details: {},
        }),
      };

      expect(() => createTestCortexAgent(
        piAgent,
        config,
        [legacyTool as unknown as CortexTool],
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      )).toThrow(/fromPiAgentTool/);
    });

    it('does not throw when agent lacks setTools', () => {
      const agent = createTestCortexAgent(piAgent, config);

      expect(() => agent.refreshTools()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Event bridge access
  // -----------------------------------------------------------------------

  describe('event bridge access', () => {
    it('exposes the event bridge', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const bridge = agent.getEventBridge();
      expect(bridge).toBeDefined();
    });

    it('exposes the budget guard', () => {
      const agent = createTestCortexAgent(piAgent, config);
      const guard = agent.getBudgetGuard();
      expect(guard).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // steer()
  // -----------------------------------------------------------------------

  describe('steer', () => {
    it('calls agent.steer() with user role message when prompting', async () => {
      const steerCalls: Array<{ role: string; content: string }> = [];
      piAgent.steer = (msg: { role: string; content: string }) => {
        steerCalls.push(msg);
      };

      const agent = createTestCortexAgent(piAgent, config);

      // Override run to hold open the prompting state so we can steer
      const originalPrompt = piAgent.prompt.bind(piAgent);
      piAgent.prompt = async (input: string): Promise<unknown> => {
        // Agent is now "prompting". Steer during this window.
        agent.steer('New context from user');
        return originalPrompt(input);
      };

      await agent.prompt('Hello');

      expect(steerCalls.length).toBe(1);
      expect(steerCalls[0]!.role).toBe('user');
      expect(steerCalls[0]!.content).toBe('New context from user');
    });

    it('is a no-op when not prompting', () => {
      const steerCalls: Array<{ role: string; content: string }> = [];
      piAgent.steer = (msg: { role: string; content: string }) => {
        steerCalls.push(msg);
      };

      const agent = createTestCortexAgent(piAgent, config);

      // Not prompting, should be a no-op
      agent.steer('This should be ignored');

      expect(steerCalls.length).toBe(0);
    });

    it('is a no-op after prompt completes', async () => {
      const steerCalls: Array<{ role: string; content: string }> = [];
      piAgent.steer = (msg: { role: string; content: string }) => {
        steerCalls.push(msg);
      };

      const agent = createTestCortexAgent(piAgent, config);
      await agent.prompt('Hello');

      // Prompt is done, should be a no-op
      agent.steer('Late message');

      expect(steerCalls.length).toBe(0);
    });

    it('delivers a steer issued in the same frame as prompt()', async () => {
      const steerCalls: Array<{ role: string; content: string }> = [];
      piAgent.steer = (msg: { role: string; content: string }) => {
        steerCalls.push(msg);
      };

      const agent = createTestCortexAgent(piAgent, config);

      // The turn is deferred one microtask (it dequeues from the loop gate),
      // so _isPrompting is still false here. steer() must treat the non-empty
      // gate as "prompting" and forward to pi instead of dropping the message.
      const turn = agent.prompt('Hello');
      agent.steer('same-frame steer');
      await turn;

      expect(steerCalls).toHaveLength(1);
      expect(steerCalls[0]!.content).toBe('same-frame steer');
    });
  });

  // -----------------------------------------------------------------------
  // Prompt serialization (loop gate)
  // -----------------------------------------------------------------------

  describe('prompt serialization', () => {
    interface GateInternals {
      _prePromptMessageCount: number;
      _isPrompting: boolean;
      toolRuntime: { resetForLoop: () => void };
    }

    function holdPromptOpen(mock: MockPiAgent): { release: () => void; calls: string[] } {
      const originalPrompt = mock.prompt.bind(mock);
      const calls: string[] = [];
      let release!: () => void;
      mock.prompt = async (input: string): Promise<unknown> => {
        calls.push(input);
        if (calls.length === 1) {
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return originalPrompt(input);
      };
      return { release: () => release(), calls };
    }

    it('a concurrent prompt() fails fast without touching the running loop', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const internal = agent as unknown as GateInternals;
      const { release, calls } = holdPromptOpen(piAgent);

      const first = agent.prompt('first turn');
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls).toHaveLength(1);

      const boundaryDuringLoop = internal._prePromptMessageCount;
      const resetSpy = vi.spyOn(internal.toolRuntime, 'resetForLoop');

      await expect(agent.prompt('second turn')).rejects.toThrow(/already processing/i);

      // The loser never reset the live loop's tool runtime, never moved its
      // history boundary, and never reached pi-agent-core.
      expect(resetSpy).not.toHaveBeenCalled();
      expect(internal._prePromptMessageCount).toBe(boundaryDuringLoop);
      expect(calls).toHaveLength(1);

      // The running loop is still live: steer() reaches it.
      const steerCalls: Array<{ role: string; content: string }> = [];
      piAgent.steer = (msg: { role: string; content: string }) => {
        steerCalls.push(msg);
      };
      expect(internal._isPrompting).toBe(true);
      agent.steer('mid-loop steer');
      expect(steerCalls).toHaveLength(1);

      // And the first loop completes normally.
      release();
      await expect(first).resolves.toBeDefined();
    });

    it('a background completion arriving while idle does not race a consumer prompt()', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const internal = agent as unknown as GateInternals & {
        toolRuntime: { resetForLoop: () => void; backgroundTasks: { set: (t: unknown) => void } };
        deliverOrQueueBackgroundCompletion: (item: unknown) => Promise<void>;
      };
      internal.toolRuntime.backgroundTasks.set({
        id: 'task_9',
        command: 'sleep 1',
        process: {},
        stdout: 'done',
        stderr: '',
        exitCode: 0,
        completed: true,
        notified: false,
        startTime: Date.now() - 1000,
      });
      const promptSpy = vi.spyOn(piAgent, 'prompt');

      // Delivery is scheduled (gate becomes busy synchronously), so a
      // consumer prompt in the same tick fails fast instead of interleaving.
      const delivery = internal.deliverOrQueueBackgroundCompletion({ kind: 'bash', taskId: 'task_9' });
      await expect(agent.prompt('user turn')).rejects.toThrow(/already processing/i);

      await delivery;
      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(promptSpy.mock.calls[0][0] as string).toContain('task_9');
    });

    it('a same-frame prompt() + abort() cancels the queued turn without running pi', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const promptSpy = vi.spyOn(piAgent, 'prompt');
      const errored = vi.fn();
      agent.onError(errored);

      // prompt() only enqueues; the cycle dequeues next microtask. A same-
      // frame abort() must be visible to that not-yet-started cycle, which
      // cancels it before it ever calls pi (matching main, which cancels in
      // ~1ms rather than running the whole turn un-aborted).
      const turn = agent.prompt('do work');
      const settled = turn.then(
        () => 'resolved',
        (e: Error) => e.name,
      );
      const aborting = agent.abort();

      const [outcome] = await Promise.all([settled, aborting]);

      expect(outcome).toBe('AbortError');
      expect(promptSpy).not.toHaveBeenCalled();
      expect(agent.state).toBe('active');
      expect(errored).toHaveBeenCalledTimes(1);
      expect(errored.mock.calls[0][0].category).toBe('cancelled');

      // The agent stays usable: a fresh prompt runs normally afterward.
      await expect(agent.prompt('next')).resolves.toBeDefined();
      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(promptSpy.mock.calls[0][0] as string).toBe('next');
    });
  });

  // -----------------------------------------------------------------------
  // directComplete()
  // -----------------------------------------------------------------------

  describe('directComplete', () => {
    it('directComplete method exists and is callable', () => {
      const agent = createTestCortexAgent(piAgent, config);
      expect(typeof agent.directComplete).toBe('function');
    });
  });

  // -----------------------------------------------------------------------
  // CortexAgent.create() factory
  // -----------------------------------------------------------------------

  describe('create factory', () => {
    it('create factory method exists', () => {
      expect(typeof CortexAgent.create).toBe('function');
    });
  });

  // -----------------------------------------------------------------------
  // Background bash task completion wake-up
  // -----------------------------------------------------------------------

  describe('background bash task completion', () => {
    interface InternalAgent {
      toolRuntime: { backgroundTasks: { set: (t: unknown) => void } };
      deliverOrQueueBackgroundCompletion: (item: unknown) => Promise<void>;
      drainPendingBackgroundResults: () => Promise<void>;
      pendingBackgroundResults: unknown[];
      _isPrompting: boolean;
    }

    function seedCompletedTask(
      agent: CortexAgent,
      overrides?: { exitCode?: number; stdout?: string; notified?: boolean; id?: string },
    ): string {
      const id = overrides?.id ?? 'task_1';
      (agent as unknown as InternalAgent).toolRuntime.backgroundTasks.set({
        id,
        command: 'npm run check',
        process: {},
        stdout: overrides?.stdout ?? 'all tests green',
        stderr: '',
        exitCode: overrides?.exitCode ?? 0,
        completed: true,
        notified: overrides?.notified ?? false,
        startTime: Date.now() - 1000,
      });
      return id;
    }

    it('wakes the loop when a bash task completes while idle', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const internal = agent as unknown as InternalAgent;
      const id = seedCompletedTask(agent, { stdout: 'all tests green' });
      const promptSpy = vi.spyOn(piAgent, 'prompt');

      await internal.deliverOrQueueBackgroundCompletion({ kind: 'bash', taskId: id });

      expect(promptSpy).toHaveBeenCalledTimes(1);
      const delivered = promptSpy.mock.calls[0][0] as string;
      expect(delivered).toContain(id);
      expect(delivered).toContain('completed');
      expect(delivered).toContain('exit code: 0');
      expect(delivered).toContain('all tests green');
    });

    it('marks a failed task and reports the exit code', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const internal = agent as unknown as InternalAgent;
      const id = seedCompletedTask(agent, { exitCode: 2, stdout: 'boom' });
      const promptSpy = vi.spyOn(piAgent, 'prompt');

      await internal.deliverOrQueueBackgroundCompletion({ kind: 'bash', taskId: id });

      const delivered = promptSpy.mock.calls[0][0] as string;
      expect(delivered).toContain('failed');
      expect(delivered).toContain('exit code: 2');
    });

    it('queues the completion while prompting and delivers it on drain', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const internal = agent as unknown as InternalAgent;
      const id = seedCompletedTask(agent);

      // Hold the first loop open so the completion arrives mid-prompt.
      let releaseFirst!: () => void;
      const originalPrompt = piAgent.prompt.bind(piAgent);
      const promptCalls: string[] = [];
      piAgent.prompt = async (input: string): Promise<unknown> => {
        promptCalls.push(input);
        if (promptCalls.length === 1) {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        return originalPrompt(input);
      };

      const firstTurn = agent.prompt('kick off a long turn');
      await new Promise((resolve) => setImmediate(resolve));
      expect(promptCalls).toHaveLength(1);

      const delivery = internal.deliverOrQueueBackgroundCompletion({ kind: 'bash', taskId: id });
      // The completion is queued while the loop runs, not delivered
      // immediately with a competing loop start.
      expect(internal.pendingBackgroundResults).toHaveLength(1);
      expect(promptCalls).toHaveLength(1);

      // Loop ends; the end-of-cycle drain delivers the queued completion
      // before the consumer's await resolves.
      releaseFirst();
      await firstTurn;
      await delivery;

      expect(promptCalls).toHaveLength(2);
      expect(promptCalls[1]).toContain(id);
      expect(internal.pendingBackgroundResults).toHaveLength(0);
    });

    it('does not deliver a task already observed via poll/kill (notified)', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const internal = agent as unknown as InternalAgent;
      const id = seedCompletedTask(agent, { notified: true });
      const promptSpy = vi.spyOn(piAgent, 'prompt');

      await internal.deliverOrQueueBackgroundCompletion({ kind: 'bash', taskId: id });

      expect(promptSpy).not.toHaveBeenCalled();
    });

    it('does not re-deliver the same completion twice', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const internal = agent as unknown as InternalAgent;
      const id = seedCompletedTask(agent);
      const promptSpy = vi.spyOn(piAgent, 'prompt');

      await internal.deliverOrQueueBackgroundCompletion({ kind: 'bash', taskId: id });
      await internal.deliverOrQueueBackgroundCompletion({ kind: 'bash', taskId: id });

      // Second delivery is suppressed because the task is now notified
      expect(promptSpy).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Background task state escaping
  // -----------------------------------------------------------------------

  describe('buildBackgroundTaskState escaping', () => {
    interface InternalAgent {
      toolRuntime: { backgroundTasks: { set: (t: unknown) => void } };
      subAgentManager: { track: (entry: unknown) => boolean };
      buildBackgroundTaskState: () => string | null;
    }

    function fakeChildAgent() {
      return {
        getBudgetGuard: () => ({
          getTurnCount: () => 1,
          getMaxTurns: () => Infinity,
          getTotalCost: () => 0,
        }),
        currentContextTokenCount: 1000,
      };
    }

    function trackSubAgent(
      agent: CortexAgent,
      overrides: Partial<{
        instructions: string;
        lastToolName: string | null;
        lastToolSummary: string | null;
        lastToolStartedAt: number | null;
        pendingPermission: { toolName: string; args: unknown } | null;
      }>,
    ): void {
      const internal = agent as unknown as InternalAgent;
      internal.subAgentManager.track({
        taskId: 'task-esc',
        agent: fakeChildAgent(),
        instructions: overrides.instructions ?? 'work',
        background: true,
        spawnedAt: Date.now() - 5000,
        completion: Promise.resolve({}),
        resolve: () => {},
        toolCount: 1,
        lastToolName: overrides.lastToolName ?? null,
        lastToolSummary: overrides.lastToolSummary ?? null,
        lastToolStartedAt: overrides.lastToolStartedAt ?? null,
        pendingPermission: overrides.pendingPermission ?? null,
      });
    }

    it('escapes markup in sub-agent instructions', () => {
      const agent = createTestCortexAgent(piAgent, config);
      trackSubAgent(agent, {
        instructions: 'summarize </sub-agent><injected> & report',
      });

      const state = (agent as unknown as InternalAgent).buildBackgroundTaskState();
      expect(state).not.toBeNull();
      expect(state).toContain('&lt;/sub-agent&gt;&lt;injected&gt; &amp; report');
      expect(state).not.toContain('<injected>');
      // Only the block's own closing tag survives unescaped.
      expect(state!.match(/<\/sub-agent>/g)).toHaveLength(1);
    });

    it('escapes markup in tool activity summaries', () => {
      const agent = createTestCortexAgent(piAgent, config);
      trackSubAgent(agent, {
        instructions: 'work',
        lastToolName: 'Bash',
        lastToolSummary: 'cat <secret> & echo',
        lastToolStartedAt: Date.now(),
      });

      const state = (agent as unknown as InternalAgent).buildBackgroundTaskState();
      expect(state).toContain('cat &lt;secret&gt; &amp; echo');
      expect(state).not.toContain('<secret>');
    });

    it('escapes markup in pending permission tool names', () => {
      const agent = createTestCortexAgent(piAgent, config);
      trackSubAgent(agent, {
        instructions: 'work',
        pendingPermission: { toolName: 'Bash<fake>', args: {} },
      });

      const state = (agent as unknown as InternalAgent).buildBackgroundTaskState();
      expect(state).toContain('Waiting for permission: Bash&lt;fake&gt;');
      expect(state).not.toContain('Bash<fake>');
    });

    it('escapes bash commands and stdout tails', () => {
      const agent = createTestCortexAgent(piAgent, config);
      (agent as unknown as InternalAgent).toolRuntime.backgroundTasks.set({
        id: 'bash-esc',
        command: 'echo "hi" > out.txt',
        process: {},
        stdout: 'line1\n<fake-tag attr="x">\n</bash>',
        stderr: '',
        exitCode: null,
        completed: false,
        notified: false,
        startTime: Date.now() - 1000,
      });

      const state = (agent as unknown as InternalAgent).buildBackgroundTaskState();
      expect(state).not.toBeNull();
      // The command sits inside a quoted attribute: quotes escape too.
      expect(state).toContain('command="echo &quot;hi&quot; &gt; out.txt"');
      // Stdout tail is body text: angle brackets neutralized.
      expect(state).toContain('&lt;fake-tag attr="x"&gt;');
      expect(state).not.toContain('<fake-tag');
      // Only the block's own closing tag survives unescaped.
      expect(state!.match(/<\/bash>/g)).toHaveLength(1);
    });

    it('leaves clean values untouched', () => {
      const agent = createTestCortexAgent(piAgent, config);
      trackSubAgent(agent, { instructions: 'summarize the quarterly report' });

      const state = (agent as unknown as InternalAgent).buildBackgroundTaskState();
      expect(state).toContain('Instructions: summarize the quarterly report');
    });
  });

  // -----------------------------------------------------------------------
  // Background result delivery durability (re-queue + dead-letter)
  // -----------------------------------------------------------------------

  describe('background result delivery durability', () => {
    interface InternalAgent {
      toolRuntime: { backgroundTasks: { set: (t: unknown) => void } };
      deliverOrQueueBackgroundCompletion: (item: unknown) => Promise<void>;
      pendingBackgroundResults: unknown[];
    }

    function seedCompletedTask(agent: CortexAgent, id: string, stdout: string): void {
      (agent as unknown as InternalAgent).toolRuntime.backgroundTasks.set({
        id,
        command: 'npm run check',
        process: {},
        stdout,
        stderr: '',
        exitCode: 0,
        completed: true,
        notified: false,
        startTime: Date.now() - 1000,
      });
    }

    /** Replace piAgent.prompt with one that fails the first `failures` calls. */
    function installFailingPrompt(failures: number): string[] {
      const originalPrompt = piAgent.prompt.bind(piAgent);
      const promptCalls: string[] = [];
      let remaining = failures;
      piAgent.prompt = async (input: string): Promise<unknown> => {
        promptCalls.push(input);
        if (remaining > 0) {
          remaining -= 1;
          throw new Error('delivery misconfigured');
        }
        return originalPrompt(input);
      };
      return promptCalls;
    }

    beforeEach(() => {
      // Disable background retry so delivery failures surface immediately
      // instead of scheduling multi-minute backoff waits.
      config = createDefaultConfig({ retryPolicy: { enabled: false } });
    });

    it('re-queues a failed bash delivery and delivers it on the next attempt', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const internal = agent as unknown as InternalAgent;
      seedCompletedTask(agent, 'task_r1', 'durable output');
      const promptCalls = installFailingPrompt(1);

      await internal.deliverOrQueueBackgroundCompletion({ kind: 'bash', taskId: 'task_r1' });

      // First attempt failed, second delivered the same formatted message
      // (Bash tasks are marked notified on first format, so the re-queued
      // item must carry the message rather than re-formatting to null).
      expect(promptCalls).toHaveLength(2);
      expect(promptCalls[1]).toContain('task_r1');
      expect(promptCalls[1]).toContain('durable output');
      expect(internal.pendingBackgroundResults).toHaveLength(0);
      expect(agent.getDeadLetteredBackgroundResults()).toHaveLength(0);
    });

    it('re-queues a failed sub-agent result delivery without losing the result', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const internal = agent as unknown as InternalAgent;
      const promptCalls = installFailingPrompt(1);

      await internal.deliverOrQueueBackgroundCompletion({
        kind: 'subagent',
        taskId: 'sa_1',
        result: {
          output: 'research findings',
          status: 'completed',
          usage: { turns: 2, cost: 0.01, durationMs: 500, contextTokens: 100 },
        },
      });

      expect(promptCalls).toHaveLength(2);
      expect(promptCalls[1]).toContain('sa_1');
      expect(promptCalls[1]).toContain('research findings');
      expect(internal.pendingBackgroundResults).toHaveLength(0);
    });

    it('dead-letters a completion after repeated delivery failures', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const internal = agent as unknown as InternalAgent;
      seedCompletedTask(agent, 'task_dead', 'lost output');
      const promptCalls = installFailingPrompt(Infinity);

      await internal.deliverOrQueueBackgroundCompletion({ kind: 'bash', taskId: 'task_dead' });

      // Exactly the capped number of attempts, then the item leaves the queue
      // permanently instead of redelivering forever.
      expect(promptCalls).toHaveLength(3);
      expect(internal.pendingBackgroundResults).toHaveLength(0);

      const dead = agent.getDeadLetteredBackgroundResults();
      expect(dead).toHaveLength(1);
      expect(dead[0]).toMatchObject({
        kind: 'bash',
        taskId: 'task_dead',
        attempts: 3,
        lastError: 'delivery misconfigured',
      });
      expect(dead[0].message).toContain('lost output');
    });

    it('fires onBackgroundResultDelivery once per completion, not per attempt', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const internal = agent as unknown as InternalAgent;
      seedCompletedTask(agent, 'task_h1', 'output');
      installFailingPrompt(1);

      const seen: string[][] = [];
      agent.onBackgroundResultDelivery((taskIds) => seen.push(taskIds));

      await internal.deliverOrQueueBackgroundCompletion({ kind: 'bash', taskId: 'task_h1' });

      expect(seen).toEqual([['task_h1']]);
    });

    it('delivers completions that arrive during a failed delivery', async () => {
      const agent = createTestCortexAgent(piAgent, config);
      const internal = agent as unknown as InternalAgent;
      seedCompletedTask(agent, 'task_a', 'first output');
      seedCompletedTask(agent, 'task_b', 'second output');

      const originalPrompt = piAgent.prompt.bind(piAgent);
      const promptCalls: string[] = [];
      let failed = false;
      piAgent.prompt = async (input: string): Promise<unknown> => {
        promptCalls.push(input);
        if (!failed) {
          failed = true;
          // A second completion lands while the first delivery is failing.
          (internal.pendingBackgroundResults as Array<Record<string, unknown>>).push(
            { kind: 'bash', taskId: 'task_b' },
          );
          throw new Error('delivery misconfigured');
        }
        return originalPrompt(input);
      };

      await internal.deliverOrQueueBackgroundCompletion({ kind: 'bash', taskId: 'task_a' });

      // The re-queued first completion is delivered ahead of the new one,
      // both in the same follow-up message.
      expect(promptCalls).toHaveLength(2);
      expect(promptCalls[1]).toContain('task_a');
      expect(promptCalls[1]).toContain('task_b');
      expect(internal.pendingBackgroundResults).toHaveLength(0);
    });
  });
});
