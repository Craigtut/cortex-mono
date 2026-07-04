import { describe, it, expect } from 'vitest';
import {
  WindowsRestrictedTokenProvider,
  serializeWindowsPolicy,
  buildHelperInvocation,
  WINDOWS_POLICY_VERSION,
  DEFAULT_CAPABILITY_SID_NAME,
} from '../src/windows.js';
import { createSandboxProvider } from '../src/factory.js';
import { SandboxRuntimeProvider } from '../src/provider.js';
import { buildDefaultPolicy } from '../src/policy.js';
import type { SandboxPolicy, SandboxSpawnSpec } from '@animus-labs/cortex';

// All deterministic and platform-independent: the pure policy/argv logic and the
// provider's honest-status behavior are exercised without a Windows host or the
// helper binary. The Rust helper itself cannot be built or run here.

const WS_ROOT = 'C:\\Users\\dev\\project';
const SBX_TEMP = 'C:\\Users\\dev\\AppData\\Local\\Temp\\cortex-sbx-abc';

function windowsWorkspacePolicy(): SandboxPolicy {
  // buildDefaultPolicy canonicalizes via realpath; these Windows paths do not
  // exist on the test host, so they pass through verbatim (realpath no-ops).
  return buildDefaultPolicy('workspace', {
    workspaceRoots: [WS_ROOT],
    home: 'C:\\Users\\dev',
    sessionTmpDir: SBX_TEMP,
  });
}

function spec(overrides: Partial<SandboxSpawnSpec> = {}): SandboxSpawnSpec {
  return {
    shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    shellArgs: ['-NoProfile', '-NonInteractive', '-Command'],
    command: 'Get-ChildItem; $__ec=$LASTEXITCODE',
    cwd: WS_ROOT,
    env: { PATH: 'C:\\Windows\\System32', GITHUB_TOKEN: 'ghp_secret', HOME: 'C:\\Users\\dev' },
    ...overrides,
  };
}

describe('serializeWindowsPolicy', () => {
  it('projects the policy into the helper contract with the version stamp', () => {
    const json = serializeWindowsPolicy(windowsWorkspacePolicy(), {
      sandboxTemp: SBX_TEMP,
      capabilitySidName: 'cortex-sandbox-install-42',
      lowIntegrity: true,
    });
    expect(json.version).toBe(WINDOWS_POLICY_VERSION);
    expect(json.capabilitySidName).toBe('cortex-sandbox-install-42');
    expect(json.lowIntegrity).toBe(true);
    expect(json.writableRoots).toContain(WS_ROOT);
    expect(json.sandboxTemp).toBe(SBX_TEMP);
    // Secret stores and persistence targets flow through from the default policy.
    expect(json.denyReadPaths.some((p) => p.endsWith('.ssh'))).toBe(true);
    expect(json.denyWritePaths.some((p) => p.endsWith('.gitconfig'))).toBe(true);
  });

  it('appends the sandbox temp to writableRoots when the policy omits it', () => {
    const policy = windowsWorkspacePolicy();
    policy.filesystem.writableRoots = [WS_ROOT]; // no temp
    const json = serializeWindowsPolicy(policy, {
      sandboxTemp: SBX_TEMP,
      capabilitySidName: 'x',
      lowIntegrity: true,
    });
    expect(json.writableRoots).toEqual([WS_ROOT, SBX_TEMP]);
  });

  it('does not duplicate the sandbox temp when already present', () => {
    const policy = windowsWorkspacePolicy();
    policy.filesystem.writableRoots = [WS_ROOT, SBX_TEMP];
    const json = serializeWindowsPolicy(policy, {
      sandboxTemp: SBX_TEMP,
      capabilitySidName: 'x',
      lowIntegrity: false,
    });
    expect(json.writableRoots.filter((r) => r === SBX_TEMP)).toHaveLength(1);
    expect(json.lowIntegrity).toBe(false);
  });

  it('is JSON-round-trippable (no undefined or non-serializable fields)', () => {
    const json = serializeWindowsPolicy(windowsWorkspacePolicy(), {
      sandboxTemp: SBX_TEMP,
      capabilitySidName: 'x',
      lowIntegrity: true,
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe('buildHelperInvocation', () => {
  it('puts the policy file first, then -- then shell+args+command', () => {
    const wrapped = buildHelperInvocation({
      helperPath: 'C:\\cortex\\helper.exe',
      policyFilePath: 'C:\\Temp\\policy.json',
      spec: spec(),
      scrubEnv: (e) => e,
    });
    expect(wrapped.file).toBe('C:\\cortex\\helper.exe');
    expect(wrapped.args).toEqual([
      'C:\\Temp\\policy.json',
      '--',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-ChildItem; $__ec=$LASTEXITCODE',
    ]);
  });

  it('runs env through the scrubber', () => {
    const wrapped = buildHelperInvocation({
      helperPath: 'h.exe',
      policyFilePath: 'p.json',
      spec: spec(),
      scrubEnv: (e) => {
        const { GITHUB_TOKEN: _drop, ...rest } = e;
        return rest;
      },
    });
    expect(wrapped.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(wrapped.env['PATH']).toBe('C:\\Windows\\System32');
  });

  it('preserves the -- separator so a command starting with a dash is not read as a flag', () => {
    const wrapped = buildHelperInvocation({
      helperPath: 'h.exe',
      policyFilePath: 'p.json',
      spec: spec({ command: '--version' }),
      scrubEnv: (e) => e,
    });
    // Everything after the first '--' is the command tail, verbatim.
    const sep = wrapped.args.indexOf('--');
    expect(sep).toBe(1);
    expect(wrapped.args[wrapped.args.length - 1]).toBe('--version');
  });
});

describe('WindowsRestrictedTokenProvider.initialize (honest status)', () => {
  it('reports filesystem enforced + network none when the helper is present (on win32)', async () => {
    let writtenJson: string | undefined;
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'C:\\cortex\\helper.exe',
      capabilitySidName: 'cortex-sandbox-install-7',
      fileExists: () => true,
      writePolicyFile: (json) => {
        writtenJson = json;
        return 'C:\\Temp\\policy.json';
      },
      removePolicyFile: () => {},
    });
    // Force the win32 branch regardless of the host running the test.
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const status = await provider.initialize(windowsWorkspacePolicy());
      expect(status.backend).toBe('win-restricted-token');
      expect(status.filesystem).toBe('enforced');
      expect(status.network).toBe('none');
      expect(status.degradations.join(' ')).toMatch(/network/i);
      expect(writtenJson).toBeDefined();
      expect(JSON.parse(writtenJson as string).capabilitySidName).toBe('cortex-sandbox-install-7');
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });

  it('reports fully uncontained none when the helper binary is absent (on win32)', async () => {
    const degraded: string[][] = [];
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'C:\\cortex\\missing.exe',
      fileExists: () => false,
      onDegraded: (d) => degraded.push(d),
    });
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const status = await provider.initialize(windowsWorkspacePolicy());
      expect(status.backend).toBe('none');
      expect(status.filesystem).toBe('none');
      expect(status.network).toBe('none');
      expect(status.degradations[0]).toMatch(/helper not found/i);
      expect(degraded).toHaveLength(1);
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });

  it('reports uncontained none on a non-win32 platform', async () => {
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'C:\\cortex\\helper.exe',
      fileExists: () => true,
    });
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const status = await provider.initialize(windowsWorkspacePolicy());
      expect(status.backend).toBe('none');
      expect(status.degradations[0]).toMatch(/win32-only/i);
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });
});

describe('WindowsRestrictedTokenProvider.wrapSpawn', () => {
  async function enforcingProvider(): Promise<WindowsRestrictedTokenProvider> {
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'C:\\cortex\\helper.exe',
      fileExists: () => true,
      writePolicyFile: () => 'C:\\Temp\\policy.json',
      removePolicyFile: () => {},
    });
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await provider.initialize(windowsWorkspacePolicy());
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
    return provider;
  }

  it('wraps through the helper and scrubs credential env vars from the child', async () => {
    const provider = await enforcingProvider();
    const wrapped = await provider.wrapSpawn(spec());
    expect(wrapped.file).toBe('C:\\cortex\\helper.exe');
    expect(wrapped.args[0]).toBe('C:\\Temp\\policy.json');
    expect(wrapped.args[1]).toBe('--');
    // GITHUB_TOKEN is a default credential var, scrubbed from the child.
    expect(wrapped.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(wrapped.env['PATH']).toBe('C:\\Windows\\System32');
  });

  it('passes the command through unwrapped when not enforcing', async () => {
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'C:\\cortex\\missing.exe',
      fileExists: () => false,
    });
    // No initialize / helper absent => backend none => pass-through.
    const wrapped = await provider.wrapSpawn(spec());
    expect(wrapped.file).toBe(spec().shell);
    expect(wrapped.args).toEqual([...spec().shellArgs, spec().command]);
    expect(wrapped.env).toEqual(spec().env);
  });
});

