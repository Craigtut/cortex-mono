/**
 * deliver(): the state machine over (loop-gate depth, pi run state, abort
 * state) that lets a facade hand content to a loop regardless of its run
 * state, plus the queue surfaces exposed alongside it (followUp, queue
 * modes, queue clears).
 *
 * The load-bearing assertions here mirror docs/cortex/duplex/log-and-context.md:
 * NO deliver() content ever touches pi's steering queue (that queue belongs
 * to the public steer() API alone), silent (no-wake) content waits for the
 * next real prompt, and wake content parked while the gate is held opens
 * the NEXT run exactly once: as leading batch messages of a prompt queued
 * ahead of the sweep, or through the sweep's own run.
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
// Mock PiAgent with steering/follow-up queues and a run that can hold at
// steering-poll boundaries. `holds` counts turn boundaries the next run
// pauses at (each drains the steering queue when released, like pi does
// after a tool batch); `finalHold` pauses once more AFTER the run's last
// steering poll, modeling the tail of a real run (follow-up poll, agent_end
// listeners, promise unwinding) where arriving content has no poll left to
// drain it. That window is exactly where the old reconciliation-based
// parking duplicated or destroyed content.
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
  /** Messages queued for a would-stop point (mirrors pi's follow-up queue). */
  followUpQueue: Array<{ role: string; content: string }>;
  /** Steering polls made so far (run start and each released hold). */
  polls: number;
  /** Number of turn-boundary holds the next run pauses at. */
  holds: number;
  /** When true, the next run pauses once more AFTER its last steering poll. */
  finalHold: boolean;
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
    followUpQueue: [],
    polls: 0,
    holds: 0,
    finalHold: false,

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
        agent.polls += 1;
        agent.state.messages.push(
          ...(agent.steeringQueue.splice(0) as AgentMessage[]),
        );

        const holds = agent.holds;
        agent.holds = 0;
        for (let i = 0; i < holds; i += 1) {
          await new Promise<void>((resolve) => {
            releaseRun = resolve;
          });
          // ... and again at every turn boundary within the run.
          agent.polls += 1;
          agent.state.messages.push(
            ...(agent.steeringQueue.splice(0) as AgentMessage[]),
          );
        }

        if (agent.finalHold) {
          agent.finalHold = false;
          // Past the run's last steering poll: whatever arrives now has no
          // poll left inside this run.
          await new Promise<void>((resolve) => {
            releaseRun = resolve;
          });
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
      agent.followUpQueue.push(message);
    },

    clearSteeringQueue(): void {
      agent.clearSteeringQueueCalls += 1;
      agent.steeringQueue = [];
    },

    hasQueuedMessages(): boolean {
      return agent.steeringQueue.length > 0 || agent.followUpQueue.length > 0;
    },

    clearFollowUpQueue(): void {
      agent.clearFollowUpQueueCalls += 1;
      agent.followUpQueue = [];
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

/** Times `needle` appears across the transcript (duplication detector). */
function occurrences(agent: DeliverMockPiAgent, needle: string): number {
  return agent.state.messages.filter((m) => contentOf(m).includes(needle)).length;
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

  it('delivery into a running turn parks and opens the next run, not the one in flight', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const resetSpy = vi.spyOn(loop.getBudgetGuard(), 'reset');

    piAgent.holds = 1;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    const result = loop.deliver('mid-run redirect');

    expect(result.outcome).toBe('parked');
    // No separate promise: the parked content has no turn until a run
    // consumes it; that run's failures surface through onError.
    expect(result.turn).toBeUndefined();
    // Wake content never enters pi's steering queue (public steer() only).
    expect(piAgent.steerCalls).toEqual([]);
    expect(loop.pendingWakeDeliveryCount).toBe(1);

    piAgent.releaseRun();
    await turn;
    // The in-flight run never carried the parked content (its prompt was
    // the plain string, and nothing was steered into it): the accepted
    // cost of exact parking is a bounded one-run delay.
    expect(piAgent.promptCalls[0]).toBe('long task');

    // The sweep then delivers it with a run of its own, exactly once.
    await waitUntil(() => piAgent.promptCalls.length === 2);
    expect(piAgent.promptCalls[1]).toBe('mid-run redirect');
    await waitUntil(() => !loop.isLoopActive);
    expect(occurrences(piAgent, 'mid-run redirect')).toBe(1);
    // Two logical turns, each with its own budget window.
    expect(resetSpy).toHaveBeenCalledTimes(2);
  });

  it('same-frame delivery after prompt() parks and rides that prompt as a leading batch message', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    const turn = loop.prompt('first');
    // Same synchronous frame: the gate is held but pi has not started yet.
    // prompt() would throw here; deliver() parks, and the already-queued
    // prompt splices the parked content to the front of its batch.
    const result = loop.deliver('same frame delivery');

    expect(result.outcome).toBe('parked');
    await turn;
    expect(piAgent.steerCalls).toEqual([]);
    const batch = piAgent.promptCalls[0]!;
    expect(Array.isArray(batch)).toBe(true);
    expect((batch as AgentMessage[]).map((m) => contentOf(m))).toEqual([
      'same frame delivery',
      'first',
    ]);

    // The splice cleared the parked list at batch time, so the sweep finds
    // nothing and starts no second run.
    await waitUntil(() => !loop.isLoopActive);
    expect(piAgent.promptCalls).toHaveLength(1);
    expect(occurrences(piAgent, 'same frame delivery')).toBe(1);
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

    piAgent.holds = 1;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

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
  it('a wake delivery parked while the gate is held by an empty drain still runs a turn', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    // Schedule a drain with nothing to deliver: it dequeues, finds the
    // pending queue empty, and returns while still holding the gate. No
    // run will start on its own for content parked in that window.
    const drain = (loop as unknown as {
      schedulePendingResultDelivery: () => Promise<void>;
    }).schedulePendingResultDelivery();
    const result = loop.deliver('urgent redirect');
    expect(result.outcome).toBe('parked');

    await drain;
    // The sweep queued behind the drain delivers the parked content with a
    // run of its own instead of leaving it for an unrelated later run.
    await waitUntil(() => piAgent.promptCalls.length === 1);
    expect(piAgent.promptCalls[0]).toBe('urgent redirect');
    expect(piAgent.steerCalls).toEqual([]);
    await waitUntil(() => !loop.isLoopActive);
    expect(loop.pendingWakeDeliveryCount).toBe(0);
  });

  it('clearAllQueues drops parked wake deliveries so the sweep finds nothing', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    const drain = (loop as unknown as {
      schedulePendingResultDelivery: () => Promise<void>;
    }).schedulePendingResultDelivery();
    loop.deliver('will be cleared');
    const dropped = loop.clearAllQueues();
    expect(dropped).toEqual(['will be cleared']);

    await drain;
    await waitUntil(() => !loop.isLoopActive);
    // Content the caller explicitly dropped is not resurrected by the sweep.
    expect(piAgent.promptCalls).toHaveLength(0);
  });
});

