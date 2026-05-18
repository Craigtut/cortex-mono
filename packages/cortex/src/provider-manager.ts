/**
 * ProviderManager: standalone class wrapping pi-ai for provider discovery,
 * OAuth login/refresh, API key validation, model resolution, and custom
 * endpoint creation.
 *
 * ProviderManager and CortexAgent are fully independent. Neither knows
 * about the other. The consumer creates both, uses ProviderManager for
 * auth/discovery, and provides a getApiKey callback to CortexAgent.
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
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ThinkingLevel } from './types.js';
import type { ProviderInfo, ModelInfo } from './provider-registry.js';
import { wrapModel } from './model-wrapper.js';
import { inferUtilityModelId } from './utility-model-inference.js';
import type { CortexModel } from './model-wrapper.js';

const nodeRequire = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// OAuth types
// ---------------------------------------------------------------------------

/** OAuth flow shape, used by consumers to render provider-specific UX. */
export type OAuthFlowType = 'browser' | 'localhost_callback' | 'device_code';

/** URL and flow metadata emitted when a user needs to authorize a provider. */
export interface OAuthAuthInfo {
  /** URL the user should open to authorize the provider. */
  url: string;
  /** Provider-supplied instructions, when available. */
  instructions?: string | undefined;
  /** Normalized flow type. */
  flowType: OAuthFlowType;
  /** Device code extracted from provider instructions, when available. */
  deviceCode?: string | undefined;
  /** Whether a remote/headless environment should show a manual paste input. */
  manualCodeRecommended?: boolean | undefined;
  /** Fixed localhost callback port, for callback-server flows. */
  callbackPort?: number | undefined;
  /** Fixed callback path, for callback-server flows. */
  callbackPath?: string | undefined;
}

/** Prompt emitted when a provider needs user input during OAuth. */
export interface OAuthPromptInfo {
  /** User-facing prompt text. */
  message: string;
  /** Optional input placeholder. */
  placeholder?: string | undefined;
  /** Whether an empty response is valid. */
  allowEmpty?: boolean | undefined;
}

/** Callbacks provided by the consumer during an OAuth flow. */
export interface OAuthCallbacks {
  /**
   * Called when the user needs to visit a URL to authorize.
   * The consumer should open the URL in a browser or display it.
   */
  onAuth: (info: OAuthAuthInfo) => void;

  /**
   * Called when the OAuth flow needs user input (e.g., a prompt).
   * The consumer should display the prompt and return the user's response.
   */
  onPrompt: (prompt: OAuthPromptInfo) => Promise<string>;

  /**
   * Called with progress messages during the flow.
   */
  onProgress?: (message: string) => void;

  /**
   * Called when a callback-server OAuth flow needs the user to paste a
   * manual authorization code.
   */
  onManualCodeInput?: () => Promise<string>;

  /**
   * Called when the OAuth flow needs the user to choose from provider-specific
   * options, such as a Copilot organization or endpoint.
   */
  onSelect?: (prompt: {
    message: string;
    options: Array<{ id: string; label: string }>;
  }) => Promise<string | undefined>;

  /**
   * Optional renderer for provider OAuth callback pages shown in the browser.
   *
   * Pi-ai does not expose a native callback page hook, so Cortex implements
   * this as a narrow Node.js compatibility shim. It only runs for known pi-ai
   * localhost callback routes and is restored immediately after the login flow.
   */
  renderCallbackPage?: OAuthCallbackPageRenderer | undefined;

  /**
   * Overall timeout for the OAuth flow, in milliseconds. pi-ai's
   * callback-server flows (e.g. Anthropic) do not honor an abort signal and
   * hang forever if the callback never arrives or arrives with an error, so
   * Cortex enforces this timeout itself and rejects with an
   * `OAuthError('timed_out')`. Defaults to 5 minutes. Pass `0` or a negative
   * value to disable (not recommended).
   */
  timeoutMs?: number | undefined;
}

/** Status of the browser callback page produced by an OAuth flow. */
export type OAuthCallbackPageStatus = 'success' | 'error';

/** Context passed to a custom OAuth callback page renderer. */
export interface OAuthCallbackPageContext {
  /** Provider identifier, e.g. "anthropic" or "openai-codex". */
  provider: string;
  /** Human-readable provider name when available. */
  providerName: string;
  /** Whether the callback response represents success or failure. */
  status: OAuthCallbackPageStatus;
  /** Page title extracted from pi-ai's default page. */
  title: string;
  /** Page heading extracted from pi-ai's default page. */
  heading: string;
  /** User-facing message extracted from pi-ai's default page. */
  message: string;
  /** Error details extracted from pi-ai's default page, if present. */
  details?: string | undefined;
  /** Callback path matched by the shim, without query parameters. */
  callbackPath: string;
  /** Local callback port matched by the shim. */
  callbackPort: number;
  /** Pi-ai's original generated page. */
  defaultHtml: string;
}

