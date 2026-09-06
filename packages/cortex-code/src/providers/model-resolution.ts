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
      ...(ollama?.transport === 'native' && contextWindowLimit != null ? { contextWindowLimit } : {}),
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
