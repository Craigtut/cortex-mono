import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxSession } from '../../../src/sandbox/session.js';

const roots: string[] = [];
const sessions: SandboxSession[] = [];
afterAll(async () => {
  await Promise.all(sessions.map((s) => s.dispose()));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
async function execute(session: SandboxSession, cwd: string, command: string) {
  const wrapped = await session.wrapSpawn({ shell: '/bin/bash', shellArgs: ['-c'], command, cwd, env: { PATH: process.env['PATH'] ?? '' } });
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(wrapped.file, wrapped.args, { cwd, env: wrapped.env, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', resolve);
  });
}

describe.skipIf(process.platform !== 'darwin')('managed runtime process isolation', () => {
  it('isolates roots and lifetime across two simultaneous agents without changing the host environment', async () => {
    const originalTmp = process.env['CLAUDE_CODE_TMPDIR'];
    for (let i = 0; i < 2; i++) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'cortex-process-test-')));
      roots.push(root);
      sessions.push((await SandboxSession.create(true, root))!);
    }
    const [first, second] = sessions as [SandboxSession, SandboxSession];
    const [a, b] = roots as [string, string];
    expect(first.status().filesystem).toBe('enforced');
    expect(second.status().filesystem).toBe('enforced');
    expect(await execute(first, a, `echo yes > '${a}/allowed'`)).toBe(0);
    expect(await execute(first, a, `echo no > '${b}/escape'`)).not.toBe(0);
    expect(existsSync(join(b, 'escape'))).toBe(false);
    await first.dispose();
    expect(await execute(second, b, `echo yes > '${b}/still-active'`)).toBe(0);
    expect(await execute(second, b, `echo no > '${a}/escape'`)).not.toBe(0);
    expect(existsSync(join(a, 'escape'))).toBe(false);
    expect(process.env['CLAUDE_CODE_TMPDIR']).toBe(originalTmp);
  }, 30000);
});