/**
 * Render custom HTML for the browser page shown after an OAuth callback.
 *
 * The renderer must be synchronous because Node's response end hook is
 * synchronous. If it throws or returns an empty string, Cortex falls back to
 * pi-ai's default page.
 */
export type OAuthCallbackPageRenderer = (context: OAuthCallbackPageContext) => string;

/** Display-safe metadata extracted at login time. */
export interface OAuthMeta {
  /** Provider identifier. */
  provider: string;
  /** Display name, email, or account identifier (if available). */
  displayName?: string | undefined;
  /** When the access token expires (Unix timestamp ms). Undefined if non-expiring. */
  expiresAt?: number | undefined;
  /** Whether the credential supports automatic refresh. */
  refreshable: boolean;
}

/** Result of a successful OAuth login. */
export interface OAuthResult {
  /**
   * Serialized credential payload. The consumer stores this (encrypted)
   * and passes it back to resolveOAuthApiKey() for refresh.
   * Treat as an opaque blob: encrypt, store, decrypt, pass back. Never parse.
   */
  credentials: string;
  /** Display-safe metadata extracted at login time. */
  meta: OAuthMeta;
}

/** Result of resolving/refreshing an OAuth API key. */
export interface OAuthRefreshResult {
  /** The API key to use for LLM calls. */
  apiKey: string;
  /**
   * Credential payload (may be updated if refresh occurred).
   * Same format as OAuthResult.credentials.
   */
  credentials: string;
  /** Updated metadata. */
  meta: OAuthMeta;
  /** Whether the credentials were actually refreshed (true) or reused as-is (false). */
  changed: boolean;
}

/**
 * Discriminant for OAuth flow failures, so consumers can render specific
 * UX instead of parsing error strings.
 *
 * - `unsupported_provider`: provider has no OAuth support.
 * - `callback_port_in_use`: the provider's fixed loopback callback port is
 *   already bound (e.g. another Anthropic app on 53692, or a leftover flow).
 *   Detected before the browser opens.
 * - `cancelled`: the flow was cancelled via `cancelOAuth()`.
 * - `timed_out`: the flow exceeded its timeout (pi-ai's callback servers do
 *   not honor an abort signal, so this is the backstop against hangs).
 * - `callback_failed`: the browser callback fired but the provider reported
 *   an error (e.g. state mismatch). Surfaced immediately instead of hanging.
 */
export type OAuthErrorCode =
  | 'unsupported_provider'
  | 'callback_port_in_use'
  | 'cancelled'
  | 'timed_out'
  | 'callback_failed';

/** Structured error thrown by initiateOAuth. */
export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  readonly provider: string;
  /** The fixed callback port, when relevant (`callback_port_in_use`). */
  readonly port?: number | undefined;

  constructor(
    code: OAuthErrorCode,
    provider: string,
    message: string,
    options?: { port?: number | undefined; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'OAuthError';
    this.code = code;
    this.provider = provider;
    this.port = options?.port;
  }
}

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
}

// ---------------------------------------------------------------------------
// Pi-ai dynamic import types
// ---------------------------------------------------------------------------

/** Shape of the pi-ai main module functions we use. */
interface PiAiModule {
  getModel: (provider: string, modelId: string) => unknown;
  getModels: (provider: string) => Array<Record<string, unknown>>;
  getEnvApiKey: (provider: string) => string | undefined;
  getSupportedThinkingLevels?: ((model: unknown) => string[]) | undefined;
  completeSimple?: ((model: unknown, context: unknown, options?: unknown) => Promise<unknown>) | undefined;
  complete?: ((model: unknown, context: unknown, options?: unknown) => Promise<unknown>) | undefined;
}

