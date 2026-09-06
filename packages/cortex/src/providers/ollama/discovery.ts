import { z } from 'zod';

const positiveInt = z.number().int().positive();
export const ollamaDetailsSchema = z.object({
  family: z.string().optional(),
  parameter_size: z.string().optional(),
  quantization_level: z.string().optional(),
});
export const ollamaShowSchema = z.object({
  capabilities: z.array(z.string()).default([]),
  model_info: z.record(z.string(), z.unknown()).default({}),
  parameters: z.string().optional(),
  details: ollamaDetailsSchema.optional(),
  remote_host: z.string().optional(),
});
const runningSchema = z.object({ models: z.array(z.object({
  name: z.string(), model: z.string().optional(),
  context_length: positiveInt.optional(),
})) });
const tagsSchema = z.object({ models: z.array(z.object({
  name: z.string(), size: z.number().nonnegative(), details: ollamaDetailsSchema.optional(),
})) });

export interface OllamaConnection {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  signal?: AbortSignal | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  timeoutMs?: number | undefined;
}

export function getOllamaHost(baseUrl?: string): string {
  const value = baseUrl ?? process.env['OLLAMA_HOST'] ?? 'http://localhost:11434';
  const url = new URL(value.includes('://') ? value : `http://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Ollama requires an HTTP(S) URL without embedded credentials, query, or fragment');
  }
  return url.toString().replace(/\/+$/, '').replace(/\/v1$/, '');
}

export async function ollamaRequest(
  connection: OllamaConnection, path: string, body?: unknown,
): Promise<unknown> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(connection.timeoutMs ?? 10_000),
    ...(connection.signal ? [connection.signal] : []),
  ]);
  const response = await (connection.fetch ?? globalThis.fetch)(`${getOllamaHost(connection.baseUrl)}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
  });
  if (!response.ok) throw new Error(`Ollama ${path}: HTTP ${response.status}`);
  return response.json();
}

export async function showOllamaModel(connection: OllamaConnection, model: string) {
  return ollamaShowSchema.parse(await ollamaRequest(connection, '/api/show', { model }));
}

export function trainedContextLength(show: z.infer<typeof ollamaShowSchema>): number | undefined {
  const arch = show.model_info['general.architecture'];
  const parsed = positiveInt.safeParse(show.model_info[`${arch}.context_length`]);
  return parsed.success ? parsed.data : undefined;
}

export async function getOllamaRunningContext(connection: OllamaConnection, model: string): Promise<number | undefined> {
  const result = runningSchema.parse(await ollamaRequest(connection, '/api/ps'));
  const canonical = (name: string) => name.split('/').at(-1)?.includes(':') ? name : `${name}:latest`;
  return result.models.find(m => canonical(m.name) === canonical(model) ||
    (m.model && canonical(m.model) === canonical(model)))?.context_length;
}

/** Discovery only. Never loads a model. */
export async function detectOllama(connection: OllamaConnection = {}) {
  const host = getOllamaHost(connection.baseUrl);
  try {
    const { models } = tagsSchema.parse(await ollamaRequest({ ...connection, timeoutMs: connection.timeoutMs ?? 2000 }, '/api/tags'));
    return { running: true, host, models };
  } catch (error) {
    if (connection.signal?.aborted) throw error;
    return { running: false, host, models: [] as z.infer<typeof tagsSchema>['models'] };
  }
}

/** Trained maximum for picker display only. Resolution uses /api/ps. */
export async function getOllamaContextWindow(host: string, model: string, connection: Omit<OllamaConnection, 'baseUrl'> = {}): Promise<number | null> {
  try { return trainedContextLength(await showOllamaModel({ ...connection, baseUrl: host }, model)) ?? null; }
  catch { return null; }
}
