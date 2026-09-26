import { describe, it, expect } from 'vitest';
import { parkedWakesTerm, PromptTracker, Settlement, yieldMacrotask } from '../../src/facade/settlement.js';
import type { AgentLoop } from '../../src/agent-loop.js';
import type { SettlementTerm } from '../../src/facade/settlement.js';

/** A term whose state the test flips, recording each wait it is asked for. */
function flag(name: string, waits: string[], signal: boolean): SettlementTerm & { set(v: boolean): void } {
  let pending = false;
  let release: (() => void) | null = null;
  return {
    name,
    pending: () => pending,
    settled: () => {
      waits.push(name);
      if (!signal) return null;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    set(value: boolean) {
      pending = value;
      if (!value && release) {
        const r = release;
        release = null;
        r();
      }
    },
  };
}

describe('Settlement', () => {
  it('reads conversation idle from the conversation terms alone', () => {
    const waits: string[] = [];
    const conversation = flag('gate', waits, true);
    const work = flag('work', waits, true);
    const settlement = new Settlement({ conversation: [conversation], work: [work] });
    work.set(true);
    expect(settlement.conversationIdle).toBe(true);
    expect(settlement.workSettled).toBe(false);
    conversation.set(true);
    work.set(false);
    // The work verdict includes the conversation terms even when the work
    // list does not repeat them.
    expect(settlement.workSettled).toBe(false);
  });

  it('waits on the first pending term in order and re-checks from the top', async () => {
    const waits: string[] = [];
    const first = flag('first', waits, true);
    const second = flag('second', waits, true);
    const settlement = new Settlement({ conversation: [], work: [first, second] });
    first.set(true);
    second.set(true);
    let settled = false;
    const done = settlement.waitForWorkSettled().then(() => {
      settled = true;
    });
    await yieldMacrotask();
    expect(waits).toEqual(['first']);
    first.set(false);
    await yieldMacrotask();
    expect(waits).toEqual(['first', 'second']);
    expect(settled).toBe(false);
    second.set(false);
    await done;
    expect(settled).toBe(true);
  });

  it('yields a macrotask for a term with no signal instead of blocking', async () => {
    const waits: string[] = [];
    const spin = flag('parked', waits, false);
    const settlement = new Settlement({ conversation: [], work: [spin] });
    spin.set(true);
    const done = settlement.waitForWorkSettled();
    await yieldMacrotask();
    await yieldMacrotask();
    expect(waits.length).toBeGreaterThan(0);
    spin.set(false);
    await done;
  });

  it('confirms the work verdict across a macrotask before resolving', async () => {
    const waits: string[] = [];
    const late = flag('late', waits, true);
    const settlement = new Settlement({ conversation: [], work: [late] });
    let settled = false;
    const done = settlement.waitForWorkSettled().then(() => {
      settled = true;
    });
    // Nothing pending on entry, but work appears before the confirmation
    // yield ends: the wait must not resolve on the stale first look.
    late.set(true);
    await yieldMacrotask();
    await yieldMacrotask();
    expect(settled).toBe(false);
    late.set(false);
    await done;
    expect(settled).toBe(true);
  });
});

describe('PromptTracker', () => {
  it('releases waiters only when the last prompt ends', async () => {
    const prompts = new PromptTracker();
    prompts.begin();
    prompts.begin();
    let released = false;
    const wait = prompts.waitIdle().then(() => {
      released = true;
    });
    prompts.end();
    await Promise.resolve();
    expect(released).toBe(false);
    prompts.end();
    await wait;
    expect(released).toBe(true);
    expect(prompts.pending).toBe(false);
  });
});

describe('parkedWakesTerm', () => {
  it('waits on the loop drain signal instead of yielding a macrotask', async () => {
    let parked = 1;
    let release!: () => void;
    const loop = {
      loopPath: 'talker',
      get pendingWakeDeliveryCount() { return parked; },
      waitForWakeDeliveriesDrained: () => new Promise<void>((resolve) => { release = resolve; }),
    } as unknown as AgentLoop;
    const term = parkedWakesTerm(loop);
    expect(term.pending()).toBe(true);
    const signal = term.settled();
    expect(signal).toBeInstanceOf(Promise);
    parked = 0;
    release();
    await signal;
    expect(term.pending()).toBe(false);
  });
});
