import { describe, it, expect } from 'vitest';
import {
  denialFromViolations,
  denialFromFailureHeuristic,
  type DenialCorroborationContext,
} from '../src/classify.js';
import { SandboxRuntimeProvider } from '../src/provider.js';
import type { SandboxCommandFailure } from '@animus-labs/cortex';

// Pure attribution logic: deterministic and platform-independent, no Seatbelt
// or bubblewrap required.

function failure(overrides: Partial<SandboxCommandFailure> = {}): SandboxCommandFailure {
  return {
    command: 'true; __ec=$?; echo "___CWD___"; pwd; exit $__ec',
    exitCode: 1,
    stderr: '',
    stdout: '',
    ...overrides,
  };
}

function ctx(overrides: Partial<DenialCorroborationContext> = {}): DenialCorroborationContext {
  return {
    denyRead: ['/home/user/.ssh', '/home/user/.aws'],
    denyWrite: ['/home/user/.zshrc', '/workspace/.git/hooks'],
    home: '/home/user',
    ...overrides,
  };
}

describe('denialFromViolations (macOS violation log)', () => {
  it('returns null with no recorded violations', () => {
    expect(denialFromViolations([])).toBeNull();
  });

  it('classifies a file-write violation with operation and target', () => {
    const denial = denialFromViolations([
      { line: 'Sandbox: sh(4242) deny(1) file-write-create /private/etc/blocked' },
    ]);
    expect(denial).toEqual({
      dimension: 'filesystem-write',
      detail: 'file-write-create /private/etc/blocked',
      escalatable: true,
    });
  });

  it('classifies a file-read violation', () => {
    const denial = denialFromViolations([
      { line: 'Sandbox: cat(99) deny(1) file-read-data /Users/u/.ssh/id_ed25519' },
    ]);
    expect(denial?.dimension).toBe('filesystem-read');
    expect(denial?.detail).toContain('/Users/u/.ssh/id_ed25519');
  });

  it('classifies a network violation', () => {
    const denial = denialFromViolations([
      { line: 'Sandbox: curl(7) deny(1) network-outbound *:443' },
    ]);
    expect(denial?.dimension).toBe('network');
  });

  it('falls back to the raw line and unknown dimension for unrecognized shapes', () => {
    const denial = denialFromViolations([{ line: '  something unusual happened  ' }]);
    expect(denial?.dimension).toBe('unknown');
    expect(denial?.detail).toBe('something unusual happened');
  });

  it('prefers a recognizable violation over preceding startup noise', () => {
    // Real Seatbelt trace shape: node probes sysctls (denied, non-fatal)
    // before the write that actually failed the command.
    const denial = denialFromViolations([
      { line: 'Sandbox: node(123) deny(1) sysctl-read kern.iossupportversion' },
      { line: 'Sandbox: node(123) deny(1) file-write-create /Users/u/outside.txt' },
    ]);
    expect(denial?.dimension).toBe('filesystem-write');
    expect(denial?.detail).toBe('file-write-create /Users/u/outside.txt');
  });
});

