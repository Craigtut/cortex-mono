import { describe, it, expect, vi, afterEach } from 'vitest';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { SandboxRuntimeProvider } from '../src/provider.js';
import type { SandboxStatus } from '@animus-labs/cortex';

// Force the provider to look enforced without standing up a real backend, so the
// mid-session degrade path can be exercised in isolation (mirrors the helper in
// session-tmp-env.test.ts).
function forceEnforced(provider: SandboxRuntimeProvider): void {
  (provider as unknown as { currentStatus: SandboxStatus }).currentStatus = {
    filesystem: 'enforced',
    network: 'enforced',
    backend: 'seatbelt',
    degradations: [],
  };
}

describe('SandboxRuntimeProvider: notifyWrappedSpawnFailure (mid-session degrade)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('degrades to uncontained none and fires onDegraded when the wrapper cannot launch', () => {
    vi.spyOn(SandboxManager, 'reset').mockResolvedValue(undefined);
    const degradations: string[][] = [];
    const provider = new SandboxRuntimeProvider({ onDegraded: (d) => degradations.push(d) });
    forceEnforced(provider);

    provider.notifyWrappedSpawnFailure({ code: 'ENOENT', message: 'spawn sandbox-exec ENOENT' });

    // Subsequent spawns pass through because the status is now none.
    const status = provider.status();
    expect(status.backend).toBe('none');
    expect(status.filesystem).toBe('none');
    expect(status.network).toBe('none');
    expect(status.degradations[0]).toContain('failed to launch');
    // The reason also reached the consumer's onDegraded channel.
    expect(degradations.at(-1)?.[0]).toContain('ENOENT');
  });

  it('is a no-op when already uncontained (does not reset or re-notify)', () => {
    const resetSpy = vi.spyOn(SandboxManager, 'reset').mockResolvedValue(undefined);
    const degradations: string[][] = [];
    const provider = new SandboxRuntimeProvider({ onDegraded: (d) => degradations.push(d) });

    // A fresh provider is uncontained ("not initialized"), so this must no-op.
    provider.notifyWrappedSpawnFailure({ code: 'EACCES', message: 'blocked' });

    expect(resetSpy).not.toHaveBeenCalled();
    expect(degradations).toHaveLength(0);
    expect(provider.status().backend).toBe('none');
  });
});
