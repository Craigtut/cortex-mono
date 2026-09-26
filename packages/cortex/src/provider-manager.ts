/**
 * ProviderManager: standalone class wrapping pi-ai for provider discovery,
 * OAuth login/refresh, API key validation, model resolution, and custom
 * endpoint creation.
 *
 * ProviderManager and AgentLoop are fully independent. Neither knows
 * about the other. The consumer creates both, uses ProviderManager for
 * auth/discovery, and provides a getApiKey callback to AgentLoop.
 *
 * Pi-ai is loaded dynamically so consumers never import it directly.
 * If the dependency is missing or unavailable, methods that require it
 * throw clear errors.
 *
 * Reference: provider-manager.md
 */

import {
  PROVIDER_REGISTRY,
  OAUTH_PROVIDER_IDS,
  UTILITY_MODEL_OVERRIDES,
} from './provider-registry.js';
import type { ThinkingLevel } from './types.js';
import { THINKING_LEVEL_ORDER } from './types.js';
import type { ProviderInfo, ModelInfo } from './provider-registry.js';
import { wrapModel } from './model-wrapper.js';
import { inferUtilityModelId } from './utility-model-inference.js';
import type { CortexModel } from './model-wrapper.js';
import type { OllamaModelConfig } from './providers/ollama/runtime.js';
import {
  loadOAuthCapableProviderIds,
  loadPiAi,
  loadPiOAuth,
} from './provider-manager/pi-ai.js';
import type {
  PiAiModule,
  PiAuthEvent,
  PiAuthInteraction,
  PiAuthPrompt,
  PiOAuthCredential,
} from './provider-manager/pi-ai.js';
import { OAuthError } from './provider-manager/oauth-types.js';
import type {
  OAuthFlowType,
  OAuthAuthInfo,
  OAuthPromptInfo,
  OAuthCallbacks,
  OAuthCallbackPageStatus,
  OAuthCallbackPageContext,
  OAuthMeta,
  OAuthResult,
  OAuthRefreshResult,
} from './provider-manager/oauth-types.js';
import {
  assertOAuthCallbackPortAvailable,
  maybeInstallOAuthCallbackShim,
  OAUTH_CALLBACK_ROUTES,
  probeCallbackPortInUse,
} from './provider-manager/oauth-callback-page.js';
import type { OAuthCallbackRoute } from './provider-manager/oauth-callback-page.js';

export { OAuthError } from './provider-manager/oauth-types.js';
export type {
  OAuthFlowType,
  OAuthAuthInfo,
  OAuthPromptInfo,
  OAuthCallbacks,
  OAuthCallbackPageStatus,
  OAuthCallbackPageContext,
  OAuthCallbackPageRenderer,
  OAuthMeta,
  OAuthResult,
  OAuthRefreshResult,
  OAuthErrorCode,
} from './provider-manager/oauth-types.js';
export type { OAuthCallbackRoute } from './provider-manager/oauth-callback-page.js';

/** Configuration for creating a custom model endpoint. */
export interface CustomModelConfig {
  /** Base URL of the OpenAI-compatible API (e.g., 'http://localhost:11434/v1'). */
  baseUrl: string;
  /** Model identifier to send in API requests. */
  modelId: string;
  /** Context window size (default: 128,000). */
  contextWindow?: number | undefined;
  /** Optional API key (some local servers don't require one). */
  apiKey?: string | undefined;
  /** Compatibility settings for non-standard servers. */
  compat?: {
    /** Whether the server supports the 'developer' role (default: true). */
    supportsDeveloperRole?: boolean | undefined;
    /** Whether the server supports reasoning_effort (default: true). */
    supportsReasoningEffort?: boolean | undefined;
  } | undefined;
}

export type ApiKeyValidationStatus =
  | 'valid'
  | 'invalid_credentials'
  | 'transient_error'
  | 'resolution_error';

export interface ApiKeyValidationResult {
  provider: string;
  modelId: string | null;
  valid: boolean;
  retryable: boolean;
  status: ApiKeyValidationStatus;
  message?: string | undefined;
}

// ---------------------------------------------------------------------------
// IProviderManager interface
// ---------------------------------------------------------------------------

/**
 * Interface for provider management operations.
 * Consumers can mock this for testing.
 */
export interface IProviderManager {
  // Discovery
  listProviders(): ProviderInfo[];
  listOAuthProviders(): string[];
  listModels(provider: string): Promise<ModelInfo[]>;

