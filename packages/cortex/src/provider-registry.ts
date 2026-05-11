/**
 * Static provider registry for known LLM providers.
 *
 * This module contains:
 * 1. PROVIDER_REGISTRY: metadata for all known providers (auth methods, env vars, key prefixes)
 * 2. OAUTH_PROVIDER_IDS: the subset of providers that support OAuth
 * 3. UTILITY_MODEL_DEFAULTS: per-provider cheapest-capable model for utility operations
 *
 * OAuth flows are resolved through pi-ai's OAuth provider registry at runtime.
 *
 * Reference: provider-manager.md
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Authentication method supported by a provider. */
export type AuthMethod = 'oauth' | 'api_key';

/** Static metadata for a known LLM provider. */
export interface ProviderInfo {
  /** Provider identifier (e.g., 'anthropic', 'openai', 'google'). */
  id: string;
  /** Human-readable name (e.g., 'Anthropic', 'OpenAI'). */
  name: string;
  /** Supported authentication methods. */
  authMethods: AuthMethod[];
  /** Environment variable name for API key (e.g., 'ANTHROPIC_API_KEY'). */
  envVar?: string | undefined;
  /** API key prefix for client-side type inference (e.g., 'sk-ant-'). */
  keyPrefix?: string | undefined;
  /** URL where users obtain API keys. */
  keyUrl?: string | undefined;
}

/** Metadata about a model available from a provider. */
export interface ModelInfo {
  /** Model identifier (e.g., 'claude-sonnet-4-20250514'). */
  id: string;
  /** Human-readable name (e.g., 'Claude Sonnet 4'). */
  name: string;
  /** Context window size in tokens. */
  contextWindow: number;
  /** Whether the model supports extended thinking. */
  supportsThinking: boolean;
  /** Thinking levels supported by this model, in Cortex's public naming. */
  supportedThinkingLevels: Array<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max'>;
  /** Whether the model supports image input. */
  supportsImages: boolean;
  /** Pricing per million tokens (if available). */
  pricing?: { input: number; output: number } | undefined;
}

// ---------------------------------------------------------------------------
// Provider Registry
// ---------------------------------------------------------------------------

/**
 * All known providers with their authentication methods and UX metadata.
 *
 * This registry is maintained manually. When pi-ai adds a new provider,
 * a corresponding entry is added here. Providers not in the registry can
 * still be used via resolveModel() and createCustomModel() with direct
 * API keys; they just won't appear in the discovery UI.
 */
