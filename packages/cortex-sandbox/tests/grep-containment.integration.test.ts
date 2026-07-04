/**
 * End-to-end proof that the Grep tool respects the OS sandbox boundary, driven
 * against a REAL provider (not a mock). This is the one test that exercises the
 * actual kernel denial: it builds a real SandboxRuntimeProvider, initializes a
 * policy that denyReads a real secret file, and runs the real createGrepTool()
 * execute(). It guards the critical regression where Grep's in-process JS
 * fallback would swallow the sandbox's denial and read the secret anyway.
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
import { createGrepTool } from '@animus-labs/cortex';
import { SandboxRuntimeProvider, buildDefaultPolicy } from '../src/index.js';

const ENFORCEABLE = process.platform === 'darwin' || process.platform === 'linux';

const readText = (result: { content: Array<{ type: string }> }): string =>
  (result.content[0] as { type: 'text'; text: string }).text;

describe.skipIf(!ENFORCEABLE)('Grep containment against a real OS sandbox', () => {
  it('denies reading a denyRead secret through the real Grep tool, without falling back', async () => {
    const SECRET = 'SUPERSECRET_AKIA_DO_NOT_LEAK';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-grep-integ-'));
    const ws = path.join(root, 'ws');
    const vault = path.join(root, 'vault');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(vault, { recursive: true });
    const wsFile = path.join(ws, 'code.txt');
    const secretFile = path.join(vault, 'credentials');
    fs.writeFileSync(wsFile, 'line with WORKSPACE_TOKEN here\n');
    fs.writeFileSync(secretFile, `aws_secret = ${SECRET}\n`);

    const provider = new SandboxRuntimeProvider();
    try {
      const status = await provider.initialize(
        buildDefaultPolicy('workspace', {
          workspaceRoots: [ws],
          home: os.homedir(),
          sessionTmpDir: path.join(root, 'tmp'),
          extraDenyRead: [secretFile],
        }),
      );
      // Host cannot actually enforce (e.g. bubblewrap userns unavailable): there
      // is no boundary to test, so soft-return rather than assert a false pass.
      if (status.filesystem !== 'enforced') return;

      const grep = createGrepTool({ defaultCwd: ws, sandbox: provider });

      // Content search of the denyRead secret: the kernel denies ripgrep the
      // read, and the tool must NOT fall back to an in-process fs read.
      const denied = await grep.execute({
        pattern: SECRET,
        path: secretFile,
        output_mode: 'content',
      });
      expect(readText(denied)).not.toContain(SECRET);
      expect(denied.details.usingFallback).toBe(false);

      // A normal workspace search still returns matches (not over-restricted).
      const allowed = await grep.execute({
        pattern: 'WORKSPACE_TOKEN',
        path: wsFile,
        output_mode: 'content',
      });
      expect(readText(allowed)).toContain('WORKSPACE_TOKEN');
    } finally {
      await provider.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