  // OAuth
  initiateOAuth(provider: string, callbacks: OAuthCallbacks): Promise<OAuthResult>;
  cancelOAuth(): void;
  resolveOAuthApiKey(provider: string, credentials: string): Promise<OAuthRefreshResult>;

  // API Key
  validateApiKey(provider: string, apiKey: string): Promise<ApiKeyValidationResult>;
  checkEnvApiKey(provider: string): string | null;

  // Model Resolution
  resolveModel(provider: string, modelId: string): Promise<CortexModel>;
  createCustomModel(config: CustomModelConfig): Promise<CortexModel>;
  createOllamaModel(config: OllamaModelConfig): Promise<CortexModel>;
}

const DEVICE_CODE_INSTRUCTIONS_RE = /\benter\s+code:\s*([A-Z0-9-]+)/i;

/** Default overall OAuth flow timeout (pi-ai hangs without this). */
const DEFAULT_OAUTH_FLOW_TIMEOUT_MS = 5 * 60_000;

/**
 * Refresh this far ahead of expiry. A token that expires while the request
 * it was fetched for is still in flight fails that request, so treat
 * nearly-expired as expired.
 */
const OAUTH_REFRESH_SKEW_MS = 5 * 60_000;

/** Cap a token refresh so a stalled provider cannot wedge a turn. */
const OAUTH_REFRESH_TIMEOUT_MS = 15_000;

function normalizeOAuthPromptInfo(prompt: unknown): OAuthPromptInfo {
  if (typeof prompt === 'string') {
    return { message: prompt };
  }

  const raw = prompt as Record<string, unknown> | null | undefined;
  const message = typeof raw?.['message'] === 'string' ? raw['message'] : String(prompt ?? '');
  const normalized: OAuthPromptInfo = { message };

  if (typeof raw?.['placeholder'] === 'string') {
    normalized.placeholder = raw['placeholder'];
  }

  if (typeof raw?.['allowEmpty'] === 'boolean') {
    normalized.allowEmpty = raw['allowEmpty'];
  }

  return normalized;
}

function isOAuthFlowType(value: unknown): value is OAuthFlowType {
  return value === 'browser' || value === 'localhost_callback' || value === 'device_code';
}

function normalizeOAuthAuthInfo(
  provider: string,
  info: unknown,
  legacyInstructions: string | undefined,
  routes: Record<string, OAuthCallbackRoute>,
): OAuthAuthInfo {
  const raw = typeof info === 'string'
    ? { url: info, instructions: legacyInstructions }
    : (info as Record<string, unknown> | null | undefined);

  const url = typeof raw?.['url'] === 'string' ? raw['url'] : String(info ?? '');
  const instructions = typeof raw?.['instructions'] === 'string'
    ? raw['instructions']
    : legacyInstructions;
  const callbackRoute = routes[provider];
  const deviceCode = typeof raw?.['deviceCode'] === 'string'
    ? raw['deviceCode']
    : instructions?.match(DEVICE_CODE_INSTRUCTIONS_RE)?.[1];
  const isDeviceCodeFlow = Boolean(deviceCode) || provider === 'github-copilot';
  const flowType = isOAuthFlowType(raw?.['flowType'])
    ? raw['flowType']
    : isDeviceCodeFlow ? 'device_code'
      : callbackRoute ? 'localhost_callback'
      : 'browser';
  const manualCodeRecommended = typeof raw?.['manualCodeRecommended'] === 'boolean'
    ? raw['manualCodeRecommended']
    : flowType === 'localhost_callback' && callbackRoute ? true : undefined;
  const callbackPort = typeof raw?.['callbackPort'] === 'number'
    ? raw['callbackPort']
    : flowType === 'localhost_callback' ? callbackRoute?.port : undefined;
  const callbackPath = typeof raw?.['callbackPath'] === 'string'
    ? raw['callbackPath']
    : flowType === 'localhost_callback' ? callbackRoute?.path : undefined;

  return {
    url,
    ...(instructions ? { instructions } : {}),
    flowType,
    ...(deviceCode ? { deviceCode } : {}),
    ...(manualCodeRecommended !== undefined ? { manualCodeRecommended } : {}),
    ...(callbackPort !== undefined ? { callbackPort } : {}),
    ...(callbackPath !== undefined ? { callbackPath } : {}),
  };
}

