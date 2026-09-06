import { z } from 'zod';
import type { Model } from '@earendil-works/pi-ai';
import { getOllamaHost, getOllamaRunningContext, ollamaRequest, showOllamaModel, trainedContextLength } from './discovery.js';
import type { OllamaConnection } from './discovery.js';
import { inferOllamaThinking } from './thinking.js';
import type { OllamaThinking } from './thinking.js';

export interface OllamaMetrics {
  model: string;
  transport: 'native' | 'openai';
  contextWindow: number;
  totalMs: number;
  firstOutputMs?: number;
  firstTextMs?: number;
  loadMs?: number;
  promptEvalMs?: number;
  generationMs?: number;
  promptTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
}

export interface OllamaModelConfig extends OllamaConnection {
  modelId: string;
  /** Explicit allocation request. Omitted adopts the server's loaded allocation. */
  contextWindow?: number | undefined;
  /** Native allocation cap. Never increases an existing allocation unless contextWindow requests it. */
  contextWindowLimit?: number | undefined;
  /** Native is opt-in until the hardware comparison in the integration plan passes. */
  transport?: 'native' | 'openai' | undefined;
  keepAlive?: string | number | undefined;
  thinking?: OllamaThinking | undefined;
  maxOutputTokens?: number | undefined;
  onMetrics?: ((metrics: OllamaMetrics) => void) | undefined;
}

export interface OllamaRuntime {
  connection: OllamaConnection;
  modelId: string;
  contextWindow: number;
  trainedContextWindow?: number;
  transport: 'native' | 'openai';
  keepAlive?: string | number;
  thinking: OllamaThinking;
  maxOutputTokens: number;
  capabilities: string[];
  onMetrics?: (metrics: OllamaMetrics) => void;
}

export type OllamaPiModel = Model<string> & { ollamaRuntime: OllamaRuntime };

const settingsSchema = z.object({
  modelId: z.string().trim().min(1),
  contextWindow: z.number().int().positive().optional(),
  contextWindowLimit: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  transport: z.enum(['native', 'openai']).default('openai'),
  thinking: z.enum(['binary', 'levels', 'default']).optional(),
  keepAlive: z.union([z.number().finite(), z.string().regex(/^-?\d+(?:\.\d+)?(?:ms|s|m|h)$/)])
    .refine(value => Number.parseFloat(String(value)) !== 0,
      'Ollama keepAlive must be nonzero: zero unloads the model and prevents a stable runtime allocation').optional(),
});

export async function resolveOllamaRuntime(config: OllamaModelConfig): Promise<OllamaRuntime> {
  const settings = settingsSchema.parse(config);
  if (settings.transport === 'openai' && (settings.contextWindow !== undefined || settings.contextWindowLimit !== undefined)) {
    throw new Error('Explicit Ollama context allocation requires transport "native"; otherwise configure num_ctx on the server');
  }
  if (settings.transport === 'openai' && settings.keepAlive !== undefined) {
    throw new Error('Per-request Ollama keepAlive requires transport "native"; use OLLAMA_KEEP_ALIVE with OpenAI compatibility');
  }
  const connection: OllamaConnection = { ...config, baseUrl: getOllamaHost(config.baseUrl) };
  if (settings.transport === 'native') {
    const { version } = z.object({ version: z.string() }).parse(await ollamaRequest(connection, '/api/version'));
    const match = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(version);
    if (!match || (Number(match[1]) === 0 && Number(match[2]) < 15)) {
      throw new Error('Native Ollama requires version 0.15.0 or newer for explicit context overflow controls; use transport "openai" with older servers');
    }
  }
  const show = await showOllamaModel(connection, settings.modelId);
  if (show.remote_host) throw new Error('This Ollama integration requires a local model, not an Ollama Cloud model');
  const trained = trainedContextLength(show);
  if (trained && settings.contextWindow && settings.contextWindow > trained) {
    throw new Error(`Requested Ollama context ${settings.contextWindow} exceeds trained maximum ${trained}`);
  }
  let running = await getOllamaRunningContext(connection, settings.modelId);
  // Resolve the cap once. All calls sharing this model then use one allocation,
  // including utility work with a smaller output budget.
  const requested = settings.contextWindowLimit === undefined ? settings.contextWindow : Math.min(
    settings.contextWindow ?? running ?? settings.contextWindowLimit,
    settings.contextWindowLimit, trained ?? Infinity,
  );
  if (settings.transport === 'openai' || !running || (requested && running !== requested)) {
    // An empty request loads only the selected model, without generating text.
    // Compatibility re-resolves server/Modelfile defaults and cannot preserve
    // a prior native num_ctx override. Prepare its defaults before measuring.
    await ollamaRequest({ ...connection, timeoutMs: config.timeoutMs ?? 300_000 }, '/api/chat', {
      model: settings.modelId, messages: [], stream: false,
      ...(settings.transport === 'native' ? { shift: false, truncate: false } : {}),
      ...(requested ? { options: { num_ctx: requested } } : {}),
      ...(settings.keepAlive === undefined ? {} : { keep_alive: settings.keepAlive }),
    });
    running = await getOllamaRunningContext(connection, settings.modelId);
  }
  if (!running) throw new Error('Ollama did not report its running context length in /api/ps. Update Ollama or configure a compatible server');
  if (requested && running !== requested) {
    throw new Error(`Ollama allocated ${running} tokens instead of requested ${requested}`);
  }
  return {
    connection, modelId: settings.modelId,
    contextWindow: trained ? Math.min(running, trained) : running,
    ...(trained === undefined ? {} : { trainedContextWindow: trained }),
    transport: settings.transport,
    ...(settings.keepAlive === undefined ? {} : { keepAlive: settings.keepAlive }),
    thinking: settings.thinking ?? inferOllamaThinking(show.details?.family ?? settings.modelId, show.capabilities.includes('thinking')),
    maxOutputTokens: settings.maxOutputTokens ?? Math.min(8192, Math.max(1, Math.floor(running / 4))),
    capabilities: show.capabilities,
    ...(config.onMetrics ? { onMetrics: config.onMetrics } : {}),
  };
}

/** Recheck without changing allocation. Other clients can reload a shared server. */
export async function checkOllamaAllocation(runtime: OllamaRuntime, signal?: AbortSignal): Promise<void> {
  const connection = { ...runtime.connection, signal };
  let actual = await getOllamaRunningContext(connection, runtime.modelId);
  if (!actual) {
    await ollamaRequest({ ...connection, timeoutMs: runtime.connection.timeoutMs ?? 300_000 }, '/api/chat', {
      model: runtime.modelId, messages: [], stream: false,
      ...(runtime.transport === 'native' ? { options: { num_ctx: runtime.contextWindow }, shift: false, truncate: false } : {}),
      ...(runtime.keepAlive === undefined ? {} : { keep_alive: runtime.keepAlive }),
    });
    actual = await getOllamaRunningContext(connection, runtime.modelId);
  }
  if (!actual || Math.min(actual, runtime.trainedContextWindow ?? actual) !== runtime.contextWindow) {
    throw new Error(`Ollama context allocation changed to ${actual} tokens (expected ${runtime.contextWindow}); reselect the model to refresh its context limit`);
  }
}
