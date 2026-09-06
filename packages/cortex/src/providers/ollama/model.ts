import { registerApiProvider, getApiProvider } from '@earendil-works/pi-ai/compat';
import { stream as streamOpenAI, streamSimple as streamSimpleOpenAI } from '@earendil-works/pi-ai/api/openai-completions';
import type { OpenAICompletionsOptions } from '@earendil-works/pi-ai/api/openai-completions';
import type { Api, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { wrapModel, unwrapModel } from '../../model-wrapper.js';
import { resolveOllamaRuntime, checkOllamaAllocation } from './runtime.js';
import type { OllamaModelConfig, OllamaPiModel, OllamaRuntime } from './runtime.js';
import { ollamaThinkingMap } from './thinking.js';
import { streamOllama } from './stream.js';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

const NATIVE_API = 'cortex-ollama-chat';
const OPENAI_API = 'cortex-ollama-openai';

/** The compatibility bridge stays isolated from the native codec and pi's eventual Models migration. */
function registerOllamaApis(): void {
  if (!getApiProvider(NATIVE_API)) registerApiProvider({
    api: NATIVE_API, stream: streamOllama,
    streamSimple: (model, context, options) => streamOllama(model, context, {
      ...options,
      // Agent-core represents off as an omitted reasoning option. Clamp models
      // which cannot disable thinking to their weakest supported level.
      reasoning: options?.reasoning ?? ((model as OllamaPiModel).ollamaRuntime.thinking === 'levels' ? 'low' : 'off'),
    }),
  });
  if (!getApiProvider(OPENAI_API)) registerApiProvider({
    api: OPENAI_API,
    stream: (model, context, options) => streamCompatibility(model, context, options, false),
    streamSimple: (model, context, options) => streamCompatibility(model, context, options, true),
  });
}

function streamCompatibility(model: Model<Api>, context: Context, options: SimpleStreamOptions = {}, simple: boolean) {
  const runtime = (model as OllamaPiModel).ollamaRuntime;
  const stream = createAssistantMessageEventStream();
  const started = performance.now();
  let firstOutputMs: number | undefined;
  let firstTextMs: number | undefined;
  void (async () => {
    try {
      await checkOllamaAllocation(runtime, options.signal);
      const headroom = runtime.contextWindow - estimateContextTokens(context).tokens
        - Math.min(1024, Math.ceil(runtime.contextWindow * 0.05));
      if (headroom < 1) {
        throw new Error('Ollama context window exceeded: prompt does not fit the running allocation');
      }
      const requested = options.maxTokens ?? runtime.maxOutputTokens;
      if (!Number.isFinite(requested) || requested < 1) throw new Error('Ollama maxTokens must be positive');
      const compatModel: Model<'openai-completions'> = {
        ...model, api: 'openai-completions',
        compat: {
          supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: false,
          supportsLongCacheRetention: false, supportsReasoningEffort: runtime.thinking !== 'default',
          requiresToolResultName: true, maxTokensField: 'max_tokens',
        },
      };
      const fetch = options.fetch ?? runtime.connection.fetch;
      const opts = { ...options, maxTokens: Math.min(Math.floor(requested), headroom),
        apiKey: options.apiKey ?? runtime.connection.apiKey ?? 'sk-no-key-required',
        onPayload: async (payload: unknown, wireModel: Model<Api>) => {
          const body = payload as Record<string, unknown>;
          const effort = simple ? options.reasoning ?? 'off' : (options as OpenAICompletionsOptions).reasoningEffort;
          if (runtime.thinking === 'binary') {
            // Ollama accepts "none" as false, but rejects low/medium/high for
            // binary models. Omitting effort selects its enabled default.
            if (effort === 'off') body['reasoning_effort'] = 'none';
            else delete body['reasoning_effort'];
          } else if (runtime.thinking === 'levels' && simple && !options.reasoning) {
            body['reasoning_effort'] = 'low';
          }
          return (await options.onPayload?.(body, wireModel)) ?? body;
        },
        ...(fetch ? { fetch } : {}) };
      const upstream = simple ? streamSimpleOpenAI(compatModel, context, opts) : streamOpenAI(compatModel, context, opts);
      for await (const event of upstream) {
        if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_end') {
          firstOutputMs ??= performance.now() - started;
          if (event.type === 'text_delta') firstTextMs ??= performance.now() - started;
        }
        if (event.type === 'done') {
          try { runtime.onMetrics?.({
            model: model.id, transport: 'openai', contextWindow: runtime.contextWindow,
            totalMs: performance.now() - started,
            ...(firstOutputMs === undefined ? {} : { firstOutputMs }),
            ...(firstTextMs === undefined ? {} : { firstTextMs }),
            promptTokens: event.message.usage.input + event.message.usage.cacheRead,
            outputTokens: event.message.usage.output,
            // pi-ai normalizes an absent cache metric to zero. Only positive
            // hits are evidence in this compatibility path.
            ...(event.message.usage.cacheRead > 0 ? { cachedTokens: event.message.usage.cacheRead } : {}),
          }); } catch { /* Diagnostics cannot fail a completion. */ }
        }
        // Store the real wire family so pi preserves reasoning metadata on replay.
        stream.push(event);
      }
    } catch (error) {
      const reason = options.signal?.aborted ? 'aborted' : 'error';
      stream.push({ type: 'error', reason, error: {
        role: 'assistant', content: [], api: 'openai-completions', provider: 'ollama', model: model.id,
        timestamp: Date.now(), stopReason: reason, errorMessage: error instanceof Error ? error.message : String(error),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
    }
  })();
  return stream;
}

export async function createOllamaModel(config: OllamaModelConfig) {
  const runtime = await resolveOllamaRuntime(config);
  registerOllamaApis();
  const model: OllamaPiModel & { cortexCapabilities: import('../../model-wrapper.js').ModelCapabilities } = {
    id: runtime.modelId, name: runtime.modelId, provider: 'ollama',
    api: runtime.transport === 'native' ? NATIVE_API : OPENAI_API,
    baseUrl: runtime.transport === 'native' ? runtime.connection.baseUrl! : `${runtime.connection.baseUrl}/v1`,
    contextWindow: runtime.contextWindow, maxTokens: runtime.maxOutputTokens,
    reasoning: runtime.capabilities.includes('thinking'),
    thinkingLevelMap: ollamaThinkingMap(runtime.thinking)!,
    input: runtime.capabilities.includes('vision') ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ollamaRuntime: runtime,
    cortexCapabilities: {
      promptCaching: 'automatic-prefix',
      ...(runtime.trainedContextWindow ? { trainedContextWindow: runtime.trainedContextWindow } : {}),
      ...(runtime.transport === 'native' ? { structuredOutput: 'json-schema' as const } : {}),
    },
  };
  return wrapModel(model, 'ollama', model.id, runtime.contextWindow);
}

export function getOllamaRuntimeInfo(model: import('../../model-wrapper.js').CortexModel): Pick<OllamaRuntime, 'transport' | 'contextWindow' | 'trainedContextWindow' | 'thinking'> | null {
  if (model.provider !== 'ollama') return null;
  const runtime = (unwrapModel(model) as OllamaPiModel).ollamaRuntime;
  return runtime ? { transport: runtime.transport, contextWindow: runtime.contextWindow,
    ...(runtime.trainedContextWindow ? { trainedContextWindow: runtime.trainedContextWindow } : {}),
    thinking: runtime.thinking } : null;
}
