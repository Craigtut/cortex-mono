/**
 * deliver(): the state machine over (loop-gate depth, pi run state, abort
 * state) that lets a facade hand content to a loop regardless of its run
 * state, plus the queue surfaces exposed alongside it (followUp, queue
 * modes, queue clears).
 *
 * The load-bearing assertions here mirror docs/cortex/duplex/log-and-context.md:
 * silent (no-wake) content must NEVER touch pi's steering queue in any run
 * state, and a message delivered into a running turn extends that turn
 * (inheriting its budget window and consumer promise) rather than starting
 * a new one.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type { AgentLoopConfig } from '../../src/types.js';
import type { AgentMessage } from '../../src/context-manager.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { CortexModel } from '../../src/model-wrapper.js';

// ---------------------------------------------------------------------------
// Mock PiAgent with steer/followUp queues and a controllable hanging run
// ---------------------------------------------------------------------------

interface DeliverMockPiAgent extends PiAgent {
  emitEvent: (event: PiEvent) => void;
  promptCalls: Array<string | AgentMessage[]>;
  steerCalls: Array<{ role: string; content: string }>;
  followUpCalls: Array<{ role: string; content: string }>;
  clearSteeringQueueCalls: number;
  clearFollowUpQueueCalls: number;
  /** Messages steered but not yet drained by a run (mirrors pi's queue). */
  steeringQueue: Array<{ role: string; content: string }>;
  /** When true, the next run stays in flight until releaseRun() is called. */
  hangNextRun: boolean;
  releaseRun: () => void;
}

function createMockPiAgent(): DeliverMockPiAgent {
  let eventHandler: ((event: PiEvent) => void) | null = null;
  let releaseRun: (() => void) | null = null;
  let idleResolve: (() => void) | null = null;
  let running = false;

  const agent: DeliverMockPiAgent = {
    state: {
      messages: [],
      systemPrompt: '',
      tools: [],
    },
    promptCalls: [],
    steerCalls: [],
    followUpCalls: [],
    clearSteeringQueueCalls: 0,
    clearFollowUpQueueCalls: 0,
    steeringQueue: [],
    hangNextRun: false,

    subscribe(handler: (event: PiEvent) => void): () => void {
      eventHandler = handler;
      return () => {
        eventHandler = null;
      };
    },

    emitEvent(event: PiEvent): void {
      eventHandler?.(event);
    },

    async prompt(input: string | AgentMessage[]): Promise<unknown> {
      agent.promptCalls.push(input);
      running = true;
      try {
        agent.emitEvent({ type: 'agent_start' });
        // Mirrors pi-agent-core: prompt messages (single or batch) are pushed
        // into state.messages at run start, before any model call.
        const messages: AgentMessage[] = Array.isArray(input)
          ? input
          : [{ role: 'user', content: input, timestamp: Date.now() }];
        agent.state.messages.push(...messages);
        // Pi polls the steering queue at run start.
        agent.state.messages.push(
          ...(agent.steeringQueue.splice(0) as AgentMessage[]),
        );

        if (agent.hangNextRun) {
          agent.hangNextRun = false;
          await new Promise<void>((resolve) => {
            releaseRun = resolve;
          });
          // ... and again at every turn boundary within the run.
          agent.state.messages.push(
            ...(agent.steeringQueue.splice(0) as AgentMessage[]),
          );
        }

        agent.emitEvent({ type: 'turn_end', text: 'ok' });
        agent.state.messages.push({
          role: 'assistant',
          content: 'ok',
          timestamp: Date.now(),
        });
        agent.emitEvent({ type: 'agent_end' });
        return { content: 'ok' };
      } finally {
        running = false;
        idleResolve?.();
        idleResolve = null;
      }
    },

    releaseRun(): void {
      releaseRun?.();
      releaseRun = null;
    },

    async continue(): Promise<unknown> {
      throw new Error('not used in these tests');
    },

    abort(): void {
      releaseRun?.();
      releaseRun = null;
    },

    async waitForIdle(): Promise<void> {
      if (!running) return;
      return new Promise<void>((resolve) => {
        idleResolve = resolve;
      });
    },

    reset(): void {
      agent.state.messages = [];
    },

    steer(message: { role: string; content: string }): void {
      agent.steerCalls.push(message);
      agent.steeringQueue.push(message);
    },

    followUp(message: { role: string; content: string }): void {
      agent.followUpCalls.push(message);
    },

    clearSteeringQueue(): void {
      agent.clearSteeringQueueCalls += 1;
      agent.steeringQueue = [];
    },

    hasQueuedMessages(): boolean {
      return agent.steeringQueue.length > 0;
    },

    clearFollowUpQueue(): void {
      agent.clearFollowUpQueueCalls += 1;
    },
  };

  return agent;
}

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
) => AgentLoop;

