import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SandboxSession } from '../../../src/sandbox/session.js';
import { createSandboxNetworkResolver } from '../../../src/sandbox/network-policy.js';
import type { SandboxProvider, SandboxStatus, SandboxPolicy } from '../../../src/sandbox/types.js';

const enforced: SandboxStatus = { backend: 'seatbelt', filesystem: 'enforced', network: 'enforced', degradations: [] };
const absent: SandboxStatus = { backend: 'none', filesystem: 'none', network: 'none', degradations: ['test unavailable'] };
function backend(status = enforced) {
  return {
    initialize: vi.fn(async (_policy: SandboxPolicy) => status),
    status: vi.fn(() => status),
    wrapSpawn: vi.fn(async (spec) => ({ file: spec.shell, args: [...spec.shellArgs, spec.command], env: spec.env })),
    wrapExec: vi.fn(async (spec) => ({ file: spec.file, args: spec.args, env: spec.env })),
    dispose: vi.fn(async () => {}),
  } satisfies SandboxProvider;
}
let cwd: string;
const sessions: SandboxSession[] = [];
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'managed-sandbox-test-')); });
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.dispose()));
  rmSync(cwd, { recursive: true, force: true });
});
async function create(options: Parameters<typeof SandboxSession.create>[0]) {
  const session = await SandboxSession.create(options, cwd);
  if (session) sessions.push(session);
  return session!;
}

