/**
 * Drives the REAL Session.setSandboxRung / resolveInitialRung so a wiring bug
 * in Session itself (not re-initializing the provider, forgetting to persist
 * the rung, reporting a stale indicator) is caught. Only the OS-touching
 * provider is stubbed; the per-workspace settings store runs for real against
 * a fake home, so persistence is exercised end to end without ever starting a
 * real sandbox backend.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SandboxPolicy, SandboxRung, SandboxStatus } from '@animus-labs/cortex';

// A single lazily-created fake home for the whole file. It must resolve even
// when transitive imports (e.g. logger) call homedir() at module-load time,
// before any beforeEach runs, so it lives on globalThis with no TDZ. Per-test
// isolation comes from a fresh `cwd` each test (workspace settings are keyed
// by a hash of the project path, not by home).
function currentHome(): string {
  const g = globalThis as { __sessionSandboxHome?: string };
  if (!g.__sessionSandboxHome) {
    g.__sessionSandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-sandbox-home-'));
  }
  return g.__sessionSandboxHome;
}
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => currentHome() };
});

import { Session } from '../src/session.js';
import { workspaceSettingsPath } from '../src/permissions/rules.js';

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-sandbox-ws-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

interface StubProvider {
  initialize: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
}

function stubProvider(status: Partial<SandboxStatus> = {}): StubProvider {
  const result: SandboxStatus = {
    filesystem: 'enforced',
    network: 'enforced',
    backend: 'seatbelt',
    degradations: [],
    ...status,
  };
  return {
    initialize: vi.fn(async (_policy: SandboxPolicy) => result),
    dispose: vi.fn(async () => {}),
    status: vi.fn(() => result),
  };
}

function makeSession(config: Record<string, unknown> = {}): {
  session: Session;
  updateStatus: ReturnType<typeof vi.fn>;
} {
  const updateStatus = vi.fn();
  const session = new Session({
    config: config as never,
    mode: { name: 'test', systemPrompt: '', contextSlots: [] } as never,
    model: {} as never,
    provider: 'test',
    modelId: 'test',
    providerManager: {} as never,
    credentialStore: {} as never,
    cwd,
    yoloMode: false,
    initialEffort: 'medium',
    resumeSessionId: undefined,
  });
  (session as unknown as { app: unknown }).app = {
    updateStatus,
    transcript: { addNotification: vi.fn() },
  };
  return { session, updateStatus };
}

/** Put the session into a known sandbox state without running initSandbox. */
function injectSandbox(session: Session, provider: StubProvider | undefined, rung: SandboxRung): void {
  const s = session as unknown as { sandboxProvider: unknown; sandboxRung: SandboxRung };
  s.sandboxProvider = provider;
  s.sandboxRung = rung;
}

function readPersistedRung(): unknown {
  const settings = JSON.parse(fs.readFileSync(workspaceSettingsPath(cwd), 'utf-8')) as {
    sandbox?: { rung?: unknown };
  };
  return settings.sandbox?.rung;
}

