import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ProviderManager, OAuthError } from '../../src/provider-manager.js';
import { PROVIDER_REGISTRY, OAUTH_PROVIDER_IDS } from '../../src/provider-registry.js';
import { isCortexModel, unwrapModel } from '../../src/model-wrapper.js';

// ---------------------------------------------------------------------------
// Mock pi-ai module
// ---------------------------------------------------------------------------

const mockGetModel = vi.fn();
const mockCreateModel = vi.fn();
const mockGetModels = vi.fn();
const mockGetEnvApiKey = vi.fn();
const mockGetSupportedThinkingLevels = vi.fn();
const mockCompleteSimple = vi.fn();

vi.mock('@earendil-works/pi-ai', () => ({
  getModel: (...args: unknown[]) => mockGetModel(...args),
  createModel: (...args: unknown[]) => mockCreateModel(...args),
  getModels: (...args: unknown[]) => mockGetModels(...args),
  getEnvApiKey: (...args: unknown[]) => mockGetEnvApiKey(...args),
  getSupportedThinkingLevels: (...args: unknown[]) => mockGetSupportedThinkingLevels(...args),
  completeSimple: (...args: unknown[]) => mockCompleteSimple(...args),
}));

// Mock pi-ai/oauth module
const mockLoginAnthropic = vi.fn();
const mockLoginCodex = vi.fn();
const mockGetOAuthApiKey = vi.fn();
const mockGetOAuthProvider = vi.fn((provider: string) => {
  if (provider === 'anthropic') {
    return { id: provider, name: 'Anthropic', login: mockLoginAnthropic };
  }
  if (provider === 'openai-codex') {
    return { id: provider, name: 'OpenAI Codex', login: mockLoginCodex };
  }
  if (provider === 'github-copilot') {
    return { id: provider, name: 'GitHub Copilot', login: vi.fn() };
  }
  return undefined;
});

vi.mock('@earendil-works/pi-ai/oauth', () => ({
  getOAuthProvider: (...args: unknown[]) => mockGetOAuthProvider(...args),
  getOAuthProviders: () => [
    { id: 'anthropic', name: 'Anthropic', login: mockLoginAnthropic },
    { id: 'openai-codex', name: 'OpenAI Codex', login: mockLoginCodex },
    { id: 'github-copilot', name: 'GitHub Copilot', login: vi.fn() },
  ],
  getOAuthApiKey: (...args: unknown[]) => mockGetOAuthApiKey(...args),
}));

const PI_OAUTH_SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Authentication successful</title>
</head>
<body>
  <main>
    <h1>Authentication successful</h1>
    <p>Anthropic authentication completed. You can close this window.</p>
  </main>
</body>
</html>`;

const PI_OAUTH_FAILURE_HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Authentication failed</title>
</head>
<body>
  <main>
    <h1>Authentication failed</h1>
    <p>State mismatch.</p>
    <div class="details">expected state did not match</div>
  </main>
</body>
</html>`;

/** Bind a TCP listener on a fixed loopback port for preflight tests. */
async function occupyPort(port: number): Promise<() => Promise<void>> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