function createLoop(agent: PiAgent, overrides?: Partial<AgentLoopConfig>): AgentLoop {
  const model: CortexModel = wrapModel(
    { provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel,
    'anthropic',
    'claude-sonnet-4-20250514',
  );
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  return new AgentLoopCtor(agent, {
    model,
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    slots: [],
    ...overrides,
  });
}

function contentOf(message: AgentMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

/** Poll until `predicate` holds; fails the test after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('AgentLoop.deliver', () => {
  it('idle + wake starts a turn whose promise the result carries', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    const result = loop.deliver('new direction');

    expect(result.outcome).toBe('prompted');
    expect(result.turn).toBeDefined();
    await result.turn;
    expect(piAgent.promptCalls).toEqual(['new direction']);
    expect(piAgent.steerCalls).toEqual([]);
  });

  it('delivery into a running turn steers, extending that turn instead of starting a new one', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const resetSpy = vi.spyOn(loop.getBudgetGuard(), 'reset');

    piAgent.hangNextRun = true;
    const turn = loop.prompt('long task');
    // Let the gate task dequeue and the run start.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = loop.deliver('mid-run redirect');

    expect(result.outcome).toBe('steered');
    // No separate promise: the delivery rides the in-flight turn's promise.
    expect(result.turn).toBeUndefined();
    expect(piAgent.steerCalls).toEqual([{ role: 'user', content: 'mid-run redirect' }]);
    // No second prompt cycle: the message extends the running logical turn,
    // so the budget window was reset exactly once (for the original prompt).
    expect(piAgent.promptCalls).toHaveLength(1);
    expect(resetSpy).toHaveBeenCalledTimes(1);

    // The consumer promise of the ORIGINAL turn is the one that settles.
    piAgent.releaseRun();
    await expect(turn).resolves.toBeDefined();
    expect(resetSpy).toHaveBeenCalledTimes(1);
  });

  it('same-frame delivery after prompt() (gate held, pi idle) steers instead of throwing', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    const turn = loop.prompt('first');
    // Same synchronous frame: the gate is held but pi has not started yet.
    // This is the "gate held, pi idle" state (same shape as retry backoff
    // and the drain window). prompt() would throw here; deliver() must not.
    const result = loop.deliver('same frame delivery');

    expect(result.outcome).toBe('steered');
    expect(piAgent.steerCalls).toEqual([{ role: 'user', content: 'same frame delivery' }]);
    await turn;
  });

  it('silent delivery while idle queues on the loop, never on pi', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    const result = loop.deliver('background fact', { wake: false });

    expect(result.outcome).toBe('queued');
    expect(loop.queuedDeliveryCount).toBe(1);
    // The R2-A1 trap: parked in pi's steering queue this would drain into
    // whatever run starts next and be answered unprompted.
    expect(piAgent.steerCalls).toEqual([]);
    expect(piAgent.promptCalls).toEqual([]);
  });

  it('silent delivery during a LIVE run also queues, never steers', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    piAgent.hangNextRun = true;
    const turn = loop.prompt('long task');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = loop.deliver('silent while running', { wake: false });

    expect(result.outcome).toBe('queued');
    // After a terminated tool batch pi polls steering and continues the
    // inner loop if anything is queued, so a silent steer during a live run
    // would surface as an unprompted response.
    expect(piAgent.steerCalls).toEqual([]);
    expect(loop.queuedDeliveryCount).toBe(1);

    piAgent.releaseRun();
    await turn;
  });

  it('queued silent deliveries flush into the next real prompt as leading batch messages', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    loop.deliver('fact one', { wake: false });
    loop.deliver('fact two', { wake: false });
    await loop.prompt('real question');

    expect(loop.queuedDeliveryCount).toBe(0);
    expect(piAgent.promptCalls).toHaveLength(1);
    const batch = piAgent.promptCalls[0]!;
    expect(Array.isArray(batch)).toBe(true);
    const messages = batch as AgentMessage[];
    expect(messages.map((m) => contentOf(m))).toEqual(['fact one', 'fact two', 'real question']);
    expect(messages.every((m) => m.role === 'user' && typeof m.timestamp === 'number')).toBe(true);
  });

  it('a background-completion drain does not flush the silent queue', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    // Activate the loop so drains run (state transitions on first prompt).
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    loop.deliver('silent fact', { wake: false });
    await (loop as unknown as {
      deliverOrQueueBackgroundCompletion: (item: unknown) => Promise<void>;
    }).deliverOrQueueBackgroundCompletion({
      kind: 'subagent',
      taskId: 'task-1',
      result: {
        output: 'done',
        status: 'completed',
        usage: { turns: 1, cost: 0, durationMs: 5, contextTokens: 10 },
      },
    });

    // The drain delivered its completion as a plain string prompt and the
    // silent content is still waiting for the next REAL prompt.
    expect(piAgent.promptCalls).toHaveLength(1);
    expect(typeof piAgent.promptCalls[0]).toBe('string');
    expect(piAgent.promptCalls[0]).toContain('task-1');
    expect(loop.queuedDeliveryCount).toBe(1);

    await loop.prompt('follow-up');
    const batch = piAgent.promptCalls[1] as AgentMessage[];
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.map((m) => contentOf(m))).toEqual(['silent fact', 'follow-up']);
  });

  it('rejects whitespace-only content', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    expect(() => loop.deliver('   \n  ')).toThrow('non-whitespace');
    expect(() => loop.deliver('   ', { wake: false })).toThrow('non-whitespace');
  });

  it('throws synchronously when no base prompt is configured', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent, { initialBasePrompt: undefined as never });

    // Without the synchronous check, the idle+wake branch would return
    // { outcome: 'prompted' } carrying a turn that rejects pre-flight
    // without emitting onError: a reported outcome for a turn that never
    // ran, invisible to a fire-and-forget caller.
    expect(() => loop.deliver('content')).toThrow('not configured');
    expect(piAgent.promptCalls).toEqual([]);
  });

  it('throws once the loop is shutting down', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    await loop.destroy();

    expect(() => loop.deliver('too late')).toThrow('destroyed');
  });

  it('drops queued silent deliveries on destroy', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    loop.deliver('will be dropped', { wake: false });
    expect(loop.queuedDeliveryCount).toBe(1);
    await loop.destroy();
    expect(loop.queuedDeliveryCount).toBe(0);
  });
});

describe('AgentLoop.deliver run guarantee (sweep)', () => {
  it('a wake delivery steered while the gate is held by an empty drain still runs a turn', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    // Schedule a drain with nothing to deliver: it dequeues, finds the
    // pending queue empty, and returns while still holding the gate. A
    // steer landing in that window has no run to drain it.
    const drain = (loop as unknown as {
      schedulePendingResultDelivery: () => Promise<void>;
    }).schedulePendingResultDelivery();
    const result = loop.deliver('urgent redirect');
    expect(result.outcome).toBe('steered');

    await drain;
    // The sweep queued behind the drain converts the parked steer into a
    // real run instead of leaving it for an unrelated later run.
    await waitUntil(() => piAgent.promptCalls.length === 1);
    expect(piAgent.promptCalls[0]).toBe('urgent redirect');
    expect(piAgent.steeringQueue).toEqual([]);
    await waitUntil(() => !loop.isLoopActive);
  });

  it('does not start a second run for a delivery steered into a live run', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    piAgent.hangNextRun = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    expect(loop.deliver('mid-run redirect').outcome).toBe('steered');
    piAgent.releaseRun();
    await turn;

    // The boundary poll drained the steer into the live run; the sweep must
    // conclude nothing is parked rather than re-delivering the content.
    await waitUntil(() => !loop.isLoopActive);
    expect(piAgent.promptCalls).toHaveLength(1);
    expect(piAgent.state.messages.map(contentOf)).toContain('mid-run redirect');
  });

  it('clearing the steering queue also clears the sweep record', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    const drain = (loop as unknown as {
      schedulePendingResultDelivery: () => Promise<void>;
    }).schedulePendingResultDelivery();
    loop.deliver('will be cleared');
    loop.clearSteeringQueue();

    await drain;
    await waitUntil(() => !loop.isLoopActive);
    // Content the caller explicitly cleared is not resurrected by the sweep.
    expect(piAgent.promptCalls).toHaveLength(0);
  });
});

describe('AgentLoop follow-up and queue surfaces', () => {
  it('followUp forwards to pi follow-up queue', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    loop.followUp('after you finish');

    expect(piAgent.followUpCalls).toEqual([{ role: 'user', content: 'after you finish' }]);
  });

  it('followUp throws a clear error when the underlying agent lacks it', () => {
    const piAgent = createMockPiAgent();
    delete (piAgent as Partial<PiAgent>).followUp;
    const loop = createLoop(piAgent);

    expect(() => loop.followUp('x')).toThrow('does not expose followUp');
  });

  it('queue mode setters write through to pi', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    loop.setSteeringQueueMode('all');
    loop.setFollowUpQueueMode('one-at-a-time');

    expect(piAgent.steeringMode).toBe('all');
    expect(piAgent.followUpMode).toBe('one-at-a-time');
  });

  it('clearAllQueues clears pi queues and returns dropped silent content', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    loop.deliver('queued one', { wake: false });
    loop.deliver('queued two', { wake: false });
    const dropped = loop.clearAllQueues();

    expect(piAgent.clearSteeringQueueCalls).toBe(1);
    expect(piAgent.clearFollowUpQueueCalls).toBe(1);
    expect(dropped).toEqual(['queued one', 'queued two']);
    expect(loop.queuedDeliveryCount).toBe(0);
  });

  it('clearQueuedDeliveries drops only the silent queue', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    loop.deliver('queued', { wake: false });
    const dropped = loop.clearQueuedDeliveries();

    expect(dropped).toEqual(['queued']);
    expect(loop.queuedDeliveryCount).toBe(0);
    expect(piAgent.clearSteeringQueueCalls).toBe(0);
    expect(piAgent.clearFollowUpQueueCalls).toBe(0);
  });
});
