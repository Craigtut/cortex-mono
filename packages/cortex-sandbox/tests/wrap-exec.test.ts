import { describe, it, expect, vi, afterEach } from 'vitest';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import {
  SandboxRuntimeProvider,
  singleQuoteShellToken,
  composeShellCommand,
} from '../src/provider.js';
import type { SandboxStatus } from '@animus-labs/cortex';

// wrapExec only reads currentStatus.backend to decide pass-through vs wrap.
// Poke the private status so the wrapping branch runs on any platform, without
// standing up a real OS backend (Seatbelt/bubblewrap are platform-specific and
// would otherwise force this test to skip on CI).
function forceEnforced(
  provider: SandboxRuntimeProvider,
  backend: SandboxStatus['backend'] = 'seatbelt',
): void {
  (provider as unknown as { currentStatus: SandboxStatus }).currentStatus = {
    filesystem: 'enforced',
    network: 'enforced',
    backend,
    degradations: [],
  };
}

describe('shell quoting (composeShellCommand / singleQuoteShellToken)', () => {
  it('wraps a plain token in single quotes', () => {
    expect(singleQuoteShellToken('AKIA')).toBe("'AKIA'");
  });

  it('escapes an embedded single quote by closing, escaping, and reopening', () => {
    // a'b  ->  'a'\''b'  (close quote, escaped literal quote, reopen quote)
    expect(singleQuoteShellToken("a'b")).toBe("'a'\\''b'");
  });

  it('neutralizes spaces and shell metacharacters', () => {
    for (const meta of ['$HOME', '`id`', 'a;rm -rf /', 'x&&y', 'a|b', '>out', '*.ts', 'a b c']) {
      // The result is the token verbatim inside single quotes, so a shell
      // parses it as one literal argument with no expansion or command run.
      expect(singleQuoteShellToken(meta)).toBe(`'${meta}'`);
    }
  });

  it('composes a command by single-quoting every token and joining with spaces', () => {
    expect(composeShellCommand('/bin/rg', ['--hidden', 'pat tern', '/a/b'])).toBe(
      "'/bin/rg' '--hidden' 'pat tern' '/a/b'",
    );
  });

  it('composes safely even when a path or pattern contains a single quote', () => {
    expect(composeShellCommand('/bin/rg', ["it's", "/x'y"])).toBe(
      "'/bin/rg' 'it'\\''s' '/x'\\''y'",
    );
  });
});

describe('SandboxRuntimeProvider.wrapExec', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through unchanged when the sandbox is not enforcing', async () => {
    // A fresh provider has backend 'none' (not initialized), so wrapExec must
    // return the invocation untouched, exactly like having no sandbox.
    const provider = new SandboxRuntimeProvider();
    const spy = vi.spyOn(SandboxManager, 'wrapWithSandboxArgv');

    const wrapped = await provider.wrapExec({
      file: '/bin/rg',
      args: ['AKIA', '/home/me/.aws/credentials'],
      cwd: '/work',
      env: { PATH: '/usr/bin' },
    });

    expect(wrapped).toEqual({
      file: '/bin/rg',
      args: ['AKIA', '/home/me/.aws/credentials'],
      env: { PATH: '/usr/bin' },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('composes a single-quoted command and hands it to the runtime when enforcing', async () => {
    const spy = vi
      .spyOn(SandboxManager, 'wrapWithSandboxArgv')
      .mockResolvedValue({
        argv: ['/usr/bin/sandbox-exec', '-p', '(profile)', '/bin/sh', '-c', 'rg ...'],
        env: {} as NodeJS.ProcessEnv,
      });

    const provider = new SandboxRuntimeProvider();
    forceEnforced(provider);

    const args = ["pat'tern", '/a b/c', '$HOME'];
    const env = { PATH: '/usr/bin' };
    const wrapped = await provider.wrapExec({ file: '/bin/rg', args, cwd: '/work', env });

    // The bare argv is composed into a fully single-quoted command string and
    // passed to the runtime with no explicit shell (default shell).
    expect(spy).toHaveBeenCalledTimes(1);
    const [commandArg, shellArg] = spy.mock.calls[0]!;
    expect(commandArg).toBe(composeShellCommand('/bin/rg', args));
    expect(shellArg).toBeUndefined();

    // The wrapped invocation is the runtime's argv, split into file + args, with
    // the caller's env carried through unchanged.
    expect(wrapped.file).toBe('/usr/bin/sandbox-exec');
    expect(wrapped.args).toEqual(['-p', '(profile)', '/bin/sh', '-c', 'rg ...']);
    expect(wrapped.env).toBe(env);
  });
});
