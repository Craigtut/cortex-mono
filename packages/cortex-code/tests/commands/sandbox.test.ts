import { describe, it, expect, vi } from 'vitest';
import type { SandboxPolicy, SandboxStatus } from '@animus-labs/cortex';
import { sandboxCommand, formatSandboxStatus, type SandboxStatusView } from '../../src/commands/sandbox.js';
import type { CommandSession } from '../../src/commands/index.js';

function policyFixture(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    rung: 'workspace',
    filesystem: {
      writableRoots: ['/work/project', '/tmp'],
      denyRead: ['/home/u/.ssh', '/home/u/.aws'],
      denyWrite: ['/home/u/.zshrc'],
    },
    network: {
      mode: 'allowlist',
      allowedDomains: ['registry.npmjs.org', 'github.com'],
      deniedDomains: [],
      allowLocalBinding: true,
    },
    ...overrides,
  };
}

function statusFixture(overrides: Partial<SandboxStatus> = {}): SandboxStatus {
  return {
    filesystem: 'enforced',
    network: 'enforced',
    backend: 'seatbelt',
    degradations: [],
    ...overrides,
  };
}

function viewFixture(overrides: Partial<SandboxStatusView> = {}): SandboxStatusView {
  return {
    rung: 'workspace',
    configEnabled: true,
    status: statusFixture(),
    policy: policyFixture(),
    grants: { persisted: [], session: [] },
    ...overrides,
  };
}

