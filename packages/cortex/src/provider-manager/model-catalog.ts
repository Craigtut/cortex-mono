/**
 * The model catalog as the picker sees it: pi-ai's builtin models mapped to
 * ModelInfo, with legacy generations and alias duplicates filtered out.
 */

import type { ModelInfo } from '../provider-registry.js';
import type { ThinkingLevel } from '../types.js';
import { THINKING_LEVEL_ORDER } from '../types.js';
import { loadPiAi } from './pi-ai.js';

// ---------------------------------------------------------------------------
// Legacy model filtering
// ---------------------------------------------------------------------------

/**
 * Model ID prefixes considered legacy/deprecated per provider.
 * Pi-ai doesn't flag deprecation, so we maintain this list to keep
 * the model picker clean and prevent users from selecting models that
 * produce poor results with modern tool-use patterns.
 */
const LEGACY_MODEL_PREFIXES: Record<string, string[]> = {
  anthropic: [
    'claude-3-',      // Claude 3.x family (Haiku/Sonnet/Opus from 2024)
    'claude-3.',      // Alternate naming
  ],
  openai: [
    'gpt-3.5-',      // GPT-3.5 family
    'gpt-4-',        // GPT-4 original (not 4o/4.1)
  ],
  google: [
    'gemini-1.',      // Gemini 1.x family
    'gemini-pro',     // Original Gemini Pro
  ],
};

// ---------------------------------------------------------------------------
// Model mapping helper
// ---------------------------------------------------------------------------

/**
 * Narrow a pi level name to Cortex's union. Identity apart from the
 * membership check: Cortex's names are pi's names, and folding two of them
 * (xhigh into max, say) would hide one of a model's levels.
 */
function mapPiThinkingLevel(level: string): ThinkingLevel | null {
  return (THINKING_LEVEL_ORDER as readonly string[]).includes(level)
    ? (level as ThinkingLevel)
    : null;
}

function mapPiThinkingLevels(levels: readonly string[]): ThinkingLevel[] {
  const mapped: ThinkingLevel[] = [];
  for (const level of levels) {
    const cortexLevel = mapPiThinkingLevel(level);
    if (cortexLevel && !mapped.includes(cortexLevel)) {
      mapped.push(cortexLevel);
    }
  }
  return mapped;
}

/**
 * Map a raw pi-ai model object to our ModelInfo type.
 */
function mapRawToModelInfo(
  raw: Record<string, unknown>,
  getSupportedThinkingLevels?: (model: unknown) => string[],
): ModelInfo {
  // pi-ai models have 'id' (API identifier like "claude-sonnet-4-6") and
  // 'name' (display name like "Claude Sonnet 4.6"). Use 'id' as our id.
  const rawId = raw['id'];
  const id = typeof rawId === 'string' ? rawId : String(rawId ?? raw['name'] ?? 'unknown');

  const rawDisplayName = raw['displayName'];
  const rawName = raw['name'];
  const name = typeof rawDisplayName === 'string'
    ? rawDisplayName
    : typeof rawName === 'string'
      ? rawName
      : id;

  const rawContextWindow = raw['contextWindow'];
  const contextWindow = typeof rawContextWindow === 'number' ? rawContextWindow : 200_000;

  let supportedThinkingLevels: ThinkingLevel[] = [];
  if (getSupportedThinkingLevels) {
    try {
      supportedThinkingLevels = mapPiThinkingLevels(getSupportedThinkingLevels(raw));
    } catch {
      supportedThinkingLevels = [];
    }
  }
  if (supportedThinkingLevels.length === 0 && raw['reasoning'] === true) {
    supportedThinkingLevels = ['minimal', 'low', 'medium', 'high'];
  }

  const info: ModelInfo = {
    id,
    name,
    contextWindow,
    supportsThinking: supportedThinkingLevels.some(level => level !== 'off')
      || !!(raw['supportsThinking'] || raw['reasoning']),
    supportedThinkingLevels,
    supportsImages: Array.isArray(raw['input'])
      ? raw['input'].includes('image')
      : !!raw['supportsImages'],
  };

  const rawPricing = raw['pricing'] ?? raw['cost'];
  if (rawPricing && typeof rawPricing === 'object') {
    const pricing = rawPricing as Record<string, unknown>;
    const inputPrice = pricing['input'];
    const outputPrice = pricing['output'];
    info.pricing = {
      input: typeof inputPrice === 'number' ? inputPrice : 0,
      output: typeof outputPrice === 'number' ? outputPrice : 0,
    };
  }

  return info;
}

/** The models a provider offers, as the model picker should list them. */
export async function listProviderModels(provider: string): Promise<ModelInfo[]> {
  const piAi = await loadPiAi();
  const rawModels = piAi.getModels(provider);
  const models = rawModels.map(raw => mapRawToModelInfo(raw, piAi.getSupportedThinkingLevels));

  // Filter pipeline:
  // 1. Remove legacy/deprecated generation models
  // 2. Remove "-latest" alias duplicates
  // 3. Remove duplicate display names
  const legacyPrefixes = LEGACY_MODEL_PREFIXES[provider];
  const filtered = legacyPrefixes
    ? models.filter(m => !legacyPrefixes.some(prefix => m.id.startsWith(prefix)))
    : models;

  const seen = new Set<string>();
  return filtered.filter(m => {
    // Strip "-latest" suffix to check for duplicate base names
    const baseName = m.id.replace(/-latest$/, '');
    if (m.id.endsWith('-latest')) {
      // Only include the "-latest" alias if no pinned version exists
      return !filtered.some(other => other.id === baseName);
    }
    // Skip duplicates with identical names (different IDs but same display name)
    if (seen.has(m.name)) return false;
    seen.add(m.name);
    return true;
  });
}