// The interleavings the duplex facade generates by design: a run drains one
// message at a boundary poll while another lands after the run's last poll.
// The old reconciliation-based parking (steer into pi's queue, inspect
// hasQueuedMessages() afterwards) duplicated the drained content (BL1),
// destroyed public steer() content with clearSteeringQueue() (BL2), and
// re-delivered drained content whenever a follow-up sat queued (SF1).
describe('AgentLoop.deliver exactness under partial-drain interleavings', () => {
  it('a delivery mid-run plus one after the last poll are each delivered exactly once (BL1)', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    piAgent.holds = 1;
    piAgent.finalHold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    // C1 lands mid-run, before the run's remaining boundary poll.
    loop.deliver('C1-first');
    piAgent.releaseRun();
    await waitUntil(() => piAgent.polls === 2);

    // C2 lands after the run's last poll.
    loop.deliver('C2-second');
    piAgent.releaseRun();
    await turn;

    await waitUntil(() => !loop.isLoopActive);
    expect(occurrences(piAgent, 'C1-first')).toBe(1);
    expect(occurrences(piAgent, 'C2-second')).toBe(1);
  });

  it('a public steer() parked after the last poll is not destroyed by the sweep (BL2)', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    piAgent.holds = 1;
    piAgent.finalHold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    loop.deliver('D-delivery');
    piAgent.releaseRun();
    await waitUntil(() => piAgent.polls === 2);

    // An unrelated public steer() lands after the run's last steering poll
    // and parks in pi's queue.
    loop.steer('S-plain-steer');
    piAgent.releaseRun();
    await turn;

    await waitUntil(() => !loop.isLoopActive);
    // The sweep never blanket-clears pi's queue: the parked steer drains
    // into the next run start (here the sweep's own run), exactly once.
    expect(piAgent.clearSteeringQueueCalls).toBe(0);
    expect(occurrences(piAgent, 'S-plain-steer')).toBe(1);
    expect(occurrences(piAgent, 'D-delivery')).toBe(1);
  });

  it('a queued follow-up does not trigger re-delivery of consumed content (SF1)', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    piAgent.holds = 1;
    piAgent.finalHold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    loop.deliver('F-delivery');
    piAgent.releaseRun();
    await waitUntil(() => piAgent.polls === 2);

    // A consumer queues a follow-up near the run's end. The old sweep read
    // this as "something is still parked" and re-ran the whole record.
    loop.followUp('later thought');
    piAgent.releaseRun();
    await turn;

    await waitUntil(() => !loop.isLoopActive);
    expect(occurrences(piAgent, 'F-delivery')).toBe(1);
  });
});

