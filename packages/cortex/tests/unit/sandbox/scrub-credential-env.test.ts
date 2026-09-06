import { describe, it, expect } from 'vitest';
import { SandboxRuntimeProvider } from '../../../src/sandbox/backends/runtime.js';

// An approved escalation leaves the OS boundary for one command (the Bash tool
// skips wrapSpawn), so the provider must still strip credential env vars: the
// "secrets stay unreadable" invariant holds on every rung except Off, and
// escalation is not Off.
describe('SandboxRuntimeProvider.scrubCredentialEnv', () => {
  it('removes the default credential env vars and keeps everything else', () => {
    const provider = new SandboxRuntimeProvider();
    const out = provider.scrubCredentialEnv({
      GITHUB_TOKEN: 'ghp_x',
      AWS_SECRET_ACCESS_KEY: 'y',
      ANTHROPIC_API_KEY: 'z',
      PATH: '/usr/bin',
      HOME: '/home/me',
    });
    expect(out['GITHUB_TOKEN']).toBeUndefined();
    expect(out['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(out['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(out['PATH']).toBe('/usr/bin');
    expect(out['HOME']).toBe('/home/me');
  });

  it('honors a custom credentialEnvVars list', () => {
    const provider = new SandboxRuntimeProvider({ credentialEnvVars: ['MY_SECRET'] });
    const out = provider.scrubCredentialEnv({ MY_SECRET: 'x', GITHUB_TOKEN: 'keep', PATH: '/b' });
    expect(out['MY_SECRET']).toBeUndefined();
    // Not in the custom list, so it is kept.
    expect(out['GITHUB_TOKEN']).toBe('keep');
    expect(out['PATH']).toBe('/b');
  });

  it('returns the input untouched when scrubbing is disabled', () => {
    const provider = new SandboxRuntimeProvider({ credentialEnvVars: [] });
    const env = { GITHUB_TOKEN: 'x', PATH: '/b' };
    expect(provider.scrubCredentialEnv(env)).toBe(env);
  });
});
