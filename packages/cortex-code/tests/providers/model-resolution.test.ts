import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderManager, wrapModel } from '@animus-labs/cortex';
import { defaultModelFor, resolveConfiguredModel } from '../../src/providers/model-resolution.js';
import { ModelSelection } from '../../src/session/model-selection.js';

afterEach(() => vi.restoreAllMocks());

describe('connection model resolution', () => {
  it('resolves Ollama before the legacy custom credential method and preserves runtime preferences', async () => {
    const manager = new ProviderManager();
    const model = wrapModel({ provider: 'ollama' }, 'ollama', 'test', 32768);
    const native = vi.spyOn(manager, 'createOllamaModel').mockResolvedValue(model);
    const custom = vi.spyOn(manager, 'createCustomModel');
    expect(await resolveConfiguredModel(manager, 'ollama', 'test', { method: 'custom', baseUrl: 'http://server:11434/v1' },
      { contextWindow: 32768, keepAlive: '30m' })).toBe(model);
    expect(native).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'test', contextWindow: 32768, baseUrl: 'http://server:11434/v1', keepAlive: '30m' }));
    expect(custom).not.toHaveBeenCalled();
  });

  it('retains stored custom URLs and keys without treating other providers as Ollama', async () => {
    const manager = new ProviderManager();
    const model = await resolveConfiguredModel(manager, 'local-proxy', 'test', { method: 'custom', baseUrl: 'http://proxy/v1', apiKey: 'test-only' });
    expect(model.provider).toBe('custom');
    await expect(resolveConfiguredModel(manager, 'local-proxy', 'test', { method: 'custom' })).rejects.toThrow('base URL');
  });

  it('passes the Cortex limit to allocation without requiring Ollama-specific settings', async () => {
    const manager = new ProviderManager();
    const resolve = vi.spyOn(manager, 'createOllamaModel').mockResolvedValue(wrapModel({}, 'ollama', 'test', 8192));
    await resolveConfiguredModel(manager, 'ollama', 'test', null, undefined, 8192);
    expect(resolve).toHaveBeenLastCalledWith(expect.objectContaining({ contextWindowLimit: 8192 }));
  });

  it.each(['switchModel', 'switchProvider', 'setUtilityModel'] as const)('%s uses the same connection configuration', async method => {
    const manager = new ProviderManager();
    const model = wrapModel({ provider: 'ollama' }, 'ollama', 'new', 32768);
    const resolve = vi.spyOn(manager, 'createOllamaModel').mockResolvedValue(model);
    const agent = { setModel: vi.fn(), setUtilityModel: vi.fn(), resetUtilityModel: vi.fn(), effectiveContextWindow: 32768 };
    const selection = new ModelSelection({
      provider: 'ollama',
      modelId: 'old',
      initialEffort: 'low',
      providerManager: manager,
      config: { contextWindowLimit: 8192, ollama: { contextWindow: 32768 } } as never,
      credentialStore: {
        getProvider: vi.fn(async () => ({ method: 'custom', baseUrl: 'http://server:11434/v1' })),
        setDefaults: vi.fn(), setDefaultUtilityModel: vi.fn(), getDefaultUtilityModel: vi.fn(async () => null),
      } as never,
      getAgent: () => agent as never,
      getApp: () => null,
    });
    vi.spyOn(selection, 'reconcileEffort').mockResolvedValue({ clamped: false, effective: 'low' });
    if (method === 'switchProvider') await selection.switchProvider('ollama', 'new');
    else await selection[method]('new');
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'new', contextWindow: 32768, contextWindowLimit: 8192 }));
  });

  it('starts a provider on its own catalog default, never another provider\'s', async () => {
    const manager = new ProviderManager();
    for (const provider of ['anthropic', 'deepseek', 'openrouter']) {
      const model = await manager.resolveModel(provider, defaultModelFor(provider));
      expect(model.provider).toBe(provider);
    }
    expect(defaultModelFor('anthropic')).toMatch(/^claude-opus-/);
    expect(() => defaultModelFor('ollama')).toThrow(/No default model for provider "ollama"/);
  });
});
