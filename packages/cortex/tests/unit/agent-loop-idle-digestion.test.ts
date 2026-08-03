/**
 * Idle-digestion entry point: digestIdle() runs pending observation buffers
 * and threshold compaction OUTSIDE a prompt. Observation normally triggers
 * only on turn_end and compaction only inside transformContext; this is the
 * primitive that lets an owner schedule the blocking work during idle
 * windows (and it deliberately overrides the non-blocking posture for its
 * own pass).
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { AgentLoopConfig } from '../../src/types.js';
import type { AgentMessage } from '../../src/context-manager.js';
import type { CompleteFn } from '../../src/compaction/compaction.js';
import { wrapModel } from '../../src/model-wrapper.js';

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

function makeModel(raw: PiModel) {
  return wrapModel(raw, raw.provider, raw.name, raw.contextWindow);
}

interface DigestMockPiAgent extends PiAgent {
  hangNextRun: boolean;
  releaseRun: () => void;
  promptCalls: Array<string | AgentMessage[]>;
  steeringQueue: Array<{ role: string; content: string }>;
}

function createMockPiAgent(): DigestMockPiAgent {
  let release: (() => void) | null = null;
  const agent: DigestMockPiAgent = {
    state: { messages: [], systemPrompt: '', tools: [] },
    hangNextRun: false,
    promptCalls: [],
    steeringQueue: [],
    subscribe() { return () => {}; },
    async prompt(input: string | AgentMessage[]) {
      agent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      agent.state.messages.push(...messages);
      // Pi polls the steering queue at run start.
      agent.state.messages.push(...(agent.steeringQueue.splice(0) as AgentMessage[]));
      if (agent.hangNextRun) {
        agent.hangNextRun = false;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      agent.state.messages.push({ role: 'assistant', content: 'ok', timestamp: Date.now() });
      return { content: 'ok' };
    },
    releaseRun() {
      release?.();
      release = null;
    },
    async continue() { throw new Error('not used'); },
    abort() {},
    async waitForIdle() {},
    reset() { agent.state.messages = []; },
    steer(message: { role: string; content: string }) {
      agent.steeringQueue.push(message);
    },
    clearSteeringQueue() {
      agent.steeringQueue = [];
    },
    hasQueuedMessages() {
      return agent.steeringQueue.length > 0;
    },
  };
  return agent;
}

/** Poll until `predicate` holds; fails the test after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createLoop(
  piAgent: PiAgent,
  overrides?: Partial<AgentLoopConfig>,
): AgentLoop {
  const Ctor = AgentLoop as unknown as TestAgentLoopConstructor;
  return new Ctor(
    piAgent,
    {
      model: makeModel({
        provider: 'anthropic',
        name: 'claude-sonnet-4-20250514',
        contextWindow: 200_000,
      } as PiModel),
      workingDirectory: '/tmp/test-workspace',
      initialBasePrompt: 'Test prompt',
      slots: [],
      contextWindowLimit: 20_000,
      ...overrides,
    },
    [],
    { enableSubAgentTool: false, enableLoadSkillTool: false },
  );
}

const OBSERVER_OUTPUT =
  '<observations>\nDate: Apr 10, 2026\n\n* \u{1F7E1} (14:30) Digested observation\n</observations>\n\n' +
  '<current-task>\nDigesting between turns.\n</current-task>\n\n' +
  '<suggested-response>\nContinue.\n</suggested-response>';

/** Push post-slot history big enough to clear the buffering floor (5k tokens). */
function seedHistory(piAgent: PiAgent, chars = 30_000): void {
  piAgent.state.messages.push(
    { role: 'user', content: 'work '.repeat(Math.ceil(chars / 10)), timestamp: 1 } as AgentMessage,
    { role: 'assistant', content: 'done '.repeat(Math.ceil(chars / 10)), timestamp: 2 } as AgentMessage,
  );
}

describe('digestIdle (observational)', () => {
  it('buffers the unobserved tail into a chunk without waiting for a turn or a threshold', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn().mockResolvedValue(OBSERVER_OUTPUT);
    loop.getCompactionManager().setObservationalCompleteFn(complete as unknown as CompleteFn);
    seedHistory(piAgent);
    const lengthBefore = piAgent.state.messages.length;

    const result = await loop.digestIdle();

    expect(result.observerRan).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    // Below the activation threshold nothing activates: the chunk waits,
    // history is untouched, and the observer work is already paid for.
    expect(result.historyCompacted).toBe(false);
    expect(piAgent.state.messages).toHaveLength(lengthBefore);
    const state = loop.getObservationalMemoryState();
    expect(state?.bufferedChunks).toHaveLength(1);
    expect(state?.bufferWatermark).toBe(2);
  });

  it('skips the observer when the unobserved tail is below the buffering floor', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn().mockResolvedValue(OBSERVER_OUTPUT);
    loop.getCompactionManager().setObservationalCompleteFn(complete as unknown as CompleteFn);
    piAgent.state.messages.push(
      { role: 'user', content: 'tiny', timestamp: 1 } as AgentMessage,
    );

    const result = await loop.digestIdle();

    expect(result.observerRan).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('activates over the threshold: history trims and the observation slot fills, all between turns', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn().mockResolvedValue(OBSERVER_OUTPUT);
    loop.getCompactionManager().setObservationalCompleteFn(complete as unknown as CompleteFn);
    seedHistory(piAgent);
    // Over the activation threshold (default 0.9 of the 20k budget).
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);
    const lengthBefore = piAgent.state.messages.length;

    const result = await loop.digestIdle();

    expect(result.observerRan).toBe(true);
    expect(result.historyCompacted).toBe(true);
    expect(piAgent.state.messages.length).toBeLessThan(lengthBefore);
    expect(loop.getCompactionManager().hasObservations()).toBe(true);
  });

  it('overrides the non-blocking posture for its own pass', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent, { compaction: { nonBlocking: true } });
    const complete = vi.fn().mockResolvedValue(OBSERVER_OUTPUT);
    loop.getCompactionManager().setObservationalCompleteFn(complete as unknown as CompleteFn);
    seedHistory(piAgent);
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);

    const result = await loop.digestIdle();

    // Under nonBlocking an in-band call would have skipped all of this;
    // the digestion pass runs it deliberately.
    expect(result.observerRan).toBe(true);
    expect(result.historyCompacted).toBe(true);
    expect(loop.getCompactionManager().hasObservations()).toBe(true);
  });
});

