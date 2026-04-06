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
 * Auto-detect a running Ollama instance and list its available models.
 * Checks OLLAMA_HOST env var, falls back to localhost:11434.
 */
export async function detectOllama(): Promise<OllamaStatus> {
  const host = process.env['OLLAMA_HOST'] ?? 'http://localhost:11434';
  const normalizedHost = host.startsWith('http') ? host : `http://${host}`;

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
