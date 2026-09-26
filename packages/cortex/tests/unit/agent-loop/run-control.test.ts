import { describe, it, expect, vi } from 'vitest';
import {
  ABORTED,
  AbortState,
  isAbortShapedError,
  LoopGate,
  raceAbort,
  raceTimeout,
  sleepUnlessAborted,
} from '../../../src/agent-loop/run-control.js';

describe('LoopGate', () => {
  it('runs tasks one at a time in order and counts running plus queued', async () => {
    const gate = new LoopGate();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = gate.enqueue(async () => {
      order.push('first:start');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push('first:end');
    });
    const second = gate.enqueue(async () => {
      order.push('second');
      return 42;
    });
    expect(gate.depth).toBe(2);
    expect(gate.isActive).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirst();
    await first;
    expect(await second).toBe(42);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    await gate.settled;
    expect(gate.depth).toBe(0);
  });

  it('keeps the tail alive after a task rejects', async () => {
    const gate = new LoopGate();
    await expect(gate.enqueue(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(gate.enqueue(async () => 'next')).resolves.toBe('next');
  });

  it('waitForIdle covers tasks enqueued by tasks', async () => {
    const gate = new LoopGate();
    const ran: string[] = [];
    void gate.enqueue(async () => {
      ran.push('a');
      void gate.enqueue(async () => { ran.push('b'); });
    });
    await gate.waitForIdle();
    expect(ran).toEqual(['a', 'b']);
    expect(gate.isActive).toBe(false);
  });
});

describe('AbortState', () => {
  it('is in flight from begin() until end(), which advances the epoch', () => {
    const state = new AbortState();
    const abort = state.begin();
    expect(abort.signal.aborted).toBe(true);
    expect(state.inFlight).toBe(true);
    abort.renew();
    // Renewed controller is fresh, but the abort itself is still completing.
    expect(state.signal.aborted).toBe(false);
    expect(state.inFlight).toBe(true);
    abort.end();
    expect(state.inFlight).toBe(false);
    expect(state.epoch).toBe(1);
  });

  it('does not replace a controller a newer run already installed', () => {
    const state = new AbortState();
    const abort = state.begin();
    state.renewIfAborted();
    const newer = state.signal;
    abort.renew();
    expect(state.signal).toBe(newer);
    abort.end();
  });
});

describe('abortable waits', () => {
  it('raceAbort returns the value, or ABORTED when the signal wins', async () => {
    expect(await raceAbort(Promise.resolve(1), undefined)).toBe(1);
    const controller = new AbortController();
    const pending = raceAbort(new Promise(() => {}), controller.signal);
    controller.abort();
    expect(await pending).toBe(ABORTED);
    // Already aborted: a late rejection is swallowed.
    expect(await raceAbort(Promise.reject(new Error('late')), controller.signal)).toBe(ABORTED);
  });

  it('raceTimeout distinguishes settled, timeout, and aborted, and propagates early rejection', async () => {
    vi.useFakeTimers();
    try {
      expect(await raceTimeout(Promise.resolve(), 1000)).toBe('settled');
      const timedOut = raceTimeout(new Promise(() => {}), 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await timedOut).toBe('timeout');
      const controller = new AbortController();
      const preempted = raceTimeout(new Promise(() => {}), 1000, controller.signal);
      controller.abort();
      expect(await preempted).toBe('aborted');
      await expect(raceTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sleepUnlessAborted resolves false as soon as the signal aborts', async () => {
    const controller = new AbortController();
    const sleeping = sleepUnlessAborted(60_000, controller.signal);
    controller.abort();
    expect(await sleeping).toBe(false);
    expect(await sleepUnlessAborted(1, new AbortController().signal)).toBe(true);
  });
});

describe('isAbortShapedError', () => {
  it('matches abort and cancel words but not network codes that contain them', () => {
    expect(isAbortShapedError({ errorMessage: 'Request was aborted' })).toBe(true);
    expect(isAbortShapedError({ errorMessage: 'Operation cancelled by user' })).toBe(true);
    expect(isAbortShapedError({ error: new Error('AbortError: stopped') })).toBe(true);
    expect(isAbortShapedError({ errorMessage: 'connect ECONNABORTED 1.2.3.4' })).toBe(false);
    expect(isAbortShapedError({})).toBe(false);
  });
});