describe('formatSandboxStatus', () => {
  it('prints the full effective policy for an enforced contained rung', () => {
    const out = formatSandboxStatus(
      viewFixture({
        grants: { persisted: ['api.example.com'], session: ['staging.local'] },
      }),
    );
    expect(out).toContain('Rung: workspace');
    expect(out).not.toContain('NOT ENFORCED');
    expect(out).toContain('Backend: seatbelt');
    expect(out).toContain('Filesystem: enforced');
    expect(out).toContain('Network: enforced (allowlist)');
    expect(out).toContain('/work/project');
    expect(out).toContain('Denied reads: 2 paths');
    expect(out).toContain('Allowed domains: 2 pre-approved');
    expect(out).toContain('api.example.com (always)');
    expect(out).toContain('staging.local (session)');
    expect(out).toContain('Degradations: none');
  });

  it('shouts when a contained rung is not actually enforced', () => {
    const out = formatSandboxStatus(
      viewFixture({
        status: statusFixture({
          filesystem: 'none',
          network: 'none',
          backend: 'none',
          degradations: ['OS sandbox not available on win32; commands run uncontained'],
        }),
      }),
    );
    expect(out).toContain('Rung: workspace (NOT ENFORCED)');
    expect(out).toContain('Backend: none');
    expect(out).toContain('OS sandbox not available on win32');
  });

  it('describes the restricted rung as read-only with no egress', () => {
    const out = formatSandboxStatus(
      viewFixture({
        rung: 'restricted',
        policy: policyFixture({
          rung: 'restricted',
          filesystem: { writableRoots: [], denyRead: ['/home/u/.ssh'], denyWrite: [] },
          network: { mode: 'deny', allowedDomains: [], deniedDomains: [], allowLocalBinding: true },
        }),
      }),
    );
    expect(out).toContain('Rung: restricted');
    expect(out).toContain('Writable roots: none (read-only)');
    expect(out).toContain('Network: enforced (all egress blocked)');
    expect(out).toContain('Allowed domains: none');
  });

  it('describes off plainly, with the way back', () => {
    const out = formatSandboxStatus(viewFixture({ rung: 'off', status: undefined, policy: undefined }));
    expect(out).toContain('Rung: off (no containment)');
    expect(out).toContain('full user access');
    expect(out).toContain('/sandbox workspace');
  });

  it('attributes off to the config kill switch when disabled there', () => {
    const out = formatSandboxStatus(
      viewFixture({ rung: 'off', configEnabled: false, status: undefined, policy: undefined }),
    );
    expect(out).toContain('disabled by config: sandbox.enabled=false');
    expect(out).not.toContain('/sandbox workspace');
  });
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface FakeSetup {
  session: CommandSession;
  notifications: Array<{ title: string; message: string }>;
  overlays: unknown[];
  setSandboxRung: ReturnType<typeof vi.fn>;
}

function makeFakeSession(overrides: Record<string, unknown> = {}): FakeSetup {
  const notifications: Array<{ title: string; message: string }> = [];
  const overlays: unknown[] = [];
  const setSandboxRung = vi.fn(async () => ({ changed: true }));
  const app = {
    transcript: {
      addNotification: (title: string, message: string) => notifications.push({ title, message }),
    },
    tui: {
      showOverlay: vi.fn((box: unknown) => {
        overlays.push(box);
        return { hide: vi.fn() };
      }),
    },
    focusEditor: vi.fn(),
  };
  const session = {
    getApp: () => app,
    getSandboxRung: () => 'workspace',
    isSandboxConfigEnabled: () => true,
    getSandboxStatus: () => statusFixture(),
    getSandboxPolicy: () => policyFixture(),
    getNetworkGrantInfo: () => ({ persisted: [], session: [] }),
    setSandboxRung,
    ...overrides,
  };
  // Only the members /sandbox reads; the rest of the session is never reached.
  return { session: session as unknown as CommandSession, notifications, overlays, setSandboxRung };
}

/** Reach the SelectList inside a captured OverlayBox. */
function overlayList(overlay: unknown): {
  onSelect?: (item: { value: string; label: string }) => void;
  onCancel?: () => void;
} {
  return (overlay as { innerComponent: ReturnType<typeof overlayList> }).innerComponent;
}

describe('sandboxCommand handler', () => {
  it('prints the status report with no argument', async () => {
    const { session, notifications, setSandboxRung } = makeFakeSession();
    await sandboxCommand.handler(session, []);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.title).toBe('Sandbox');
    expect(notifications[0]!.message).toContain('Rung: workspace');
    expect(setSandboxRung).not.toHaveBeenCalled();
  });

  it('prints the status report for the explicit status argument', async () => {
    const { session, notifications } = makeFakeSession();
    await sandboxCommand.handler(session, ['status']);
    expect(notifications[0]!.message).toContain('Backend: seatbelt');
  });

  it('rejects an unknown argument with usage', async () => {
    const { session, notifications, setSandboxRung } = makeFakeSession();
    await sandboxCommand.handler(session, ['yolo']);
    expect(notifications[0]!.message).toContain('Usage: /sandbox');
    expect(setSandboxRung).not.toHaveBeenCalled();
  });

  it('applies a contained rung change directly and confirms honestly', async () => {
    const { session, notifications, setSandboxRung, overlays } = makeFakeSession();
    await sandboxCommand.handler(session, ['trusted']);
    expect(setSandboxRung).toHaveBeenCalledWith('trusted');
    expect(overlays).toHaveLength(0);
    expect(notifications[0]!.message).toContain('Rung set to trusted (seatbelt)');
  });

  it('reports when a rung change lands without OS enforcement', async () => {
    const { session, notifications } = makeFakeSession({
      getSandboxStatus: () =>
        statusFixture({ backend: 'none', filesystem: 'none', network: 'none', degradations: ['no backend'] }),
    });
    await sandboxCommand.handler(session, ['restricted']);
    expect(notifications[0]!.message).toContain('OS enforcement is unavailable');
    expect(notifications[0]!.message).toContain('no backend');
  });

  it('relays the reason when the session refuses the change', async () => {
    const { session, notifications } = makeFakeSession({
      setSandboxRung: vi.fn(async () => ({ changed: false, reason: 'Sandbox is already at the workspace rung.' })),
    });
    await sandboxCommand.handler(session, ['workspace']);
    expect(notifications[0]!.message).toBe('Sandbox is already at the workspace rung.');
  });

  it('asks for confirmation before turning the sandbox off', async () => {
    const { session, notifications, setSandboxRung, overlays } = makeFakeSession();
    const done = sandboxCommand.handler(session, ['off']);
    expect(overlays).toHaveLength(1);
    expect(setSandboxRung).not.toHaveBeenCalled();

    overlayList(overlays[0]).onSelect?.({ value: 'confirm', label: '' });
    await done;

    expect(setSandboxRung).toHaveBeenCalledWith('off');
    expect(notifications[0]!.message).toContain('Containment is off');
  });

  it('does nothing when the off confirmation is cancelled', async () => {
    const { session, notifications, setSandboxRung, overlays } = makeFakeSession();
    const done = sandboxCommand.handler(session, ['off']);
    overlayList(overlays[0]).onSelect?.({ value: 'cancel', label: '' });
    await done;
    expect(setSandboxRung).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(0);
  });

  it('skips the confirmation when already off', async () => {
    const alreadyOff = vi.fn(async () => ({ changed: false, reason: 'Sandbox is already at the off rung.' }));
    const { session, overlays, notifications } = makeFakeSession({
      getSandboxRung: () => 'off',
      setSandboxRung: alreadyOff,
    });
    await sandboxCommand.handler(session, ['off']);
    expect(overlays).toHaveLength(0);
    expect(alreadyOff).toHaveBeenCalledWith('off');
    expect(notifications[0]!.message).toContain('already');
  });
});
