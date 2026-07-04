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

  it('defaults a fresh workspace to Workspace and remembers it', async () => {
    const { session } = makeSession();

    expect(await resolveRung(session)).toBe('workspace');
    expect(readPersistedRung()).toBe('workspace');
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
