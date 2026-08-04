/**
 * Duplex assembly end to end over mock pi agents: config builders (hard
 * talker caps, fail-fast retries, non-blocking staggered compaction,
 * per-loop identity), prompt routing through the talker, conversation
 * deltas queued to the reasoner (D18), control-tool dispatch into real
 * reasoner runs, the Deliver tool and implicit deliveries through the
 * router's wake policy, the D17 terminate guards in the real afterToolCall
 * path, the stop-reason repair turn, the aggregate budget guard fed by
 * utility spend, duplex abort scopes, composite persistence over two live
 * loops, and settlement.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { AgentLoop, TOOL_RESULT_WORKING_TAGS_REMINDER } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import { EventBridge } from '../../src/event-bridge.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type { AgentLoopConfig } from '../../src/types.js';
import type { AgentMessage } from '../../src/context-manager.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { CortexModel } from '../../src/model-wrapper.js';
import {
  CortexAgent,
  TALKER_MAX_TURNS,
  buildDuplexReasonerConfig,
  buildTalkerConfig,
} from '../../src/cortex-agent.js';
import type { CortexAgentConfig, CortexAgentStateV2 } from '../../src/cortex-agent.js';
import { CONTROL_TOOL_NAMES } from '../../src/duplex/control-tools.js';
import {
  REASONER_ROLE_PROMPT,
  SPEAK_NOW_APPENDIX,
  TALKER_ROLE_PROMPT,
  TALKER_TRUNCATION_REPAIR_MESSAGE,
  CONVERSATION_CONTEXT_OPEN,
} from '../../src/duplex/prompts.js';
import { TOOL_NAMES } from '../../src/tools/index.js';

// ---------------------------------------------------------------------------
// Mock pi agent: holdable runs, pi-shaped turn_end/agent_end payloads
// (message with content blocks, stopReason, usage; agent_end carries the
// run's messages) so the facade's stop-reason audit and implicit-delivery
// extraction see what real pi emits.
// ---------------------------------------------------------------------------

interface DuplexMockPiAgent extends PiAgent {
  emitEvent: (event: PiEvent) => void;
  promptCalls: Array<string | AgentMessage[]>;
  steeringQueue: Array<{ role: string; content: string }>;
  followUpQueue: Array<{ role: string; content: string }>;
  /** Text of the next run's assistant message. */
  nextTurnText: string;
  /** When true, the next run pauses until releaseRun() is called. */
  hold: boolean;
  releaseRun: () => void;
}