interface PiOAuthProvider {
  id: string;
  name: string;
  login: (callbacks: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

interface PiAiOAuthModule {
  getOAuthProvider?: ((id: string) => PiOAuthProvider | undefined) | undefined;
  getOAuthProviders?: (() => PiOAuthProvider[]) | undefined;
  getOAuthApiKey?: ((
    provider: string,
    credentials: Record<string, unknown>,
  ) => Promise<{ apiKey: string; newCredentials: Record<string, unknown> } | null>) | undefined;
}

// ---------------------------------------------------------------------------
// OAuth callback page rendering shim
// ---------------------------------------------------------------------------

interface OAuthCallbackRoute {
  readonly path: string;
  readonly port: number;
}

interface ActiveOAuthCallbackPageShim {
  readonly provider: string;
  readonly providerName: string;
  readonly route: OAuthCallbackRoute;
  readonly render: OAuthCallbackPageRenderer | undefined;
  /**
   * Notified exactly once when the browser callback fires and its status
   * (success/error) is known. Lets the flow react immediately instead of
   * waiting on pi-ai (which hangs on non-success callbacks).
   */
  readonly onResult?: ((status: OAuthCallbackPageStatus, context: OAuthCallbackPageContext) => void) | undefined;
}

type ServerResponseEnd = ServerResponse['end'];

const OAUTH_CALLBACK_ROUTES: Record<string, OAuthCallbackRoute> = {
  anthropic: { path: '/callback', port: 53692 },
  'openai-codex': { path: '/auth/callback', port: 1455 },
};

const DEVICE_CODE_INSTRUCTIONS_RE = /\benter\s+code:\s*([A-Z0-9-]+)/i;

let activeOAuthCallbackPageShim: ActiveOAuthCallbackPageShim | null = null;
/** Ensures `onResult` fires at most once per installed shim. */
let oauthCallbackResultNotified = false;

/** Default overall OAuth flow timeout (pi-ai hangs without this). */
const DEFAULT_OAUTH_FLOW_TIMEOUT_MS = 5 * 60_000;

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
  legacyInstructions?: string,
): OAuthAuthInfo {
  const raw = typeof info === 'string'
    ? { url: info, instructions: legacyInstructions }
    : (info as Record<string, unknown> | null | undefined);

  const url = typeof raw?.['url'] === 'string' ? raw['url'] : String(info ?? '');
  const instructions = typeof raw?.['instructions'] === 'string'
    ? raw['instructions']
    : legacyInstructions;
  const callbackRoute = OAUTH_CALLBACK_ROUTES[provider];
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

/**
 * Probe whether something is already listening on a loopback port. Used to
 * fail an OAuth flow fast (before opening a browser) when the provider's
 * fixed callback port is occupied — otherwise pi-ai binds the other stack /
 * the browser hits the wrong listener and the user gets a dead page while
 * pi-ai waits forever.
 */
function probeCallbackPortInUse(port: number, host: string): Promise<boolean> {
  const net = nodeRequire('node:net') as typeof import('node:net');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    const socket = net.connect({ port, host });
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(600, () => finish(false));
  });
}

/**
 * Throw an `OAuthError('callback_port_in_use')` if the provider's fixed
 * callback port is occupied on either IPv4 or IPv6 loopback. No-op for
 * providers without a known callback route (manual/device-code flows).
 */
async function assertOAuthCallbackPortAvailable(provider: string): Promise<void> {
  const route = OAUTH_CALLBACK_ROUTES[provider];
  if (!route) return;

  for (const host of ['127.0.0.1', '::1']) {
    if (await probeCallbackPortInUse(route.port, host)) {
      throw new OAuthError(
        'callback_port_in_use',
        provider,
        `OAuth callback port ${route.port} for "${provider}" is already in use ` +
        `(detected on ${host}). This is a fixed port: another application is ` +
        `holding it, or a previous sign-in did not finish. Close that ` +
        `application (or restart the host process), then try again.`,
        { port: route.port },
      );
    }
  }
}

/**
 * Install the callback-page shim for a flow when there is a known callback
 * route AND something to do with it (a custom renderer and/or a result
 * observer). Returns a release function (a no-op when no shim was installed).
 *
 * Unlike a `try/finally` wrapper around pi-ai's `login()`, the caller owns
 * the release lifecycle: pi-ai's callback-server flows hang forever on a
 * non-success callback, so cleanup must be tied to the flow's own
 * race/timeout, not to awaiting the (possibly never-settling) login promise.
 */
function maybeInstallOAuthCallbackShim(
  provider: string,
  providerName: string,
  render: OAuthCallbackPageRenderer | undefined,
  onResult: ActiveOAuthCallbackPageShim['onResult'],
): () => void {
  const route = OAUTH_CALLBACK_ROUTES[provider];
  if (!route || (!render && !onResult)) {
    return () => {};
  }

  return installOAuthCallbackPageShim({
    provider,
    providerName,
    route,
    render,
    onResult,
  });
}

