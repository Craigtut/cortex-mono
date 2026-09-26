import { describe, expect, it } from 'vitest';
import { ProviderManager } from '../../src/provider-manager.js';
import { unwrapModel } from '../../src/model-wrapper.js';
import { detectOllama, getOllamaHost } from '../../src/providers/ollama/discovery.js';
import { getOllamaRuntimeInfo } from '../../src/providers/ollama/model.js';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { ollamaServer } from '../helpers/ollama.js';

describe('Ollama model resolution', () => {
  it.each([
    ['localhost:11434', 'http://localhost:11434'],
    ['http://localhost:11434/v1/', 'http://localhost:11434'],
    ['https://example.test/ollama/v1', 'https://example.test/ollama'],
  ])('normalizes %s', (input, expected) => expect(getOllamaHost(input)).toBe(expected));

  it('rejects embedded credentials and invalid discovery data', async () => {
    expect(() => getOllamaHost('https://secret@example.test')).toThrow('credentials');
    await expect(new ProviderManager().createOllamaModel({ modelId: 'test', fetch: async () => Response.json({}) })).rejects.toThrow();
  });

  it('uses the loaded allocation and explicit local capabilities, never GPT-4.1 defaults', async () => {
    const server = ollamaServer({ context: 8192 });
    const model = await new ProviderManager().createOllamaModel({ modelId: 'test', fetch: server.fetch });
    expect(model.provider).toBe('ollama');
    expect(model.contextWindow).toBe(8192);
    expect(model.capabilities).toMatchObject({ trainedContextWindow: 131072, promptCaching: 'automatic-prefix' });
    expect(unwrapModel(model)).toMatchObject({ reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0 } });
    expect(server.requests.filter(r => r.path === '/api/chat').map(r => r.body['messages'])).toEqual([]);
    expect(getOllamaRuntimeInfo(model)).toMatchObject({ thinking: 'binary', contextWindow: 8192 });
  });

  it('is serial by default and parallel only on the explicit opt-in', async () => {
    const pm = new ProviderManager();
    const serial = await pm.createOllamaModel({ modelId: 'test', fetch: ollamaServer().fetch });
    const parallel = await pm.createOllamaModel({ modelId: 'test', fetch: ollamaServer().fetch, parallelRequests: true });
    expect(serial.capabilities?.concurrency).toBe('serial');
    expect(parallel.capabilities?.concurrency).toBe('parallel');
    await expect(pm.createOllamaModel({
      modelId: 'test', fetch: ollamaServer().fetch, parallelRequests: 'yes' as never,
    })).rejects.toThrow();
  });

  it('preserves the loaded allocation when server defaults differ', async () => {
    const server = ollamaServer({ context: 32768, defaultContext: 8192 });
    const model = await new ProviderManager().createOllamaModel({ modelId: 'test', fetch: server.fetch });
    expect(model.contextWindow).toBe(32768);
    expect(unwrapModel(model)).toMatchObject({ api: 'cortex-ollama-chat' });
    expect(server.requests.some(r => r.path === '/api/chat')).toBe(false);
  });

  it('loads only the selected unloaded model, then measures allocation', async () => {
    const server = ollamaServer({ loaded: false, context: 24576 });
    const model = await new ProviderManager().createOllamaModel({ modelId: 'test', fetch: server.fetch });
    expect(model.contextWindow).toBe(24576);
    expect(server.requests.filter(r => r.path === '/api/chat').map(r => r.body)).toEqual([
      { model: 'test', messages: [], stream: false, shift: false, truncate: false },
    ]);
  });

  it('changes allocation only on explicit configuration', async () => {
    const server = ollamaServer();
    const model = await new ProviderManager().createOllamaModel({ modelId: 'test', contextWindow: 16384, fetch: server.fetch });
    expect(model.contextWindow).toBe(16384);
    expect(server.requests.find(r => r.path === '/api/chat')?.body['options']).toEqual({ num_ctx: 16384 });
  });

  it('lists models without loading any', async () => {
    const server = ollamaServer({ loaded: false });
    expect((await detectOllama({ fetch: server.fetch })).models).toHaveLength(1);
    expect(server.requests.map(r => r.path)).toEqual(['/api/tags']);
  });

  it.each([
    { loaded: true, context: 32768, limit: 8192, expected: 8192 },
    { loaded: true, context: 4096, limit: 8192, expected: 4096 },
    { loaded: false, context: 32768, limit: 8192, expected: 8192 },
  ])('caps allocation without increasing a smaller running context: %j', async ({ loaded, context, limit, expected }) => {
    const server = ollamaServer({ loaded, context });
    const model = await new ProviderManager().createOllamaModel({
      modelId: 'test', contextWindowLimit: limit, fetch: server.fetch,
    });
    expect(model.contextWindow).toBe(expected);
    const preloads = server.requests.filter(r => r.path === '/api/chat');
    if (loaded && context === expected) expect(preloads).toHaveLength(0);
    else expect(preloads.map(r => r.body['options'].num_ctx)).toEqual([expected]);
  });

  it('applies the cap to an explicit allocation', async () => {
    const server = ollamaServer();
    const manager = new ProviderManager();
    const model = await manager.createOllamaModel({ modelId: 'test', contextWindow: 65536, contextWindowLimit: 8192, fetch: server.fetch });
    expect(model.contextWindow).toBe(8192);
  });

  it('requires allocation evidence instead of falling back to trained capacity', async () => {
    const server = ollamaServer();
    const fetch = async (url: string | URL | Request, init?: RequestInit) => String(url).endsWith('/api/ps')
      ? Response.json({ models: [{ name: 'test:latest' }] }) : server.fetch(url, init);
    await expect(new ProviderManager().createOllamaModel({ modelId: 'test', fetch })).rejects.toThrow('context length');
  });

  it('rejects older servers without falling back to another API', async () => {
    const server = ollamaServer({ version: '0.12.0' });
    await expect(new ProviderManager().createOllamaModel({ modelId: 'test', fetch: server.fetch })).rejects.toThrow('0.15.0');
    expect(server.requests.some(r => r.path === '/api/chat')).toBe(false);
  });

  it.each([0, '0s', '0.0h'])('rejects unload-on-request keepAlive %j before touching the server', async keepAlive => {
    const server = ollamaServer({ loaded: false });
    await expect(new ProviderManager().createOllamaModel({ modelId: 'test', keepAlive, fetch: server.fetch })).rejects.toThrow('keepAlive must be nonzero');
    expect(server.requests).toHaveLength(0);
  });

  it.each([
    ['gptoss', ['low', 'medium', 'high']],
    ['qwen3', ['off', 'low']],
  ])('advertises enforceable thinking settings for %s', async (family, levels) => {
    const server = ollamaServer({ family });
    const model = await new ProviderManager().createOllamaModel({ modelId: 'test', fetch: server.fetch });
    expect(getSupportedThinkingLevels(unwrapModel(model) as never)).toEqual(levels);
  });
});
