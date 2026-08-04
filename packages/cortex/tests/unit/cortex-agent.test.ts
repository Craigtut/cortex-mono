/**
 * CortexAgent facade skeleton (docs/cortex/duplex/facade-api.md):
 * passthrough mode routing, the duplex not-implemented guard, config
 * routing completeness, session log wiring with causation stamps,
 * append-then-emit ordering, abort scope semantics, and the settlement
 * predicates built on loop-gate depth.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type { AgentLoopConfig, SubAgentResult, TrackedSubAgent } from '../../src/types.js';
import type { AgentMessage } from '../../src/context-manager.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { CortexModel } from '../../src/model-wrapper.js';
import {
  CortexAgent,
  CONFIG_ROUTING,
  AGENT_LOOP_DELEGATION,
  buildReasonerConfig,
} from '../../src/cortex-agent.js';
import type { CortexAgentConfig } from '../../src/cortex-agent.js';

// ---------------------------------------------------------------------------
// Mock PiAgent (holdable runs, steering/follow-up queues) — the shared shape
// used across agent-loop unit tests.
// ---------------------------------------------------------------------------

interface FacadeMockPiAgent extends PiAgent {
  emitEvent: (event: PiEvent) => void;
  promptCalls: Array<string | AgentMessage[]>;
  steeringQueue: Array<{ role: string; content: string }>;
  followUpQueue: Array<{ role: string; content: string }>;
  clearSteeringQueueCalls: number;
  clearFollowUpQueueCalls: number;
  /** When true, the next run pauses until releaseRun() is called. */
  hold: boolean;
  /** When set, the next run throws this error after starting. */
  failWith: Error | null;
  releaseRun: () => void;
}

function createMockPiAgent(): FacadeMockPiAgent {
  let eventHandler: ((event: PiEvent) => void) | null = null;
  let releaseRun: (() => void) | null = null;
  let rejectRun: ((err: Error) => void) | null = null;
  let idleResolve: (() => void) | null = null;
  let running = false;

  const agent: FacadeMockPiAgent = {
    state: {
      messages: [],
      systemPrompt: '',
      tools: [],
    },
    promptCalls: [],
    steeringQueue: [],
    followUpQueue: [],
    clearSteeringQueueCalls: 0,
    clearFollowUpQueueCalls: 0,
    hold: false,
    failWith: null,

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
        const messages: AgentMessage[] = Array.isArray(input)
          ? input
          : [{ role: 'user', content: input, timestamp: Date.now() }];
        agent.state.messages.push(...messages);
        agent.state.messages.push(...(agent.steeringQueue.splice(0) as AgentMessage[]));

        if (agent.hold) {
          agent.hold = false;
          await new Promise<void>((resolve, reject) => {
            releaseRun = resolve;
            rejectRun = reject;
          });
        }

        if (agent.failWith) {
          const err = agent.failWith;
          agent.failWith = null;
          (agent.state as Record<string, unknown>)['errorMessage'] = err.message;
          throw err;
        }
        delete (agent.state as Record<string, unknown>)['errorMessage'];

        agent.state.messages.push(...(agent.followUpQueue.splice(0) as AgentMessage[]));

        agent.emitEvent({
          type: 'turn_end',
          text: 'ok',
          usage: {
            input: 100,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 120,
            cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
          },
        });
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
      rejectRun = null;
    },

    async continue(): Promise<unknown> {
      throw new Error('not used in these tests');
    },

    abort(): void {
      // Like real pi: aborting a held run fails it.
      if (rejectRun) {
        const err = new Error('Request was aborted.');
        err.name = 'AbortError';
        rejectRun(err);
      }
      releaseRun = null;
      rejectRun = null;
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
      agent.steeringQueue.push(message);
    },

    followUp(message: { role: string; content: string }): void {
      agent.followUpQueue.push(message);
    },

    clearSteeringQueue(): void {
      agent.clearSteeringQueueCalls += 1;
      agent.steeringQueue = [];
    },

    clearFollowUpQueue(): void {
      agent.clearFollowUpQueueCalls += 1;
      agent.followUpQueue = [];
    },

    hasQueuedMessages(): boolean {
      return agent.steeringQueue.length > 0 || agent.followUpQueue.length > 0;
    },
  };

  return agent;
}

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
) => AgentLoop;