function installOAuthCallbackPageShim(shim: ActiveOAuthCallbackPageShim): () => void {
  if (activeOAuthCallbackPageShim) {
    throw new Error(
      `An OAuth callback page renderer is already active for provider "${activeOAuthCallbackPageShim.provider}".`,
    );
  }

  const http = nodeRequire('node:http') as typeof import('node:http');
  const prototype = http.ServerResponse.prototype;
  const previousEnd = prototype.end;
  activeOAuthCallbackPageShim = shim;
  oauthCallbackResultNotified = false;

  const patchedEnd = function patchedOAuthCallbackEnd(this: ServerResponse, ...args: unknown[]) {
    const replacement = maybeRenderOAuthCallbackPage(this, args[0]);
    if (replacement) {
      args[0] = replacement;
    }

    return Reflect.apply(previousEnd, this, args) as ReturnType<ServerResponseEnd>;
  } as ServerResponseEnd;

  prototype.end = patchedEnd;

  return () => {
    if (activeOAuthCallbackPageShim === shim) {
      activeOAuthCallbackPageShim = null;
    }

    if (prototype.end === patchedEnd) {
      prototype.end = previousEnd;
    }
  };
}

function maybeRenderOAuthCallbackPage(response: ServerResponse, chunk: unknown): string | null {
  const shim = activeOAuthCallbackPageShim;
  if (!shim) return null;

  const request = (response as ServerResponse & { req?: IncomingMessage | undefined }).req;
  if (!request || request.method !== 'GET' || !request.url) return null;

  const localPort = response.socket?.localPort;
  if (localPort !== shim.route.port) return null;

  let url: URL;
  try {
    url = new URL(request.url, `http://localhost:${shim.route.port}`);
  } catch {
    return null;
  }

  if (url.pathname !== shim.route.path) return null;
  if (!isExpectedLocalCallbackHost(request.headers.host, shim.route.port)) return null;

  const contentType = response.getHeader('content-type');
  if (typeof contentType === 'string' && !contentType.toLowerCase().includes('text/html')) {
    return null;
  }

  const defaultHtml = responseChunkToString(chunk);
  if (!defaultHtml || !looksLikePiOAuthPage(defaultHtml)) return null;

  const status = extractOAuthCallbackPageStatus(defaultHtml);
  if (!status) return null;

  const details = extractHtmlClassText(defaultHtml, 'details');
  const context: OAuthCallbackPageContext = {
    provider: shim.provider,
    providerName: shim.providerName,
    status,
    title: extractHtmlTagText(defaultHtml, 'title') ?? defaultOAuthCallbackTitle(status),
    heading: extractHtmlTagText(defaultHtml, 'h1') ?? defaultOAuthCallbackTitle(status),
    message: extractHtmlTagText(defaultHtml, 'p') ?? defaultOAuthCallbackMessage(status),
    callbackPath: shim.route.path,
    callbackPort: shim.route.port,
    defaultHtml,
  };
  if (details !== undefined) {
    context.details = details;
  }

  // Notify the flow that the browser callback fired (once). This lets
  // initiateOAuth react to a failed callback immediately rather than
  // waiting on pi-ai, which hangs on non-success callbacks.
  if (!oauthCallbackResultNotified && shim.onResult) {
    oauthCallbackResultNotified = true;
    try {
      shim.onResult(status, context);
    } catch {
      // An observer must never break the callback response.
    }
  }

  if (!shim.render) return null;
  try {
    const rendered = shim.render(context);
    return typeof rendered === 'string' && rendered.trim().length > 0 ? rendered : null;
  } catch {
    return null;
  }
}

function isExpectedLocalCallbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false;

  try {
    const url = new URL(`http://${host}`);
    const hostname = url.hostname.toLowerCase();
    const parsedPort = url.port ? Number(url.port) : 80;
    return (
      parsedPort === port
      && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

function responseChunkToString(chunk: unknown): string | null {
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  return null;
}

function looksLikePiOAuthPage(html: string): boolean {
  return (
    html.includes('<title>Authentication successful</title>')
    || html.includes('<title>Authentication failed</title>')
  );
}

function extractOAuthCallbackPageStatus(html: string): OAuthCallbackPageStatus | null {
  if (html.includes('<title>Authentication successful</title>')) return 'success';
  if (html.includes('<title>Authentication failed</title>')) return 'error';
  return null;
}

function defaultOAuthCallbackTitle(status: OAuthCallbackPageStatus): string {
  return status === 'success' ? 'Authentication successful' : 'Authentication failed';
}

function defaultOAuthCallbackMessage(status: OAuthCallbackPageStatus): string {
  return status === 'success' ? 'Authentication completed.' : 'Authentication failed.';
}

function extractHtmlTagText(html: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = html.match(pattern);
  return match?.[1] ? decodeHtmlText(match[1]) : undefined;
}

function extractHtmlClassText(html: string, className: string): string | undefined {
  const pattern = new RegExp(`<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i');
  const match = html.match(pattern);
  return match?.[1] ? decodeHtmlText(match[1]) : undefined;
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .trim();
}

// ---------------------------------------------------------------------------
// Pi-ai dynamic import helpers
// ---------------------------------------------------------------------------

/**
 * Lazily load the pi-ai main module.
 * Throws a clear error if pi-ai is not installed.
 */
async function loadPiAi(): Promise<PiAiModule> {
  try {
    // Dynamic import with string literal to avoid bundler resolution
    const modulePath = '@earendil-works/pi-ai';
    return await import(/* @vite-ignore */ modulePath) as PiAiModule;
  } catch {
    throw new Error(
      'pi-ai is not installed. Install @earendil-works/pi-ai to use ProviderManager.'
    );
  }
}

/**
 * Lazily load the pi-ai OAuth module.
 * Throws a clear error if pi-ai is not installed.
 */
async function loadPiAiOAuth(): Promise<PiAiOAuthModule> {
  try {
    const modulePath = '@earendil-works/pi-ai/oauth';
    return await import(/* @vite-ignore */ modulePath) as PiAiOAuthModule;
  } catch {
    throw new Error(
      'pi-ai is not installed. Install @earendil-works/pi-ai to use OAuth features.'
    );
  }
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

const CORTEX_THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'max',
];

function mapPiThinkingLevel(level: string): ThinkingLevel | null {
  const mapped = level === 'xhigh' ? 'max' : level;
  return (CORTEX_THINKING_LEVELS as readonly string[]).includes(mapped)
    ? mapped as ThinkingLevel
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

export class ProviderManager implements IProviderManager {
  /** Active OAuth AbortController, if any. */
  private activeOAuthAbort: AbortController | null = null;

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
    const oauthModule = await loadPiAiOAuth();
    const oauthProvider = oauthModule.getOAuthProvider?.(provider);
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
    await assertOAuthCallbackPortAvailable(provider);

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

    const login = oauthProvider.login({
      onAuth: (info: unknown, legacyInstructions?: string) => {
        callbacks.onAuth(normalizeOAuthAuthInfo(provider, info, legacyInstructions));
      },
      onPrompt: (prompt: unknown) => callbacks.onPrompt(normalizeOAuthPromptInfo(prompt)),
      onProgress: callbacks.onProgress,
      onManualCodeInput: callbacks.onManualCodeInput,
      onSelect: callbacks.onSelect,
      signal: abort.signal,
    }) as Promise<Record<string, unknown>>;
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
    const oauthModule = await loadPiAiOAuth();
    const getOAuthApiKeyFn = oauthModule.getOAuthApiKey;
    if (typeof getOAuthApiKeyFn !== 'function') {
      throw new Error('getOAuthApiKey not found in pi-ai/oauth');
    }

    const rawCredentials = JSON.parse(credentials) as Record<string, unknown>;
    // Security: spread rawCredentials first so Cortex-owned 'type' cannot be overridden
    const credMap = { [provider]: { ...rawCredentials, type: 'oauth' as const } };

    const result = await getOAuthApiKeyFn(provider, credMap);

    if (!result) {
      throw new Error(`OAuth resolution failed for provider "${provider}"`);
    }

    const originalSerialized = credentials;
    const newSerialized = JSON.stringify(result.newCredentials);
    const changed = newSerialized !== originalSerialized;
    const meta = buildOAuthMeta(provider, result.newCredentials);

    return {
      apiKey: result.apiKey,
      credentials: changed ? newSerialized : credentials,
      meta,
      changed,
    };
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
   * @param provider - The provider identifier
   * @param modelId - The model identifier
   * @returns A CortexModel handle
   * @throws Error if pi-ai is not installed or the model is not found
   */
  async resolveModel(provider: string, modelId: string): Promise<CortexModel> {
    const piAi = await loadPiAi();
    const piModel = piAi.getModel(provider, modelId);
    let contextWindow: number | undefined;
    if (piModel && typeof piModel === 'object') {
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
