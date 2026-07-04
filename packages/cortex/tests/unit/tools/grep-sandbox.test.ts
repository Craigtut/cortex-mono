import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createGrepTool } from '../../../src/tools/grep.js';
import type {
  SandboxProvider,
  SandboxExecSpec,
  WrappedSpawn,
} from '../../../src/sandbox/types.js';

// A provider whose wrapExec RECORDS the spec and returns the invocation
// UNCHANGED, so the real bundled ripgrep still runs and stdout parsing is
// exercised end to end. The Grep tool only ever calls wrapExec; the remaining
// members are no-op stubs to satisfy the SandboxProvider contract.
function makeRecordingProvider(overrides?: {
  wrapExec?: SandboxProvider['wrapExec'];
}): { provider: SandboxProvider; calls: SandboxExecSpec[] } {
  const calls: SandboxExecSpec[] = [];
  const provider: SandboxProvider = {
    async initialize() {
      return { filesystem: 'enforced', network: 'enforced', backend: 'seatbelt', degradations: [] };
    },
    async wrapSpawn(spec) {
      return { file: spec.shell, args: [...spec.shellArgs, spec.command], env: spec.env };
    },
    wrapExec:
      overrides && 'wrapExec' in overrides
        ? overrides.wrapExec
        : async (spec: SandboxExecSpec): Promise<WrappedSpawn> => {
            calls.push(spec);
            return { file: spec.file, args: spec.args, env: spec.env };
          },
    async dispose() {},
  };
  return { provider, calls };
}

const readText = (result: { content: Array<{ type: string }> }): string =>
  (result.content[0] as { type: 'text'; text: string }).text;

describe('Grep tool sandbox routing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-grep-sbx-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('routes ripgrep through wrapExec when a provider is present', async () => {
    fs.writeFileSync(path.join(tmpDir, 'match.ts'), 'hello world\n');
    fs.writeFileSync(path.join(tmpDir, 'nomatch.ts'), 'goodbye\n');

    const { provider, calls } = makeRecordingProvider();
    const grep = createGrepTool({ defaultCwd: tmpDir, sandbox: provider });

    const result = await grep.execute({ pattern: 'hello' });

    // The spawn went through the sandbox seam...
    expect(calls).toHaveLength(1);
    const spec = calls[0]!;
    // ...wrapping the bundled ripgrep binary with the search pattern as an arg.
    expect(spec.file).toMatch(/\brg(\.exe)?$/);
    expect(spec.args).toContain('hello');
    // ...and the results are still parsed identically (the wrapper ran rg).
    const text = readText(result);
    expect(text).toContain('match.ts');
    expect(text).not.toContain('nomatch.ts');
    expect(result.details.usingFallback).toBe(false);
  });

  it('passes wrapExec a sanitized env (dangerous vars stripped, PATH kept)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'needle\n');

    const prevLd = process.env['LD_PRELOAD'];
    process.env['LD_PRELOAD'] = '/tmp/evil.so';
    try {
      const { provider, calls } = makeRecordingProvider();
      const grep = createGrepTool({ defaultCwd: tmpDir, sandbox: provider });

      await grep.execute({ pattern: 'needle' });

      expect(calls).toHaveLength(1);
      const env = calls[0]!.env;
      // buildSafeEnv strips loader-injection vars but keeps ordinary ones.
      expect(env['LD_PRELOAD']).toBeUndefined();
      expect(env['PATH']).toBe(process.env['PATH']);
    } finally {
      if (prevLd === undefined) delete process.env['LD_PRELOAD'];
      else process.env['LD_PRELOAD'] = prevLd;
    }
  });

  it('runs ripgrep raw (no wrapExec) when no provider is configured', async () => {
    fs.writeFileSync(path.join(tmpDir, 'match.ts'), 'hello world\n');

    const grep = createGrepTool({ defaultCwd: tmpDir });
    const result = await grep.execute({ pattern: 'hello' });

    const text = readText(result);
    expect(text).toContain('match.ts');
    expect(result.details.usingFallback).toBe(false);
  });

  it('runs ripgrep raw when the provider does not implement wrapExec', async () => {
    fs.writeFileSync(path.join(tmpDir, 'match.ts'), 'hello world\n');

    // A provider (e.g. the scaffolded Windows one) that omits wrapExec must not
    // change behavior: the `sandbox?.wrapExec` guard falls through to a raw run.
    const { provider } = makeRecordingProvider({ wrapExec: undefined });
    const grep = createGrepTool({ defaultCwd: tmpDir, sandbox: provider });

    const result = await grep.execute({ pattern: 'hello' });

    const text = readText(result);
    expect(text).toContain('match.ts');
    expect(result.details.usingFallback).toBe(false);
  });
});