type TestCortexAgentConstructor = new (
  reasoner: AgentLoop,
  config: CortexAgentConfig,
) => CortexAgent;

function testModel(): CortexModel {
  return wrapModel(
    { provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel,
    'anthropic',
    'claude-sonnet-4-20250514',
  );
}

function createLoop(agent: PiAgent, overrides?: Partial<AgentLoopConfig>): AgentLoop {
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  return new AgentLoopCtor(agent, {
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    slots: [],
    ...overrides,
  });
}

function createFacade(overrides?: Partial<CortexAgentConfig>): {
  facade: CortexAgent;
  loop: AgentLoop;
  piAgent: FacadeMockPiAgent;
} {
  const piAgent = createMockPiAgent();
  const loop = createLoop(piAgent, overrides as Partial<AgentLoopConfig>);
  const CortexAgentCtor = CortexAgent as unknown as TestCortexAgentConstructor;
  const facade = new CortexAgentCtor(loop, {
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    ...overrides,
  });
  return { facade, loop, piAgent };
}

/** Poll until `predicate` holds; fails the test after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Register a fake tracked sub-agent on the loop's manager. */
function trackFakeSubAgent(
  loop: AgentLoop,
  taskId: string,
  options?: { background?: boolean },
): { resolve: (result: SubAgentResult) => void; entry: TrackedSubAgent } {
  let resolveCompletion!: (result: SubAgentResult) => void;
  const completion = new Promise<SubAgentResult>((resolve) => {
    resolveCompletion = resolve;
  });
  const entry: TrackedSubAgent = {
    taskId,
    agent: {
      loopPath: `main/${taskId}`,
      currentContextTokenCount: 0,
      isLoopActive: false,
      isPrompting: false,
      deliver: () => ({ outcome: 'queued' as const }),
      steer: () => {},
      abort: async () => {},
      destroy: async () => {},
      getBudgetGuard: () => ({
        getTurnCount: () => 0,
        getTotalCost: () => 0,
        getMaxTurns: () => Infinity,
        getMaxCost: () => Infinity,
      }),
    },
    instructions: `instructions for ${taskId}`,
    background: options?.background ?? true,
    spawnedAt: Date.now(),
    completion,
    resolve: resolveCompletion,
    toolCount: 0,
    lastToolName: null,
    lastToolSummary: null,
    lastToolStartedAt: null,
    pendingPermission: null,
  };
  expect(loop.getSubAgentManager().track(entry)).toBe(true);
  return { resolve: resolveCompletion, entry };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

describe('CortexAgent modes', () => {
  it('create() with duplex mode throws the Phase 2b not-implemented error', async () => {
    await expect(
      CortexAgent.create({
        model: testModel(),
        workingDirectory: '/tmp/test-workspace',
        mode: 'duplex',
      }),
    ).rejects.toThrow(/duplex mode is not implemented yet \(Phase 2b\)/);
  });

  it('the test constructor also rejects duplex, so it can never silently degrade', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const CortexAgentCtor = CortexAgent as unknown as TestCortexAgentConstructor;
    expect(
      () =>
        new CortexAgentCtor(loop, {
          model: testModel(),
          workingDirectory: '/tmp/test-workspace',
          mode: 'duplex',
        }),
    ).toThrow(/duplex mode is not implemented yet/);
  });

  it('defaults to passthrough and runs prompts through the reasoner', async () => {
    const { facade, piAgent } = createFacade();
    const result = await facade.prompt('hello');
    expect(result).toEqual({ content: 'ok' });
    expect(piAgent.promptCalls).toEqual(['hello']);
  });
});

// ---------------------------------------------------------------------------
// Config routing
// ---------------------------------------------------------------------------

describe('CortexAgent config routing', () => {
  it('routes every key: the table covers exactly the config surface', () => {
    // Compile-time exhaustiveness is enforced by the mapped type; this
    // guards the runtime shape (no key routed twice, none dangling).
    const tableKeys = Object.keys(CONFIG_ROUTING).sort();
    expect(new Set(tableKeys).size).toBe(tableKeys.length);
    expect(tableKeys).toContain('model');
    expect(tableKeys).toContain('mode');
    expect(tableKeys).toContain('tools');
  });

  it('strips facade-owned keys and passes everything else through unchanged', () => {
    const resolvePermission = vi.fn();
    const config: CortexAgentConfig = {
      model: testModel(),
      workingDirectory: '/tmp/test-workspace',
      initialBasePrompt: 'base',
      slots: ['profile'],
      thinkingLevel: 'high',
      budgetGuard: { maxTurns: 5 },
      retryPolicy: { enabled: false },
      resolvePermission,
      sessionId: 'session-1',
      loopPath: 'custom-path',
      mode: 'passthrough',
      talker: {},
      idleSignal: () => true,
      sessionLog: { maxEntries: 10 },
      stateChangeDebounceMs: 5,
    };

    const routed = buildReasonerConfig(config) as unknown as Record<string, unknown>;

    // Facade keys never reach the loop config.
    for (const facadeKey of ['mode', 'talker', 'idleSignal', 'sessionLog', 'stateChangeDebounceMs']) {
      expect(facadeKey in routed).toBe(false);
    }

    // Routed keys arrive unchanged (same references, same values).
    expect(routed['model']).toBe(config.model);
    expect(routed['workingDirectory']).toBe('/tmp/test-workspace');
    expect(routed['initialBasePrompt']).toBe('base');
    expect(routed['slots']).toBe(config.slots);
    expect(routed['thinkingLevel']).toBe('high');
    expect(routed['budgetGuard']).toBe(config.budgetGuard);
    expect(routed['retryPolicy']).toBe(config.retryPolicy);
    expect(routed['resolvePermission']).toBe(resolvePermission);
    expect(routed['sessionId']).toBe('session-1');
    expect(routed['loopPath']).toBe('custom-path');
  });

  it('keys absent from consumer config stay absent (no key materializes as undefined)', () => {
    const routed = buildReasonerConfig({
      model: testModel(),
      workingDirectory: '/tmp/test-workspace',
    }) as unknown as Record<string, unknown>;
    expect('slots' in routed).toBe(false);
    expect('budgetGuard' in routed).toBe(false);
    expect('sessionId' in routed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// prompt() serialization
// ---------------------------------------------------------------------------

describe('CortexAgent.prompt', () => {
  it('never throws on a busy loop: concurrent prompts serialize in order', async () => {
    const { facade, piAgent } = createFacade();

    piAgent.hold = true;
    const first = facade.prompt('first');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    // Direct AgentLoop.prompt() would throw here; the facade queues.
    const second = facade.prompt('second');

    piAgent.releaseRun();
    await expect(first).resolves.toEqual({ content: 'ok' });
    await expect(second).resolves.toEqual({ content: 'ok' });
    expect(piAgent.promptCalls).toEqual(['first', 'second']);
  });

  it('each serialized prompt resolves against the turn that carried its input', async () => {
    const { facade, piAgent } = createFacade();

    piAgent.hold = true;
    const first = facade.prompt('first');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    piAgent.failWith = new Error('boom');
    const second = facade.prompt('second');
    piAgent.releaseRun();

    // The first turn fails; the second still runs and succeeds.
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toEqual({ content: 'ok' });
    expect(piAgent.promptCalls).toEqual(['first', 'second']);
  });

  it('threads DirectCompletionOptions through to the loop', async () => {
    const { facade, loop, piAgent } = createFacade();
    const promptSpy = vi.spyOn(loop, 'prompt');
    const options = { sessionId: 'per-call-affinity' };
    await facade.prompt('hello', options);
    expect(promptSpy).toHaveBeenCalledWith('hello', options);
    expect(piAgent.promptCalls).toEqual(['hello']);
  });

  it('rejects after destroy', async () => {
    const { facade } = createFacade();
    await facade.destroy();
    await expect(facade.prompt('late')).rejects.toThrow('CortexAgent has been destroyed');
  });

  it('rejects unconfigured input without logging a phantom utterance', async () => {
    const piAgent = createMockPiAgent();
    const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
    const loop = new AgentLoopCtor(piAgent, {
      model: testModel(),
      workingDirectory: '/tmp/test-workspace',
      slots: [],
    });
    const CortexAgentCtor = CortexAgent as unknown as TestCortexAgentConstructor;
    const facade = new CortexAgentCtor(loop, {
      model: testModel(),
      workingDirectory: '/tmp/test-workspace',
    });

    await expect(facade.prompt('never ran')).rejects.toThrow(/not configured/);
    expect(() => facade.deliver('never ran either')).toThrow(/not configured/);
    expect(facade.getLog()).toEqual([]);
    expect(piAgent.promptCalls).toEqual([]);
  });

  it('rejects on a directly destroyed loop without logging a phantom utterance', async () => {
    const { facade, loop } = createFacade();
    await loop.destroy();
    await expect(facade.prompt('too late')).rejects.toThrow(/destroyed/);
    expect(facade.getLog().filter((e) => e.type === 'utterance')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Session log wiring
// ---------------------------------------------------------------------------

describe('CortexAgent session log', () => {
  it('logs the utterance before the run and the reply with a causation stamp', async () => {
    const { facade } = createFacade();
    await facade.prompt('do the thing');

    const entries = facade.getLog();
    expect(entries.map((e) => e.type)).toEqual(['utterance', 'reply']);
    const [utterance, reply] = entries;
    expect(utterance!.content).toBe('do the thing');
    expect(utterance!.causedBy).toBeUndefined();
    expect(reply!.content).toBe('ok');
    expect(reply!.causedBy).toBe(utterance!.seq);
    expect(reply!.loopPath).toBe('main');
  });

  it('append-then-emit: subscribers see the utterance before pi sees the run', async () => {
    const { facade, piAgent } = createFacade();
    const order: string[] = [];
    facade.subscribeLog((event) => {
      if (event.kind === 'entry') order.push(`log:${event.entry.type}`);
    });
    const originalPrompt = piAgent.prompt.bind(piAgent);
    piAgent.prompt = async (input) => {
      order.push('pi:prompt');
      return originalPrompt(input);
    };

    await facade.prompt('hello');
    expect(order[0]).toBe('log:utterance');
    expect(order.indexOf('pi:prompt')).toBeGreaterThan(order.indexOf('log:utterance'));
  });

  it('a prompted deliver() logs the utterance and stamps the reply causation', async () => {
    const { facade } = createFacade();
    const result = facade.deliver('delivered input');
    expect(result.outcome).toBe('prompted');
    await result.turn;

    const entries = facade.getLog();
    expect(entries.map((e) => e.type)).toEqual(['utterance', 'reply']);
    expect(entries[1]!.causedBy).toBe(entries[0]!.seq);
  });

  it('a silent deliver() logs the utterance without starting a run', () => {
    const { facade, piAgent } = createFacade();
    const result = facade.deliver('background fact', { wake: false, target: 'work' });
    expect(result.outcome).toBe('queued');
    expect(piAgent.promptCalls).toEqual([]);

    const entries = facade.getLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe('utterance');
    expect(entries[0]!.data).toEqual({ target: 'work' });
  });

  it('a failed run logs an error entry stamped with the utterance causation', async () => {
    const { facade, piAgent } = createFacade({ retryPolicy: { enabled: false } });
    piAgent.failWith = new Error('provider exploded');

    await expect(facade.prompt('doomed')).rejects.toThrow('provider exploded');

    const entries = facade.getLog();
    const utterance = entries.find((e) => e.type === 'utterance')!;
    const error = entries.find((e) => e.type === 'error')!;
    expect(error.content).toContain('provider exploded');
    expect(error.causedBy).toBe(utterance.seq);
    expect(error.data).toMatchObject({ severity: expect.any(String) });
  });

  it('a scheduled retry logs a retrying entry', async () => {
    const { facade, piAgent } = createFacade({
      retryPolicy: { backoffMs: [1], maxAttempts: 1 },
    });
    piAgent.failWith = new Error('socket hang up');
    // continue() resumes the failed turn on retry.
    piAgent.continue = async () => {
      delete (piAgent.state as Record<string, unknown>)['errorMessage'];
      piAgent.emitEvent({ type: 'turn_end', text: 'recovered' });
      piAgent.emitEvent({ type: 'agent_end' });
      return { content: 'recovered' };
    };

    await facade.prompt('flaky');

    const retrying = facade.getLog().filter((e) => e.type === 'retrying');
    expect(retrying).toHaveLength(1);
    expect(retrying[0]!.data).toMatchObject({ attempt: 1, category: 'network' });
    expect(retrying[0]!.causedBy).toBe(facade.getLog()[0]!.seq);
  });

  it('sub-agent lifecycle entries chain causation: spawn during a run, completion to the spawn', async () => {
    const { facade, loop } = createFacade();

    // Spawn a fake child while the facade-initiated run is live (from the
    // turn-complete handler), so the spawn lifecycle entry picks up the
    // utterance causation.
    let spawned = false;
    loop.onTurnComplete(() => {
      if (!spawned) {
        spawned = true;
        trackFakeSubAgent(loop, 'task-1');
      }
    });
    await facade.prompt('spawn something');

    const spawn = facade.getLog().find((e) => e.data?.['event'] === 'sub_agent_spawned')!;
    const utterance = facade.getLog().find((e) => e.type === 'utterance')!;
    expect(spawn.causedBy).toBe(utterance.seq);
    expect(spawn.data).toMatchObject({ taskId: 'task-1', background: true });

    // Completion entry is caused by the spawn entry.
    loop.getSubAgentManager().complete('task-1', {
      output: 'done',
      status: 'completed',
      usage: { turns: 1, cost: 0.01, durationMs: 5, contextTokens: 100 },
    });

    const completed = facade.getLog().find((e) => e.data?.['event'] === 'sub_agent_completed')!;
    expect(completed.causedBy).toBe(spawn.seq);
    expect(completed.data).toMatchObject({ taskId: 'task-1', status: 'completed' });
  });

  it('entries produced outside any facade-initiated run carry no causation stamp', () => {
    const { facade, loop } = createFacade();
    trackFakeSubAgent(loop, 'task-idle');
    const spawn = facade.getLog().find((e) => e.data?.['event'] === 'sub_agent_spawned')!;
    expect(spawn.causedBy).toBeUndefined();
  });

  it('getLog(fromSeq) and subscribeLog replay delegate to the log', async () => {
    const { facade } = createFacade();
    await facade.prompt('one');
    await facade.prompt('two');

    const all = facade.getLog();
    expect(all.length).toBeGreaterThanOrEqual(4);
    const tail = facade.getLog(all[2]!.seq);
    expect(tail.map((e) => e.seq)).toEqual(all.slice(2).map((e) => e.seq));

    const replayed: number[] = [];
    const unsubscribe = facade.subscribeLog((event) => {
      if (event.kind === 'entry') replayed.push(event.entry.seq);
    }, all[2]!.seq);
    expect(replayed).toEqual(all.slice(2).map((e) => e.seq));
    unsubscribe();
    unsubscribe();
  });

  it('whitespace deliver() throws without logging an utterance', () => {
    const { facade } = createFacade();
    expect(() => facade.deliver('   ')).toThrow('non-whitespace');
    expect(facade.getLog()).toEqual([]);
  });

  it('log order matches execution order when a same-tick deliver() runs first', async () => {
    const { facade, piAgent } = createFacade();

    // The prompt is accepted first but its run is chained; the deliver sees
    // an empty gate in the same tick and starts its run immediately. The
    // log (the ordering authority) must record them in execution order.
    const turn = facade.prompt('queued input');
    const result = facade.deliver('barged-in input');
    expect(result.outcome).toBe('prompted');
    await Promise.all([turn, result.turn]);

    expect(piAgent.promptCalls).toEqual(['barged-in input', 'queued input']);
    const utterances = facade
      .getLog()
      .filter((e) => e.type === 'utterance')
      .map((e) => e.content);
    expect(utterances).toEqual(['barged-in input', 'queued input']);

    // Causation still binds each reply to its own utterance.
    const entries = facade.getLog();
    for (const reply of entries.filter((e) => e.type === 'reply')) {
      const cause = entries.find((e) => e.seq === reply.causedBy);
      expect(cause?.type).toBe('utterance');
    }
  });
});

// ---------------------------------------------------------------------------
// Abort scopes
// ---------------------------------------------------------------------------

describe('CortexAgent.abort', () => {
  it("abort('all') aborts the in-flight turn, clears queues, and cancels children", async () => {
    const { facade, loop, piAgent } = createFacade();
    trackFakeSubAgent(loop, 'task-1');

    piAgent.hold = true;
    const turn = facade.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    facade.deliver('queued silent', { wake: false });
    facade.steer('steered');

    await facade.abort();
    await expect(turn).rejects.toThrow();

    expect(facade.queuedDeliveryCount).toBe(0);
    expect(piAgent.clearSteeringQueueCalls).toBeGreaterThan(0);
    expect(piAgent.clearFollowUpQueueCalls).toBeGreaterThan(0);
    expect(loop.getSubAgentManager().activeCount).toBe(0);
    expect(loop.getSubAgentManager().isCancelled('task-1')).toBe(true);

    const lifecycle = facade.getLog().find((e) => e.data?.['event'] === 'abort')!;
    expect(lifecycle.data).toMatchObject({ scope: 'all' });

    // The loop remains usable after abort.
    await facade.prompt('after abort');
    expect(piAgent.promptCalls.at(-1)).toBe('after abort');
  });

  it("abort('conversation') leaves children running", async () => {
    const { facade, loop } = createFacade();
    trackFakeSubAgent(loop, 'task-keep');

    await facade.abort('conversation');

    expect(loop.getSubAgentManager().activeCount).toBe(1);
    expect(loop.getSubAgentManager().isCancelled('task-keep')).toBe(false);
  });

  it("abort('work') cancels children", async () => {
    const { facade, loop } = createFacade();
    trackFakeSubAgent(loop, 'task-work');

    await facade.abort('work');

    expect(loop.getSubAgentManager().activeCount).toBe(0);
    expect(loop.getSubAgentManager().isCancelled('task-work')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Settlement predicates
// ---------------------------------------------------------------------------

describe('CortexAgent settlement', () => {
  it('conversationIdle keys on gate depth and facade prompt queue', async () => {
    const { facade, piAgent } = createFacade();
    expect(facade.conversationIdle).toBe(true);

    piAgent.hold = true;
    const turn = facade.prompt('busy');
    expect(facade.conversationIdle).toBe(false);
    await waitUntil(() => piAgent.promptCalls.length === 1);

    piAgent.releaseRun();
    await turn;
    await facade.waitForConversationIdle();
    expect(facade.conversationIdle).toBe(true);
  });

  it('waitForConversationIdle covers serialized facade prompts still queued', async () => {
    const { facade, piAgent } = createFacade();
    piAgent.hold = true;
    const first = facade.prompt('first');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    const second = facade.prompt('second');

    let settled = false;
    const wait = facade.waitForConversationIdle().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    piAgent.releaseRun();
    await Promise.all([first, second, wait]);
    expect(settled).toBe(true);
    expect(piAgent.promptCalls).toEqual(['first', 'second']);
  });

  it('workSettled is false while a sub-agent is active and true after it completes', async () => {
    const { facade, loop } = createFacade();
    expect(facade.workSettled).toBe(true);

    trackFakeSubAgent(loop, 'task-settle');
    expect(facade.workSettled).toBe(false);

    let settled = false;
    const wait = facade.waitForWorkSettled().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    loop.getSubAgentManager().complete('task-settle', {
      output: 'done',
      status: 'completed',
      usage: { turns: 1, cost: 0, durationMs: 1, contextTokens: 0 },
    });
    await wait;
    expect(settled).toBe(true);
    expect(facade.workSettled).toBe(true);
  });

  it('waitForWorkSettled blocks on ask settlement without hot-polling', async () => {
    const { facade, loop } = createFacade();
    const registry = loop as unknown as {
      registerPendingAsk(ask: {
        askId: string;
        loopPath: string;
        toolName: string;
        renderedRequest: string;
        requestedAt: number;
        voiced: boolean;
      }): void;
      settlePendingAsk(askId: string): void;
    };
    registry.registerPendingAsk({
      askId: 'ask-outlives-child',
      loopPath: 'main',
      toolName: 'Bash',
      renderedRequest: 'Bash: make deploy',
      requestedAt: Date.now(),
      voiced: false,
    });
    expect(facade.workSettled).toBe(false);

    // Fixed observation window for a negative assertion: while the ask is
    // pending the wait must neither resolve nor spin. A setImmediate poll
    // re-evaluates the predicate hundreds of times in this window; the
    // event-driven wait checks a handful of times then blocks.
    const pendingAsksSpy = vi.spyOn(loop, 'getPendingAsks');
    let settled = false;
    const wait = facade.waitForWorkSettled().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    expect(pendingAsksSpy.mock.calls.length).toBeLessThan(20);

    registry.settlePendingAsk('ask-outlives-child');
    await wait;
    expect(settled).toBe(true);
    expect(facade.workSettled).toBe(true);
  });

  it('workSettled counts parked wake deliveries (and settles once they deliver)', async () => {
    const { facade, piAgent } = createFacade();

    piAgent.hold = true;
    const turn = facade.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    const result = facade.deliver('mid-run redirect');
    expect(result.outcome).toBe('parked');
    expect(facade.workSettled).toBe(false);

    piAgent.releaseRun();
    await turn;
    await facade.waitForWorkSettled();
    expect(facade.workSettled).toBe(true);
    // The sweep delivered the parked content before settlement.
    expect(piAgent.promptCalls).toContain('mid-run redirect');
  });
});

// ---------------------------------------------------------------------------
// Delegated surface
// ---------------------------------------------------------------------------

describe('CortexAgent delegation', () => {
  it('structurally exposes every non-withheld public AgentLoop member', () => {
    // The delegation table in src/cortex-agent.ts is compile-time exhaustive
    // over AgentLoop's public surface (a new member is a type error until
    // routed). This asserts the runtime facade matches every disposition,
    // so a forwarding gap (or an accidental exposure of a withheld member)
    // cannot silently reappear.
    const { facade } = createFacade();
    for (const [member, disposition] of Object.entries(AGENT_LOOP_DELEGATION)) {
      if (disposition === 'forwarded') {
        expect(member in facade, `AgentLoop.${member} is marked forwarded but missing on CortexAgent`).toBe(true);
      } else {
        expect(
          member in facade,
          `AgentLoop.${member} is marked ${disposition} but exposed on CortexAgent; update the table if intended`,
        ).toBe(false);
      }
    }
  });

  it('exposes the reasoner event bridge, context manager, and usage verbatim', async () => {
    const { facade, loop } = createFacade();
    expect(facade.getEventBridge()).toBe(loop.getEventBridge());
    expect(facade.getContextManager()).toBe(loop.getContextManager());
    expect(facade.getBudgetGuard()).toBe(loop.getBudgetGuard());

    await facade.prompt('hello');
    expect(facade.getSessionUsage()).toEqual(loop.getSessionUsage());
    expect(facade.getConversationHistory()).toEqual(loop.getConversationHistory());
  });

  it('destroy is idempotent and tears down the loop', async () => {
    const { facade, loop } = createFacade();
    await facade.destroy();
    await facade.destroy();
    expect(loop.state).toBe('destroyed');
  });
});
