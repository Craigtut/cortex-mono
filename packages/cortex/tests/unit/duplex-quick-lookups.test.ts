/**
 * QuickLookupManager: the facade's ephemeral read-only lookup fleet (D13).
 * Cap enforcement (the separate small pool), wall-clock timeout producing a
 * visible timed_out outcome, cancellation (including a cancel racing loop
 * creation), answer extraction with working tags stripped, settled-usage
 * accumulation, and teardown.
 */
import { describe, it, expect } from 'vitest';
import { QuickLookupManager } from '../../src/duplex/quick-lookups.js';
import type { QuickLookupOutcome } from '../../src/duplex/quick-lookups.js';
import type { AgentLoop } from '../../src/agent-loop.js';

/** Poll until `predicate` holds; fails after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface FakeLoop {
  loop: AgentLoop;
  destroyed: boolean;
  aborted: boolean;
  release: () => void;
}

function createFakeLoop(options?: {
  answer?: string;
  hold?: boolean;
  failWith?: Error;
  cost?: number;
}): FakeLoop {
  const answer = options?.answer ?? 'the answer';
  let rejectRun: ((err: Error) => void) | null = null;
  let resolveRun: (() => void) | null = null;
  const state: FakeLoop = {
    destroyed: false,
    aborted: false,
    release: () => {
      resolveRun?.();
      resolveRun = null;
      rejectRun = null;
    },
    loop: null as unknown as AgentLoop,
  };
  state.loop = {
    async prompt(): Promise<unknown> {
      if (options?.failWith) throw options.failWith;
      if (options?.hold) {
        await new Promise<void>((resolve, reject) => {
          resolveRun = resolve;
          rejectRun = reject;
        });
      }
      return undefined;
    },
    async abort(): Promise<void> {
      state.aborted = true;
      if (rejectRun) {
        const err = new Error('Request was aborted.');
        err.name = 'AbortError';
        rejectRun(err);
        rejectRun = null;
        resolveRun = null;
      }
    },
    async destroy(): Promise<void> {
      state.destroyed = true;
    },
    getConversationHistory: () => [
      { role: 'user', content: 'q', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: answer }],
        timestamp: 2,
      },
    ],
    getSessionUsage: () => ({
      totalCost: options?.cost ?? 0.002,
      totalTurns: 2,
      tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    }),
  } as unknown as AgentLoop;
  return state;
}

interface Harness {
  manager: QuickLookupManager;
  outcomes: QuickLookupOutcome[];
  fakes: FakeLoop[];
  cleanupCalls: string[];
}

function createHarness(options?: {
  maxConcurrent?: number;
  timeoutMs?: number;
  nextLoop?: (alias: string) => FakeLoop | Promise<FakeLoop>;
  createError?: Error;
}): Harness {
  const outcomes: QuickLookupOutcome[] = [];
  const fakes: FakeLoop[] = [];
  const cleanupCalls: string[] = [];
  const manager = new QuickLookupManager(
    {
      createLoop: async (alias) => {
        if (options?.createError) throw options.createError;
        const fake = await (options?.nextLoop?.(alias) ?? createFakeLoop());
        fakes.push(fake);
        return { loop: fake.loop, cleanup: () => cleanupCalls.push(alias) };
      },
      onOutcome: (outcome) => outcomes.push(outcome),
    },
    {
      maxConcurrent: options?.maxConcurrent ?? 2,
      timeoutMs: options?.timeoutMs ?? 5_000,
    },
  );
  return { manager, outcomes, fakes, cleanupCalls };
}

describe('QuickLookupManager', () => {
  it('runs a lookup to completion: answer extracted, loop destroyed, cleanup ran', async () => {
    const h = createHarness({
      nextLoop: () => createFakeLoop({ answer: '<working>checking</working>Port 8080.' }),
    });
    const verdict = h.manager.request('what port?', 7);
    expect(verdict).toEqual({ accepted: true, alias: 'lk-1' });
    expect(h.manager.activeCount).toBe(1);

    await waitUntil(() => h.outcomes.length === 1);
    expect(h.outcomes[0]).toMatchObject({
      alias: 'lk-1',
      question: 'what port?',
      status: 'completed',
      // Working tags stripped: lookup output feeds spoken conversation.
      answer: 'Port 8080.',
      causeSeq: 7,
    });
    expect(h.manager.activeCount).toBe(0);
    expect(h.fakes[0]!.destroyed).toBe(true);
    expect(h.cleanupCalls).toEqual(['lk-1']);
    expect(h.manager.getSettledUsage().totalCost).toBeCloseTo(0.002);
  });

  it('refuses past the cap with a synchronous reason, and frees the slot on settle', async () => {
    const h = createHarness({
      maxConcurrent: 2,
      nextLoop: () => createFakeLoop({ hold: true }),
    });
    expect(h.manager.request('a', null).accepted).toBe(true);
    expect(h.manager.request('b', null).accepted).toBe(true);
    const refused = h.manager.request('c', null);
    expect(refused.accepted).toBe(false);
    if (!refused.accepted) {
      expect(refused.reason).toContain('lookup limit reached');
    }

    await waitUntil(() => h.fakes.length === 2);
    h.fakes[0]!.release();
    await waitUntil(() => h.manager.activeCount === 1);
    expect(h.manager.request('d', null).accepted).toBe(true);
    h.fakes[1]!.release();
    await waitUntil(() => h.fakes.length === 3);
    h.fakes[2]!.release();
    await h.manager.waitForIdle();
  });

  it('aborts on wall-clock timeout and reports timed_out', async () => {
    const h = createHarness({
      timeoutMs: 30,
      nextLoop: () => createFakeLoop({ hold: true }),
    });
    h.manager.request('slow question', 3);
    await waitUntil(() => h.outcomes.length === 1);
    expect(h.outcomes[0]).toMatchObject({ status: 'timed_out', causeSeq: 3 });
    expect(h.fakes[0]!.aborted).toBe(true);
    expect(h.fakes[0]!.destroyed).toBe(true);
  });

  it('reports failed when the lookup loop cannot be created', async () => {
    const h = createHarness({ createError: new Error('no provider') });
    h.manager.request('q', null);
    await waitUntil(() => h.outcomes.length === 1);
    expect(h.outcomes[0]).toMatchObject({ status: 'failed', error: 'no provider' });
    expect(h.manager.activeCount).toBe(0);
  });

  it('cancelAll aborts live lookups and reports cancelled, awaiting settlement', async () => {
    const h = createHarness({ nextLoop: () => createFakeLoop({ hold: true }) });
    h.manager.request('a', null);
    h.manager.request('b', null);
    await waitUntil(() => h.fakes.length === 2);

    await h.manager.cancelAll();
    expect(h.outcomes.map((o) => o.status)).toEqual(['cancelled', 'cancelled']);
    expect(h.manager.activeCount).toBe(0);
    expect(h.fakes.every((fake) => fake.destroyed)).toBe(true);
  });

  it('a cancel racing loop creation still tears the late loop down', async () => {
    let resolveCreate: ((fake: FakeLoop) => void) | null = null;
    const h = createHarness({
      nextLoop: () => new Promise<FakeLoop>((resolve) => { resolveCreate = resolve; }),
    });
    h.manager.request('q', null);
    await waitUntil(() => resolveCreate !== null);

    const cancelled = h.manager.cancelAll();
    const fake = createFakeLoop();
    resolveCreate!(fake);
    await cancelled;

    expect(h.outcomes[0]).toMatchObject({ status: 'cancelled' });
    expect(fake.destroyed).toBe(true);
  });

  it('destroy refuses new lookups and is idempotent', async () => {
    const h = createHarness({ nextLoop: () => createFakeLoop({ hold: true }) });
    h.manager.request('a', null);
    await waitUntil(() => h.fakes.length === 1);
    const first = h.manager.destroy();
    const second = h.manager.destroy();
    await Promise.all([first, second]);
    expect(h.outcomes[0]!.status).toBe('cancelled');
    const refused = h.manager.request('b', null);
    expect(refused.accepted).toBe(false);
    if (!refused.accepted) expect(refused.reason).toContain('shutting down');
  });
});