describe('denialFromFailureHeuristic (Linux stderr heuristic)', () => {
  it('returns null for a successful or signal-terminated command', () => {
    expect(
      denialFromFailureHeuristic(failure({ exitCode: 0, stderr: 'Permission denied' }), ctx()),
    ).toBeNull();
    expect(
      denialFromFailureHeuristic(failure({ exitCode: null, stderr: 'Permission denied' }), ctx()),
    ).toBeNull();
  });

  it('returns null when stderr carries no denial marker', () => {
    expect(
      denialFromFailureHeuristic(failure({ stderr: 'error: tests failed (3 of 7)' }), ctx()),
    ).toBeNull();
  });

  it('attributes a read-only filesystem error to filesystem-write without corroboration', () => {
    const denial = denialFromFailureHeuristic(
      failure({ stderr: 'touch: /etc/x: Read-only file system' }),
      ctx(),
    );
    expect(denial?.dimension).toBe('filesystem-write');
    expect(denial?.escalatable).toBe(true);
  });

  it('attributes unreachable-network and DNS failures to network without corroboration', () => {
    expect(
      denialFromFailureHeuristic(failure({ stderr: 'connect: Network is unreachable' }), ctx())
        ?.dimension,
    ).toBe('network');
    expect(
      denialFromFailureHeuristic(
        failure({ stderr: 'Temporary failure in name resolution' }),
        ctx(),
      )?.dimension,
    ).toBe('network');
  });

  it('does NOT attribute a generic permission error with no corroborating signal', () => {
    // The command touches nothing outside the workspace and no network tool;
    // this shape (missing exec bit, root-owned file) is the classic false
    // positive the corroboration requirement removes.
    expect(
      denialFromFailureHeuristic(
        failure({
          command: 'mkdir data',
          stderr: 'mkdir: cannot create directory: Permission denied',
        }),
        ctx(),
      ),
    ).toBeNull();
    expect(
      denialFromFailureHeuristic(failure({ command: './gradlew build', stderr: 'spawn EACCES' }), ctx()),
    ).toBeNull();
    expect(
      denialFromFailureHeuristic(
        failure({ command: 'npm install', stderr: 'EPERM: operation not permitted' }),
        ctx(),
      ),
    ).toBeNull();
  });

  it('does not corroborate a bare generic marker on a path outside the writable roots', () => {
    // Reads outside the workspace are allowed in-sandbox, so a generic
    // "Permission denied" on an outside path (e.g. cat /etc/shadow, a DAC
    // denial) must not be mistaken for a sandbox block. A real write out there
    // surfaces the distinctive read-only marker, which attributes on its own.
    expect(
      denialFromFailureHeuristic(
        failure({ command: 'touch /etc/blocked', stderr: 'touch: Permission denied' }),
        ctx(),
      ),
    ).toBeNull();
    const readOnly = denialFromFailureHeuristic(
      failure({ command: 'touch /etc/blocked', stderr: 'touch: Read-only file system' }),
      ctx(),
    );
    expect(readOnly?.dimension).toBe('filesystem-write');
  });

  it('does not corroborate a generic marker from a path inside the writable roots', () => {
    expect(
      denialFromFailureHeuristic(
        failure({ command: 'touch /workspace/out.txt', stderr: 'touch: Permission denied' }),
        ctx(),
      ),
    ).toBeNull();
  });

  it('pins the dimension when the referenced path is under a deny set', () => {
    const write = denialFromFailureHeuristic(
      failure({ command: 'cp payload ~/.zshrc', stderr: 'cp: Permission denied' }),
      ctx(),
    );
    expect(write?.dimension).toBe('filesystem-write');
    expect(write?.detail).toContain('write-protected');

    const read = denialFromFailureHeuristic(
      failure({ command: 'cat /home/user/.ssh/id_ed25519', stderr: 'cat: Permission denied' }),
      ctx(),
    );
    expect(read?.dimension).toBe('filesystem-read');
    expect(read?.detail).toContain('read-protected');
  });

  it('corroborates a generic marker with a network tool in command position', () => {
    const denial = denialFromFailureHeuristic(
      failure({ command: 'curl https://example.com/x', stderr: 'curl: (7) EACCES' }),
      ctx(),
    );
    expect(denial?.dimension).toBe('network');
    expect(denial?.detail).toContain('curl');
  });

  it('treats git remote subcommands as network, but not local git', () => {
    expect(
      denialFromFailureHeuristic(
        failure({ command: 'git push origin main', stderr: 'git: Permission denied' }),
        ctx(),
      )?.dimension,
    ).toBe('network');
    expect(
      denialFromFailureHeuristic(
        failure({ command: 'git status', stderr: 'git: Permission denied' }),
        ctx(),
      ),
    ).toBeNull();
  });

  it('does not corroborate from a network tool name in argument position', () => {
    expect(
      denialFromFailureHeuristic(
        failure({ command: 'cat curl', stderr: 'cat: Permission denied' }),
        ctx(),
      ),
    ).toBeNull();
  });

  it('does not corroborate from the program path itself (exec is allowed in-sandbox)', () => {
    expect(
      denialFromFailureHeuristic(
        failure({ command: '/usr/local/bin/tool build', stderr: 'sh: Permission denied' }),
        ctx(),
      ),
    ).toBeNull();
  });

  it('sees a network tool through a wrapper and a shell operator', () => {
    expect(
      denialFromFailureHeuristic(
        failure({ command: 'cd /workspace && sudo curl https://x.dev', stderr: 'EACCES' }),
        ctx(),
      )?.dimension,
    ).toBe('network');
  });

  it('expands ~ against the provided home when checking deny sets', () => {
    const denial = denialFromFailureHeuristic(
      failure({ command: 'ls ~/.aws', stderr: 'ls: Permission denied' }),
      ctx(),
    );
    expect(denial?.dimension).toBe('filesystem-read');
  });
});

describe('SandboxRuntimeProvider.classifyFailure', () => {
  it('never attributes anything while not enforcing (backend none)', () => {
    // Un-initialized provider: spawns pass through unwrapped, so no failure can
    // be the sandbox's doing, whatever stderr says.
    const provider = new SandboxRuntimeProvider();
    expect(provider.classifyFailure(failure({ stderr: 'Permission denied' }))).toBeNull();
  });
});
