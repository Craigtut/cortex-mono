import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AssistantMessage, JsonObject, Model, SimpleStreamOptions, ToolCall, TranscriptContext,
} from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { collapseSystemMessages, getInitialSystemMessage } from '@earendil-works/pi-ai/utils/transcript';
import { encodeOllamaMessages } from './messages.js';
import { checkOllamaAllocation } from './runtime.js';
import type { OllamaMetrics, OllamaPiModel } from './runtime.js';
import { resolveOllamaThinking } from './thinking.js';

const count = z.number().int().nonnegative().optional();
const chunkSchema = z.object({
  error: z.string().optional(), done: z.boolean().optional(), done_reason: z.string().optional(),
  message: z.object({
    content: z.string().optional(), thinking: z.string().optional(),
    tool_calls: z.array(z.object({ id: z.string().optional(), function: z.object({
      index: z.number().int().nonnegative().optional(), name: z.string().min(1), arguments: z.record(z.string(), z.unknown()),
    }) })).optional(),
  }).optional(),
  prompt_eval_count: count, prompt_eval_cached_count: count, eval_count: count,
  load_duration: count, prompt_eval_duration: count, eval_duration: count,
});

/** Bounded NDJSON decoder. A successful HTTP EOF without a done frame is an error. */
async function* readLines(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf('\n')) !== -1) {
        if (boundary > 8 * 1024 * 1024) throw new Error('Ollama stream frame exceeds 8 MiB');
        const line = pending.slice(0, boundary).trim();
        pending = pending.slice(boundary + 1);
        if (line) yield JSON.parse(line);
      }
      if (pending.length > 8 * 1024 * 1024) throw new Error('Ollama stream frame exceeds 8 MiB');
      if (done) {
        if (pending.trim()) yield JSON.parse(pending);
        return;
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface OllamaStreamOptions extends Omit<SimpleStreamOptions, 'reasoning'> {
  reasoning?: SimpleStreamOptions['reasoning'] | 'off';
  jsonSchema?: Record<string, unknown>;
}

/** `transcript` without its head's tool declarations (a request with tools disabled). */
function withoutTools(transcript: TranscriptContext): TranscriptContext {
  const [head, ...rest] = transcript.messages;
  if (head?.role !== 'system' || !head.toolsAdded) return transcript;
  const { toolsAdded: _disabled, ...bare } = head;
  return { messages: [bare, ...rest] } as unknown as TranscriptContext;
}

export function streamOllama(rawModel: Model<string>, context: TranscriptContext, options: OllamaStreamOptions = {}) {
  const model = rawModel as OllamaPiModel;
  const runtime = model.ollamaRuntime;
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: [], timestamp: Date.now(), stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const started = performance.now();
  const metrics: OllamaMetrics = { model: model.id, contextWindow: runtime.contextWindow, totalMs: 0 };
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 600_000), ...(options.signal ? [options.signal] : [])]);
  void (async () => {
    try {
      signal.throwIfAborted();
      if (options.toolChoice && options.toolChoice !== 'auto' && options.toolChoice !== 'none') {
        throw new Error('Ollama does not support forced tool choice; use structuredComplete() for schema output');
      }
      // Ollama has no mid-conversation system messages: the replayed prompt
      // and tool set lead the request.
      const collapsed = collapseSystemMessages(context);
      const requestContext = options.toolChoice === 'none' ? withoutTools(collapsed) : collapsed;
      const tools = getInitialSystemMessage(requestContext.messages)?.toolsAdded ?? [];
      if (tools.length && !runtime.capabilities.includes('tools')) throw new Error('The selected Ollama model does not support tools');
      await checkOllamaAllocation(runtime, signal);
      const estimated = estimateContextTokens(requestContext).tokens;
      const headroom = runtime.contextWindow - estimated - Math.min(1024, Math.ceil(runtime.contextWindow * 0.05));
      if (headroom < 1) throw new Error(`Ollama context window exceeded: estimated prompt ${estimated}, allocation ${runtime.contextWindow}`);
      const requested = options.maxTokens ?? runtime.maxOutputTokens;
      if (!Number.isFinite(requested) || requested < 1) throw new Error('Ollama maxTokens must be positive');
      const think = resolveOllamaThinking(runtime.thinking, options.reasoning);
      if (think !== undefined) output.providerThinkingLevel = String(think);
      let payload: unknown = {
        model: model.id, messages: encodeOllamaMessages(requestContext.messages, model.input.includes('image')), stream: true,
        truncate: false, shift: false,
        ...(options.jsonSchema ? { format: options.jsonSchema } : {}),
        ...(think === undefined ? {} : { think }),
        ...(runtime.keepAlive === undefined ? {} : { keep_alive: runtime.keepAlive }),
        options: {
          ...model.samplingParams, ...options.samplingParams,
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          num_ctx: runtime.contextWindow, num_predict: Math.min(Math.floor(requested), headroom),
        },
        ...(!tools.length ? {} : {
          tools: tools.map(tool => ({ type: 'function', function: {
            name: tool.name, description: tool.description, parameters: tool.parameters,
          } })),
        }),
      };
      payload = (await options.onPayload?.(payload, model)) ?? payload;
      const headers = new Headers({ 'Content-Type': 'application/json', ...model.headers });
      const key = options.apiKey ?? runtime.connection.apiKey;
      if (key && key !== 'sk-no-key-required') headers.set('Authorization', `Bearer ${key}`);
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        if (value === null) headers.delete(name); else if (value !== undefined) headers.set(name, value);
      }
      const response = await (options.fetch ?? runtime.connection.fetch ?? globalThis.fetch)(`${runtime.connection.baseUrl}/api/chat`, {
        method: 'POST', headers, body: JSON.stringify(payload), signal,
      });
      await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`);
      if (!response.body) throw new Error('Ollama response has no stream');
      stream.push({ type: 'start', partial: output });
      let active: { index: number; type: 'text' | 'thinking' } | undefined;
      const finishBlock = () => {
        if (!active) return;
        const block = output.content[active.index]!;
        const content = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : '';
        stream.push({ type: active.type === 'text' ? 'text_end' : 'thinking_end', contentIndex: active.index, content, partial: output });
        active = undefined;
      };
      const append = (type: 'text' | 'thinking', value: string | undefined) => {
        if (!value) return;
        metrics.firstOutputMs ??= performance.now() - started;
        if (type === 'text') metrics.firstTextMs ??= performance.now() - started;
        if (active?.type !== type) {
          finishBlock();
          active = { type, index: output.content.length };
          output.content.push(type === 'text' ? { type, text: '' } : { type, thinking: '', thinkingSignature: 'ollama' });
          stream.push({ type: type === 'text' ? 'text_start' : 'thinking_start', contentIndex: active.index, partial: output });
        }
        const block = output.content[active.index]!;
        if (block.type === 'text') block.text += value;
        if (block.type === 'thinking') block.thinking += value;
        stream.push({ type: type === 'text' ? 'text_delta' : 'thinking_delta', contentIndex: active.index, delta: value, partial: output });
      };
      for await (const data of readLines(response.body, signal)) {
        const chunk = chunkSchema.parse(data);
        if (chunk.error) throw new Error(chunk.error);
        append('thinking', chunk.message?.thinking);
        append('text', chunk.message?.content);
        for (const call of chunk.message?.tool_calls ?? []) {
          finishBlock();
          metrics.firstOutputMs ??= performance.now() - started;
          const toolCall: ToolCall = { type: 'toolCall', id: call.id ?? randomUUID(), name: call.function.name,
            // Decoded from the NDJSON frame, so JSON-valued by construction.
            arguments: call.function.arguments as JsonObject };
          const contentIndex = output.content.length;
          output.content.push(toolCall);
          stream.push({ type: 'toolcall_start', contentIndex, partial: output });
          stream.push({ type: 'toolcall_delta', contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output });
          stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: output });
        }
        if (chunk.done) {
          if (chunk.done_reason && !['stop', 'length'].includes(chunk.done_reason)) {
            throw new Error(`Ollama ended inference with unexpected reason: ${chunk.done_reason}`);
          }
          finishBlock();
          const input = chunk.prompt_eval_count ?? 0;
          const cached = Math.min(input, chunk.prompt_eval_cached_count ?? 0);
          const generated = chunk.eval_count ?? 0;
          output.usage = { ...output.usage, input: input - cached, output: generated, cacheRead: cached, totalTokens: input + generated };
          output.stopReason = chunk.done_reason === 'length' ? 'length' : output.content.some(b => b.type === 'toolCall') ? 'toolUse' : 'stop';
          if (chunk.done_reason) output.rawStopReason = chunk.done_reason;
          metrics.totalMs = performance.now() - started;
          if (chunk.load_duration !== undefined) metrics.loadMs = chunk.load_duration / 1e6;
          if (chunk.prompt_eval_duration !== undefined) metrics.promptEvalMs = chunk.prompt_eval_duration / 1e6;
          if (chunk.eval_duration !== undefined) metrics.generationMs = chunk.eval_duration / 1e6;
          if (chunk.prompt_eval_count !== undefined) metrics.promptTokens = chunk.prompt_eval_count;
          if (chunk.prompt_eval_cached_count !== undefined) metrics.cachedTokens = chunk.prompt_eval_cached_count;
          if (chunk.eval_count !== undefined) metrics.outputTokens = chunk.eval_count;
          try { runtime.onMetrics?.(metrics); } catch { /* Diagnostics cannot fail a completion. */ }
          stream.push({ type: 'done', reason: output.stopReason, message: output });
          return;
        }
      }
      throw new Error('Ollama stream ended before its final done frame');
    } catch (error) {
      output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: 'error', reason: output.stopReason, error: output });
    }
  })();
  return stream;
}