describe('Session.setSandboxRung', () => {
  it('re-initializes the provider with the new rung policy and updates the indicator', async () => {
    const { session, updateStatus } = makeSession();
    const provider = stubProvider();
    injectSandbox(session, provider, 'workspace');

    const result = await session.setSandboxRung('trusted');

    expect(result.changed).toBe(true);
    expect(provider.initialize).toHaveBeenCalledTimes(1);
    const policy = provider.initialize.mock.calls[0]![0] as SandboxPolicy;
    expect(policy.rung).toBe('trusted');
    expect(policy.network.mode).toBe('full');
    expect(policy.filesystem.writableRoots).toContain(fs.realpathSync.native(cwd));
    expect(session.getSandboxRung()).toBe('trusted');
    expect(session.getSandboxPolicy()?.rung).toBe('trusted');
    expect(session.getSandboxStatus()?.backend).toBe('seatbelt');
    expect(updateStatus).toHaveBeenCalledWith({
      sandboxRung: 'trusted',
      sandboxEnforcement: 'enforced',
    });
  });

  it('persists the new rung to the per-workspace settings', async () => {
    const { session } = makeSession();
    injectSandbox(session, stubProvider(), 'workspace');

    await session.setSandboxRung('restricted');

    expect(readPersistedRung()).toBe('restricted');
  });

  it('off disposes the provider, clears policy and status, and persists', async () => {
    const { session, updateStatus } = makeSession();
    const provider = stubProvider();
    injectSandbox(session, provider, 'workspace');
    await session.setSandboxRung('trusted');

    const result = await session.setSandboxRung('off');

    expect(result.changed).toBe(true);
    expect(provider.dispose).toHaveBeenCalledTimes(1);
    expect(provider.initialize).toHaveBeenCalledTimes(1); // only the trusted change
    expect(session.getSandboxRung()).toBe('off');
    expect(session.getSandboxPolicy()).toBeUndefined();
    expect(session.getSandboxStatus()).toBeUndefined();
    expect(readPersistedRung()).toBe('off');
    expect(updateStatus).toHaveBeenLastCalledWith({
      sandboxRung: 'off',
      sandboxEnforcement: 'none',
    });
  });

  it('re-initializes containment when coming back from off', async () => {
    const { session, updateStatus } = makeSession();
    const provider = stubProvider();
    injectSandbox(session, provider, 'off');

    const result = await session.setSandboxRung('workspace');

    expect(result.changed).toBe(true);
    expect(provider.initialize).toHaveBeenCalledTimes(1);
    const policy = provider.initialize.mock.calls[0]![0] as SandboxPolicy;
    expect(policy.rung).toBe('workspace');
    expect(policy.network.mode).toBe('allowlist');
    expect(updateStatus).toHaveBeenLastCalledWith({
      sandboxRung: 'workspace',
      sandboxEnforcement: 'enforced',
    });
  });

  it('is a no-op at the same rung', async () => {
    const { session } = makeSession();
    const provider = stubProvider();
    injectSandbox(session, provider, 'workspace');

    const result = await session.setSandboxRung('workspace');

    expect(result.changed).toBe(false);
    expect(result.reason).toContain('already');
    expect(provider.initialize).not.toHaveBeenCalled();
    expect(provider.dispose).not.toHaveBeenCalled();
  });

  it('reports honest degradation when the host cannot enforce', async () => {
    const { session, updateStatus } = makeSession();
    const provider = stubProvider({
      filesystem: 'none',
      network: 'none',
      backend: 'none',
      degradations: ['OS sandbox not available'],
    });
    injectSandbox(session, provider, 'off');

    const result = await session.setSandboxRung('workspace');

    expect(result.changed).toBe(true);
    // The policy is still recorded (it gates WebFetch in-process)...
    expect(session.getSandboxPolicy()?.rung).toBe('workspace');
    // ...but the indicator must not claim enforcement.
    expect(updateStatus).toHaveBeenLastCalledWith({
      sandboxRung: 'workspace',
      sandboxEnforcement: 'none',
    });
  });

  it('maps partial per-dimension enforcement to a partial indicator', async () => {
    const { session, updateStatus } = makeSession();
    const provider = stubProvider({ network: 'none', backend: 'win-restricted-token' });
    injectSandbox(session, provider, 'off');

    await session.setSandboxRung('workspace');

    expect(updateStatus).toHaveBeenLastCalledWith({
      sandboxRung: 'workspace',
      sandboxEnforcement: 'partial',
    });
  });

  it('refuses when the config kill switch is set', async () => {
    const { session } = makeSession({ sandbox: { enabled: false } });
    injectSandbox(session, undefined, 'off');

    const result = await session.setSandboxRung('workspace');

    expect(result.changed).toBe(false);
    expect(result.reason).toContain('disabled by config');
  });

  it('refreshes the model-facing <environment> block immediately on a rung change', async () => {
    const { session } = makeSession();
    injectSandbox(session, stubProvider(), 'workspace');
    // Enough of the agent for updateEphemeralContext: a context manager to
    // receive the ephemeral block plus the token accounting it reads.
    const setEphemeral = vi.fn();
    (session as unknown as { agent: unknown }).agent = {
      getContextManager: () => ({ setEphemeral }),
      effectiveContextWindow: 200_000,
      currentContextTokenCount: 0,
      estimateCurrentContextTokens: () => 0,
    };

    await session.setSandboxRung('trusted');

    expect(setEphemeral).toHaveBeenCalledTimes(1);
    expect(String(setEphemeral.mock.calls[0]![0])).toContain('Sandbox: trusted rung');

    // Off drops the sandbox line entirely rather than showing a stale rung.
    await session.setSandboxRung('off');
    expect(String(setEphemeral.mock.calls.at(-1)![0])).not.toContain('Sandbox:');
  });
});

describe('Session per-session sandbox temp dir', () => {
  it('scopes the writable temp to a cortex-sbx- dir and threads it into the policy', async () => {
    const { session } = makeSession();
    const provider = stubProvider();
    injectSandbox(session, provider, 'off');

    await session.setSandboxRung('workspace');

    const policy = provider.initialize.mock.calls[0]![0] as SandboxPolicy;
    const tmp = policy.filesystem.sessionTmpDir;
    expect(tmp).toBeDefined();
    expect(path.basename(tmp!)).toMatch(/^cortex-sbx-/);
    // It is a real writable root and exists on disk.
    expect(policy.filesystem.writableRoots).toContain(tmp);
    expect(fs.existsSync(tmp!)).toBe(true);

    // Removal is best-effort and idempotent: it sweeps the dir and a second call
    // is a no-op rather than a throw.
    session.removeSessionTmpDir();
    expect(fs.existsSync(tmp!)).toBe(false);
    session.removeSessionTmpDir();
  });

  it('reuses the same session temp dir across rung changes', async () => {
    const { session } = makeSession();
    const provider = stubProvider();
    injectSandbox(session, provider, 'off');

    await session.setSandboxRung('workspace');
    await session.setSandboxRung('trusted');

    const first = (provider.initialize.mock.calls[0]![0] as SandboxPolicy).filesystem.sessionTmpDir;
    const second = (provider.initialize.mock.calls[1]![0] as SandboxPolicy).filesystem.sessionTmpDir;
    expect(first).toBeDefined();
    expect(second).toBe(first);

    session.removeSessionTmpDir();
  });
});