describe('Cortex-owned sandbox session', () => {
  it('opts out without creating a provider or temporary directory', async () => {
    const provider = backend();
    expect(await create(false)).toBeUndefined();
    expect(await create({ enabled: false, provider })).toBeUndefined();
    expect(provider.initialize).not.toHaveBeenCalled();
  });

  it('defaults to the workspace, protects paths, and owns a reusable temporary directory', async () => {
    const provider = backend();
    const session = await create({ provider });
    const policy = session.getState().policy!;
    const temporary = policy.filesystem.sessionTmpDir!;
    expect(policy.rung).toBe('workspace');
    expect(policy.filesystem.writableRoots).toContain(resolve(cwd).replace(/^\/var\//, '/private/var/'));
    expect(policy.filesystem.writableRoots).toContain(temporary);
    expect(existsSync(temporary)).toBe(true);
    expect(session.checkToolCall('Write', { file_path: join(cwd, '.git/config') }, cwd)).toContain('write-protected');
    await session.setRung('trusted');
    expect(session.getState().policy!.filesystem.sessionTmpDir).toBe(temporary);
    await session.dispose();
    await session.dispose();
    expect(provider.dispose).toHaveBeenCalledOnce();
    expect(existsSync(temporary)).toBe(false);
  });

  it('refuses unavailable or partial enforcement by default and cleans failed setup', async () => {
    for (const status of [absent, { ...enforced, network: 'none' as const }]) {
      const provider = backend(status);
      await expect(create({ provider })).rejects.toThrow('enforcement is required');
      const temporary = provider.initialize.mock.calls[0]![0].filesystem.sessionTmpDir!;
      expect(existsSync(temporary)).toBe(false);
      expect(provider.dispose).toHaveBeenCalled();
    }
  });

  it('allows degraded operation only with an explicit setting and still gates files', async () => {
    const session = await create({ provider: backend(absent), requireEnforcement: false });
    expect(session.getState().status).toEqual(absent);
    expect(session.checkToolCall('Write', { file_path: join(cwd, '../escape') }, cwd)).toContain('outside the writable roots');
  });

  it('blocks tools after enforcement is lost, including an escalation request', async () => {
    const provider = backend();
    const session = await create({ provider });
    provider.status.mockReturnValue(absent);
    expect(session.checkToolCall('Bash', {}, cwd)).toContain('enforcement is required');
    expect(session.checkToolCall('Bash(escalate)', {}, cwd)).toContain('enforcement is required');
    await expect(session.wrapExec({ file: 'echo', args: [], env: {}, cwd })).rejects.toThrow('enforcement is required');
    expect(provider.wrapExec).not.toHaveBeenCalled();
  });

  it('rechecks enforcement after an asynchronous wrapper reports degradation', async () => {
    const provider = backend();
    const session = await create({ provider });
    provider.wrapExec.mockImplementationOnce(async (spec) => {
      provider.status.mockReturnValue(absent);
      return { file: spec.file, args: spec.args, env: spec.env };
    });
    await expect(session.wrapExec({ file: 'echo', args: [], env: {}, cwd })).rejects.toThrow('enforcement is required');
  });

  it('guards reads and writes through symlinks without a consumer callback', async () => {
    const session = await create({ provider: backend(), denyRead: ['secret'] });
    symlinkSync(tmpdir(), join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(session.checkToolCall('Write', { file_path: join(cwd, 'escape/new/file') }, cwd)).toContain('outside the writable roots');
    expect(session.checkToolCall('Read', { file_path: join(cwd, 'secret') }, cwd)).toContain('read-protected');
    expect(session.checkToolCall('Edit', { file_path: join(cwd, 'secret') }, cwd)).toContain('read-protected');
    expect(session.checkToolCall('Write', { file_path: join(cwd, 'new/file') }, cwd)).toBeNull();
    expect(session.checkToolCall('Write', { file_path: 'relative/file' }, cwd)).toContain('absolute path');
  });

  it('can start off, enable later, and blocks access after disposal', async () => {
    const provider = backend();
    const session = await create({ provider, rung: 'off' });
    expect(provider.initialize).not.toHaveBeenCalled();
    expect(session.getState().rung).toBe('off');
    await session.setRung('workspace');
    expect(provider.initialize).toHaveBeenCalledOnce();
    await session.setRung('off');
    expect(session.getState().policy).toBeUndefined();
    expect(session.checkToolCall('Write', { file_path: '/outside' }, cwd)).toBeNull();
    await session.dispose();
    expect(session.checkToolCall('Read', {}, cwd)).toContain('disposed');
  });

  it('rejects concurrent policy changes and blocks tools until setup settles', async () => {
    const provider = backend();
    const session = await create({ provider });
    let finish!: (status: SandboxStatus) => void;
    provider.initialize.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const change = session.setRung('trusted');
    await expect(session.setRung('off')).rejects.toThrow('already changing');
    expect(session.checkToolCall('Bash', {}, cwd)).toContain('policy is changing');
    finish(enforced);
    await change;
    expect(session.checkToolCall('Bash', {}, cwd)).toBeNull();
  });

  it('cleans up a provider that throws during initialization', async () => {
    const provider = backend();
    provider.initialize.mockRejectedValueOnce(new Error('setup failed'));
    await expect(create({ provider })).rejects.toThrow('setup failed');
    expect(provider.dispose).toHaveBeenCalled();
    expect(existsSync(provider.initialize.mock.calls[0]![0].filesystem.sessionTmpDir!)).toBe(false);
  });
});

describe('managed network policy', () => {
  it('applies defaults to WebFetch without a consumer resolver', async () => {
    const session = await create({ provider: backend() });
    expect((await session.resolveNetworkAccess({ host: 'registry.npmjs.org', via: 'webfetch' })).decision).toBe('allow');
    expect((await session.resolveNetworkAccess({ host: 'unknown.invalid', via: 'webfetch' })).decision).toBe('deny');
  });

  it('gives denials priority and shares session grants across request paths', async () => {
    const policy = { mode: 'allowlist' as const, allowedDomains: ['*.example.com'], deniedDomains: ['secret.example.com'] };
    const decide = vi.fn(async () => ({ decision: 'allow' as const, scope: 'session' as const }));
    const gate = createSandboxNetworkResolver(() => policy, decide);
    expect((await gate({ host: 'secret.example.com', via: 'shell' })).decision).toBe('deny');
    expect(decide).not.toHaveBeenCalled();
    await gate({ host: 'new.invalid', via: 'shell' });
    await gate({ host: 'new.invalid', via: 'webfetch' });
    expect(decide).toHaveBeenCalledOnce();
    policy.deniedDomains.push('new.invalid');
    expect((await gate({ host: 'new.invalid', via: 'webfetch' })).decision).toBe('deny');
  });
});
