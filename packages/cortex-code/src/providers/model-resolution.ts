import { resolveDefaultModelId } from '@animus-labs/cortex';
import type { CortexModel, ProviderManager } from '@animus-labs/cortex';
import type { CredentialEntry } from '../config/credentials.js';
import type { CortexCodeConfig } from '../config/config.js';
import { log } from '../logger.js';

/** One connection contract for startup, setup, switches, utility, and standalone completion. */
export async function resolveConfiguredModel(
  manager: ProviderManager, provider: string, modelId: string,
  entry: Pick<CredentialEntry, 'method' | 'baseUrl' | 'apiKey'> | null,
  ollama?: CortexCodeConfig['ollama'],
  contextWindowLimit?: CortexCodeConfig['contextWindowLimit'],
): Promise<CortexModel> {
  if (provider === 'ollama') {
    return manager.createOllamaModel({
      ...ollama, modelId, baseUrl: entry?.baseUrl,
      ...(contextWindowLimit != null ? { contextWindowLimit } : {}),
      apiKey: entry?.apiKey,
      onMetrics: metrics => log.debug('Ollama inference', { ...metrics }),
    });
  }
  if (entry?.method === 'custom') {
    if (!entry.baseUrl) throw new Error('The custom provider has no base URL. Run /login to configure it');
    return manager.createCustomModel({ baseUrl: entry.baseUrl, modelId, ...(entry.apiKey ? { apiKey: entry.apiKey } : {}) });
  }
  return manager.resolveModel(provider, modelId);
}

/**
 * The model a provider starts on when none was picked: Cortex's default for
 * it from the pi-ai catalog. A provider without a catalog (Ollama, custom
 * endpoints) has no default and must be given a model explicitly.
 */
export function defaultModelFor(provider: string): string {
  const modelId = resolveDefaultModelId(provider);
  if (!modelId) {
    throw new Error(`No default model for provider "${provider}". Pass --model or pick one with /model.`);
  }
  return modelId;
}