function usagePayload(cost: number) {
  return {
    input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function createMockPiAgent(): DuplexMockPiAgent {
  let eventHandler: ((event: PiEvent) => void) | null = null;
  let releaseRun: (() => void) | null = null;
  let rejectRun: ((err: Error) => void) | null = null;
  let idleResolve: (() => void) | null = null;
  let running = false;

  const agent: DuplexMockPiAgent = {
    state: { messages: [], systemPrompt: '', tools: [] },
    promptCalls: [],
    steeringQueue: [],
    followUpQueue: [],
    nextTurnText: 'ok',
    hold: false,

    subscribe(handler: (event: PiEvent) => void): () => void {
      eventHandler = handler;
      return () => { eventHandler = null; };
    },

    emitEvent(event: PiEvent): void {
      eventHandler?.(event);
    },

    async prompt(input: string | AgentMessage[]): Promise<unknown> {
      agent.promptCalls.push(input);
      running = true;
      try {
        agent.emitEvent({ type: 'agent_start' });
        const runMessages: AgentMessage[] = Array.isArray(input)
          ? [...input]
          : [{ role: 'user', content: input, timestamp: Date.now() }];
        agent.state.messages.push(...runMessages);
        agent.state.messages.push(...(agent.steeringQueue.splice(0) as AgentMessage[]));

        if (agent.hold) {
          agent.hold = false;
          await new Promise<void>((resolve, reject) => {
            releaseRun = resolve;
            rejectRun = reject;
          });
        }

        const assistant = {
          role: 'assistant',
          content: [{ type: 'text', text: agent.nextTurnText }],
          stopReason: 'stop',
          usage: usagePayload(0.003),
          timestamp: Date.now(),
        } as unknown as AgentMessage;
        agent.state.messages.push(assistant);
        runMessages.push(assistant);
        agent.emitEvent({ type: 'turn_end', message: assistant });
        agent.emitEvent({ type: 'agent_end', messages: runMessages });
        return { content: agent.nextTurnText };
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
      return new Promise<void>((resolve) => { idleResolve = resolve; });
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
      agent.steeringQueue = [];
    },

    clearFollowUpQueue(): void {
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
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

type TestCortexAgentConstructor = new (
  reasoner: AgentLoop,
  config: CortexAgentConfig,
  talker?: AgentLoop,
) => CortexAgent;

function testModel(): CortexModel {
  return wrapModel(
    { provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel,
    'anthropic',
    'claude-sonnet-4-20250514',
  );
}

interface DuplexHarness {
  facade: CortexAgent;
  talkerLoop: AgentLoop;
  reasonerLoop: AgentLoop;
  talkerPi: DuplexMockPiAgent;
  reasonerPi: DuplexMockPiAgent;
}

const liveFacades: CortexAgent[] = [];

function createDuplexFacade(overrides?: Partial<CortexAgentConfig>): DuplexHarness {
  const talkerPi = createMockPiAgent();
  const reasonerPi = createMockPiAgent();
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  const reasonerLoop = new AgentLoopCtor(reasonerPi, {
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    slots: [],
    loopPath: 'reasoner',
  });
  const talkerLoop = new AgentLoopCtor(talkerPi, {
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    slots: [],
    loopPath: 'talker',
    disableTools: Object.values(TOOL_NAMES),
  }, [], { enableSubAgentTool: false, enableLoadSkillTool: false });
  const CortexAgentCtor = CortexAgent as unknown as TestCortexAgentConstructor;
  const { duplex: duplexOverrides, ...restOverrides } = overrides ?? {};
  const facade = new CortexAgentCtor(reasonerLoop, {
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    mode: 'duplex',
    duplex: {
      minDeliverySpacingMs: 0,
      idlePollMs: 5,
      whenIdleDegradeMs: 60_000,
      // Kept out of the way: these tests drive the router directly.
      watchdogIntervalMs: 3_600_000,
      idleDigestionDelayMs: 3_600_000,
      ...duplexOverrides,
    },
    ...restOverrides,
  }, talkerLoop);
  liveFacades.push(facade);
  return { facade, talkerLoop, reasonerLoop, talkerPi, reasonerPi };
}

afterEach(async () => {
  for (const facade of liveFacades.splice(0)) {
    await facade.destroy().catch(() => {});
  }
});

/** Poll until `predicate` holds; fails the test after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function piToolNames(pi: DuplexMockPiAgent): string[] {
  return (pi.state.tools as Array<{ name: string }>).map((tool) => tool.name);
}

function getPiTool(pi: DuplexMockPiAgent, name: string): {
  execute: (id: string, params: unknown) => Promise<unknown>;
} {
  const tool = (pi.state.tools as Array<{ name: string; execute: never }>)
    .find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool as never;
}

// ---------------------------------------------------------------------------
// Config builders
// ---------------------------------------------------------------------------

describe('duplex config builders', () => {
  const baseConfig: CortexAgentConfig = {
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Consumer identity prompt',
    slots: ['project'],
    sessionId: 'sess-1',
    mode: 'duplex',
    tools: [{
      name: 'consumer_tool',
      description: 'x',
      parameters: {},
      execute: async () => 'ok',
    }],
    budgetGuard: { maxTurns: 500, maxCost: 42 },
    resolvePermission: async () => true,
  };

  it('gives the talker a hard low maxTurns that consumer config cannot raise', () => {
    const talker = buildTalkerConfig(baseConfig, testModel());
    expect(talker.budgetGuard).toEqual({ maxTurns: TALKER_MAX_TURNS, scope: 'prompt' });
    expect(TALKER_MAX_TURNS).toBeLessThanOrEqual(10);
  });

  it('constructs the talker without a permission resolver (the answer_ask deadlock)', () => {
    const talker = buildTalkerConfig(baseConfig, testModel());
    expect(talker.resolvePermission).toBeUndefined();
    expect(talker.resolveNetworkAccess).toBeUndefined();
  });

  it('never routes consumer tools, sub-agent config, or MCP surface to the talker', () => {
    const talker = buildTalkerConfig(baseConfig, testModel()) as Record<string, unknown>;
    expect(talker['tools']).toBeUndefined();
    expect(talker['maxConcurrentSubAgents']).toBeUndefined();
    expect(talker['enableSubAgentTool']).toBe(false);
    expect(talker['enableLoadSkillTool']).toBe(false);
    // Every built-in tool is disabled: no blocking tools on the talker (D5).
    expect(talker['disableTools']).toEqual(Object.values(TOOL_NAMES));
  });

  it('gives the talker fail-fast retries and a non-blocking staggered compaction posture', () => {
    const talker = buildTalkerConfig(
      { ...baseConfig, compaction: { observational: { activationThreshold: 0.8 } } },
      testModel(),
    );
    expect(talker.retryPolicy?.maxAttempts).toBe(2);
    expect(talker.retryPolicy?.maxElapsedMs).toBe(10_000);
    expect(talker.compaction?.nonBlocking).toBe(true);
    // Staggered below the reasoner's threshold so blocking work never
    // coincides across the loops.
    expect(talker.compaction?.observational?.activationThreshold).toBeCloseTo(0.75);
  });

  it('keeps the stagger strict at and below the old 0.55 boundary (never equal, never inverted)', () => {
    // At 0.5 the old floor collapsed the stagger to equality; below it the
    // talker landed ABOVE the reasoner. Both are exactly the coinciding
    // blocking work the stagger exists to prevent.
    for (const reasonerThreshold of [0.55, 0.5, 0.4, 0.2]) {
      const talker = buildTalkerConfig(
        { ...baseConfig, compaction: { observational: { activationThreshold: reasonerThreshold } } },
        testModel(),
      );
      const talkerThreshold = talker.compaction!.observational!.activationThreshold!;
      expect(talkerThreshold).toBeLessThan(reasonerThreshold);
      expect(talkerThreshold).toBeGreaterThan(0);
    }
  });

  it('staggers the classic threshold on defaults, not only when the consumer set it', () => {
    const talker = buildTalkerConfig(baseConfig, testModel());
    // Reasoner default is COMPACTION_DEFAULTS.threshold (0.70); the talker
    // sits the full stagger below it without the consumer configuring
    // anything.
    expect(talker.compaction?.compaction?.threshold).toBeCloseTo(0.65);
    // A consumer-set classic threshold staggers relative to that value.
    const configured = buildTalkerConfig(
      { ...baseConfig, compaction: { compaction: { threshold: 0.8, preserveRecentTurns: 6 } } },
      testModel(),
    );
    expect(configured.compaction?.compaction?.threshold).toBeCloseTo(0.75);
    expect(configured.compaction?.compaction?.preserveRecentTurns).toBe(6);
  });

  it('derives distinct stable per-loop identity: loopPath and session id', () => {
    const talker = buildTalkerConfig(baseConfig, testModel());
    const reasoner = buildDuplexReasonerConfig(baseConfig);
    expect(talker.loopPath).toBe('talker');
    expect(reasoner.loopPath).toBe('reasoner');
    expect(talker.sessionId).toBe('sess-1:talker');
    expect(reasoner.sessionId).toBe('sess-1');
  });

  it('sends consumer slots to both loops and appends each role prompt to the base', () => {
    const talker = buildTalkerConfig(baseConfig, testModel());
    const reasoner = buildDuplexReasonerConfig(baseConfig);
    expect(talker.slots).toEqual(['project']);
    expect(reasoner.slots).toEqual(['project']);
    expect(talker.initialBasePrompt).toBe(`Consumer identity prompt\n\n${TALKER_ROLE_PROMPT}`);
    expect(reasoner.initialBasePrompt).toBe(`Consumer identity prompt\n\n${REASONER_ROLE_PROMPT}`);
  });

  it('defaults the duplex reasoner to a persistent tool runtime (explicit consumer value wins)', () => {
    expect(buildDuplexReasonerConfig(baseConfig).persistentRuntime).toBe(true);
    expect(
      buildDuplexReasonerConfig({ ...baseConfig, persistentRuntime: false }).persistentRuntime,
    ).toBe(false);
  });

  it('keeps consumer tools and budget on the reasoner', () => {
    const reasoner = buildDuplexReasonerConfig(baseConfig);
    expect(reasoner.tools?.[0]?.name).toBe('consumer_tool');
    expect(reasoner.budgetGuard).toEqual({ maxTurns: 500, maxCost: 42 });
  });
});

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

describe('duplex assembly', () => {
  it('registers the five control tools on the talker and the duplex tools on the reasoner', () => {
    const { talkerPi, reasonerPi } = createDuplexFacade();
    const talkerTools = piToolNames(talkerPi);
    for (const name of CONTROL_TOOL_NAMES) {
      expect(talkerTools).toContain(name);
    }
    const reasonerTools = piToolNames(reasonerPi);
    expect(reasonerTools).toContain('Deliver');
    expect(reasonerTools).toContain('SteerSubAgent');
    // Never crossed: no control tools on the reasoner, no Deliver on the
    // talker.
    for (const name of CONTROL_TOOL_NAMES) {
      expect(reasonerTools).not.toContain(name);
    }
    expect(talkerTools).not.toContain('Deliver');
  });

  it('labels the merged event stream with loop paths in loopPath, never childTaskId', async () => {
    const { facade } = createDuplexFacade();
    const events: Array<{ loopPath?: string; childTaskId?: string }> = [];
    facade.getEventBridge().on('turn_end', (event) =>
      events.push({ loopPath: event.loopPath, childTaskId: event.childTaskId }));
    await facade.prompt('hello');
    const talkerEvents = events.filter((event) => event.loopPath === 'talker');
    expect(talkerEvents.length).toBeGreaterThan(0);
    // A main-loop event must not arrive as a pseudo-child: the consumer
    // idiom `if (event.childTaskId) return;` has to keep seeing it.
    for (const event of talkerEvents) {
      expect(event.childTaskId).toBeUndefined();
    }
  });

  it('prefixes child origins into loopPath while childTaskId keeps the bare child id', () => {
    const { facade, reasonerLoop } = createDuplexFacade();
    const seen: Array<{ loopPath?: string; childTaskId?: string }> = [];
    facade.getEventBridge().on('utility_usage', (event) =>
      seen.push({ loopPath: event.loopPath, childTaskId: event.childTaskId }));
    // A sub-agent's bridge forwards into its parent loop's bridge with
    // childTaskId set; the merged stream adds the loop-path prefix on top.
    const childBridge = new EventBridge(false);
    reasonerLoop.getEventBridge().forwardFrom(childBridge, 'task-7');
    childBridge.emitUtilityUsage('observer', {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    });
    expect(seen).toEqual([{ loopPath: 'reasoner/task-7', childTaskId: 'task-7' }]);
  });
});

// ---------------------------------------------------------------------------
// Prompt routing and conversation deltas (D18)
// ---------------------------------------------------------------------------

describe('duplex prompt routing', () => {
  it('routes prompt() to the talker; the reasoner runs no turn for plain conversation', async () => {
    const { facade, talkerPi, reasonerPi } = createDuplexFacade();
    talkerPi.nextTurnText = 'You are welcome.';
    const result = await facade.prompt('thanks, that is great');
    expect(result).toEqual({ content: 'You are welcome.' });
    expect(talkerPi.promptCalls).toEqual(['thanks, that is great']);
    // D18: deltas are queued, never prompted. Only a control-tool dispatch
    // starts a reasoner turn.
    expect(reasonerPi.promptCalls).toEqual([]);
  });

  it('logs the utterance (talker path) and the reply caused by it', async () => {
    const { facade } = createDuplexFacade();
    await facade.prompt('hello there');
    const log = facade.getLog();
    const utterance = log.find((entry) => entry.type === 'utterance')!;
    const reply = log.find((entry) => entry.type === 'reply')!;
    expect(utterance.loopPath).toBe('talker');
    expect(reply.loopPath).toBe('talker');
    expect(reply.causedBy).toBe(utterance.seq);
  });

  it('a barge-in during a live talker turn parks instead of throwing', async () => {
    const { facade, talkerPi } = createDuplexFacade();
    talkerPi.hold = true;
    const first = facade.prompt('first');
    await waitUntil(() => talkerPi.promptCalls.length === 1);
    const second = facade.prompt('barge-in');
    talkerPi.releaseRun();
    await first;
    await second;
    // The barge-in rode a later run rather than being rejected.
    const inputs = talkerPi.promptCalls.map((call) =>
      typeof call === 'string' ? call : (call[0] as { content?: unknown })?.content);
    expect(inputs.some((input) => String(input).includes('barge-in'))).toBe(true);
  });

  it('a control-tool dispatch flushes both conversation sides to the reasoner', async () => {
    const { facade, talkerPi, reasonerPi } = createDuplexFacade();
    talkerPi.nextTurnText = 'On it, starting a scan.';
    await facade.prompt('please scan the repo');
    // Dispatch as the talker would (mid-exchange the mock cannot issue tool
    // calls itself, so drive the registered pi tool directly).
    const spawn = getPiTool(talkerPi, 'spawn_task');
    const receipt = await spawn.execute('call-1', { instructions: 'scan the repo' }) as {
      content: Array<{ text: string }>;
      terminate?: boolean;
    };
    expect(receipt.terminate).toBe(true);
    expect(receipt.content[0]!.text).toBe('Started task-1.');

    await waitUntil(() => reasonerPi.promptCalls.length === 1);
    const message = String(reasonerPi.promptCalls[0]);
    expect(message).toContain(CONVERSATION_CONTEXT_OPEN);
    expect(message).toContain('User: please scan the repo');
    expect(message).toContain('Assistant (conversation surface): On it, starting a scan.');
    expect(message).toContain('New task "task-1": scan the repo');
  });

  it('binds directive causation to the utterance when dispatched mid-run', async () => {
    const { facade, talkerPi } = createDuplexFacade();
    talkerPi.hold = true;
    const turn = facade.prompt('go build it');
    await waitUntil(() => talkerPi.promptCalls.length === 1);
    const spawn = getPiTool(talkerPi, 'spawn_task');
    await spawn.execute('call-1', { instructions: 'build it' });
    talkerPi.releaseRun();
    await turn;

    const log = facade.getLog();
    const utterance = log.find((entry) => entry.type === 'utterance')!;
    const directive = log.find((entry) => entry.type === 'directive')!;
    expect(directive.causedBy).toBe(utterance.seq);
    expect(directive.data).toMatchObject({ tool: 'spawn_task', alias: 'task-1' });
  });

  it('stamps discriminated cause tags (kind + seq), never bare seqs (SF-2)', async () => {
    // 2b-ii tags headline deliveries on the same talker port, making the
    // run's cause set mixed-kind; a bare-number tag cannot say which causes
    // are user utterances, and D16's consent check then misreads the set in
    // both directions. The tag must be self-describing.
    const { facade, talkerLoop, talkerPi } = createDuplexFacade();
    talkerPi.hold = true;
    const turn = facade.prompt('hello tags');
    await waitUntil(() => talkerPi.promptCalls.length === 1);
    const utterance = facade.getLog().find((entry) => entry.type === 'utterance')!;
    expect(talkerLoop.activeRunCauseTags).toEqual([{ kind: 'utterance', seq: utterance.seq }]);
    talkerPi.releaseRun();
    await turn;
    expect(talkerLoop.activeRunCauseTags).toEqual([]);
  });

  it('stamps a dispatch with a directive-kind cause tag on the reasoner run (SF-2)', async () => {
    const { facade, talkerPi, reasonerLoop, reasonerPi } = createDuplexFacade();
    reasonerPi.hold = true;
    await facade.prompt('go build it');
    const spawn = getPiTool(talkerPi, 'spawn_task');
    await spawn.execute('call-1', { instructions: 'build it' });
    await waitUntil(() => reasonerPi.promptCalls.length === 1);
    const directive = facade.getLog().find((entry) => entry.type === 'directive')!;
    expect(reasonerLoop.activeRunCauseTags).toEqual([{ kind: 'directive', seq: directive.seq }]);
    reasonerPi.releaseRun();
    await waitUntil(() => !facade.isRunning);
  });

  it('a barge-in utterance keeps its causation stamp through the sweep run (B1)', async () => {
    const { facade, talkerPi } = createDuplexFacade();
    talkerPi.hold = true;
    const first = facade.prompt('first question');
    await waitUntil(() => talkerPi.promptCalls.length === 1);
    // Barge-in: parks behind the live run and rides the sweep run.
    const second = facade.prompt('yes, go ahead');
    // Hold the sweep run so the control tool below executes while the run
    // carrying the barge-in is live (the normal voice interleaving: the
    // talker answers a parked "yes" and calls a control tool from it).
    talkerPi.hold = true;
    talkerPi.releaseRun();
    await waitUntil(() => talkerPi.promptCalls.length === 2);
    expect(String(talkerPi.promptCalls[1])).toContain('yes, go ahead');

    const spawn = getPiTool(talkerPi, 'spawn_task');
    await spawn.execute('call-1', { instructions: 'proceed with the plan' });
    talkerPi.releaseRun();
    await Promise.all([first, second]);

    const log = facade.getLog();
    const bargeIn = log.find(
      (entry) => entry.type === 'utterance' && entry.content === 'yes, go ahead',
    )!;
    const directive = log.find((entry) => entry.type === 'directive')!;
    // The stamp travels with the parked content: the sweep-run dispatch is
    // caused by the barge-in utterance, not unstamped and not the first
    // utterance's.
    expect(directive.causedBy).toBe(bargeIn.seq);
  });

  it('a delivery-woken talker run inherits no stamp from the previous run', async () => {
    const { facade, talkerPi, reasonerPi } = createDuplexFacade();
    talkerPi.hold = true;
    const turn = facade.prompt('kick something off');
    await waitUntil(() => talkerPi.promptCalls.length === 1);
    // An interrupt delivery parks behind the live (utterance-tagged) run.
    const deliver = getPiTool(reasonerPi, 'Deliver');
    await deliver.execute('c1', { content: 'urgent finding', wake: 'interrupt' });
    // Hold the sweep run, which carries only the untagged background update.
    talkerPi.hold = true;
    talkerPi.releaseRun();
    await turn;
    await waitUntil(() => talkerPi.promptCalls.length === 2);
    expect(String(talkerPi.promptCalls[1])).toContain('urgent finding');

    const spawn = getPiTool(talkerPi, 'spawn_task');
    await spawn.execute('call-2', { instructions: 'follow up on the finding' });
    talkerPi.releaseRun();
    await waitUntil(() => !facade.isRunning);

    // A run with no user utterance behind it must carry no causation stamp:
    // an unstamped chain is exactly what D16 refuses consent from.
    const directive = facade.getLog().find((entry) => entry.type === 'directive')!;
    expect(directive.causedBy).toBeUndefined();
  });

  it('a dispatch parked behind a busy reasoner carries its directive causation into the sweep run', async () => {
    const { facade, talkerPi, reasonerPi } = createDuplexFacade();
    reasonerPi.hold = true;
    reasonerPi.nextTurnText = 'first analysis done';
    const busy = facade.deliver('long analysis', { target: 'work' });
    expect(busy.outcome).toBe('prompted');
    await waitUntil(() => reasonerPi.promptCalls.length === 1);

    await facade.prompt('also check the tests');
    const spawn = getPiTool(talkerPi, 'spawn_task');
    await spawn.execute('call-1', { instructions: 'check the tests' });
    const directive = facade.getLog().find((entry) => entry.type === 'directive')!;

    // Hold the sweep run so its final text can differ from run 1's.
    reasonerPi.hold = true;
    reasonerPi.releaseRun();
    await waitUntil(() => reasonerPi.promptCalls.length === 2);
    reasonerPi.nextTurnText = 'tests checked: all green';
    reasonerPi.releaseRun();
    await waitUntil(() => facade.getLog().some(
      (entry) => entry.type === 'delivery' && entry.content === 'tests checked: all green'));

    const delivery = facade.getLog().find(
      (entry) => entry.type === 'delivery' && entry.content === 'tests checked: all green',
    )!;
    // The sweep-delivered dispatch still binds the run to its directive.
    expect(delivery.causedBy).toBe(directive.seq);
  });

  it('a dispatch parked behind a busy reasoner still carries its conversation block', async () => {
    const { facade, talkerPi, reasonerPi } = createDuplexFacade();
    // Occupy the reasoner.
    reasonerPi.hold = true;
    const busy = facade.deliver('long analysis', { target: 'work' });
    expect(busy.outcome).toBe('prompted');
    await waitUntil(() => reasonerPi.promptCalls.length === 1);

    await facade.prompt('also check the tests');
    const spawn = getPiTool(talkerPi, 'spawn_task');
    await spawn.execute('call-1', { instructions: 'check the tests' });

    // Parked: no second reasoner prompt yet.
    expect(reasonerPi.promptCalls).toHaveLength(1);
    reasonerPi.releaseRun();
    await waitUntil(() => reasonerPi.promptCalls.length === 2);
    const message = String(reasonerPi.promptCalls[1]);
    // The sweep-delivered dispatch still carries the conversation: the
    // block travels INSIDE the dispatch message, not in a queue the sweep
    // never flushes.
    expect(message).toContain('User: also check the tests');
    expect(message).toContain('check the tests');
  });

  it("deliver(target: 'work', wake: false) is context only and never starts a reasoner turn", async () => {
    const { facade, talkerPi, reasonerPi } = createDuplexFacade();
    const result = facade.deliver('project uses pnpm', { target: 'work', wake: false });
    expect(result.outcome).toBe('queued');
    expect(reasonerPi.promptCalls).toEqual([]);
    // It rides the next dispatch as conversation context.
    const spawn = getPiTool(talkerPi, 'spawn_task');
    await spawn.execute('call-1', { instructions: 'install deps' });
    await waitUntil(() => reasonerPi.promptCalls.length === 1);
    expect(String(reasonerPi.promptCalls[0])).toContain('Consumer note: project uses pnpm');
  });
});

// ---------------------------------------------------------------------------
// Deliveries: Deliver tool, implicit deliveries, wake policy in situ
// ---------------------------------------------------------------------------

describe('duplex deliveries', () => {
  it('a silent Deliver lands in the talker silent queue without waking it', async () => {
    const { facade, talkerLoop, talkerPi, reasonerPi } = createDuplexFacade();
    const deliver = getPiTool(reasonerPi, 'Deliver');
    const result = await deliver.execute('call-1', {
      content: 'halfway through the scan',
      wake: 'silent',
    }) as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain('Delivered (silent)');
    expect(talkerLoop.queuedDeliveryCount).toBe(1);
    expect(talkerPi.promptCalls).toHaveLength(0);
    const entry = facade.getLog().find((item) => item.type === 'delivery')!;
    expect(entry.wake).toBe('silent');
    expect(entry.content).toBe('halfway through the scan');
  });

  it('an interrupt Deliver wakes the talker with the wrapped update', async () => {
    const { talkerPi, reasonerPi } = createDuplexFacade();
    const deliver = getPiTool(reasonerPi, 'Deliver');
    await deliver.execute('call-1', { content: 'need a decision from the user', wake: 'interrupt' });
    await waitUntil(() => talkerPi.promptCalls.length === 1);
    const message = String(talkerPi.promptCalls[0]);
    expect(message).toContain('<background-update>');
    expect(message).toContain('need a decision from the user');
  });

  it('a reasoner run ending without Deliver produces an implicit when_idle delivery', async () => {
    const { facade, talkerPi, reasonerPi } = createDuplexFacade();
    reasonerPi.nextTurnText = 'Scan complete: 3 issues found.';
    const spawn = getPiTool(talkerPi, 'spawn_task');
    await spawn.execute('call-1', { instructions: 'scan the repo' });

    await waitUntil(() => talkerPi.promptCalls.length === 1);
    expect(String(talkerPi.promptCalls[0])).toContain('Scan complete: 3 issues found.');
    const entry = facade.getLog().find((item) => item.type === 'delivery')!;
    expect(entry.wake).toBe('when_idle');
    expect(entry.data).toMatchObject({ implicit: true });
    // Caused by the directive that started the run.
    const directive = facade.getLog().find((item) => item.type === 'directive')!;
    expect(entry.causedBy).toBe(directive.seq);
  });

  it('an identical implicit result for a new directive is delivered, not absorbed', async () => {
    const { facade, talkerPi, reasonerPi } = createDuplexFacade();
    reasonerPi.nextTurnText = 'Scan complete: no issues.';
    const spawn = getPiTool(talkerPi, 'spawn_task');
    await spawn.execute('c1', { instructions: 'scan the repo' });
    await waitUntil(() => talkerPi.promptCalls.length === 1);

    // "Run it again": a new exchange, a new directive, and a reasoner run
    // whose final text is byte-identical to the previous result.
    await facade.prompt('run it again');
    await spawn.execute('c2', { instructions: 'scan the repo' });
    // The second result reaches the talker; absorbed-as-duplicate here
    // would leave the user's second request looking unanswered.
    await waitUntil(() => talkerPi.promptCalls.length === 3);
    const deliveries = facade.getLog().filter((entry) => entry.type === 'delivery');
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]!.causedBy).not.toBe(deliveries[1]!.causedBy);
  });

  it('an explicit Deliver suppresses the implicit delivery for the same run', async () => {
    const { facade, talkerPi, reasonerPi } = createDuplexFacade();
    // The reasoner "calls Deliver" mid-run: simulate by holding the run and
    // executing the tool while it is live.
    reasonerPi.hold = true;
    reasonerPi.nextTurnText = 'internal wrap-up note';
    const spawn = getPiTool(talkerPi, 'spawn_task');
    await spawn.execute('call-1', { instructions: 'scan' });
    await waitUntil(() => reasonerPi.promptCalls.length === 1);
    const deliver = getPiTool(reasonerPi, 'Deliver');
    await deliver.execute('call-2', { content: 'the real result', wake: 'when_idle' });
    reasonerPi.releaseRun();

    await waitUntil(() => talkerPi.promptCalls.length === 1);
    // Only the explicit delivery reached the talker; the final text did not.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(talkerPi.promptCalls).toHaveLength(1);
    expect(String(talkerPi.promptCalls[0])).toContain('the real result');
    const deliveries = facade.getLog().filter((item) => item.type === 'delivery');
    expect(deliveries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// D17 terminate guards in the real afterToolCall path
// ---------------------------------------------------------------------------

type AfterToolCallHook = (ctx: {
  toolCall: { name: string };
  assistantMessage?: unknown;
  args?: unknown;
  result: { content: unknown };
  isError: boolean;
}) => Promise<{ content?: unknown; terminate?: boolean } | undefined>;

function extractAfterToolCall(talkerLoop: AgentLoop): AfterToolCallHook {
  const statics = AgentLoop as unknown as {
    buildPiAgentConfig: (params: {
      cortexConfig: AgentLoopConfig;
      cacheBreakpointState: { agentLoop: AgentLoop | null };
    }) => Record<string, unknown>;
  };
  const agentConfig = statics.buildPiAgentConfig({
    cortexConfig: {
      model: testModel(),
      workingDirectory: '/tmp/test-workspace',
    },
    cacheBreakpointState: { agentLoop: talkerLoop },
  });
  return agentConfig['afterToolCall'] as AfterToolCallHook;
}

describe('duplex terminate guards (D17)', () => {
  it('control-tool receipts stay bare: no working-tags reminder appendix', async () => {
    const { talkerLoop } = createDuplexFacade();
    const hook = extractAfterToolCall(talkerLoop);
    const out = await hook({
      toolCall: { name: 'spawn_task' },
      assistantMessage: { role: 'assistant', content: [{ type: 'text', text: 'Starting that now.' }] },
      result: { content: [{ type: 'text', text: 'Started task-1.' }] },
      isError: false,
    });
    // No overrides at all: the receipt's own terminate: true stands and no
    // reminder is appended.
    expect(out).toBeUndefined();
  });

  it('suppresses terminate when the assistant message spoke nothing', async () => {
    const { talkerLoop } = createDuplexFacade();
    const hook = extractAfterToolCall(talkerLoop);
    const out = await hook({
      toolCall: { name: 'spawn_task' },
      assistantMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: '<working>silent planning</working>' }],
      },
      result: { content: [{ type: 'text', text: 'Started task-1.' }] },
      isError: false,
    });
    expect(out?.terminate).toBe(false);
    const blocks = out?.content as Array<{ text: string }>;
    expect(blocks[blocks.length - 1]!.text).toContain(SPEAK_NOW_APPENDIX);
  });

  it('leaves non-control tools on the normal reminder path', async () => {
    const { talkerLoop } = createDuplexFacade();
    const hook = extractAfterToolCall(talkerLoop);
    const out = await hook({
      toolCall: { name: 'Recall' },
      assistantMessage: { role: 'assistant', content: [{ type: 'text', text: '' }] },
      result: { content: [{ type: 'text', text: 'memories' }] },
      isError: false,
    });
    const blocks = out?.content as Array<{ type: string; text: string }>;
    expect(blocks[1]!.text).toContain(TOOL_RESULT_WORKING_TAGS_REMINDER);
  });
});

// ---------------------------------------------------------------------------
// Stop-reason audit (D17 truncation repair)
// ---------------------------------------------------------------------------

describe('duplex stop-reason audit', () => {
  it('runs one repair turn after a maxTokens stop with no dispatched call', async () => {
    const { facade, talkerLoop, talkerPi } = createDuplexFacade();
    // Hold the repair run so the streak stays open (no clean turn yet).
    talkerPi.hold = true;
    talkerPi.emitEvent({
      type: 'turn_end',
      message: {
        stopReason: 'length',
        content: [{ type: 'text', text: 'Sure, let me start th' }],
      },
    });
    await waitUntil(() => talkerPi.promptCalls.length === 1);
    expect(String(talkerPi.promptCalls[0])).toBe(TALKER_TRUNCATION_REPAIR_MESSAGE);

    // A second truncation in the same streak (no clean turn in between)
    // does not stack another repair.
    talkerPi.emitEvent({
      type: 'turn_end',
      message: {
        stopReason: 'length',
        content: [{ type: 'text', text: 'still truncated' }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(talkerLoop.pendingWakeDeliveryCount).toBe(0);
    talkerPi.releaseRun();
    await waitUntil(() => !facade.isRunning);
    expect(talkerPi.promptCalls).toHaveLength(1);
  });

  it('does not repair a truncated message that did dispatch a tool call', async () => {
    const { talkerPi } = createDuplexFacade();
    talkerPi.emitEvent({
      type: 'turn_end',
      message: {
        stopReason: 'length',
        content: [
          { type: 'text', text: 'Starting now.' },
          { type: 'toolCall', id: 'c1', name: 'spawn_task', arguments: {} },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(talkerPi.promptCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Aggregate budget guard (active from first assembly; sees utility spend)
// ---------------------------------------------------------------------------

describe('duplex aggregate budget guard', () => {
  it('counts talker and reasoner turns plus utility spend in one lifetime aggregate', async () => {
    const { facade, reasonerLoop } = createDuplexFacade({
      duplex: { maxTotalCost: 10 },
    });
    const guard = facade.getBudgetGuard();
    await facade.prompt('hello'); // one talker turn, cost 0.003
    expect(guard.getTotalCost()).toBeCloseTo(0.003);

    // Utility spend (observer/reflector class) reaches the same aggregate.
    reasonerLoop.getEventBridge().emitUtilityUsage('observer', {
      input: 500, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 600,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
    });
    expect(guard.getTotalCost()).toBeCloseTo(0.503);
  });

  it('a breach on utility spend alone stops the loops and logs once', async () => {
    const { facade, reasonerLoop } = createDuplexFacade({
      duplex: { maxTotalCost: 0.4 },
    });
    const usage = {
      input: 500, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 600,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    };
    reasonerLoop.getEventBridge().emitUtilityUsage('observer', usage);
    expect(facade.getBudgetGuard().isBreached()).toBe(false);
    reasonerLoop.getEventBridge().emitUtilityUsage('reflector', usage);
    expect(facade.getBudgetGuard().isBreached()).toBe(true);
    await waitUntil(() =>
      facade.getLog().some((entry) =>
        entry.type === 'lifecycle' &&
        (entry.data as { event?: string } | undefined)?.event === 'budget_breached'));
    const breaches = facade.getLog().filter((entry) =>
      (entry.data as { event?: string } | undefined)?.event === 'budget_breached');
    expect(breaches).toHaveLength(1);
  });

  it("never reinterprets the consumer's per-prompt maxCost as the session aggregate cap", () => {
    const { facade } = createDuplexFacade({
      budgetGuard: { maxTurns: 500, maxCost: 42 },
      duplex: { maxTotalCost: 5 },
    });
    // budgetGuard.maxCost keeps its per-prompt meaning on the reasoner;
    // the aggregate's cap is its own key.
    expect(facade.getBudgetGuard().getMaxCost()).toBe(5);
  });

  it('leaves the aggregate uncapped when only budgetGuard.maxCost is set', () => {
    const { facade } = createDuplexFacade({
      budgetGuard: { maxCost: 42 },
    });
    expect(facade.getBudgetGuard().getMaxCost()).toBe(Infinity);
  });

  it('restore() resets the aggregate guard so a restored session is not wedged by a pre-restore breach', async () => {
    const { facade, reasonerLoop } = createDuplexFacade({
      duplex: { maxTotalCost: 0.4 },
    });
    const usage = {
      input: 500, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 600,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
    };
    reasonerLoop.getEventBridge().emitUtilityUsage('observer', usage);
    expect(facade.getBudgetGuard().isBreached()).toBe(true);

    facade.restore({
      version: 2,
      log: [],
      talkerHistory: [],
      reasonerHistory: [],
      talkerMemory: null,
      reasonerMemory: null,
      usage: {
        total: { totalCost: 0, totalTurns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        perLoop: {
          talker: null,
          reasoner: { totalCost: 0, totalTurns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        },
      },
    });
    // Counters and the breach flag describe the replaced session.
    expect(facade.getBudgetGuard().isBreached()).toBe(false);
    expect(facade.getBudgetGuard().getTotalCost()).toBe(0);
    // The restored session still enforces the cap on fresh spend.
    reasonerLoop.getEventBridge().emitUtilityUsage('observer', usage);
    expect(facade.getBudgetGuard().isBreached()).toBe(true);
  });

  it('counts a forwarded child event exactly once after the loopPath split', () => {
    const { facade, reasonerLoop } = createDuplexFacade();
    const guard = facade.getBudgetGuard();
    // One child utility completion, forwarded child bridge -> reasoner
    // bridge -> merged bridge. The aggregate must count its cost once.
    const childBridge = new EventBridge(false);
    reasonerLoop.getEventBridge().forwardFrom(childBridge, 'task-1');
    childBridge.emitUtilityUsage('observer', {
      input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.2 },
    });
    expect(guard.getTotalCost()).toBeCloseTo(0.2);
  });

  it('is wired even when the consumer sets no budget (mechanism active from assembly)', () => {
    const { facade } = createDuplexFacade();
    const guard = facade.getBudgetGuard();
    expect(guard.getMaxCost()).toBe(Infinity);
    // The aggregate exists and accumulates; it just has no finite bound.
    expect(guard.getTotalCost()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Abort scopes
// ---------------------------------------------------------------------------

describe('duplex abort scopes', () => {
  it("abort('conversation') drops held deliveries but leaves the reasoner running", async () => {
    const { facade, reasonerPi } = createDuplexFacade({
      idleSignal: () => false,
      duplex: { whenIdleDegradeMs: 3_600_000, minDeliverySpacingMs: 0, idlePollMs: 5 },
    });
    reasonerPi.hold = true;
    facade.deliver('long analysis', { target: 'work' });
    await waitUntil(() => reasonerPi.promptCalls.length === 1);
    const deliver = getPiTool(reasonerPi, 'Deliver');
    await deliver.execute('c1', { content: 'held result', wake: 'when_idle' });
    expect(facade.workSettled).toBe(false);

    await facade.abort('conversation');
    // The held delivery is dropped from the router but retained in the log.
    expect(facade.getLog().some((entry) => entry.type === 'delivery' && entry.content === 'held result')).toBe(true);
    // The reasoner's run was not aborted by the conversation scope.
    expect(reasonerPi.promptCalls).toHaveLength(1);
    reasonerPi.releaseRun();
    await waitUntil(() => !facade.isRunning);
  });

  it("abort('work') drops held deliveries from the stopped work (retained in the log, not voiced)", async () => {
    const { facade, talkerPi, reasonerPi } = createDuplexFacade({
      idleSignal: () => false,
      duplex: { whenIdleDegradeMs: 3_600_000 },
    });
    reasonerPi.hold = true;
    facade.deliver('long analysis', { target: 'work' });
    await waitUntil(() => reasonerPi.promptCalls.length === 1);
    const deliver = getPiTool(reasonerPi, 'Deliver');
    await deliver.execute('c1', { content: 'held result of stopped work', wake: 'when_idle' });
    expect(facade.workSettled).toBe(false);

    await facade.abort('work');
    // Retained in the log, never delivered: the held result belongs to the
    // work the user just stopped.
    expect(facade.getLog().some(
      (entry) => entry.type === 'delivery' && entry.content === 'held result of stopped work',
    )).toBe(true);
    await waitUntil(() => facade.workSettled);
    expect(talkerPi.promptCalls).toHaveLength(0);
  });

  it("abort('work') cancels the reasoner and drops buffered deltas; the talker survives", async () => {
    const { facade, talkerPi, reasonerPi } = createDuplexFacade();
    facade.deliver('note for later', { target: 'work', wake: false });
    reasonerPi.hold = true;
    facade.deliver('crunch data', { target: 'work' });
    await waitUntil(() => reasonerPi.promptCalls.length === 1);

    talkerPi.hold = true;
    const talkerTurn = facade.prompt('how is it going');
    await waitUntil(() => talkerPi.promptCalls.length === 1);

    await facade.abort('work');
    // Talker run still live and completable.
    talkerPi.releaseRun();
    await talkerTurn;
    // The reasoner's next dispatch carries no stale deltas from before the
    // work abort.
    const spawn = getPiTool(talkerPi, 'spawn_task');
    await spawn.execute('c1', { instructions: 'fresh start' });
    await waitUntil(() => reasonerPi.promptCalls.length === 2);
    expect(String(reasonerPi.promptCalls[1])).not.toContain('note for later');
  });
});

// ---------------------------------------------------------------------------
// Composite persistence over two live loops
// ---------------------------------------------------------------------------

describe('duplex persistence', () => {
  it('captures both live histories and per-loop usage in the v2 artifact', async () => {
    const { facade } = createDuplexFacade();
    await facade.prompt('hello');
    const state = await facade.getState();
    expect(state.version).toBe(2);
    expect(state.talkerHistory.length).toBeGreaterThan(0);
    expect(state.usage.perLoop.talker).not.toBeNull();
    expect(state.usage.perLoop.talker!.totalTurns).toBe(1);
    expect(state.usage.total.totalCost).toBeCloseTo(0.003);
  });

  it('restores a v2 artifact into the live talker and reasoner', async () => {
    const { facade: source } = createDuplexFacade();
    await source.prompt('hello');
    const artifact = await source.getState();

    const { facade: target, talkerLoop } = createDuplexFacade();
    target.restore(artifact);
    expect(talkerLoop.getConversationHistory()).toEqual(artifact.talkerHistory);
    expect(target.getSessionUsage().totalCost).toBeCloseTo(artifact.usage.total.totalCost);
    // Idempotent: restoring the same artifact again does not double-count.
    target.restore(artifact);
    expect(target.getSessionUsage().totalCost).toBeCloseTo(artifact.usage.total.totalCost);
  });

  it('rejects restore while the talker is running', async () => {
    const { facade, talkerPi } = createDuplexFacade();
    talkerPi.hold = true;
    const turn = facade.prompt('busy');
    await waitUntil(() => talkerPi.promptCalls.length === 1);
    const artifact: CortexAgentStateV2 = {
      version: 2,
      log: [],
      talkerHistory: [],
      reasonerHistory: [],
      talkerMemory: null,
      reasonerMemory: null,
      usage: {
        total: { totalCost: 0, totalTurns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        perLoop: {
          talker: null,
          reasoner: { totalCost: 0, totalTurns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        },
      },
    };
    expect(() => target(artifact)).toThrow(/a loop is running/);
    function target(state: CortexAgentStateV2): void {
      facade.restore(state);
    }
    talkerPi.releaseRun();
    await turn;
  });
});

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

describe('duplex settlement', () => {
  it('workSettled accounts for router-held deliveries', async () => {
    const { facade, reasonerPi } = createDuplexFacade({
      idleSignal: () => false,
      duplex: { whenIdleDegradeMs: 3_600_000, minDeliverySpacingMs: 0, idlePollMs: 5 },
    });
    expect(facade.workSettled).toBe(true);
    const deliver = getPiTool(reasonerPi, 'Deliver');
    await deliver.execute('c1', { content: 'held', wake: 'when_idle' });
    expect(facade.workSettled).toBe(false);

    let settled = false;
    void facade.waitForWorkSettled().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    await facade.abort('conversation'); // drops the held delivery
    await waitUntil(() => settled);
  });
});
