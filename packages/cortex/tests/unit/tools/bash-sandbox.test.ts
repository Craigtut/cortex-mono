import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { CwdTracker } from '../../../src/tools/shared/cwd-tracker.js';
import { createBashTool } from '../../../src/tools/bash/index.js';
import type {
  SandboxProvider,
  SandboxSpawnSpec,
  SandboxStatus,
  WrappedSpawn,
} from '../../../src/sandbox/types.js';

/**
 * A fake sandbox provider that records the spawns it is asked to wrap and
 * prepends an observable marker onto the composed command, so a test can prove
 * the Bash tool actually routes execution through wrapSpawn.
 */
function makeFakeProvider() {
  const calls: SandboxSpawnSpec[] = [];
  const provider: SandboxProvider = {
    async initialize(): Promise<SandboxStatus> {
      return { filesystem: 'enforced', network: 'enforced', backend: 'seatbelt', degradations: [] };
    },
    wrapSpawn(spec: SandboxSpawnSpec): WrappedSpawn {
      calls.push(spec);
      const args = [...spec.args];
      // The last arg is the fully-composed command (with the cwd-capture suffix).
      // Prefix a marker so the wrapping is observable without disturbing the suffix.
      args[args.length - 1] = `echo SANDBOXED; ${args[args.length - 1]}`;
      return { file: spec.file, args, env: spec.env };
    },
    async dispose(): Promise<void> {},
  };
  return { provider, calls };
}

describe('Bash tool sandbox seam', () => {
  let cwdTracker: CwdTracker;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-bash-sandbox-'));
    cwdTracker = new CwdTracker(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('leaves execution unchanged when no provider is configured (no-op default)', async () => {
    const tool = createBashTool({ cwdTracker });
    const result = await tool.execute({ command: 'echo plain' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('plain');
    expect(text).not.toContain('SANDBOXED');
    expect(result.details.exitCode).toBe(0);
  });

  it('routes the spawn through the provider when configured', async () => {
    const { provider, calls } = makeFakeProvider();
    const tool = createBashTool({ cwdTracker, sandbox: provider });

    // Capture before execution: the tool resolves symlinks in the tracked cwd
    // after parsing `pwd` output, so getCwd() changes once the command runs.
    const expectedCwd = cwdTracker.getCwd();
    const result = await tool.execute({ command: 'echo hello' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    // The wrapped command ran (marker present) and the original ran too.
    expect(text).toContain('SANDBOXED');
    expect(text).toContain('hello');
    expect(result.details.exitCode).toBe(0);

    // wrapSpawn was invoked once with the resolved shell, args, and cwd.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBeTruthy();
    expect(calls[0]!.args.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]!.cwd).toBe(expectedCwd);

    // The env handed to the provider is already sanitized (injection vectors
    // stripped) and still carries PATH.
    expect(calls[0]!.env['NODE_OPTIONS']).toBeUndefined();
    expect(calls[0]!.env['PATH'] ?? calls[0]!.env['Path']).toBeTruthy();
  });

  it('preserves working-directory tracking through the wrapper', async () => {
    const { provider } = makeFakeProvider();
    const tool = createBashTool({ cwdTracker, sandbox: provider });

    const subDir = path.join(tmpDir, 'nested');
    fs.mkdirSync(subDir);
    await tool.execute({ command: `cd "${subDir}"` });

    expect(cwdTracker.getCwd()).toBe(subDir);
  });
});
