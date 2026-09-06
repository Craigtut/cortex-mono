import { vi } from 'vitest';

/** Synthetic server. Discovery never needs a GPU; all inference frames are supplied by the test. */
export function ollamaServer(options: {
  context?: number; defaultContext?: number; trained?: number; loaded?: boolean; family?: string; capabilities?: string[]; version?: string;
} = {}) {
  let loaded = options.loaded ?? true;
  let context = options.context ?? 32768;
  const requests: Array<{ path: string; body: Record<string, any> }> = [];
  const replies: Array<unknown[] | Response> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path, body });
    if (path === '/api/version') return Response.json({ version: options.version ?? '0.15.0' });
    if (path === '/api/show') return Response.json({ capabilities: options.capabilities ?? ['completion', 'tools', 'thinking'],
      details: { family: options.family ?? 'qwen3' }, model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': options.trained ?? 131072 } });
    if (path === '/api/ps') return Response.json({ models: loaded ? [{ name: 'test:latest', context_length: context }] : [] });
    if (path === '/api/tags') return Response.json({ models: [{ name: 'test:latest', size: 1 }] });
    if (path === '/api/chat' && body.messages.length === 0) {
      loaded = true;
      context = body.options?.num_ctx ?? options.defaultContext ?? context;
      return Response.json({ done: true });
    }
    const reply = replies.shift() ?? [{ message: { content: 'Done' }, done: true, prompt_eval_count: 100, eval_count: 1 }];
    return reply instanceof Response ? reply : new Response(reply.map(x => JSON.stringify(x)).join('\n'), { headers: { 'Content-Type': 'application/x-ndjson' } });
  });
  return { fetch, requests, replies, setContext: (value: number) => { context = value; }, unload: () => { loaded = false; } };
}
