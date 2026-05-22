import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CortexAgent } from '../../src/cortex-agent.js';
import { ProviderManager } from '../../src/provider-manager.js';

const mockGetModel = vi.fn();
const mockComplete = vi.fn();
let lastAgentConfig: Record<string, unknown> | null = null;
let lastAgentInstance: { state: Record<string, unknown> } | null = null;

class MockManagedPiAgent {
  state: Record<string, unknown>;

  constructor(config: Record<string, unknown>) {
    lastAgentConfig = config;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastAgentInstance = this;
    const initialState = config['initialState'] as Record<string, unknown>;
    this.state = {
      messages: [],
      systemPrompt: '',
      tools: [],
      ...initialState,
    };
  }

  subscribe(): () => void {
    return () => {};
  }

  async prompt(): Promise<unknown> {
    return { content: 'ok' };
  }

  abort(): void {}

  async waitForIdle(): Promise<void> {}

  reset(): void {
    this.state['messages'] = [];
  }

  steer(): void {}
}

vi.mock('@earendil-works/pi-ai', () => ({
  getModel: (...args: unknown[]) => mockGetModel(...args),
  createModel: vi.fn(),
  getModels: vi.fn(),
  getEnvApiKey: vi.fn(),
  complete: (...args: unknown[]) => mockComplete(...args),
}));

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: MockManagedPiAgent,
}));

function makeUsage() {
  return {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

describe('CortexAgent model contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastAgentConfig = null;
    lastAgentInstance = null;
  });

  it('uses the unwrapped pi-ai model across ProviderManager, create(), directComplete(), and setModel()', async () => {
    const resolvedRawModel = {
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      id: 'claude-sonnet-4-20250514',
      api: 'anthropic',
      contextWindow: 200_000,
    };
    const swappedRawModel = {
      provider: 'anthropic',
      name: 'claude-opus-4-20260101',
      id: 'claude-opus-4-20260101',
      api: 'anthropic',
      contextWindow: 200_000,
    };

    mockGetModel
      .mockReturnValueOnce(resolvedRawModel)
      .mockReturnValueOnce(swappedRawModel);

    mockComplete.mockResolvedValue({
      content: [{ type: 'text', text: 'direct completion ok' }],
      usage: makeUsage(),
    });

    const providerManager = new ProviderManager();
    const model = await providerManager.resolveModel('anthropic', 'claude-sonnet-4-20250514');
    const agent = await CortexAgent.create({
      model,
      workingDirectory: '/tmp/cortex-model-contract',
      initialBasePrompt: 'Test prompt',
    });

    expect(lastAgentConfig).not.toBeNull();
    expect((lastAgentConfig!['initialState'] as Record<string, unknown>)['model']).toBe(resolvedRawModel);

    const text = await agent.directComplete({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(text).toBe('direct completion ok');
    expect(mockComplete).toHaveBeenCalledWith(
      resolvedRawModel,
      expect.objectContaining({
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      undefined,
    );

    const nextModel = await providerManager.resolveModel('anthropic', 'claude-opus-4-20260101');
    agent.setModel(nextModel);

    expect(lastAgentInstance!.state['model']).toBe(swappedRawModel);
  });

  it('applies the agent cache retention to directComplete calls by default', async () => {
    const rawModel = {
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      id: 'claude-sonnet-4-20250514',
      api: 'anthropic',
      contextWindow: 200_000,
    };

    mockGetModel.mockReturnValue(rawModel);
    mockComplete.mockResolvedValue({
      content: [{ type: 'text', text: 'direct completion ok' }],
      usage: makeUsage(),
    });

    const providerManager = new ProviderManager();
    const model = await providerManager.resolveModel('anthropic', 'claude-sonnet-4-20250514');
    const agent = await CortexAgent.create({
      model,
      workingDirectory: '/tmp/cortex-model-contract',
      initialBasePrompt: 'Test prompt',
    });

    agent.setCacheRetention('long');

    await agent.directComplete({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(mockComplete).toHaveBeenCalledWith(
      rawModel,
      expect.objectContaining({
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      { cacheRetention: 'long' },
    );
  });

  it('applies the agent cache retention to structuredComplete calls by default', async () => {
    const rawModel = {
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      id: 'claude-sonnet-4-20250514',
      api: 'anthropic',
      contextWindow: 200_000,
    };

    mockGetModel.mockReturnValue(rawModel);
    mockComplete.mockResolvedValue({
      content: [],
      usage: makeUsage(),
    });

    const providerManager = new ProviderManager();
    const model = await providerManager.resolveModel('anthropic', 'claude-sonnet-4-20250514');
    const agent = await CortexAgent.create({
      model,
      workingDirectory: '/tmp/cortex-model-contract',
      initialBasePrompt: 'Test prompt',
    });

    agent.setCacheRetention('long');

    await agent.structuredComplete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      { type: 'object', properties: {}, required: [] },
      'structured_output',
      'Produce structured output',
    );

    expect(mockComplete).toHaveBeenCalledWith(
      rawModel,
      expect.objectContaining({
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [expect.objectContaining({ name: 'structured_output' })],
      }),
      expect.objectContaining({
        toolChoice: 'any',
        cacheRetention: 'long',
      }),
    );
  });
});
