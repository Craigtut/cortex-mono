import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { SandboxRuntimeProvider } from '../../../src/sandbox/backends/runtime.js';
import { buildDefaultPolicy } from '../../../src/sandbox/policy.js';

const isMac = process.platform === 'darwin';

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Wrap a command through the provider and actually run it, capturing the
 * outcome. This exercises the real Seatbelt boundary, not a mock.
 */
async function runContained(
  provider: SandboxRuntimeProvider,
  cwd: string,
  command: string,
): Promise<RunResult> {
  const wrapped = await provider.wrapSpawn({
    shell: '/bin/bash',
    shellArgs: ['-c'],
    command,
    cwd,
    env: { ...process.env } as Record<string, string>,
  });
  return new Promise<RunResult>((resolve) => {
    const proc = spawn(wrapped.file, wrapped.args, { cwd, env: wrapped.env });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => (stdout += String(d)));
    proc.stderr?.on('data', (d) => (stderr += String(d)));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }));
  });
}

describe.skipIf(!isMac)('SandboxRuntimeProvider containment (macOS Seatbelt)', () => {
  let workspaceDir = '';
  let outsideDir = '';
  let secretFile = '';
  let provider: SandboxRuntimeProvider;

  beforeAll(async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-sbx-ws-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-sbx-out-'));
    secretFile = path.join(workspaceDir, 'secret.env');
    fs.writeFileSync(secretFile, 'TOPSECRET=hunter2\n');

    const policy = buildDefaultPolicy('workspace', {
      workspaceRoots: [workspaceDir],
      sessionTmpDir: path.join(workspaceDir, '.tmp'),
      extraDenyRead: [secretFile],
    });
    provider = new SandboxRuntimeProvider();
    const status = await provider.initialize(policy);
    expect(status.backend).toBe('seatbelt');
    expect(status.filesystem).toBe('enforced');
  }, 30000);

  afterAll(async () => {
    await provider?.dispose();
    if (workspaceDir) fs.rmSync(workspaceDir, { recursive: true, force: true });
    if (outsideDir) fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('allows writes inside the workspace', async () => {
    const target = path.join(workspaceDir, 'inside.txt');
    const r = await runContained(provider, workspaceDir, `echo hi > "${target}"`);
    expect(r.code).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
  }, 20000);

  it('denies writes outside the workspace', async () => {
    const target = path.join(outsideDir, 'nope.txt');
    const r = await runContained(provider, workspaceDir, `echo hi > "${target}"`);
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  }, 20000);

  it('denies reading a denied secret file', async () => {
    const r = await runContained(provider, workspaceDir, `cat "${secretFile}"`);
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain('TOPSECRET');
  }, 20000);

  it('still allows reading normal files in the workspace', async () => {
    const readme = path.join(workspaceDir, 'README.md');
    fs.writeFileSync(readme, 'hello sandbox');
    const r = await runContained(provider, workspaceDir, `cat "${readme}"`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('hello sandbox');
  }, 20000);

  it('scrubs credential environment variables from the child', async () => {
    const prev = process.env['GITHUB_TOKEN'];
    process.env['GITHUB_TOKEN'] = 'ghp_should_not_leak';
    try {
      // $GITHUB_TOKEN is literal here (single-quoted JS string, not a template).
      const r = await runContained(provider, workspaceDir, 'echo "tok=[$GITHUB_TOKEN]"');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('tok=[]');
      expect(r.stdout).not.toContain('ghp_should_not_leak');
    } finally {
      if (prev === undefined) delete process.env['GITHUB_TOKEN'];
      else process.env['GITHUB_TOKEN'] = prev;
    }
  }, 20000);

  // Must run last: it re-initializes the provider with a looser policy.
  it('applies a re-initialized policy (rung change is not a silent no-op)', async () => {
    const target = path.join(outsideDir, 'reinit.txt');

    // Under the current workspace policy, writing outside is denied.
    const denied = await runContained(provider, workspaceDir, `echo hi > "${target}"`);
    expect(denied.code).not.toBe(0);
    expect(fs.existsSync(target)).toBe(false);

    // Re-initialize with outsideDir added as a writable root; the write must now
    // succeed, proving reset()+initialize() actually applied the new policy.
    const loosened = buildDefaultPolicy('workspace', {
      workspaceRoots: [workspaceDir, outsideDir],
      sessionTmpDir: path.join(workspaceDir, '.tmp'),
      extraDenyRead: [secretFile],
    });
    const status = await provider.initialize(loosened);
    expect(status.backend).toBe('seatbelt');

    const allowed = await runContained(provider, workspaceDir, `echo hi > "${target}"`);
    expect(allowed.code).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
  }, 30000);
});