describe('AgentLoop.deliver sweep failure recovery', () => {
  it('unwinds a failed sweep run and re-delivers the parked content exactly once', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const errored = vi.fn();
    loop.onError(errored);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    // The first sweep run fails after an assistant tool-call turn but
    // before its tool results: the surviving tail carries an unpaired tool
    // call, a hard provider error on the very next request if left there.
    let failuresLeft = 1;
    piAgent.prompt = async (input: string | AgentMessage[]): Promise<unknown> => {
      piAgent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      piAgent.state.messages.push(...messages);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        piAgent.state.messages.push({
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call_1', name: 'Bash', arguments: {} }],
        } as never);
        throw new Error('provider dropped mid-batch');
      }
      piAgent.state.messages.push({
        role: 'assistant',
        content: 'ok',
        timestamp: Date.now(),
      });
      return { content: 'ok' };
    };

    const drain = (loop as unknown as {
      schedulePendingResultDelivery: () => Promise<void>;
    }).schedulePendingResultDelivery();
    loop.deliver('parked content');
    await drain;

    // The failed run was unwound and the content re-parked; the follow-up
    // sweep delivers it. Exactly one copy survives, no unpaired tool call
    // lingers, and the recovered failure never surfaced through onError.
    await waitUntil(() => occurrences(piAgent, 'parked content') === 1 && !loop.isLoopActive);
    expect(piAgent.promptCalls).toHaveLength(2);
    expect(piAgent.state.messages.some((m) => Array.isArray(m.content))).toBe(false);
    expect(errored).not.toHaveBeenCalled();
    expect(loop.pendingWakeDeliveryCount).toBe(0);
  });

  it('drops parked content after repeated failed sweep runs instead of looping', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const errored = vi.fn();
    loop.onError(errored);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    piAgent.prompt = async (input: string | AgentMessage[]): Promise<unknown> => {
      piAgent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      piAgent.state.messages.push(...messages);
      piAgent.state.messages.push({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_1', name: 'Bash', arguments: {} }],
      } as never);
      throw new Error('provider dropped mid-batch');
    };

    const drain = (loop as unknown as {
      schedulePendingResultDelivery: () => Promise<void>;
    }).schedulePendingResultDelivery();
    loop.deliver('doomed content');
    await drain;

    await waitUntil(() => errored.mock.calls.length === 1 && !loop.isLoopActive);
    // Exactly the capped number of attempts, then the content is dropped
    // (surfacing through onError once) and the transcript is left clean.
    expect(piAgent.promptCalls).toHaveLength(3);
    expect(loop.pendingWakeDeliveryCount).toBe(0);
    expect(occurrences(piAgent, 'doomed content')).toBe(0);
    expect(piAgent.state.messages.some((m) => Array.isArray(m.content))).toBe(false);
  });
});

describe('AgentLoop.deliver and abort', () => {
  it('abort() drops parked wake deliveries instead of waiting on a swept run', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    piAgent.finalHold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    // Parks: the run has already made its only steering poll.
    loop.deliver('post-abort content');
    expect(loop.pendingWakeDeliveryCount).toBe(1);

    await loop.abort();
    await turn.catch(() => {});
    await waitUntil(() => !loop.isLoopActive);

    // The parked delivery was cancelled with the turn: no model run starts
    // for it after the user stopped the agent, and nothing stays parked.
    expect(piAgent.promptCalls).toHaveLength(1);
    expect(loop.pendingWakeDeliveryCount).toBe(0);
    expect(occurrences(piAgent, 'post-abort content')).toBe(0);
  });

  it('an abort during a swept run cancels the content instead of re-parking it', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const errored = vi.fn();
    loop.onError(errored);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    // First call hangs until abort rejects it; a later call (the re-park
    // path this test forbids) would succeed and show up in promptCalls.
    let rejectRun: ((err: Error) => void) | null = null;
    let first = true;
    piAgent.prompt = async (input: string | AgentMessage[]): Promise<unknown> => {
      piAgent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      piAgent.state.messages.push(...messages);
      if (first) {
        first = false;
        await new Promise<never>((_resolve, reject) => {
          rejectRun = reject;
        });
      }
      piAgent.state.messages.push({ role: 'assistant', content: 'ok', timestamp: Date.now() });
      return { content: 'ok' };
    };
    piAgent.abort = (): void => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      rejectRun?.(err);
      rejectRun = null;
    };

    const drain = (loop as unknown as {
      schedulePendingResultDelivery: () => Promise<void>;
    }).schedulePendingResultDelivery();
    loop.deliver('swept then aborted');
    await drain;
    await waitUntil(() => piAgent.promptCalls.length === 1);

    await loop.abort();
    await waitUntil(() => !loop.isLoopActive);

    // The aborted swept run was unwound and its content cancelled, not
    // re-parked for a post-abort redelivery.
    expect(piAgent.promptCalls).toHaveLength(1);
    expect(loop.pendingWakeDeliveryCount).toBe(0);
    expect(occurrences(piAgent, 'swept then aborted')).toBe(0);
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

  it('clearAllQueues clears pi queues and returns dropped silent and parked content', () => {
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