describe('Session.resolveInitialRung (folder-trust default)', () => {
  async function resolveRung(session: Session): Promise<SandboxRung> {
    const s = session as unknown as {
      sandboxSettings: { load(): Promise<void> };
      resolveInitialRung(): Promise<SandboxRung>;
    };
    await s.sandboxSettings.load();
    return s.resolveInitialRung();
  }

  it('defaults a fresh workspace to the platform default and remembers it', async () => {
    const { session } = makeSession();

    // On-by-default everywhere except Windows, where the unsigned Tier-1 helper
    // is opt-in (default 'off' so nothing is spawned until the user opts in).
    const expected = process.platform === 'win32' ? 'off' : 'workspace';
    expect(await resolveRung(session)).toBe(expected);
    expect(readPersistedRung()).toBe(expected);
  });

  it('starts a fresh workspace at the configured default rung', async () => {
    const { session } = makeSession({ sandbox: { rung: 'trusted' } });

    expect(await resolveRung(session)).toBe('trusted');
    expect(readPersistedRung()).toBe('trusted');
  });

  it('prefers the remembered per-workspace rung over the config default', async () => {
    const first = makeSession();
    injectSandbox(first.session, stubProvider(), 'workspace');
    await first.session.setSandboxRung('restricted');

    const second = makeSession({ sandbox: { rung: 'trusted' } });
    expect(await resolveRung(second.session)).toBe('restricted');
  });
});

describe('Session.resolvePermission (sandbox.requireEnforcement refuse-to-run)', () => {
  const NONE: SandboxStatus = { filesystem: 'none', network: 'none', backend: 'none', degradations: ['helper blocked'] };
  const ENFORCED: SandboxStatus = { filesystem: 'enforced', network: 'enforced', backend: 'seatbelt', degradations: [] };
  const PARTIAL: SandboxStatus = { filesystem: 'partial', network: 'none', backend: 'win-restricted-token', degradations: [] };

  function primeSession(
    opts: { requireEnforcement?: boolean; rung: SandboxRung; status: SandboxStatus | undefined },
  ): Session {
    const cfg: Record<string, unknown> = { sandbox: {} };
    if (opts.requireEnforcement !== undefined) {
      (cfg.sandbox as Record<string, unknown>).requireEnforcement = opts.requireEnforcement;
    }
    const { session } = makeSession(cfg);
    const s = session as unknown as {
      sandboxRung: SandboxRung;
      sandboxStatus: SandboxStatus | undefined;
      yoloMode: boolean;
    };
    s.sandboxRung = opts.rung;
    s.sandboxStatus = opts.status;
    s.yoloMode = true; // so a non-refused Bash resolves to allow without prompting
    return session;
  }

  function resolveBash(session: Session): Promise<boolean | { decision: string; reason?: string }> {
    return (
      session as unknown as {
        resolvePermission(n: string, a: unknown): Promise<boolean | { decision: string; reason?: string }>;
      }
    ).resolvePermission('Bash', { command: 'echo hi' });
  }

  it('blocks a shell command at a contained rung when enforcement is required but absent', async () => {
    const session = primeSession({ requireEnforcement: true, rung: 'workspace', status: NONE });
    const result = await resolveBash(session);
    expect(typeof result).toBe('object');
    const r = result as { decision: string; reason?: string };
    expect(r.decision).toBe('block');
    expect(r.reason).toMatch(/requireEnforcement/);
    expect(r.reason).toMatch(/helper blocked/);
  });

  it('does not refuse when the rung is off (uncontained is the chosen state)', async () => {
    const session = primeSession({ requireEnforcement: true, rung: 'off', status: NONE });
    expect(await resolveBash(session)).toBe(true);
  });

  it('does not refuse when a backend is actually enforcing', async () => {
    const session = primeSession({ requireEnforcement: true, rung: 'workspace', status: ENFORCED });
    expect(await resolveBash(session)).toBe(true);
  });

  it('does not refuse a working-but-partial backend (Windows Tier 1 still enforces writes)', async () => {
    const session = primeSession({ requireEnforcement: true, rung: 'workspace', status: PARTIAL });
    expect(await resolveBash(session)).toBe(true);
  });

  it('warn-and-continues by default (requireEnforcement unset) even with no enforcement', async () => {
    const session = primeSession({ rung: 'workspace', status: NONE });
    expect(await resolveBash(session)).toBe(true);
  });
});