async function requestLocalOAuthPage(options: {
  path?: string;
  port?: number;
  html?: string;
  contentType?: string;
} = {}): Promise<string> {
  const { createServer } = await import('node:http');
  const path = options.path ?? '/callback';
  const port = options.port ?? 53692;
  const html = options.html ?? PI_OAUTH_SUCCESS_HTML;
  const contentType = options.contentType ?? 'text/html; charset=utf-8';
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(html);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return await response.text();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProviderManager', () => {
  let pm: ProviderManager;

  beforeEach(() => {
    pm = new ProviderManager();
    vi.clearAllMocks();
    mockGetSupportedThinkingLevels.mockReturnValue([]);
    mockGetModels.mockReturnValue([
      {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        input: ['text'],
        cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
        contextWindow: 200_000,
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------

  describe('listProviders', () => {
    it('returns the full PROVIDER_REGISTRY', () => {
      const providers = pm.listProviders();
      expect(providers).toBe(PROVIDER_REGISTRY);
      expect(providers.length).toBeGreaterThan(0);
    });

    it('includes anthropic and openai', () => {
      const providers = pm.listProviders();
      const ids = providers.map(p => p.id);
      expect(ids).toContain('anthropic');
      expect(ids).toContain('openai');
    });
  });

  describe('listOAuthProviders', () => {
    it('returns OAUTH_PROVIDER_IDS', () => {
      const oauthProviders = pm.listOAuthProviders();
      expect(oauthProviders).toBe(OAUTH_PROVIDER_IDS);
    });

    it('includes anthropic but not openai', () => {
      const oauthProviders = pm.listOAuthProviders();
      expect(oauthProviders).toContain('anthropic');
      expect(oauthProviders).not.toContain('openai');
    });
  });

  describe('listModels', () => {
    it('delegates to pi-ai getModels and maps to ModelInfo', async () => {
      mockGetModels.mockReturnValue([
        {
          name: 'claude-sonnet-4-20250514',
          displayName: 'Claude Sonnet 4',
          contextWindow: 200000,
          supportsThinking: true,
          supportsImages: true,
          pricing: { input: 3.0, output: 15.0 },
        },
        {
          name: 'claude-haiku-4-5-20250609',
          displayName: 'Claude Haiku 4.5',
          contextWindow: 200000,
          supportsThinking: false,
          supportsImages: true,
        },
      ]);

      const models = await pm.listModels('anthropic');

      expect(mockGetModels).toHaveBeenCalledWith('anthropic');
      expect(models).toHaveLength(2);

      expect(models[0]!.id).toBe('claude-sonnet-4-20250514');
      expect(models[0]!.name).toBe('Claude Sonnet 4');
      expect(models[0]!.contextWindow).toBe(200000);
      expect(models[0]!.supportsThinking).toBe(true);
      expect(models[0]!.supportsImages).toBe(true);
      expect(models[0]!.pricing).toEqual({ input: 3.0, output: 15.0 });

      expect(models[1]!.id).toBe('claude-haiku-4-5-20250609');
      expect(models[1]!.pricing).toBeUndefined();
    });

    it('handles models without displayName', async () => {
      mockGetModels.mockReturnValue([
        { name: 'some-model', contextWindow: 100000 },
      ]);

      const models = await pm.listModels('custom');

      expect(models[0]!.name).toBe('some-model');
    });

    it('defaults contextWindow to 200k when not present', async () => {
      mockGetModels.mockReturnValue([
        { name: 'test-model' },
      ]);

      const models = await pm.listModels('custom');

      expect(models[0]!.contextWindow).toBe(200_000);
    });

    it('returns empty array when provider has no models', async () => {
      mockGetModels.mockReturnValue([]);

      const models = await pm.listModels('unknown-provider');

      expect(models).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // OAuth
  // -----------------------------------------------------------------------

  describe('initiateOAuth', () => {
    it('calls the correct login function for anthropic', async () => {
      mockLoginAnthropic.mockResolvedValue({
        accessToken: 'test-token',
        email: 'user@example.com',
        expiresAt: Date.now() + 3600_000,
        refreshToken: 'refresh-token',
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);

      expect(mockGetOAuthProvider).toHaveBeenCalledWith('anthropic');
      expect(mockLoginAnthropic).toHaveBeenCalledTimes(1);
      expect(typeof result.credentials).toBe('string');
      expect(result.meta.provider).toBe('anthropic');
      expect(result.meta.displayName).toBe('user@example.com');
      expect(result.meta.refreshable).toBe(true);
      expect(result.meta.expiresAt).toBeDefined();
    });

    it('passes normalized callbacks and signal to the login function', async () => {
      mockLoginAnthropic.mockResolvedValue({});

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
        onManualCodeInput: vi.fn(),
        onSelect: vi.fn(),
      };

      await pm.initiateOAuth('anthropic', callbacks);

      const callArgs = mockLoginAnthropic.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs['onAuth']).not.toBe(callbacks.onAuth);
      expect(callArgs['onPrompt']).not.toBe(callbacks.onPrompt);
      expect(callArgs['onProgress']).toBe(callbacks.onProgress);
      expect(callArgs['onManualCodeInput']).toBe(callbacks.onManualCodeInput);
      expect(callArgs['onSelect']).toBe(callbacks.onSelect);
      expect(callArgs['signal']).toBeInstanceOf(AbortSignal);
      expect(callArgs['renderCallbackPage']).toBeUndefined();
    });

    it('annotates localhost callback OAuth auth URLs', async () => {
      mockLoginAnthropic.mockImplementation(async (oauthCallbacks) => {
        oauthCallbacks.onAuth({
          url: 'https://claude.ai/oauth/authorize?test=1',
          instructions: 'Complete login in your browser.',
        });
        return {};
      });

      const onAuth = vi.fn();

      await pm.initiateOAuth('anthropic', {
        onAuth,
        onPrompt: vi.fn(),
      });

      expect(onAuth).toHaveBeenCalledWith({
        url: 'https://claude.ai/oauth/authorize?test=1',
        instructions: 'Complete login in your browser.',
        flowType: 'localhost_callback',
        manualCodeRecommended: true,
        callbackPort: 53692,
        callbackPath: '/callback',
      });
    });

    it('extracts device codes from OAuth auth instructions', async () => {
      const mockLoginGitHub = vi.fn(async (oauthCallbacks) => {
        oauthCallbacks.onAuth('https://github.com/login/device', 'Enter code: ABCD-1234');
        return {};
      });
      mockGetOAuthProvider.mockImplementationOnce((provider: string) => {
        if (provider === 'github-copilot') {
          return { id: provider, name: 'GitHub Copilot', login: mockLoginGitHub };
        }
        return undefined;
      });

      const onAuth = vi.fn();

      await pm.initiateOAuth('github-copilot', {
        onAuth,
        onPrompt: vi.fn(),
      });

      expect(onAuth).toHaveBeenCalledWith({
        url: 'https://github.com/login/device',
        instructions: 'Enter code: ABCD-1234',
        flowType: 'device_code',
        deviceCode: 'ABCD-1234',
      });
    });

    it('normalizes OAuth prompt metadata', async () => {
      mockLoginAnthropic.mockImplementation(async (oauthCallbacks) => {
        await oauthCallbacks.onPrompt({
          message: 'Paste the redirect URL:',
          placeholder: 'http://localhost:53692/callback',
          allowEmpty: false,
        });
        return {};
      });

      const onPrompt = vi.fn(async () => 'code');

      await pm.initiateOAuth('anthropic', {
        onAuth: vi.fn(),
        onPrompt,
      });

      expect(onPrompt).toHaveBeenCalledWith({
        message: 'Paste the redirect URL:',
        placeholder: 'http://localhost:53692/callback',
        allowEmpty: false,
      });
    });

    it('renders a custom callback page for known pi-ai callback routes', async () => {
      let callbackHtml = '';
      mockLoginAnthropic.mockImplementation(async () => {
        callbackHtml = await requestLocalOAuthPage();
        return { accessToken: 'test-token' };
      });

      const renderCallbackPage = vi.fn((context) => {
        expect(context.provider).toBe('anthropic');
        expect(context.providerName).toBe('Anthropic');
        expect(context.status).toBe('success');
        expect(context.title).toBe('Authentication successful');
        expect(context.heading).toBe('Authentication successful');
        expect(context.message).toBe('Anthropic authentication completed. You can close this window.');
        expect(context.callbackPath).toBe('/callback');
        expect(context.callbackPort).toBe(53692);
        expect(context.defaultHtml).toContain('Authentication successful');
        return '<!doctype html><html><body>Cortex OAuth complete</body></html>';
      });

      await pm.initiateOAuth('anthropic', {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        renderCallbackPage,
      });

      expect(renderCallbackPage).toHaveBeenCalledTimes(1);
      expect(callbackHtml).toContain('Cortex OAuth complete');
      expect(callbackHtml).not.toContain('Anthropic authentication completed');
    });

    it('leaves non-matching callback responses unchanged', async () => {
      let callbackHtml = '';
      mockLoginAnthropic.mockImplementation(async () => {
        callbackHtml = await requestLocalOAuthPage({ path: '/not-callback' });
        return { accessToken: 'test-token' };
      });

      const renderCallbackPage = vi.fn(() => (
        '<!doctype html><html><body>Cortex OAuth complete</body></html>'
      ));

      await pm.initiateOAuth('anthropic', {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        renderCallbackPage,
      });

      expect(renderCallbackPage).not.toHaveBeenCalled();
      expect(callbackHtml).toContain('Anthropic authentication completed');
    });

    it('restores the callback page shim after login failure', async () => {
      const renderCallbackPage = vi.fn(() => (
        '<!doctype html><html><body>Cortex OAuth complete</body></html>'
      ));
      mockLoginAnthropic.mockRejectedValue(new Error('Login failed'));

      await expect(pm.initiateOAuth('anthropic', {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        renderCallbackPage,
      })).rejects.toThrow('Login failed');

      const callbackHtml = await requestLocalOAuthPage();
      expect(renderCallbackPage).not.toHaveBeenCalled();
      expect(callbackHtml).toContain('Anthropic authentication completed');
    });

    it('rejects concurrent customized callback page shims', async () => {
      let finishLogin!: () => void;
      let resolveStarted!: () => void;
      const started = new Promise<void>(resolve => {
        resolveStarted = resolve;
      });

      mockLoginAnthropic.mockImplementationOnce(async () => {
        resolveStarted();
        return await new Promise<Record<string, unknown>>(resolve => {
          finishLogin = () => resolve({ accessToken: 'test-token' });
        });
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        renderCallbackPage: vi.fn(() => '<!doctype html><html><body>Done</body></html>'),
      };

      const firstLogin = pm.initiateOAuth('anthropic', callbacks);
      await started;

      const secondProviderManager = new ProviderManager();
      await expect(secondProviderManager.initiateOAuth('anthropic', callbacks))
        .rejects.toThrow('already active');

      finishLogin();
      await firstLogin;
    });

    it('throws for unknown OAuth provider', async () => {
      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      await expect(pm.initiateOAuth('openai', callbacks))
        .rejects.toThrow('does not support OAuth');
    });

    it('serializes credentials as JSON string', async () => {
      const rawCredentials = { token: 'abc', nested: { key: 'val' } };
      mockLoginAnthropic.mockResolvedValue(rawCredentials);

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);

      expect(JSON.parse(result.credentials)).toEqual(rawCredentials);
    });

    it('clears activeOAuthAbort after successful login', async () => {
      mockLoginAnthropic.mockResolvedValue({});

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      await pm.initiateOAuth('anthropic', callbacks);

      // cancelOAuth should be a no-op now (no active abort)
      pm.cancelOAuth(); // Should not throw
    });

    it('clears activeOAuthAbort after failed login', async () => {
      mockLoginAnthropic.mockRejectedValue(new Error('Login failed'));

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      await expect(pm.initiateOAuth('anthropic', callbacks))
        .rejects.toThrow('Login failed');

      pm.cancelOAuth(); // Should not throw
    });
  });

  describe('cancelOAuth', () => {
    it('does nothing when no OAuth flow is active', () => {
      expect(() => pm.cancelOAuth()).not.toThrow();
    });

    it('aborts an active OAuth flow with a typed OAuthError', async () => {
      // Codex port (1455) so this is independent of anything holding 53692.
      // pi-ai's anthropic flow ignores the abort signal entirely, so cancel
      // must reject via Cortex's own race, not the login promise.
      let signalRef: AbortSignal | null = null;
      mockLoginCodex.mockImplementation(async (opts: Record<string, unknown>) => {
        signalRef = opts['signal'] as AbortSignal;
        return new Promise(() => {}); // never settles (pi-ai-style hang)
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const loginPromise = pm.initiateOAuth('openai-codex', callbacks);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(signalRef).not.toBeNull();
      expect(signalRef!.aborted).toBe(false);

      pm.cancelOAuth();

      expect(signalRef!.aborted).toBe(true);

      await expect(loginPromise).rejects.toMatchObject({
        name: 'OAuthError',
        code: 'cancelled',
        provider: 'openai-codex',
      });
    });
  });

  describe('initiateOAuth resilience', () => {
    it('throws OAuthError(unsupported_provider) for unknown providers', async () => {
      await expect(
        pm.initiateOAuth('definitely-not-a-provider', { onAuth: vi.fn(), onPrompt: vi.fn() }),
      ).rejects.toMatchObject({ name: 'OAuthError', code: 'unsupported_provider' });
      expect(mockLoginCodex).not.toHaveBeenCalled();
    });

    it('fails fast with callback_port_in_use before opening a browser', async () => {
      // openai-codex callback port is 1455 (fixed in OAUTH_CALLBACK_ROUTES).
      const release = await occupyPort(1455);
      try {
        await expect(
          pm.initiateOAuth('openai-codex', { onAuth: vi.fn(), onPrompt: vi.fn() }),
        ).rejects.toMatchObject({
          name: 'OAuthError',
          code: 'callback_port_in_use',
          provider: 'openai-codex',
          port: 1455,
        });
        // The browser/login must never start when the port is taken.
        expect(mockLoginCodex).not.toHaveBeenCalled();
      } finally {
        await release();
      }
    });

    it('times out a hung flow with OAuthError(timed_out)', async () => {
      mockLoginCodex.mockImplementation(() => new Promise(() => {})); // never settles

      await expect(
        pm.initiateOAuth('openai-codex', {
          onAuth: vi.fn(),
          onPrompt: vi.fn(),
          timeoutMs: 60,
        }),
      ).rejects.toMatchObject({ name: 'OAuthError', code: 'timed_out' });

      // Flow released — a subsequent flow can start.
      pm.cancelOAuth();
    });

    it('fails immediately on a failed browser callback instead of hanging', async () => {
      // pi-ai serves its error page then hangs forever (never settles).
      // The render shim sees the error page; Cortex must reject right away.
      mockLoginCodex.mockImplementation(async () => {
        await requestLocalOAuthPage({
          port: 1455,
          path: '/auth/callback',
          html: PI_OAUTH_FAILURE_HTML,
        });
        return new Promise(() => {});
      });

      const err = await pm
        .initiateOAuth('openai-codex', { onAuth: vi.fn(), onPrompt: vi.fn() })
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).code).toBe('callback_failed');
      expect((err as OAuthError).message).toContain('State mismatch');
    });
  });

  describe('resolveOAuthApiKey', () => {
    it('calls getOAuthApiKey and returns the result', async () => {
      const originalCreds = { accessToken: 'old', refreshToken: 'refresh' };
      const newCreds = { accessToken: 'new', refreshToken: 'refresh' };

      mockGetOAuthApiKey.mockResolvedValue({
        apiKey: 'resolved-api-key',
        newCredentials: newCreds,
      });

      const result = await pm.resolveOAuthApiKey(
        'anthropic',
        JSON.stringify(originalCreds),
      );

      expect(result.apiKey).toBe('resolved-api-key');
      expect(result.changed).toBe(true);
      expect(JSON.parse(result.credentials)).toEqual(newCreds);
      expect(result.meta.provider).toBe('anthropic');
    });

    it('detects when credentials have not changed', async () => {
      const creds = { accessToken: 'same', refreshToken: 'refresh' };

      mockGetOAuthApiKey.mockResolvedValue({
        apiKey: 'api-key',
        newCredentials: creds,
      });

      const serialized = JSON.stringify(creds);
      const result = await pm.resolveOAuthApiKey('anthropic', serialized);

      expect(result.changed).toBe(false);
      expect(result.credentials).toBe(serialized);
    });

    it('throws when getOAuthApiKey returns null', async () => {
      mockGetOAuthApiKey.mockResolvedValue(null);

      await expect(pm.resolveOAuthApiKey('anthropic', '{}'))
        .rejects.toThrow('OAuth resolution failed');
    });
  });

  // -----------------------------------------------------------------------
  // API Key
  // -----------------------------------------------------------------------

  describe('validateApiKey', () => {
    it('returns a valid result when completeSimple succeeds', async () => {
      const mockModel = { provider: 'anthropic', name: 'haiku' };
      mockGetModel.mockReturnValue(mockModel);
      mockCompleteSimple.mockResolvedValue({ content: '' });

      const valid = await pm.validateApiKey('anthropic', 'sk-ant-test-key');

      expect(valid).toEqual(
        expect.objectContaining({
          provider: 'anthropic',
          modelId: 'claude-haiku-4-5-20251001',
          valid: true,
          retryable: false,
          status: 'valid',
        }),
      );
      expect(mockGetModel).toHaveBeenCalledWith(
        'anthropic',
        'claude-haiku-4-5-20251001',
      );
      expect(mockCompleteSimple).toHaveBeenCalledWith(
        mockModel,
        { messages: [{ role: 'user', content: 'hi' }] },
        { apiKey: 'sk-ant-test-key', maxTokens: 1 },
      );
    });

    it('classifies invalid credentials', async () => {
      mockGetModel.mockReturnValue({});
      mockCompleteSimple.mockRejectedValue(new Error('Invalid API key'));

      const valid = await pm.validateApiKey('anthropic', 'bad-key');

      expect(valid).toEqual(
        expect.objectContaining({
          valid: false,
          retryable: false,
          status: 'invalid_credentials',
          message: 'Invalid API key',
        }),
      );
    });

    it('classifies stopReason error validation results', async () => {
      mockGetModel.mockReturnValue({});
      mockCompleteSimple.mockResolvedValue({
        stopReason: 'error',
        errorMessage: 'Invalid API key',
      });

      const result = await pm.validateApiKey('anthropic', 'bad-key');

      expect(result).toEqual(
        expect.objectContaining({
          valid: false,
          retryable: false,
          status: 'invalid_credentials',
          message: 'Invalid API key',
        }),
      );
    });

    it('classifies transient provider failures separately', async () => {
      mockGetModel.mockReturnValue({});
      mockCompleteSimple.mockRejectedValue(new Error('503 Service Unavailable'));

      const result = await pm.validateApiKey('anthropic', 'test-key');

      expect(result).toEqual(
        expect.objectContaining({
          valid: false,
          retryable: true,
          status: 'transient_error',
          message: '503 Service Unavailable',
        }),
      );
    });

    it('falls back to first model when provider has no default', async () => {
      mockGetModels.mockReturnValue([
        { name: 'unknown-model-1' },
        { name: 'unknown-model-2' },
      ]);
      mockGetModel.mockReturnValue({});
      mockCompleteSimple.mockResolvedValue({ content: '' });

      const valid = await pm.validateApiKey('unknown-provider', 'some-key');

      expect(valid).toEqual(
        expect.objectContaining({
          provider: 'unknown-provider',
          modelId: 'unknown-model-1',
          valid: true,
          status: 'valid',
        }),
      );
      expect(mockGetModel).toHaveBeenCalledWith('unknown-provider', 'unknown-model-1');
    });

    it('returns a resolution error when provider has no models and no default', async () => {
      mockGetModels.mockReturnValue([]);

      await expect(pm.validateApiKey('empty-provider', 'some-key'))
        .resolves.toEqual(
          expect.objectContaining({
            provider: 'empty-provider',
            modelId: null,
            valid: false,
            retryable: false,
            status: 'resolution_error',
            message: 'No models found for provider "empty-provider"',
          }),
        );
    });
  });

  describe('checkEnvApiKey', () => {
    it('returns the env var value when set', () => {
      const originalEnv = process.env['ANTHROPIC_API_KEY'];
      process.env['ANTHROPIC_API_KEY'] = 'test-api-key';

      try {
        const key = pm.checkEnvApiKey('anthropic');
        expect(key).toBe('test-api-key');
      } finally {
        if (originalEnv !== undefined) {
          process.env['ANTHROPIC_API_KEY'] = originalEnv;
        } else {
          delete process.env['ANTHROPIC_API_KEY'];
        }
      }
    });

    it('returns null when env var is not set', () => {
      const originalEnv = process.env['ANTHROPIC_API_KEY'];
      delete process.env['ANTHROPIC_API_KEY'];

      try {
        const key = pm.checkEnvApiKey('anthropic');
        expect(key).toBeNull();
      } finally {
        if (originalEnv !== undefined) {
          process.env['ANTHROPIC_API_KEY'] = originalEnv;
        }
      }
    });

    it('returns null when env var is empty', () => {
      const originalEnv = process.env['ANTHROPIC_API_KEY'];
      process.env['ANTHROPIC_API_KEY'] = '';

      try {
        const key = pm.checkEnvApiKey('anthropic');
        expect(key).toBeNull();
      } finally {
        if (originalEnv !== undefined) {
          process.env['ANTHROPIC_API_KEY'] = originalEnv;
        } else {
          delete process.env['ANTHROPIC_API_KEY'];
        }
      }
    });

    it('returns null for unknown provider', () => {
      const key = pm.checkEnvApiKey('unknown-provider');
      expect(key).toBeNull();
    });

    it('returns null for OAuth-only provider without envVar', () => {
      const key = pm.checkEnvApiKey('openai-codex');
      expect(key).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Model Resolution
  // -----------------------------------------------------------------------

  describe('resolveModel', () => {
    it('wraps the pi-ai model as a CortexModel', async () => {
      const piModel = {
        provider: 'anthropic',
        name: 'claude-sonnet-4',
        contextWindow: 200_000,
      };
      mockGetModel.mockReturnValue(piModel);

      const cortexModel = await pm.resolveModel('anthropic', 'claude-sonnet-4');

      expect(isCortexModel(cortexModel)).toBe(true);
      expect(cortexModel.provider).toBe('anthropic');
      expect(cortexModel.modelId).toBe('claude-sonnet-4');
      expect(cortexModel.contextWindow).toBe(200_000);
      expect(cortexModel.__brand).toBe('CortexModel');
    });

    it('unwraps back to the original pi-ai model', async () => {
      const piModel = { provider: 'openai', name: 'gpt-4o', extra: 'data' };
      mockGetModel.mockReturnValue(piModel);

      const cortexModel = await pm.resolveModel('openai', 'gpt-4o');
      const unwrapped = unwrapModel(cortexModel);

      expect(unwrapped).toBe(piModel);
    });

    it('delegates to pi-ai getModel with correct args', async () => {
      mockGetModel.mockReturnValue({});

      await pm.resolveModel('google', 'gemini-2.0-flash');

      expect(mockGetModel).toHaveBeenCalledWith('google', 'gemini-2.0-flash');
    });
  });

  describe('createCustomModel', () => {
    it('creates a CortexModel for a custom endpoint', async () => {
      const piModel = { modelId: 'llama3', baseUrl: 'http://localhost:11434/v1' };
      mockCreateModel.mockReturnValue(piModel);

      const cortexModel = await pm.createCustomModel({
        baseUrl: 'http://localhost:11434/v1',
        modelId: 'llama3',
        contextWindow: 8_000,
      });

      expect(isCortexModel(cortexModel)).toBe(true);
      expect(cortexModel.provider).toBe('custom');
      expect(cortexModel.modelId).toBe('llama3');
      expect(cortexModel.contextWindow).toBe(8_000);
    });

    it('defaults contextWindow to 128k', async () => {
      mockCreateModel.mockReturnValue({});

      const cortexModel = await pm.createCustomModel({
        baseUrl: 'http://localhost:11434/v1',
        modelId: 'my-model',
      });

      expect(cortexModel.contextWindow).toBe(128_000);
    });

    it('builds correct model shape from config', async () => {
      mockGetModel.mockReturnValue({});

      await pm.createCustomModel({
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'test',
        contextWindow: 32_000,
        apiKey: 'local-key',
      });

      // Should clone base model via getModel('openai', 'gpt-4.1')
      expect(mockGetModel).toHaveBeenCalledWith('openai', 'gpt-4.1');
    });

    it('uses openai-completions API and sets placeholder key for keyless endpoints', async () => {
      mockGetModel.mockReturnValue({});

      const cortexModel = await pm.createCustomModel({
        baseUrl: 'http://localhost:11434/v1',
        modelId: 'test',
      });

      const inner = unwrapModel(cortexModel) as Record<string, unknown>;
      expect(inner['api']).toBe('openai-completions');
      expect(inner['apiKey']).toBe('sk-no-key-required');
      expect(inner['provider']).toBe('custom');
    });

    it('uses provided apiKey when given', async () => {
      mockGetModel.mockReturnValue({});

      const cortexModel = await pm.createCustomModel({
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'test',
        apiKey: 'local-key',
      });

      const inner = unwrapModel(cortexModel) as Record<string, unknown>;
      expect(inner['apiKey']).toBe('local-key');
    });
  });

  // -----------------------------------------------------------------------
  // Display name extraction (tested via OAuth results)
  // -----------------------------------------------------------------------

  describe('display name extraction', () => {
    it('extracts email from credentials', async () => {
      mockLoginAnthropic.mockResolvedValue({
        email: 'test@example.com',
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      expect(result.meta.displayName).toBe('test@example.com');
    });

    it('extracts accountId when no email', async () => {
      mockLoginAnthropic.mockResolvedValue({
        accountId: 'user-123',
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      expect(result.meta.displayName).toBe('user-123');
    });

    it('extracts email from JWT idToken', async () => {
      // Create a valid JWT payload with email
      const payload = { email: 'jwt@example.com', sub: '123' };
      const encodedPayload = btoa(JSON.stringify(payload));
      const idToken = `header.${encodedPayload}.signature`;

      mockLoginAnthropic.mockResolvedValue({ idToken });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      expect(result.meta.displayName).toBe('jwt@example.com');
    });

    it('returns undefined displayName when no identity fields', async () => {
      mockLoginAnthropic.mockResolvedValue({
        accessToken: 'token-only',
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      expect(result.meta.displayName).toBeUndefined();
    });

    it('handles malformed JWT gracefully', async () => {
      mockLoginAnthropic.mockResolvedValue({
        idToken: 'not.a.valid.jwt',
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      // Should not crash, displayName should be undefined
      expect(result.meta.displayName).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // OAuthMeta fields
  // -----------------------------------------------------------------------

  describe('OAuthMeta', () => {
    it('marks refreshable when refreshToken exists', async () => {
      mockLoginAnthropic.mockResolvedValue({
        refreshToken: 'refresh-token',
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      expect(result.meta.refreshable).toBe(true);
    });

    it('marks not refreshable when no refreshToken', async () => {
      mockLoginAnthropic.mockResolvedValue({
        accessToken: 'no-refresh',
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      expect(result.meta.refreshable).toBe(false);
    });

    it('includes expiresAt when present', async () => {
      const expires = Date.now() + 3600_000;
      mockLoginAnthropic.mockResolvedValue({
        expiresAt: expires,
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      expect(result.meta.expiresAt).toBe(expires);
    });

    it('omits expiresAt when not present', async () => {
      mockLoginAnthropic.mockResolvedValue({
        accessToken: 'no-expiry',
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      expect(result.meta.expiresAt).toBeUndefined();
    });
  });
});
