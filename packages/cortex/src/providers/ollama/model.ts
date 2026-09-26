import { registerApiProvider, getApiProvider } from '@earendil-works/pi-ai/compat';
import { wrapModel, unwrapModel } from '../../model-wrapper.js';
import { resolveOllamaRuntime } from './runtime.js';
import type { OllamaModelConfig, OllamaPiModel, OllamaRuntime } from './runtime.js';
import { ollamaThinkingMap } from './thinking.js';
import { streamOllama } from './stream.js';

const NATIVE_API = 'cortex-ollama-chat';

/** Register Ollama's API with pi while keeping the native codec independent of registration. */
function registerOllamaApi(): void {
  if (!getApiProvider(NATIVE_API)) registerApiProvider({
    api: NATIVE_API, stream: streamOllama,
    streamSimple: (model, context, options) => streamOllama(model, context, {
      ...options,
      // Agent-core represents off as an omitted reasoning option. Clamp models
      // which cannot disable thinking to their weakest supported level.
      reasoning: options?.reasoning ?? ((model as OllamaPiModel).ollamaRuntime.thinking === 'levels' ? 'low' : 'off'),
    }),
  });
}

export async function createOllamaModel(config: OllamaModelConfig) {
  const runtime = await resolveOllamaRuntime(config);
  registerOllamaApi();
  const model: OllamaPiModel & { cortexCapabilities: import('../../model-wrapper.js').ModelCapabilities } = {
    id: runtime.modelId, name: runtime.modelId, provider: 'ollama',
    api: NATIVE_API,
    baseUrl: runtime.connection.baseUrl!,
    contextWindow: runtime.contextWindow, maxTokens: runtime.maxOutputTokens,
    reasoning: runtime.capabilities.includes('thinking'),
    thinkingLevelMap: ollamaThinkingMap(runtime.thinking)!,
    input: runtime.capabilities.includes('vision') ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ollamaRuntime: runtime,
    cortexCapabilities: {
      promptCaching: 'automatic-prefix',
      ...(runtime.trainedContextWindow ? { trainedContextWindow: runtime.trainedContextWindow } : {}),
      structuredOutput: 'json-schema',
      // One request per model by default (OLLAMA_NUM_PARALLEL=1).
      concurrency: config.parallelRequests === true ? 'parallel' : 'serial',
    },
  };
  return wrapModel(model, 'ollama', model.id, runtime.contextWindow);
}

export function getOllamaRuntimeInfo(model: import('../../model-wrapper.js').CortexModel): Pick<OllamaRuntime, 'contextWindow' | 'trainedContextWindow' | 'thinking'> | null {
  if (model.provider !== 'ollama') return null;
  const runtime = (unwrapModel(model) as OllamaPiModel).ollamaRuntime;
  return runtime ? { contextWindow: runtime.contextWindow,
    ...(runtime.trainedContextWindow ? { trainedContextWindow: runtime.trainedContextWindow } : {}),
    thinking: runtime.thinking } : null;
}
