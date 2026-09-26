/**
 * The permission broker shows one prompt at a time. Tool asks and network
 * asks share one lock, so a burst of parallel tool calls (or a shell command
 * opening several hosts) queues rather than stacking prompts on screen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PermissionBroker } from '../../src/permissions/prompt-broker.js';

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-broker-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

interface PendingPrompt {
  kind: 'tool' | 'network';
  answer: () => void;
}

/** A broker over a fake TUI whose prompts stay open until the test answers them. */
function makeBroker(): { broker: PermissionBroker; open: PendingPrompt[]; maxOpen: () => number } {
  const open: PendingPrompt[] = [];
  let peak = 0;
  const track = (prompt: PendingPrompt) => {
    open.push(prompt);
    peak = Math.max(peak, open.length);
  };
  const settle = (prompt: PendingPrompt) => {
    open.splice(open.indexOf(prompt), 1);
  };
  let ids = 0;
  const broker = new PermissionBroker({
    cwd,
    settingsPath: path.join(cwd, 'settings.json'),
    activity: {
      recordPermissionRequested: () => ({ id: `perm-${++ids}`, written: Promise.resolve() }) as never,
      recordPermissionResolved: async () => {},
      decisionPath: (id: string) => path.join(cwd, `${id}.json`),
      recordError: async () => {},
    },
    // An enforced policy with no allowlist entry, so a network ask prompts.
    sandbox: {
      getStatus: () => undefined,
      getPolicy: () => ({
        network: { mode: 'ask', allowedDomains: [], deniedDomains: [] },
        filesystem: { denyWrite: [], denyRead: [], writableRoots: [cwd] },
      }) as never,
    },
    getApp: () => ({
      showPermissionPrompt: () =>
        new Promise((resolve) => {
          const prompt: PendingPrompt = {
            kind: 'tool',
            answer: () => { settle(prompt); resolve({ decision: 'allow' }); },
          };
          track(prompt);
        }),
      showNetworkPrompt: () =>
        new Promise((resolve) => {
          const prompt: PendingPrompt = {
            kind: 'network',
            answer: () => { settle(prompt); resolve('once'); },
          };
          track(prompt);
        }),
    }) as never,
    getYoloMode: () => false,
  });
  return { broker, open, maxOpen: () => peak };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function settle(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

describe('PermissionBroker prompt serialization', () => {
  it('never shows two tool prompts at once when several asks queue behind one', async () => {
    const { broker, open, maxOpen } = makeBroker();
    const ask = (command: string) => broker.resolvePermission('Bash', { command });

    const first = ask('git push origin main');
    await waitUntil(() => open.length === 1);
    const second = ask('git push origin dev');
    const third = ask('git push origin release');
    await settle();
    // Precondition: the queued asks are really waiting, not already shown.
    expect(open).toHaveLength(1);

    // Releasing the lock wakes both waiters at once.
    open[0]!.answer();
    await first;
    await waitUntil(() => open.length >= 1);
    await settle();
    expect(open).toHaveLength(1);

    open[0]!.answer();
    await waitUntil(() => open.length >= 1);
    await settle();
    expect(open).toHaveLength(1);
    open[0]!.answer();
    await Promise.all([second, third]);
    expect(maxOpen()).toBe(1);
  });

  it('never shows a tool prompt over a network prompt woken by the same release', async () => {
    const { broker, open, maxOpen } = makeBroker();

    const first = broker.resolvePermission('Bash', { command: 'git push origin main' });
    await waitUntil(() => open.length === 1);
    // The tool ask queues first, so it is the first waiter the release wakes.
    const tool = broker.resolvePermission('Bash', { command: 'git push origin dev' });
    await settle();
    const network = broker.resolveNetworkAccess({ host: 'example.com', via: 'webfetch' } as never);
    await settle();
    expect(open).toHaveLength(1);

    open[0]!.answer();
    await first;
    await waitUntil(() => open.length >= 1);
    await settle();
    expect(open).toHaveLength(1);

    while (open.length > 0) {
      open[0]!.answer();
      await settle();
    }
    await Promise.all([tool, network]);
    expect(maxOpen()).toBe(1);
  });
});
