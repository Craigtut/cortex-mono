import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { SandboxRuntimeProvider } from '../src/provider.js';
import { buildDefaultPolicy } from '../src/policy.js';
import type { SandboxStatus } from '@animus-labs/cortex';

// sandbox-runtime overrides the sandboxed child's TMPDIR from CLAUDE_CODE_TMPDIR
// (not the spawn env), so redirecting "write to the temp dir" at the per-session
// temp means pointing that env var at it. These tests assert the provider manages
// that var (initialize sets it, dispose restores it) without standing up a real OS
// backend. The real kernel behavior is proved by tmpdir-containment.integration.test.ts.
const TMPDIR_ENV = 'CLAUDE_CODE_TMPDIR';
const SBX_TEMP = '/tmp/cortex-sbx-abc123';

function policyWith(sessionTmpDir: string | undefined) {
  return buildDefaultPolicy('workspace', {
    workspaceRoots: ['/nope/ws'],
    home: '/nope/home',
    ...(sessionTmpDir !== undefined ? { sessionTmpDir } : {}),
  });
}

function forceEnforced(provider: SandboxRuntimeProvider): void {
  (provider as unknown as { currentStatus: SandboxStatus }).currentStatus = {
    filesystem: 'enforced',
    network: 'enforced',
    backend: 'seatbelt',
    degradations: [],
  };
}

describe('SandboxRuntimeProvider: session temp routing via CLAUDE_CODE_TMPDIR', () => {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env[TMPDIR_ENV];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (prior === undefined) delete process.env[TMPDIR_ENV];
    else process.env[TMPDIR_ENV] = prior;
  });

  it('initialize points CLAUDE_CODE_TMPDIR at the scoped session temp; dispose restores it', async () => {
    delete process.env[TMPDIR_ENV];
    const provider = new SandboxRuntimeProvider();

    await provider.initialize(policyWith(SBX_TEMP));
    // The policy carries the (canonicalized) session temp; the non-existent path
    // realpaths to itself, so the env var holds exactly SBX_TEMP here.
    expect(process.env[TMPDIR_ENV]).toBe(SBX_TEMP);

    await provider.dispose();
    // Prior value was unset, so restore removes the override entirely.
    expect(process.env[TMPDIR_ENV]).toBeUndefined();
  });

  it('restores a pre-existing CLAUDE_CODE_TMPDIR on dispose rather than deleting it', async () => {
    process.env[TMPDIR_ENV] = '/host/tmp';
    const provider = new SandboxRuntimeProvider();

    await provider.initialize(policyWith(SBX_TEMP));
    expect(process.env[TMPDIR_ENV]).toBe(SBX_TEMP);

    await provider.dispose();
    expect(process.env[TMPDIR_ENV]).toBe('/host/tmp');
  });

  it('leaves CLAUDE_CODE_TMPDIR untouched when the policy did not scope a session temp', async () => {
    process.env[TMPDIR_ENV] = '/host/tmp';
    const provider = new SandboxRuntimeProvider();

    await provider.initialize(policyWith(undefined));
    expect(process.env[TMPDIR_ENV]).toBe('/host/tmp');

    await provider.dispose();
    expect(process.env[TMPDIR_ENV]).toBe('/host/tmp');
  });

  it('restores CLAUDE_CODE_TMPDIR when reinitialized down to restricted (no scoped temp)', async () => {
    // setSandboxRung reinitializes the live provider (only "off" disposes), so a
    // workspace -> restricted change must not leave the env pointing at the old
    // session dir, which is no longer writable at restricted -> a broken $TMPDIR.
    process.env[TMPDIR_ENV] = '/host/tmp';
    const provider = new SandboxRuntimeProvider();

    await provider.initialize(policyWith(SBX_TEMP));
    expect(process.env[TMPDIR_ENV]).toBe(SBX_TEMP);

    // Restricted drops the session temp even though the consumer still passes it.
    const restricted = buildDefaultPolicy('restricted', {
      workspaceRoots: ['/nope/ws'],
      home: '/nope/home',
      sessionTmpDir: SBX_TEMP,
    });
    expect(restricted.filesystem.sessionTmpDir).toBeUndefined();

    await provider.initialize(restricted);
    // The override is undone (back to the ambient host value), not left at SBX_TEMP.
    expect(process.env[TMPDIR_ENV]).toBe('/host/tmp');

    await provider.dispose();
    expect(process.env[TMPDIR_ENV]).toBe('/host/tmp');
  });

  it('passes the spawn env through unchanged (the child TMPDIR is set by the runtime, not the env)', async () => {
    vi.spyOn(SandboxManager, 'wrapWithSandboxArgv').mockResolvedValue({
      argv: ['/usr/bin/sandbox-exec', '-p', '(profile)', '/bin/bash', '-c', 'echo hi'],
      env: {} as NodeJS.ProcessEnv,
    });
    const provider = new SandboxRuntimeProvider();
    forceEnforced(provider);

    const env = { PATH: '/usr/bin', TMPDIR: '/tmp' };
    const wrapped = await provider.wrapSpawn({
      shell: '/bin/bash',
      shellArgs: ['-c'],
      command: 'echo hi',
      cwd: '/workspace',
      env,
    });

    expect(wrapped.env).toBe(env);
  });
});
