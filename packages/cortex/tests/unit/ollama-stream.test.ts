import { describe, expect, it, vi } from 'vitest';
import { complete, streamSimple } from '@earendil-works/pi-ai/compat';
import type { Context, Model } from '@earendil-works/pi-ai';
import { ProviderManager } from '../../src/provider-manager.js';
import { unwrapModel } from '../../src/model-wrapper.js';
import { encodeOllamaMessages } from '../../src/providers/ollama/messages.js';
import { ollamaServer } from '../helpers/ollama.js';

const context: Context = { systemPrompt: 'Be useful.', messages: [{ role: 'user', content: 'Hello', timestamp: 1 }] };
async function setup(server = ollamaServer(), onMetrics = vi.fn()) {
  const handle = await new ProviderManager().createOllamaModel({ modelId: 'test', transport: 'native', keepAlive: '30m', fetch: server.fetch, onMetrics });
  return { server, onMetrics, model: unwrapModel(handle) as Model<string>, handle };
}

describe('native Ollama protocol', () => {
  it('ignores disabled tools for both capability checking and prompt estimation', async () => {
    const { model, server } = await setup(ollamaServer({ context: 4096, capabilities: ['completion'] }));
    const result = await complete(model, { ...context, tools: [{
      name: 'unused', description: 'Large unused schema '.repeat(10000), parameters: { type: 'object' },
    }] }, { toolChoice: 'none' });
    expect(result.stopReason).toBe('stop');
    expect(server.requests.at(-1)?.body).not.toHaveProperty('tools');
  });
  it('decodes split UTF-8 frames, emits ordered events, and records cached usage and timings', async () => {
    const { model, server, onMetrics } = await setup();
    const bytes = new TextEncoder().encode([
      { message: { thinking: '思考' }, done: false },
      { message: { content: 'Hello' }, done: false },
      { done: true, prompt_eval_count: 100, prompt_eval_cached_count: 80, eval_count: 5,
        load_duration: 1e6, prompt_eval_duration: 2e6, eval_duration: 3e6 },
    ].map(x => JSON.stringify(x)).join('\n'));
    server.replies.push(new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } })));
    const events = streamSimple(model, context, { reasoning: 'low' });
    const kinds = [];
    for await (const event of events) kinds.push(event.type);
    const result = await events.result();
    expect(kinds).toEqual(['start', 'thinking_start', 'thinking_delta', 'thinking_end', 'text_start', 'text_delta', 'text_end', 'done']);
    expect(result.content).toMatchObject([{ thinking: '思考' }, { text: 'Hello' }]);
    expect(result.usage).toMatchObject({ input: 20, cacheRead: 80, output: 5, totalTokens: 105 });
    expect(onMetrics).toHaveBeenCalledWith(expect.objectContaining({ cachedTokens: 80, loadMs: 1, promptEvalMs: 2, generationMs: 3 }));
    expect(server.requests.at(-1)?.body).toMatchObject({ think: true, truncate: false, shift: false, keep_alive: '30m', options: { num_ctx: 32768 } });
    expect(server.requests.at(-1)?.body['options']).not.toHaveProperty('temperature');
  });

  it('uses the same allocation for direct and agent completions despite different output limits', async () => {
    const { model, server } = await setup();
    await streamSimple(model, context, { maxTokens: 10 }).result();
    await complete(model, context, { maxTokens: 100 });
    const calls = server.requests.filter(r => r.path === '/api/chat');
    expect(calls.map(r => r.body['options'])).toEqual([{ num_ctx: 32768, num_predict: 10 }, { num_ctx: 32768, num_predict: 100 }]);
    expect(calls[0]?.body['think']).toBe(false);
    expect(calls[1]?.body).not.toHaveProperty('think');
  });

  it('retains same-name tool calls, thinking, and stable IDs across JSON restore and continuation', async () => {
    const { model, server } = await setup();
    server.replies.push([{ message: { thinking: 'Use tools', tool_calls: [
      { function: { name: 'read', arguments: { path: 'a' } } },
      { function: { name: 'read', arguments: { path: 'b' } } },
    ] }, done: true }]);
    const response = await complete(model, context);
    expect(response.stopReason).toBe('toolUse');
    const calls = response.content.filter(c => c.type === 'toolCall');
    expect(new Set(calls.map(c => c.id)).size).toBe(2);
    const restored = JSON.parse(JSON.stringify(response));
    const next: Context = { ...context, messages: [...context.messages, restored,
      ...calls.map(c => ({ role: 'toolResult' as const, toolCallId: c.id, toolName: c.name, content: [{ type: 'text' as const, text: 'OK' }], isError: false, timestamp: 2 })),
    ] };
    await complete(model, next);
    const sent = server.requests.at(-1)!.body['messages'];
    expect(sent[2]).toMatchObject({ thinking: 'Use tools', tool_calls: calls.map(c => ({ id: c.id })) });
    expect(sent.slice(3).map((m: any) => m.tool_call_id)).toEqual(calls.map(c => c.id));
  });

  it.each([
    [[{ message: { content: 'unfinished' } }], 'before its final done'],
    [[{ error: 'context window exceeded' }], 'context window exceeded'],
    [new Response('bad', { status: 500 }), 'HTTP 500'],
    [new Response('{not-json}\n'), 'JSON'],
  ])('fails incomplete or invalid streams', async (reply, error) => {
    const { model, server } = await setup();
    server.replies.push(reply as never);
    const result = await complete(model, context);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain(error);
  });

  it('cancels a stalled stream and does not report success', async () => {
    const { model, server } = await setup();
    const cancel = vi.fn();
    server.replies.push(new Response(new ReadableStream({ cancel })));
    const controller = new AbortController();
    const events = streamSimple(model, context, { signal: controller.signal });
    for await (const event of events) {
      if (event.type === 'start') controller.abort();
    }
    expect((await events.result()).stopReason).toBe('aborted');
    expect(cancel).toHaveBeenCalled();
  });

  it('refuses stale allocation without issuing an inference request', async () => {
    const { model, server } = await setup();
    server.setContext(4096);
    const result = await complete(model, context);
    expect(result.errorMessage).toContain('allocation changed');
    expect(server.requests.some(r => r.path === '/api/chat')).toBe(false);
  });

  it('reloads the selected model with the pinned allocation after expiry', async () => {
    const { model, server } = await setup();
    server.unload();
    expect((await complete(model, context)).stopReason).toBe('stop');
    expect(server.requests.filter(r => r.path === '/api/chat')[0]?.body).toMatchObject({ messages: [], options: { num_ctx: 32768 }, keep_alive: '30m' });
  });

  it('rejects forced tools, unsupported images, and oversized prompts', async () => {
    const { model } = await setup();
    expect((await complete(model, context, { toolChoice: 'required' })).errorMessage).toContain('forced tool');
    expect((await complete(model, { messages: [{ role: 'user', content: [{ type: 'image', data: 'YQ==', mimeType: 'image/png' }], timestamp: 1 }] })).errorMessage).toContain('images');
    expect((await complete(model, { systemPrompt: 'word '.repeat(150000), messages: [] })).errorMessage).toContain('context window exceeded');
  });

  it('repairs missing results without replaying aborted thinking or orphan results', () => {
    const messages = encodeOllamaMessages({ messages: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'x', name: 'read', arguments: {} }], stopReason: 'toolUse' } as never,
      { role: 'user', content: 'Continue', timestamp: 1 },
    ] }, false);
    expect(messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'x', content: 'Tool execution was interrupted.' });
  });
});
