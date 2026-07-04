/**
 * End-to-end proof that scoping the writable temp to a per-session subdir works
 * against a REAL provider (not a mock): a sandboxed shell writing to its default
 * temp dir SUCCEEDS because the provider routes the child's TMPDIR at the one
 * writable session temp, while a write to an unrelated path under the machine
 * temp root is DENIED (that root is no longer writable as a whole).
 *
 * On the sandbox-runtime backend the child's TMPDIR is set by the runtime from
 * CLAUDE_CODE_TMPDIR (not the spawn env); the provider points that var at the
 * scoped session temp during initialize(), so no per-command env trick is needed
 * here.
 *
 * Only macOS Seatbelt and Linux bubblewrap enforce, so the suite skips other
 * platforms, and each test soft-returns when the host cannot actually enforce
 * (e.g. Linux without a usable bubblewrap userns), so CI on an unsupported
 * runner stays green without pretending it verified anything.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { SandboxRuntimeProvider, buildDefaultPolicy } from '../src/index.js';

const ENFORCEABLE = process.platform === 'darwin' || process.platform === 'linux';

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Wrap a shell command through the provider and run it under the real OS boundary. */
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

describe.skipIf(!ENFORCEABLE)('per-session temp containment against a real OS sandbox', () => {
  it('allows a write to the redirected $TMPDIR and denies an unrelated machine-temp write', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-tmpenv-integ-'));
    const ws = path.join(root, 'ws');
    // Named with the shared cortex-sbx- prefix, exactly as the cortex-code
    // session creates it. buildDefaultPolicy canonicalizes it into writableRoots
    // and records it as the sessionTmpDir the provider routes the child at.
    const sessionTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-sbx-'));
    fs.mkdirSync(ws, { recursive: true });

    const provider = new SandboxRuntimeProvider();
    try {
      const status = await provider.initialize(
        buildDefaultPolicy('workspace', {
          workspaceRoots: [ws],
          home: os.homedir(),
          sessionTmpDir: sessionTmp,
        }),
      );
      // Host cannot actually enforce (e.g. bubblewrap userns unavailable): there
      // is no boundary to test, so soft-return rather than assert a false pass.
      if (status.filesystem !== 'enforced') return;

      // (a) Writing to the child's default temp dir succeeds: the runtime points
      // $TMPDIR at the writable session temp, so the write lands in-bounds.
      const probe = await runContained(provider, ws, 'echo hi > "$TMPDIR/probe"');
      expect(probe.code).toBe(0);
      expect(fs.existsSync(path.join(sessionTmp, 'probe'))).toBe(true);

      // (b) An unrelated write directly under the machine temp root is denied:
      // only the session subdir is writable now, not all of the temp root.
      const denyTarget = path.join(os.tmpdir(), `cortex-should-be-denied-${process.pid}`);
      const denied = await runContained(provider, ws, `echo hi > "${denyTarget}"`);
      expect(denied.code).not.toBe(0);
      expect(fs.existsSync(denyTarget)).toBe(false);
    } finally {
      await provider.dispose();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sessionTmp, { recursive: true, force: true });
    }
  }, 30000);
});
