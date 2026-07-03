import { describe, expect, it, vi } from 'vitest';
import { singleFlight } from '../../src/utils/single-flight.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('singleFlight', () => {
  it('runs the work once for concurrent calls with the same key', async () => {
    const inFlight = new Map<string, Promise<string>>();
    const d = deferred<string>();
    const work = vi.fn(() => d.promise);

    const a = singleFlight(inFlight, 'anthropic', work);
    const b = singleFlight(inFlight, 'anthropic', work);
    const c = singleFlight(inFlight, 'anthropic', work);

    expect(work).toHaveBeenCalledTimes(1);
    d.resolve('key-1');
    expect(await Promise.all([a, b, c])).toEqual(['key-1', 'key-1', 'key-1']);
  });

  it('starts fresh work once the previous call has cleared', async () => {
    const inFlight = new Map<string, Promise<string>>();
    const work = vi.fn()
      .mockResolvedValueOnce('key-1')
      .mockResolvedValueOnce('key-2');

    expect(await singleFlight(inFlight, 'anthropic', work)).toBe('key-1');
    // Flush the microtask that clears the settled in-flight entry so the next
    // call re-runs the work instead of reusing the resolved promise.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inFlight.has('anthropic')).toBe(false);
    expect(await singleFlight(inFlight, 'anthropic', work)).toBe('key-2');
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('does not dedupe across different keys', async () => {
    const inFlight = new Map<string, Promise<string>>();
    const work = vi.fn()
      .mockResolvedValueOnce('anthropic-key')
      .mockResolvedValueOnce('openai-key');

    const [a, b] = await Promise.all([
      singleFlight(inFlight, 'anthropic', work),
      singleFlight(inFlight, 'openai', work),
    ]);

    expect(work).toHaveBeenCalledTimes(2);
    expect(new Set([a, b])).toEqual(new Set(['anthropic-key', 'openai-key']));
  });

  it('clears the in-flight entry after a rejection so a retry can run', async () => {
    const inFlight = new Map<string, Promise<string>>();
    const work = vi.fn()
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce('key-2');

    await expect(singleFlight(inFlight, 'anthropic', work)).rejects.toThrow('refresh failed');
    expect(inFlight.has('anthropic')).toBe(false);
    expect(await singleFlight(inFlight, 'anthropic', work)).toBe('key-2');
  });

  it('collapses a burst onto a single OAuth refresh (rotation race)', async () => {
    // Model the failure: a rotating refresh token is valid exactly once. Any
    // refresh past the first rejects with invalid_grant. singleFlight must make
    // a concurrent burst trigger exactly one refresh so none of them fail.
    const inFlight = new Map<string, Promise<string>>();
    let refreshCount = 0;
    const refreshOAuthToken = vi.fn(async () => {
      refreshCount += 1;
      if (refreshCount > 1) throw new Error('invalid_grant'); // rotated token reused
      return 'fresh-access-token';
    });

    const resolve = () => singleFlight(inFlight, 'anthropic', refreshOAuthToken);

    // Main model + utility model + two subagents all resolve at once.
    const results = await Promise.all([resolve(), resolve(), resolve(), resolve()]);

    expect(refreshOAuthToken).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      'fresh-access-token',
      'fresh-access-token',
      'fresh-access-token',
      'fresh-access-token',
    ]);
  });
});
