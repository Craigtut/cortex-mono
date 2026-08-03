/**
 * Drives the REAL Session.resolvePermission with the ask context Cortex
 * threads through resolvePermission (signal, askId), so a wiring bug in
 * Session itself (discarding the context, leaving an aborted run's prompt on
 * screen while it holds permissionLockPromise, dropping the askId before the
 * activity record) is caught. Only the TUI prompt is stubbed; it mirrors the
 * real App.showPermissionPrompt contract: unsettled until the user answers or
 * the external-decision promise resolves.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolPermissionRequestContext, CortexToolPermissionResult } from '@animus-labs/cortex';

// A single lazily-created fake home for the whole file (see
// session-sandbox.test.ts for why this lives on globalThis).
function currentHome(): string {
  const g = globalThis as { __sessionPermissionHome?: string };
  if (!g.__sessionPermissionHome) {
    g.__sessionPermissionHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-perm-home-'));
  }
  return g.__sessionPermissionHome;
}
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => currentHome() };
});

import { Session } from '../src/session.js';

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-perm-ws-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

type ResolvePermissionFn = (
  toolName: string,
  toolArgs: unknown,
  context?: ToolPermissionRequestContext,
) => Promise<boolean | CortexToolPermissionResult>;

interface SessionInternals {
  app: unknown;
  permissionLockPromise: Promise<void> | null;
  resolvePermission: ResolvePermissionFn;
  activity: {
    recordPermissionRequested: (...args: unknown[]) => unknown;
    recordPermissionResolved: (...args: unknown[]) => Promise<void>;
  };
}

function makeSession(): {
  session: Session;
  internals: SessionInternals;
  showPermissionPrompt: ReturnType<typeof vi.fn>;
} {
  const session = new Session({
    config: {} as never,
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
  // Mirrors App.showPermissionPrompt: resolves only when the inline prompt is
  // answered (not simulated here) or the external-decision promise settles.
  const showPermissionPrompt = vi.fn(
    (
      _toolName: string,
      _toolArgs: unknown,
      externalDecision?: Promise<'allow' | 'deny'>,
    ) =>
      new Promise<{ decision: 'allow' | 'deny' }>((resolve) => {
        externalDecision?.then((decision) => resolve({ decision })).catch(() => {});
      }),
  );
  const internals = session as unknown as SessionInternals;
  internals.app = { showPermissionPrompt };
  return { session, internals, showPermissionPrompt };
}

/** Race a promise against a short timer to observe whether it settled. */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<{ settled: boolean; value?: T }> {
  const marker = Symbol('pending');
  const winner = await Promise.race([
    promise,
    new Promise<typeof marker>((resolve) => setTimeout(() => resolve(marker), ms)),
  ]);
  if (winner === marker) return { settled: false };
  return { settled: true, value: winner as T };
}

/**
 * Wait until `predicate` holds, polling on the microtask/timer queue. A fixed
 * sleep races the async chain from resolvePermission to the prompt spy: on a
 * loaded machine 20ms is not always enough, which showed up as roughly a
 * one-in-six suite flake.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('Session.resolvePermission ask context', () => {
  it('dismisses a pending prompt when the asking run aborts, settling with a block and releasing the lock', async () => {
    const { internals } = makeSession();
    const controller = new AbortController();
    const resolved = vi.spyOn(internals.activity, 'recordPermissionResolved');

    const resultPromise = internals.resolvePermission(
      'Bash',
      { command: 'git push origin main' },
      { signal: controller.signal, askId: 'ask-test-1', loopPath: 'main' },
    );

    // The prompt must be pending (nothing answered it yet).
    expect((await settledWithin(resultPromise, 50)).settled).toBe(false);

    controller.abort();

    const outcome = await settledWithin(resultPromise, 500);
    expect(outcome.settled).toBe(true);
    expect(outcome.value).toEqual({
      decision: 'block',
      reason: 'Run aborted before the permission prompt was answered',
    });
    // The lock is released so the next gated tool call is not serialized
    // behind a prompt for dead work.
    expect(internals.permissionLockPromise).toBeNull();
    // The activity stream records the dismissal as a cancellation, not a denial.
    const lastCall = resolved.mock.calls.at(-1);
    expect(lastCall?.[2]).toBe('cancelled');
  });

  it('carries the askId into the permission activity record', async () => {
    const { internals, showPermissionPrompt } = makeSession();
    const controller = new AbortController();
    const requested = vi.spyOn(internals.activity, 'recordPermissionRequested');

    const resultPromise = internals.resolvePermission(
      'Bash',
      { command: 'git push origin main' },
      { signal: controller.signal, askId: 'ask-test-2', loopPath: 'main' },
    );
    // Wait for the prompt itself, not for the activity record: the record is
    // written as the ask settles, so waiting on it here would deadlock.
    await waitUntil(() => showPermissionPrompt.mock.calls.length > 0);
    controller.abort();
    await resultPromise;

    expect(requested).toHaveBeenCalledWith(
      'Bash',
      { command: 'git push origin main' },
      { askId: 'ask-test-2' },
    );
  });

  it('never shows a prompt for an ask whose run aborted while waiting behind another prompt', async () => {
    const { internals, showPermissionPrompt } = makeSession();

    // First ask holds the lock.
    const firstController = new AbortController();
    const firstAsk = internals.resolvePermission(
      'Bash',
      { command: 'git push origin main' },
      { signal: firstController.signal, askId: 'ask-first' },
    );
    await waitUntil(() => showPermissionPrompt.mock.calls.length > 0);
    expect(showPermissionPrompt).toHaveBeenCalledTimes(1);

    // Second ask queues behind the lock; its run aborts while it waits.
    const secondController = new AbortController();
    const secondAsk = internals.resolvePermission(
      'Bash',
      { command: 'git push origin dev' },
      { signal: secondController.signal, askId: 'ask-second' },
    );
    secondController.abort();

    // Release the first prompt (aborting its run dismisses it).
    firstController.abort();
    await firstAsk;

    const outcome = await settledWithin(secondAsk, 500);
    expect(outcome.settled).toBe(true);
    expect(outcome.value).toEqual({
      decision: 'block',
      reason: 'Run aborted before the permission prompt was shown',
    });
    // The second ask never reached the TUI.
    expect(showPermissionPrompt).toHaveBeenCalledTimes(1);
  });
});
