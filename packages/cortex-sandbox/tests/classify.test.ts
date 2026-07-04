import { describe, it, expect } from 'vitest';
import { denialFromViolations, denialFromFailureHeuristic } from '../src/classify.js';
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
    expect(denialFromFailureHeuristic(failure({ exitCode: 0, stderr: 'Permission denied' }))).toBeNull();
    expect(denialFromFailureHeuristic(failure({ exitCode: null, stderr: 'Permission denied' }))).toBeNull();
  });

  it('returns null when stderr carries no denial marker', () => {
    expect(denialFromFailureHeuristic(failure({ stderr: 'error: tests failed (3 of 7)' }))).toBeNull();
  });

  it('attributes a read-only filesystem error to filesystem-write', () => {
    const denial = denialFromFailureHeuristic(
      failure({ stderr: 'touch: /etc/x: Read-only file system' }),
    );
    expect(denial?.dimension).toBe('filesystem-write');
    expect(denial?.escalatable).toBe(true);
  });

  it('attributes unreachable-network and DNS failures to network', () => {
    expect(
      denialFromFailureHeuristic(failure({ stderr: 'connect: Network is unreachable' }))?.dimension,
    ).toBe('network');
    expect(
      denialFromFailureHeuristic(
        failure({ stderr: 'Temporary failure in name resolution' }),
      )?.dimension,
    ).toBe('network');
  });

  it('reports generic permission errors with unknown dimension', () => {
    const denial = denialFromFailureHeuristic(
      failure({ stderr: 'mkdir: cannot create directory: Permission denied' }),
    );
    expect(denial?.dimension).toBe('unknown');
    expect(denial?.detail).toContain('Permission denied');
  });

  it('recognizes bare errno markers', () => {
    expect(denialFromFailureHeuristic(failure({ stderr: 'spawn EACCES' }))).not.toBeNull();
    expect(denialFromFailureHeuristic(failure({ stderr: 'EPERM: operation not permitted' }))).not.toBeNull();
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
