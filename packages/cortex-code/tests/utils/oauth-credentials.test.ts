import { describe, expect, it, vi } from 'vitest';
import { resolveStoredOAuthApiKey } from '../../src/utils/oauth-credentials.js';
import type { ProviderManager } from '@animus-labs/cortex';
import type { CredentialStore, CredentialEntry } from '../../src/config/credentials.js';

function oauthEntry(oauthCredentials: string): CredentialEntry {
  return { provider: 'anthropic', method: 'oauth', oauthCredentials, addedAt: 0 };
}

function refreshResult(over: Partial<{ apiKey: string; credentials: string; changed: boolean }>) {
  return {
    apiKey: over.apiKey ?? 'access-key',
    credentials: over.credentials ?? 'R1',
    meta: { provider: 'anthropic', refreshable: true, expiresAt: 1 },
    changed: over.changed ?? false,
  };
}

function makeDeps(
  resolveOAuthApiKey: ReturnType<typeof vi.fn>,
  getProvider: ReturnType<typeof vi.fn> = vi.fn(),
  setProvider: ReturnType<typeof vi.fn> = vi.fn(),
) {
  const providerManager = { resolveOAuthApiKey } as unknown as ProviderManager;
  const credentialStore = { getProvider, setProvider } as unknown as CredentialStore;
  return { providerManager, credentialStore, getProvider, setProvider };
}

describe('resolveStoredOAuthApiKey', () => {
  it('returns the key without persisting when nothing changed (token still valid)', async () => {
    const resolve = vi.fn().mockResolvedValue(refreshResult({ apiKey: 'valid-key', changed: false }));
    const { providerManager, credentialStore, setProvider } = makeDeps(resolve);

    const key = await resolveStoredOAuthApiKey(providerManager, credentialStore, 'anthropic', oauthEntry('R1'));

    expect(key).toBe('valid-key');
    expect(setProvider).not.toHaveBeenCalled();
  });

  it('persists rotated credentials when the refresh changed them', async () => {
    const resolve = vi.fn().mockResolvedValue(
      refreshResult({ apiKey: 'fresh-key', credentials: 'R2', changed: true }),
    );
    const { providerManager, credentialStore, setProvider } = makeDeps(resolve);

    const key = await resolveStoredOAuthApiKey(providerManager, credentialStore, 'anthropic', oauthEntry('R1'));

    expect(key).toBe('fresh-key');
    expect(setProvider).toHaveBeenCalledTimes(1);
    expect(setProvider.mock.calls[0][1]).toMatchObject({ oauthCredentials: 'R2' });
  });

  it('recovers from a lost cross-process race by using the winner\'s persisted credential', async () => {
    // Our refresh fails (token rotated out from under us by another process),
    // but the store now holds a different, fresh credential the winner wrote.
    const resolve = vi.fn()
      .mockRejectedValueOnce(new Error('Failed to refresh OAuth token for anthropic'))
      .mockResolvedValueOnce(refreshResult({ apiKey: 'winner-key', credentials: 'R2', changed: false }));
    const getProvider = vi.fn().mockResolvedValue(oauthEntry('R2')); // winner already persisted R2
    const { providerManager, credentialStore, setProvider } = makeDeps(resolve, getProvider);

    const key = await resolveStoredOAuthApiKey(providerManager, credentialStore, 'anthropic', oauthEntry('R1'));

    expect(key).toBe('winner-key');
    // Second resolve used the winner's credential (R2), not our spent R1.
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[1][1]).toBe('R2');
    expect(setProvider).not.toHaveBeenCalled(); // winner's token still valid; no re-persist
  });

  it('rethrows a genuine failure when no newer credential was published', async () => {
    const err = new Error('Failed to refresh OAuth token for anthropic');
    const resolve = vi.fn().mockRejectedValue(err);
    const getProvider = vi.fn().mockResolvedValue(oauthEntry('R1')); // unchanged: no concurrent winner
    const { providerManager, credentialStore } = makeDeps(resolve, getProvider);

    await expect(
      resolveStoredOAuthApiKey(providerManager, credentialStore, 'anthropic', oauthEntry('R1')),
    ).rejects.toThrow('Failed to refresh OAuth token');
    // Only the initial attempt ran; an unchanged store means no retry.
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry cap even if the credential keeps changing', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('invalid_grant'));
    let n = 0;
    const getProvider = vi.fn().mockImplementation(async () => oauthEntry(`R${++n}`)); // always different
    const { providerManager, credentialStore } = makeDeps(resolve, getProvider);

    await expect(
      resolveStoredOAuthApiKey(providerManager, credentialStore, 'anthropic', oauthEntry('R0')),
    ).rejects.toThrow('invalid_grant');
    // Initial attempt + 3 retries = 4 resolve calls, then it surfaces the error.
    expect(resolve).toHaveBeenCalledTimes(4);
  });
});