// ---------------------------------------------------------------------------
// Display name extraction
// ---------------------------------------------------------------------------

/**
 * Extract the best available display name from OAuth credentials.
 * Different providers include different identity information.
 */
function extractDisplayName(credentials: Record<string, unknown>): string | undefined {
  // Try common fields across providers
  const email = credentials['email'];
  if (typeof email === 'string') return email;

  const accountId = credentials['accountId'];
  if (typeof accountId === 'string') return accountId;

  const idToken = credentials['idToken'];
  if (typeof idToken === 'string') {
    // JWT id_token may contain email in payload
    try {
      const parts = idToken.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(atob(parts[1]!)) as Record<string, unknown>;
        const payloadEmail = payload['email'];
        if (typeof payloadEmail === 'string') return payloadEmail;
      }
    } catch {
      // Ignore malformed tokens
    }
  }
  return undefined;
}

/**
 * Build OAuthMeta from raw credential data.
 */
function buildOAuthMeta(
  provider: string,
  rawCredentials: Record<string, unknown>,
): OAuthMeta {
  const displayName = extractDisplayName(rawCredentials);
  const expiresAtRaw = rawCredentials['expiresAt'] ?? rawCredentials['expires'];
  const expiresAt = typeof expiresAtRaw === 'number' ? expiresAtRaw : undefined;

  const meta: OAuthMeta = {
    provider,
    refreshable: !!(rawCredentials['refreshToken'] ?? rawCredentials['refresh']),
  };

  if (displayName !== undefined) {
    meta.displayName = displayName;
  }
  if (expiresAt !== undefined) {
    meta.expiresAt = expiresAt;
  }

  return meta;
}

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
 * membership check: Cortex's names are pi's names. This used to fold "xhigh"
 * into "max", which made a model advertising both report a single top level.
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

// ---------------------------------------------------------------------------
// ProviderManager implementation
// ---------------------------------------------------------------------------

/**
 * Construction options for {@link ProviderManager}.
 *
 * Both fields are testing seams, not part of the product contract. Production
 * consumers construct `new ProviderManager()` with no arguments and get the
 * real fixed callback routes and a real TCP loopback probe. Tests inject these
 * to keep the OAuth callback flow deterministic under parallel execution: the
 * fixed production callback ports (e.g. 53692, 1455) are a shared, finite
 * resource that collides across workers, and the real probe reads live machine
 * port state that another worker can perturb.
 */
export interface ProviderManagerOptions {
  /**
   * Override the fixed loopback OAuth callback routes (provider -> path/port).
   * Lets a test point a provider at an OS-assigned ephemeral port so the
   * callback-page shim can be exercised without binding a fixed port.
   */
  oauthCallbackRoutes?: Record<string, OAuthCallbackRoute> | undefined;
  /**
   * Override the "is this loopback port already bound" probe. Production does a
   * real TCP connect; a test stubs it so `callback_port_in_use` behavior never
   * depends on real, worker-shared port state.
   */
  probeCallbackPortInUse?: ((port: number, host: string) => Promise<boolean>) | undefined;
}

export class ProviderManager implements IProviderManager {
  /** Active OAuth AbortController, if any. */
  private activeOAuthAbort: AbortController | null = null;

  /** Fixed loopback callback routes used by OAuth flows (injectable for tests). */
  private readonly oauthCallbackRoutes: Record<string, OAuthCallbackRoute>;

  /** Loopback port-in-use probe used before opening a browser (injectable for tests). */
  private readonly probeOAuthCallbackPort: (port: number, host: string) => Promise<boolean>;

  constructor(options: ProviderManagerOptions = {}) {
    this.oauthCallbackRoutes = options.oauthCallbackRoutes ?? OAUTH_CALLBACK_ROUTES;
    this.probeOAuthCallbackPort = options.probeCallbackPortInUse ?? probeCallbackPortInUse;
  }

  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------

  /**
   * List all known providers with their metadata.
   */
  listProviders(): ProviderInfo[] {
    return PROVIDER_REGISTRY;
  }

  /**
   * List provider IDs that support OAuth authentication.
   */
  listOAuthProviders(): string[] {
    return OAUTH_PROVIDER_IDS;
  }