export const PROVIDER_REGISTRY: ProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    authMethods: ['oauth', 'api_key'],
    envVar: 'ANTHROPIC_API_KEY',
    keyPrefix: 'sk-ant-',
    keyUrl: 'console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    authMethods: ['api_key'],
    envVar: 'OPENAI_API_KEY',
    keyPrefix: 'sk-proj-',
    keyUrl: 'platform.openai.com/api-keys',
  },
  {
    id: 'azure-openai-responses',
    name: 'Azure OpenAI',
    authMethods: ['api_key'],
    envVar: 'AZURE_OPENAI_API_KEY',
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    authMethods: ['oauth'],
  },
  {
    id: 'google',
    name: 'Google',
    authMethods: ['api_key'],
    envVar: 'GEMINI_API_KEY',
    keyUrl: 'aistudio.google.com/apikey',
  },
  {
    id: 'google-vertex',
    name: 'Google Vertex AI',
    authMethods: ['api_key'],
    envVar: 'GOOGLE_CLOUD_API_KEY',
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    authMethods: ['oauth'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    authMethods: ['api_key'],
    envVar: 'DEEPSEEK_API_KEY',
    keyUrl: 'platform.deepseek.com/api_keys',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    authMethods: ['api_key'],
    envVar: 'MISTRAL_API_KEY',
    keyUrl: 'console.mistral.ai/api-keys',
  },
  {
    id: 'groq',
    name: 'Groq',
    authMethods: ['api_key'],
    envVar: 'GROQ_API_KEY',
    keyUrl: 'console.groq.com/keys',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    authMethods: ['api_key'],
    envVar: 'CEREBRAS_API_KEY',
    keyUrl: 'cloud.cerebras.ai',
  },
  {
    id: 'xai',
    name: 'xAI',
    authMethods: ['api_key'],
    envVar: 'XAI_API_KEY',
    keyUrl: 'console.x.ai',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    authMethods: ['api_key'],
    envVar: 'OPENROUTER_API_KEY',
    keyUrl: 'openrouter.ai/keys',
  },
  {
    id: 'vercel-ai-gateway',
    name: 'Vercel AI Gateway',
    authMethods: ['api_key'],
    envVar: 'AI_GATEWAY_API_KEY',
  },
  {
    id: 'zai',
    name: 'z.ai',
    authMethods: ['api_key'],
    envVar: 'ZAI_API_KEY',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    authMethods: ['api_key'],
    envVar: 'MINIMAX_API_KEY',
  },
  {
    id: 'minimax-cn',
    name: 'MiniMax China',
    authMethods: ['api_key'],
    envVar: 'MINIMAX_CN_API_KEY',
  },
  {
    id: 'moonshotai',
    name: 'Moonshot AI',
    authMethods: ['api_key'],
    envVar: 'MOONSHOT_API_KEY',
  },
  {
    id: 'moonshotai-cn',
    name: 'Moonshot AI China',
    authMethods: ['api_key'],
    envVar: 'MOONSHOT_API_KEY',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    authMethods: ['api_key'],
    envVar: 'HF_TOKEN',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    authMethods: ['api_key'],
    envVar: 'FIREWORKS_API_KEY',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    authMethods: ['api_key'],
    envVar: 'OPENCODE_API_KEY',
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    authMethods: ['api_key'],
    envVar: 'OPENCODE_API_KEY',
  },
  {
    id: 'kimi-coding',
    name: 'Kimi Coding',
    authMethods: ['api_key'],
    envVar: 'KIMI_API_KEY',
  },
  {
    id: 'cloudflare-workers-ai',
    name: 'Cloudflare Workers AI',
    authMethods: ['api_key'],
    envVar: 'CLOUDFLARE_API_KEY',
  },
  {
    id: 'cloudflare-ai-gateway',
    name: 'Cloudflare AI Gateway',
    authMethods: ['api_key'],
    envVar: 'CLOUDFLARE_API_KEY',
  },
  {
    id: 'xiaomi',
    name: 'Xiaomi',
    authMethods: ['api_key'],
    envVar: 'XIAOMI_API_KEY',
  },
  {
    id: 'xiaomi-token-plan-cn',
    name: 'Xiaomi Token Plan China',
    authMethods: ['api_key'],
    envVar: 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  },
  {
    id: 'xiaomi-token-plan-ams',
    name: 'Xiaomi Token Plan Amsterdam',
    authMethods: ['api_key'],
    envVar: 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  },
  {
    id: 'xiaomi-token-plan-sgp',
    name: 'Xiaomi Token Plan Singapore',
    authMethods: ['api_key'],
    envVar: 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  },
];

// ---------------------------------------------------------------------------
// OAuth Providers
// ---------------------------------------------------------------------------

/**
 * Provider IDs that support OAuth login flows.
 */
export const OAUTH_PROVIDER_IDS: string[] = [
  'anthropic',
  'openai-codex',
  'github-copilot',
];

// ---------------------------------------------------------------------------
// Utility Model Defaults
// ---------------------------------------------------------------------------

/**
 * Default utility model IDs per provider.
 * Used when utilityModel is 'default' or undefined.
 *
 * These are the cheapest capable models for each provider,
 * suitable for internal operations like WebFetch summarization
 * and safety classification.
 */
/**
 * Default primary model IDs per provider.
 * Used when a user first connects a provider and no model is explicitly selected.
 * These are the best general-purpose models for each provider.
 */
export const PRIMARY_MODEL_DEFAULTS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.4',
  google: 'gemini-3.1-pro-preview',
  groq: 'openai/gpt-oss-120b',
  cerebras: 'gpt-oss-120b',
  mistral: 'mistral-large-2512',
};

export const UTILITY_MODEL_DEFAULTS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',     // $1.00/$5.00 per 1M tokens
  openai: 'gpt-4.1-nano',                     // $0.10/$0.40 per 1M tokens
  'openai-codex': 'gpt-5.1-codex-mini',      // Smallest Codex model
  google: 'gemini-2.5-flash-lite',            // $0.10/$0.40 per 1M tokens
  groq: 'llama-3.1-8b-instant',              // ~$0.05/$0.08 per 1M tokens
  cerebras: 'llama3.1-8b',                    // ~$0.10/$0.10 per 1M tokens
  mistral: 'mistral-small-2506',             // $0.06/$0.18 per 1M tokens
};

