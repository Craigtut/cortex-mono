/**
 * OAuth flows: login (the race between pi's login, cancellation, the
 * timeout, and a failed browser callback, plus the adapter from pi's
 * interaction object to Cortex's callbacks), cancellation, and API key
 * resolution with refresh. One flow is active at a time per instance.
 */

import { OAUTH_PROVIDER_IDS, PROVIDER_REGISTRY } from '../provider-registry.js';
import { loadOAuthCapableProviderIds, loadPiOAuth } from './pi-ai.js';
import type { PiAuthEvent, PiAuthInteraction, PiAuthPrompt, PiOAuthCredential } from './pi-ai.js';
import { OAuthError } from './oauth-types.js';
import type {
  OAuthAuthInfo,
  OAuthCallbackPageContext,
  OAuthCallbackPageStatus,
  OAuthCallbacks,
  OAuthFlowType,
  OAuthMeta,
  OAuthPromptInfo,
  OAuthRefreshResult,
  OAuthResult,
} from './oauth-types.js';
import { assertOAuthCallbackPortAvailable, maybeInstallOAuthCallbackShim } from './oauth-callback-page.js';
import type { OAuthCallbackRoute } from './oauth-callback-page.js';

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

export interface OAuthFlowsOptions {
  /** Fixed loopback callback routes (provider to path/port). */
  routes: Record<string, OAuthCallbackRoute>;
  /** Loopback port-in-use probe run before a browser opens. */
  probe: (port: number, host: string) => Promise<boolean>;
}

export class OAuthFlows {
  /** Active OAuth AbortController, if any. */
  private activeOAuthAbort: AbortController | null = null;

  private readonly oauthCallbackRoutes: Record<string, OAuthCallbackRoute>;

  private readonly probeOAuthCallbackPort: (port: number, host: string) => Promise<boolean>;

  constructor(options: OAuthFlowsOptions) {
    this.oauthCallbackRoutes = options.routes;
    this.probeOAuthCallbackPort = options.probe;
  }

  /** Run one login flow to completion, cancellation, timeout, or callback failure. */
  async initiate(provider: string, callbacks: OAuthCallbacks): Promise<OAuthResult> {
    const oauthProvider = await loadPiOAuth(provider);
    if (!oauthProvider) {
      throw new OAuthError(
        'unsupported_provider',
        provider,
        `Provider "${provider}" does not support OAuth`,
      );
    }

    // Fail fast, before opening a browser, if the provider's fixed
    // callback port is already taken. Otherwise pi-ai binds the other
    // stack, the browser hits the wrong listener, and pi-ai waits forever.
    await assertOAuthCallbackPortAvailable(
      provider,
      this.oauthCallbackRoutes,
      this.probeOAuthCallbackPort,
    );

    const abort = new AbortController();
    this.activeOAuthAbort = abort;

    // pi-ai only settles its callback wait on success; on a failed
    // callback (e.g. state mismatch) it hangs. The render shim already sees
    // that response, so use it to fail the flow immediately with the reason.
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

    // pi-ai callback servers ignore the abort signal, so cancellation
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

    // pi's login takes one interaction object: every out-bound message is
    // notify(AuthEvent) and every in-bound answer is prompt(AuthPrompt).
    // Adapt it to Cortex's consumer-facing OAuthCallbacks.
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
            // through rather than re-deriving it from a prose instruction.
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

  /** Cancel the in-progress flow, if any. */
  cancel(): void {
    if (this.activeOAuthAbort) {
      this.activeOAuthAbort.abort();
      this.activeOAuthAbort = null;
    }
  }

  /** Derive an API key from stored credentials, refreshing them first when near expiry. */
  async resolveApiKey(provider: string, credentials: string): Promise<OAuthRefreshResult> {
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

    // pi splits key derivation into refresh (network, may rotate the token)
    // and toAuth (pure derivation).
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

  /** OAuth-capable provider ids from the installed pi, limited to providers Cortex models. */
  async listCapableProviders(): Promise<string[]> {
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
}
