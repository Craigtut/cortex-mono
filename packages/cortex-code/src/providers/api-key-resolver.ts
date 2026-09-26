/**
 * Answers the agent's `getApiKey(provider)` callback for an interactive
 * session: which stored credential serves a provider id, and a single-flight
 * OAuth refresh so a rotating refresh token is consumed exactly once.
 */

import type { ProviderManager } from '@animus-labs/cortex';
import type { CredentialEntry, CredentialStore } from '../config/credentials.js';
import { singleFlight } from '../utils/single-flight.js';
import { resolveStoredOAuthApiKey } from '../utils/oauth-credentials.js';
import { log } from '../logger.js';

export class ApiKeyResolver {
  /**
   * In-flight OAuth resolve/refresh promises, keyed by provider. Providers like
   * Anthropic rotate the refresh token on every use and invalidate the prior
   * one, so two concurrent refreshes with the same stored token make one win
   * and the rest fail with invalid_grant ("Failed to refresh OAuth token").
   * Deduping concurrent callers onto one read-refresh-persist rotates the token
   * exactly once and hands everyone the same fresh key.
   */
  private readonly oauthResolveInFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly credentialStore: CredentialStore,
    private readonly providerManager: ProviderManager,
    /** The provider the session is currently on; changes with /model. */
    private readonly getSessionProvider: () => string,
  ) {}

  /** Credential resolution: stored API key or OAuth refresh. */
  async getApiKey(provider: string): Promise<string> {
    // Pi-agent-core passes the model's provider field. For anything built by
    // createCustomModel that is the synthetic id "custom", whose credential is
    // filed under the connection name instead (e.g. "ollama"), so a "custom"
    // request falls back to the session's provider name.
    //
    // Only "custom" does. Every other id names a real provider, and a real
    // provider's credential is filed under its own name or not stored at all:
    // borrowing a different provider's would send its token to an endpoint it
    // was not issued for. That is reachable, because a loop can outlive a
    // provider switch (a duplex talker still on the startup provider's model
    // after /model moved the session), and the honest answer there is that
    // this model has no credential.
    //
    // A borrowed entry is therefore never an OAuth one, which is what keeps
    // the OAuth branch below resolving under an id pi-ai actually knows.
    let entry = await this.credentialStore.getProvider(provider);
    if (!entry && provider === 'custom' && provider !== this.getSessionProvider()) {
      const sessionEntry = await this.credentialStore.getProvider(this.getSessionProvider());
      if (sessionEntry?.method === 'oauth') {
        log.warn('Not lending OAuth credentials to a custom-endpoint model', {
          sessionProvider: this.getSessionProvider(),
        });
      } else {
        entry = sessionEntry;
      }
    }
    if (!entry) {
      // Keyless providers (e.g., Ollama) may not have a credential store
      // entry at all. Return a placeholder so the OpenAI SDK doesn't throw.
      if (provider === 'custom' || provider === 'ollama') {
        return 'sk-no-key-required';
      }
      throw new Error(`No credentials for provider "${provider}". Run /login to connect.`);
    }

    // API key: return directly
    if (entry.method === 'api_key' && entry.apiKey) {
      return entry.apiKey;
    }

    // OAuth: resolve via ProviderManager (handles token refresh). Single-flight
    // per provider so a burst of concurrent requests (main model + utility
    // model + subagents at session start) triggers exactly one refresh; see
    // oauthResolveInFlight for why a rotating refresh token makes a race fatal.
    if (entry.method === 'oauth' && entry.oauthCredentials) {
      return this.resolveOAuthApiKey(provider, entry);
    }

    // Custom: return stored API key, or a placeholder for keyless endpoints
    // (e.g., Ollama). The OpenAI SDK client requires a non-empty API key.
    if (entry.method === 'custom') {
      return entry.apiKey || 'sk-no-key-required';
    }

    throw new Error(`Unable to resolve API key for provider "${provider}"`);
  }

  /**
   * Resolve (and refresh if expired) an OAuth API key, deduping concurrent
   * callers per provider. The single-flight spans the whole read-refresh-persist
   * cycle so a rotating refresh token is consumed exactly once; a second caller
   * only starts a fresh resolve after the first has persisted the new token, so
   * it reads the rotated credential rather than replaying the spent one.
   */
  private resolveOAuthApiKey(provider: string, entry: CredentialEntry): Promise<string> {
    return singleFlight(this.oauthResolveInFlight, provider, () =>
      resolveStoredOAuthApiKey(this.providerManager, this.credentialStore, provider, entry),
    );
  }
}