  /**
   * List models available from a provider.
   * Delegates to pi-ai's getModels().
   *
   * @param provider - Provider identifier
   * @returns Array of ModelInfo
   * @throws Error if pi-ai is not installed
   */
  async listModels(provider: string): Promise<ModelInfo[]> {
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

  // -----------------------------------------------------------------------
  // OAuth
  // -----------------------------------------------------------------------

  /**
   * Initiate an OAuth login flow for a provider.
   *
   * @param provider - OAuth provider identifier
   * @param callbacks - UI callbacks for auth URL, prompts, and progress
   * @returns The OAuth credentials and display metadata
   * @throws {OAuthError} `unsupported_provider`, `callback_port_in_use`,
   *   `cancelled`, `timed_out`, or `callback_failed`. Other errors (e.g.
   *   network/token-exchange failures from pi-ai) propagate as-is.
   */
  async initiateOAuth(provider: string, callbacks: OAuthCallbacks): Promise<OAuthResult> {
    const oauthProvider = await loadPiOAuth(provider);
    if (!oauthProvider) {
      throw new OAuthError(
        'unsupported_provider',
        provider,
        `Provider "${provider}" does not support OAuth`,
      );
    }

    // (A) Fail fast — before opening a browser — if the provider's fixed
    // callback port is already taken. Otherwise pi-ai binds the other
    // stack, the browser hits the wrong listener, and pi-ai waits forever.
    await assertOAuthCallbackPortAvailable(
      provider,
      this.oauthCallbackRoutes,
      this.probeOAuthCallbackPort,
    );

    const abort = new AbortController();
    this.activeOAuthAbort = abort;

    // (C) pi-ai only settles its callback wait on success; on a failed
    // callback (e.g. state mismatch) it hangs. The render shim already sees
    // that response — use it to fail the flow immediately with the reason.
    let failFromCallback!: (err: OAuthError) => void;
    const callbackFailure = new Promise<never>((_, reject) => {
      failFromCallback = reject;
    });
    const handleCallbackResult = (
      status: OAuthCallbackPageStatus,
      ctx: OAuthCallbackPageContext,
    ): void => {
      if (status !== 'error') return;
      const detail = ctx.details ? ` (${ctx.details})` : '';
      failFromCallback(new OAuthError(
        'callback_failed',
        provider,
        `OAuth callback for "${provider}" reported a failure: ${ctx.message}${detail}`,
      ));
    };

    const releaseShim = maybeInstallOAuthCallbackShim(
      provider,
      oauthProvider.name,
      callbacks.renderCallbackPage,
      handleCallbackResult,
      this.oauthCallbackRoutes,
    );

    // (B) pi-ai callback servers ignore the abort signal, so cancellation
    // and timeout are enforced here. Without this the flow hangs forever.
    const timeoutMs = callbacks.timeoutMs ?? DEFAULT_OAUTH_FLOW_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => reject(new OAuthError(
          'timed_out',
          provider,
          `OAuth flow for "${provider}" timed out after ${timeoutMs}ms.`,
        )), timeoutMs);
        timer.unref?.();
      }
    });
    const cancelled = new Promise<never>((_, reject) => {
      abort.signal.addEventListener('abort', () => reject(new OAuthError(
        'cancelled',
        provider,
        `OAuth flow for "${provider}" was cancelled.`,
      )), { once: true });
    });

    // pi replaced the callbacks bag with a single interaction object: every
    // out-bound message is notify(AuthEvent) and every in-bound answer is
    // prompt(AuthPrompt). Adapt here so Cortex's consumer-facing
    // OAuthCallbacks contract is unchanged by the pi restructure.
    const interaction: PiAuthInteraction = {
      signal: abort.signal,
      notify: (event: PiAuthEvent) => {
        switch (event.type) {
          case 'auth_url':
            callbacks.onAuth(
              normalizeOAuthAuthInfo(provider, event, event.instructions, this.oauthCallbackRoutes),
            );
            return;
          case 'device_code':
            // pi hands us the code as structured data, so pass it straight
            // through rather than re-deriving it from a prose instruction
            // (which is what the old string-parsing path had to do).
            callbacks.onAuth({
              url: event.verificationUri,
              flowType: 'device_code',
              deviceCode: event.userCode,
              instructions: `Enter code ${event.userCode}`,
            });
            return;
          case 'info':
          case 'progress':
            callbacks.onProgress?.(event.message);
            return;
        }
      },
      prompt: async (prompt: PiAuthPrompt): Promise<string> => {
        if (prompt.type === 'manual_code' && callbacks.onManualCodeInput) {
          return await callbacks.onManualCodeInput();
        }
        if (prompt.type === 'select' && callbacks.onSelect) {
          const chosen = await callbacks.onSelect({
            message: prompt.message,
            options: prompt.options.map(o => ({ id: o.id, label: o.label })),
          });
          // pi's prompt() contract is "resolve with the answer, reject on
          // cancel". Cortex signals cancel as undefined, so translate rather
          // than handing pi the string "undefined".
          if (chosen === undefined) {
            throw new OAuthError('cancelled', provider, `OAuth flow for "${provider}" was cancelled.`);
          }
          return chosen;
        }
        return await callbacks.onPrompt(normalizeOAuthPromptInfo(prompt));
      },
    };

    const login = oauthProvider.login(interaction) as Promise<Record<string, unknown>>;
    // Whichever promise loses the race may still settle later (pi-ai's
    // login can hang or settle late; the aux promises can reject after the
    // race is decided). Attach inert handlers so a late rejection never
    // surfaces as an unhandled rejection. Promise.race still observes the
    // first settlement independently.
    login.catch(() => {});
    cancelled.catch(() => {});
    timeout.catch(() => {});
    callbackFailure.catch(() => {});

    try {
      const rawCredentials = await Promise.race([
        login,
        cancelled,
        timeout,
        callbackFailure,
      ]);

      const credentials = JSON.stringify(rawCredentials);
      const meta = buildOAuthMeta(provider, rawCredentials);

      return { credentials, meta };
    } finally {
      if (timer) clearTimeout(timer);
      releaseShim();
      if (this.activeOAuthAbort === abort) this.activeOAuthAbort = null;
    }
  }

  /**
   * Cancel any in-progress OAuth flow.
   */
  cancelOAuth(): void {
    if (this.activeOAuthAbort) {
      this.activeOAuthAbort.abort();
      this.activeOAuthAbort = null;
    }
  }

  /**
   * Resolve an API key from stored OAuth credentials, refreshing if needed.
   *
   * @param provider - The OAuth provider
   * @param credentials - Serialized credential blob from initiateOAuth()
   * @returns The API key and potentially updated credentials
   * @throws Error if pi-ai is not installed or resolution fails
   */
  async resolveOAuthApiKey(provider: string, credentials: string): Promise<OAuthRefreshResult> {
    const oauth = await loadPiOAuth(provider);
    if (!oauth) {
      throw new OAuthError(
        'unsupported_provider',
        provider,
        `Provider "${provider}" does not support OAuth`,
      );
    }

    const rawCredentials = JSON.parse(credentials) as Record<string, unknown>;
    // Security: spread first so a stored blob cannot override Cortex's 'type'.
    const current = { ...rawCredentials, type: 'oauth' as const } as PiOAuthCredential;

    // pi removed getOAuthApiKey without a replacement, splitting it into
    // refresh (network, may rotate the token) and toAuth (pure derivation).
    // Refresh slightly early: a token that expires mid-flight fails the
    // request it was fetched for.
    let settled = current;
    if (typeof current.expires === 'number'
      && Date.now() >= current.expires - OAUTH_REFRESH_SKEW_MS) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), OAUTH_REFRESH_TIMEOUT_MS);
      timer.unref?.();
      try {
        settled = await oauth.refresh(current, abort.signal);
      } finally {
        clearTimeout(timer);
      }
    }

    const auth = await oauth.toAuth(settled);
    if (!auth.apiKey) {
      throw new Error(
        `OAuth resolution failed for provider "${provider}": pi returned no apiKey`,
      );
    }

    const newSerialized = JSON.stringify(settled);
    const changed = newSerialized !== credentials;

    return {
      apiKey: auth.apiKey,
      credentials: changed ? newSerialized : credentials,
      meta: buildOAuthMeta(provider, settled),
      changed,
    };
  }

  /**
   * Provider ids whose installed pi definition ships an OAuth flow.
   *
   * Read from pi rather than from Cortex's static list, so a provider pi
   * gains OAuth for becomes available without a Cortex release. Falls back to
   * the static list if pi cannot be loaded.
   */
  async listOAuthCapableProviders(): Promise<string[]> {
    let fromPi: string[];
    try {
      fromPi = await loadOAuthCapableProviderIds();
    } catch {
      return [...OAUTH_PROVIDER_IDS];
    }
    // Intersect with what Cortex models. pi ships OAuth for gateways Cortex
    // has no PROVIDER_REGISTRY entry for (radius today); advertising those
    // would offer a login the rest of the stack cannot follow through on.
    const known = new Set(PROVIDER_REGISTRY.map(p => p.id));
    return fromPi.filter(id => known.has(id));
  }

  // -----------------------------------------------------------------------
  // API Key
  // -----------------------------------------------------------------------

  /**
   * Validate an API key by making a minimal LLM call (maxTokens: 1).
   *
   * @param provider - The provider to validate against
   * @param apiKey - The API key to validate
   * @returns True if the key is valid, false otherwise
   * @throws Error if pi-ai is not installed
   */
  async validateApiKey(provider: string, apiKey: string): Promise<ApiKeyValidationResult> {
    const piAi = await loadPiAi();

    const models = piAi.getModels(provider) ?? [];
    if (models.length === 0) {
      return {
        provider,
        modelId: null,
        valid: false,
        retryable: false,
        status: 'resolution_error',
        message: `No models found for provider "${provider}"`,
      };
    }

    const modelId = this.getSmallestModelId(provider, models);
    if (!modelId) {
      return {
        provider,
        modelId: null,
        valid: false,
        retryable: false,
        status: 'resolution_error',
        message: `No usable models found for provider "${provider}"`,
      };
    }

    return this.tryValidation(piAi, provider, modelId, apiKey);
  }

  /**
   * Check whether a provider's API key is available in environment variables.
   *
   * @param provider - The provider to check
   * @returns The API key if found, null otherwise
   */
  checkEnvApiKey(provider: string): string | null {
    const entry = PROVIDER_REGISTRY.find(p => p.id === provider);
    if (entry?.envVar) {
      const value = process.env[entry.envVar];
      if (value && value.length > 0) return value;
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Model Resolution
  // -----------------------------------------------------------------------

  /**
   * Resolve a provider + model ID into a CortexModel.
   *
   * Only resolves models that pi-ai ships a definition for. For custom or
   * keyless OpenAI-compatible endpoints pi-ai does not know about, use
   * {@link createCustomModel} instead.
   *
   * @param provider - The provider identifier
   * @param modelId - The model identifier
   * @returns A CortexModel handle
   * @throws Error if pi-ai is not installed
   * @throws Error if the provider/model is unknown to pi-ai
   */
  async resolveModel(provider: string, modelId: string): Promise<CortexModel> {
    const piAi = await loadPiAi();
    const piModel = piAi.getModel(provider, modelId);
    // pi-ai's getModel returns undefined for ids it has no definition for.
    // Fail loudly instead of wrapping undefined into a fake-valid model that
    // would later crash deep inside the agentic loop with an opaque error.
    if (piModel == null) {
      throw new Error(
        `Unknown model "${modelId}" for provider "${provider}". ` +
          `Use ProviderManager.createCustomModel() for endpoints pi-ai has no built-in definition for.`,
      );
    }
    let contextWindow: number | undefined;
    if (typeof piModel === 'object') {
      const raw = piModel as Record<string, unknown>;
      const cw = raw['contextWindow'];
      if (typeof cw === 'number') {
        contextWindow = cw;
      }
    }
    return wrapModel(piModel, provider, modelId, contextWindow);
  }

  /**
   * Create a custom model for an OpenAI-compatible endpoint.
   *
   * @param config - Custom model configuration
   * @returns A CortexModel handle
   * @throws Error if pi-ai is not installed
   */
  async createCustomModel(config: CustomModelConfig): Promise<CortexModel> {
    const piAi = await loadPiAi();
    // Clone an OpenAI model as a base for streaming/format compatibility,
    // then override to use the Chat Completions API. The base model
    // (openai/gpt-4.1) uses the newer Responses API which most
    // OpenAI-compatible endpoints (Ollama, vLLM, etc.) do not support.
    const baseModel = piAi.getModel('openai', 'gpt-4.1');
    const piModel = {
      ...(baseModel as Record<string, unknown>),
      id: config.modelId,
      name: config.modelId,
      api: 'openai-completions',
      baseUrl: config.baseUrl,
      provider: 'custom',
      contextWindow: config.contextWindow ?? 128_000,
      // Conservative compat for OpenAI-compatible endpoints: disable
      // features that are OpenAI-specific or may not be supported.
      // Consumer-provided compat overrides are merged on top.
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsStrictMode: false,
        maxTokensField: 'max_tokens' as const,
        ...config.compat,
      },
    };
    // Set API key, using a placeholder for keyless endpoints (e.g., Ollama).
    // The OpenAI SDK client requires a non-empty apiKey value.
    (piModel as Record<string, unknown>)['apiKey'] = config.apiKey ?? 'sk-no-key-required';
    return wrapModel(
      piModel,
      'custom',
      config.modelId,
      config.contextWindow ?? 128_000,
    );
  }

  /** Resolve the selected local model's capabilities and actual runtime allocation. */
  async createOllamaModel(config: OllamaModelConfig): Promise<CortexModel> {
    const { createOllamaModel } = await import('./providers/ollama/model.js');
    return createOllamaModel(config);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Get the cheapest likely utility model ID for a provider.
   */
  private getSmallestModelId(provider: string, models: Array<Record<string, unknown>>): string | null {
    return UTILITY_MODEL_OVERRIDES[provider] ?? inferUtilityModelId(models);
  }

  /**
   * Attempt to validate an API key by making a minimal LLM call.
   */
  private async tryValidation(
    piAi: PiAiModule,
    provider: string,
    modelId: string,
    apiKey: string,
  ): Promise<ApiKeyValidationResult> {
    try {
      const model = piAi.getModel(provider, modelId);

      // Try completeSimple first, then complete
      const completeFn = piAi.completeSimple ?? piAi.complete;

      if (typeof completeFn !== 'function') {
        // Cannot validate without a complete function; assume valid
        // (the consumer will discover failures at first real call)
        return {
          provider,
          modelId,
          valid: true,
          retryable: false,
          status: 'valid',
        };
      }

      const result = await completeFn(
        model,
        { messages: [{ role: 'user', content: 'hi' }] },
        { apiKey, maxTokens: 1 },
      );
      const silentError = this.extractSilentValidationError(result);
      if (silentError) {
        throw new Error(silentError);
      }
      return {
        provider,
        modelId,
        valid: true,
        retryable: false,
        status: 'valid',
      };
    } catch (err) {
      return this.classifyValidationError(provider, modelId, err);
    }
  }

  private classifyValidationError(
    provider: string,
    modelId: string,
    err: unknown,
  ): ApiKeyValidationResult {
    const message = err instanceof Error ? err.message : String(err);
    const normalized = message.toLowerCase();

    if (
      /\b401\b/.test(normalized) ||
      /\b403\b/.test(normalized) ||
      normalized.includes('invalid api key') ||
      normalized.includes('incorrect api key') ||
      normalized.includes('authentication failed') ||
      normalized.includes('invalid_auth') ||
      normalized.includes('unauthorized') ||
      normalized.includes('forbidden') ||
      normalized.includes('invalid credential')
    ) {
      return {
        provider,
        modelId,
        valid: false,
        retryable: false,
        status: 'invalid_credentials',
        message,
      };
    }

    if (
      /\b429\b/.test(normalized) ||
      /\b500\b/.test(normalized) ||
      /\b502\b/.test(normalized) ||
      /\b503\b/.test(normalized) ||
      /\b504\b/.test(normalized) ||
      normalized.includes('rate limit') ||
      normalized.includes('timeout') ||
      normalized.includes('timed out') ||
      normalized.includes('temporar') ||
      normalized.includes('overloaded') ||
      normalized.includes('unavailable') ||
      normalized.includes('server error') ||
      normalized.includes('network') ||
      normalized.includes('econn') ||
      normalized.includes('enotfound') ||
      normalized.includes('eai_again')
    ) {
      return {
        provider,
        modelId,
        valid: false,
        retryable: true,
        status: 'transient_error',
        message,
      };
    }

    return {
      provider,
      modelId,
      valid: false,
      retryable: false,
      status: 'resolution_error',
      message,
    };
  }

  private extractSilentValidationError(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null;
    const msg = result as Record<string, unknown>;
    if (msg['stopReason'] !== 'error') return null;
    const errorMessage = msg['errorMessage'];
    return typeof errorMessage === 'string'
      ? errorMessage
      : 'Provider validation failed';
  }
}