describe('WindowsRestrictedTokenProvider.classifyFailure', () => {
  async function enforcing(): Promise<WindowsRestrictedTokenProvider> {
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'h.exe',
      fileExists: () => true,
      writePolicyFile: () => 'p.json',
      removePolicyFile: () => {},
    });
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await provider.initialize(windowsWorkspacePolicy());
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
    return provider;
  }

  it('attributes an access-denied stderr to a filesystem-write denial', async () => {
    const provider = await enforcing();
    const denial = provider.classifyFailure({
      command: 'echo x > C:\\Windows\\y.txt',
      exitCode: 1,
      stderr: 'Access is denied.',
      stdout: '',
    });
    expect(denial?.dimension).toBe('filesystem-write');
    expect(denial?.escalatable).toBe(true);
  });

  it('returns null for a clean exit and for unrelated stderr', async () => {
    const provider = await enforcing();
    expect(
      provider.classifyFailure({ command: 'x', exitCode: 0, stderr: 'Access is denied.', stdout: '' }),
    ).toBeNull();
    expect(
      provider.classifyFailure({ command: 'x', exitCode: 1, stderr: 'command not found', stdout: '' }),
    ).toBeNull();
  });
});

describe('createSandboxProvider factory', () => {
  it('returns the Windows provider on win32', () => {
    const p = createSandboxProvider({ helperPath: 'h.exe', fileExists: () => true }, 'win32');
    expect(p).toBeInstanceOf(WindowsRestrictedTokenProvider);
  });

  it('returns the sandbox-runtime provider on darwin and linux', () => {
    expect(createSandboxProvider({}, 'darwin')).toBeInstanceOf(SandboxRuntimeProvider);
    expect(createSandboxProvider({}, 'linux')).toBeInstanceOf(SandboxRuntimeProvider);
  });

  it('falls back to the sandbox-runtime provider on an unknown platform', () => {
    expect(createSandboxProvider({}, 'freebsd' as NodeJS.Platform)).toBeInstanceOf(
      SandboxRuntimeProvider,
    );
  });

  it('defaults the capability SID name when the consumer omits it', async () => {
    let writtenJson = '';
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'h.exe',
      fileExists: () => true,
      writePolicyFile: (json) => {
        writtenJson = json;
        return 'p.json';
      },
      removePolicyFile: () => {},
    });
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await provider.initialize(windowsWorkspacePolicy());
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
    expect(JSON.parse(writtenJson).capabilitySidName).toBe(DEFAULT_CAPABILITY_SID_NAME);
  });
});