describe('digestIdle (classic)', () => {
  it('runs threshold summarization outside a prompt', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent, { compaction: { strategy: 'classic' } });
    const complete = vi.fn().mockResolvedValue('Summary of the work so far');
    loop.getCompactionManager().setCompleteFn(complete as unknown as CompleteFn);
    for (let i = 0; i < 10; i++) seedHistory(piAgent, 2_000);
    // Over the L2 threshold (default 0.7 of the 20k budget).
    loop.getCompactionManager().updateCurrentContextTokenCount(15_000);
    const lengthBefore = piAgent.state.messages.length;

    const result = await loop.digestIdle();

    expect(complete).toHaveBeenCalled();
    expect(result.observerRan).toBe(false);
    expect(result.historyCompacted).toBe(true);
    expect(piAgent.state.messages.length).toBeLessThan(lengthBefore);
  });
});

describe('digestIdle observer wait bound', () => {
  it('times out a hung observer call instead of wedging the loop gate', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    // A hung provider request: the utility completion never settles.
    const complete = vi.fn(() => new Promise<string>(() => {}));
    loop.getCompactionManager().setObservationalCompleteFn(complete as unknown as CompleteFn);
    seedHistory(piAgent);

    // Unbounded, this await never resolves: prompt() then throws forever
    // and wake deliveries wait behind the wedged gate.
    const result = await loop.digestIdle({ observerTimeoutMs: 50 });

    expect(result.observerRan).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
    // The gate is free again: a real prompt can run.
    await waitUntil(() => !loop.isLoopActive);
    await loop.prompt('after the timeout');
    expect(piAgent.promptCalls.some(
      (call) => typeof call === 'string' && call.includes('after the timeout'),
    )).toBe(true);
  });

  it('times out a hung threshold pass (classic summarizer) instead of wedging the gate', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent, { compaction: { strategy: 'classic' } });
    // A hung provider request in the BLOCKING threshold pass (step 2), the
    // phase after the observer waits. Unbounded, digestIdle never resolves
    // and the gate stays wedged while holding _forceBlockingCompaction.
    const complete = vi.fn(() => new Promise<string>(() => {}));
    loop.getCompactionManager().setCompleteFn(complete as unknown as CompleteFn);
    for (let i = 0; i < 10; i++) seedHistory(piAgent, 2_000);
    loop.getCompactionManager().updateCurrentContextTokenCount(15_000);

    const result = await loop.digestIdle({ observerTimeoutMs: 50 });

    expect(complete).toHaveBeenCalled();
    expect(result.observerRan).toBe(false);
    expect(result.historyCompacted).toBe(false);
    // The gate is free again; the hung summarization was abandoned.
    await waitUntil(() => !loop.isLoopActive);
  });
});

describe('digestIdle gate serialization', () => {
  it('waits for a running turn instead of racing its history mutations', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn().mockResolvedValue(OBSERVER_OUTPUT);
    loop.getCompactionManager().setObservationalCompleteFn(complete as unknown as CompleteFn);
    seedHistory(piAgent);

    piAgent.hangNextRun = true;
    const turn = loop.prompt('long task');
    await new Promise((resolve) => setTimeout(resolve, 10));

    let digested = false;
    const digestion = loop.digestIdle().then((r) => {
      digested = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Still queued behind the running turn.
    expect(digested).toBe(false);
    expect(complete).not.toHaveBeenCalled();

    piAgent.releaseRun();
    await turn;
    const result = await digestion;
    expect(digested).toBe(true);
    expect(result.observerRan).toBe(true);
  });

  it('throws once the loop is shutting down', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    await loop.destroy();

    await expect(loop.digestIdle()).rejects.toThrow('destroyed');
  });
});

describe('digestIdle and deliver interleaving', () => {
  it('a wake delivery during idle digestion still runs a turn once the digest completes', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    let releaseObserver!: (value: string) => void;
    const complete = vi.fn(
      () => new Promise<string>((resolve) => { releaseObserver = resolve; }),
    );
    loop.getCompactionManager().setObservationalCompleteFn(complete as unknown as CompleteFn);
    seedHistory(piAgent);

    const digestion = loop.digestIdle();
    await waitUntil(() => complete.mock.calls.length === 1);

    // The gate is held by the digest, which never starts a pi run. Without
    // the sweep, the parked content would wait for some unrelated later
    // run (an unprompted response) instead of getting a run of its own.
    const result = loop.deliver('urgent while digesting');
    expect(result.outcome).toBe('parked');

    releaseObserver(OBSERVER_OUTPUT);
    await digestion;

    // A turn actually runs with the delivered content.
    await waitUntil(() => piAgent.promptCalls.some(
      (call) => typeof call === 'string' && call.includes('urgent while digesting'),
    ));
    expect(piAgent.steeringQueue).toEqual([]);
    await waitUntil(() => !loop.isLoopActive);
  });
});
