interface OllamaModel {
  name: string;
  size: number;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface OllamaStatus {
  running: boolean;
  host: string;
  models: OllamaModel[];
}

/**
 * Resolve the Ollama API host from a baseUrl or environment.
 * Strips the /v1 suffix that OpenAI-compatible endpoints use.
 */
export function getOllamaHost(baseUrl?: string): string {
  if (baseUrl) return baseUrl.replace(/\/v1\/?$/, '');
  const envHost = process.env['OLLAMA_HOST'] ?? 'localhost:11434';
  return envHost.startsWith('http') ? envHost : `http://${envHost}`;
}

/**
 * Query the context window (trained context length) for a specific Ollama model.
 * Calls POST /api/show and extracts model_info["{arch}.context_length"].
 * Returns null if the model doesn't expose this information or the call fails.
 */
export async function getOllamaContextWindow(
  host: string,
  modelName: string,
): Promise<number | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${host}/api/show`, {
      method: 'POST',
      body: JSON.stringify({ name: modelName }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;

    const data = await response.json() as Record<string, unknown>;
    const modelInfo = data['model_info'] as Record<string, unknown> | undefined;
    if (!modelInfo) return null;

    const arch = modelInfo['general.architecture'];
    if (typeof arch !== 'string') return null;

    const contextLength = modelInfo[`${arch}.context_length`];
    return typeof contextLength === 'number' ? contextLength : null;
  } catch {
    return null;
  }
}

/**
 * Auto-detect a running Ollama instance and list its available models.
 * Checks OLLAMA_HOST env var, falls back to localhost:11434.
 */
export async function detectOllama(): Promise<OllamaStatus> {
  const normalizedHost = getOllamaHost();

  // Ping Ollama with a 2-second timeout
  const isRunning = await ping(normalizedHost);
  if (!isRunning) {
    return { running: false, host: normalizedHost, models: [] };
  }

  // List available models
  const models = await listModels(normalizedHost);
  return { running: true, host: normalizedHost, models };
}

async function ping(host: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(host, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

async function listModels(host: string): Promise<OllamaModel[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${host}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) return [];

    const data = await response.json() as { models?: OllamaModel[] };
    return data.models ?? [];
  } catch {
    return [];
  }
}