// ---------------------------------------------------------------------------
// Cache Retention
// ---------------------------------------------------------------------------

export type CacheRetention = 'none' | 'short' | 'long';

/** Per-provider prompt caching characteristics as implemented in pi-ai. */
export interface ProviderCacheConfig {
  /** Whether pi-ai implements cacheRetention for this provider. */
  supported: boolean;
  /** Short-term cache TTL in ms (0 if unsupported). */
  shortTtlMs: number;
  /** Long-term cache TTL in ms (0 if unsupported). */
  longTtlMs: number;
  /** Write cost multiplier vs base input price for short cache (1.0 = free). */
  shortWritePremium: number;
  /** Write cost multiplier vs base input price for long cache. */
  longWritePremium: number;
  /** Read cost multiplier vs base input price (0.1 = 90% discount). */
  readDiscount: number;
  /** Whether the TTL resets on each cache hit. */
  ttlResetsOnHit: boolean;
  /** True if "long" has no cost penalty over "short" (e.g. OpenAI). */
  preferLong: boolean;
}

/**
 * Cache configuration for all known providers.
 *
 * Only Anthropic, Bedrock (Claude), and OpenAI Responses actually implement
 * cacheRetention in pi-ai. All other providers ignore it (no-op).
 */
export const PROVIDER_CACHE_CONFIG: Record<string, ProviderCacheConfig> = {
  anthropic:  { supported: true,  shortTtlMs: 300_000,  longTtlMs: 3_600_000,   shortWritePremium: 1.25, longWritePremium: 2.0, readDiscount: 0.1, ttlResetsOnHit: true,  preferLong: false },
  bedrock:    { supported: true,  shortTtlMs: 300_000,  longTtlMs: 3_600_000,   shortWritePremium: 1.25, longWritePremium: 2.0, readDiscount: 0.1, ttlResetsOnHit: true,  preferLong: false },
  openai:     { supported: true,  shortTtlMs: 600_000,  longTtlMs: 86_400_000,  shortWritePremium: 1.0,  longWritePremium: 1.0, readDiscount: 0.5, ttlResetsOnHit: true,  preferLong: true  },
  google:     { supported: false, shortTtlMs: 0,        longTtlMs: 0,           shortWritePremium: 1.0,  longWritePremium: 1.0, readDiscount: 1.0, ttlResetsOnHit: false, preferLong: false },
  mistral:    { supported: false, shortTtlMs: 0,        longTtlMs: 0,           shortWritePremium: 1.0,  longWritePremium: 1.0, readDiscount: 1.0, ttlResetsOnHit: false, preferLong: false },
  azure:      { supported: false, shortTtlMs: 0,        longTtlMs: 0,           shortWritePremium: 1.0,  longWritePremium: 1.0, readDiscount: 1.0, ttlResetsOnHit: false, preferLong: false },
};

/**
 * Resolve the optimal cache retention setting for a provider and tick interval.
 *
 * Decision logic:
 * - Providers with preferLong (e.g. OpenAI, free writes): always "long"
 * - Anthropic/Bedrock with interval ≤ 4.5 min: "short" (cheaper writes, TTL resets on hit)
 * - Anthropic/Bedrock with interval > 4.5 min: "long" (need 1-hour window for sleep ticks)
 * - Unsupported providers: "none"
 */
export function resolveCacheRetention(provider: string, tickIntervalMs: number): CacheRetention {
  const config = PROVIDER_CACHE_CONFIG[provider];

  // Unknown or unsupported provider
  if (!config || !config.supported) {
    return 'none';
  }

  // Providers where long cache is free (e.g. OpenAI): always use long
  if (config.preferLong) {
    return 'long';
  }

  // Providers with a write cost premium (e.g. Anthropic):
  // use short when the interval fits within the short TTL (with safety margin)
  const SHORT_TTL_SAFETY_MARGIN = 0.9; // 90% of TTL as threshold
  const shortThreshold = config.shortTtlMs * SHORT_TTL_SAFETY_MARGIN;

  if (tickIntervalMs <= shortThreshold) {
    return 'short';
  }

  // Interval exceeds short TTL: use long if available
  if (config.longTtlMs > 0) {
    return 'long';
  }

  return 'none';
}
