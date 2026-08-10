/**
 * Shared harness for the Phase 3 scenario and adversarial suites
 * (docs/cortex/duplex/migration-plan.md Phase 3).
 *
 * The existing duplex unit suites drive mechanisms: they reach into a tool's
 * execute() and assert what the router did. These suites drive SESSIONS, so
 * the mock pi agent here reproduces pi's tool-batch structure faithfully
 * instead of only its turn boundaries:
 *
 *   push assistant message -> execute its toolCall blocks (through the REAL
 *   afterToolCall hook Cortex installs) -> push one toolResult message per
 *   call -> emit turn_end {message, toolResults} -> terminate the batch when
 *   every result carries terminate: true, else run the next scripted turn.
 *
 * That ordering is pi's (node_modules/@earendil-works/pi-agent-core/dist/
 * agent-loop.js runLoop: turn_end fires AFTER the tool batch, and
 * shouldTerminateToolBatch requires every result to set terminate). It is
 * what makes a run END ON A toolResult, which is the talker's steady state
 * and the transcript shape nothing exercised before Phase 3.
 */

import { vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type { AgentLoopConfig } from '../../src/types.js';
import type { AgentMessage } from '../../src/context-manager.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { CortexModel } from '../../src/model-wrapper.js';
import { CortexAgent } from '../../src/cortex-agent.js';
import type { CortexAgentConfig } from '../../src/cortex-agent.js';
import type { PermissionBroker } from '../../src/duplex/permission-broker.js';
import type { SessionLogEntry } from '../../src/session-log.js';
import { TOOL_NAMES } from '../../src/tools/index.js';

// ---------------------------------------------------------------------------
// Scripted mock pi agent
// ---------------------------------------------------------------------------

/** One scripted assistant message plus the tool calls it carries. */
export interface ScriptedTurn {
  /** User-facing text of the assistant message ('' means a silent turn). */
  text?: string;
  /** Tool calls the message carries, executed in order like pi does. */
  calls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }>;
  /** Assistant stop reason ('length' drives the truncation audit). */
  stopReason?: string;
  /**
   * Record a run failure on this turn, the way pi does: the assistant
   * message carries `errorMessage`, pi mirrors it into `state.errorMessage`
   * (pi-agent-core agent.js:394), the run ENDS (agent_end still fires, so
   * loop_end still reaches Cortex), and Cortex's runTurnWithRetry turns the
   * recorded state error into a throw. Implies an 'error' stop reason.
   *
   * This is the shape a transient provider failure actually has, and it is
   * the only way to exercise a retry ladder here: `failWith` models a
   * throw from prompt() itself, which emits no agent_end at all.
   */
  runErrorMessage?: string;
  /** Cost attributed to the turn's usage payload. */
  cost?: number;
}

export interface ScriptedPiAgent extends PiAgent {
  emitEvent: (event: PiEvent) => void;
  promptCalls: Array<string | AgentMessage[]>;
  steeringQueue: Array<{ role: string; content: string }>;
  followUpQueue: Array<{ role: string; content: string }>;
  /**
   * Turns the next run(s) will play, consumed one per model call. When the
   * script runs dry the run plays a bare {@link ScriptedPiAgent.defaultText}
   * turn, so a scenario only scripts the turns it cares about.
   */
  script: ScriptedTurn[];
  defaultText: string;
  /** Pause the next run after its input lands, until releaseRun(). */
  hold: boolean;
  releaseRun: () => void;
  /** Every tool result the mock produced, in execution order. */
  toolResults: Array<{ name: string; text: string; terminate: boolean }>;
  /** Model calls made across all runs (one per scripted turn played). */
  modelCalls: number;
  /** continue() invocations, i.e. retry attempts after the first. */
  continueCalls: number;
  /** The real Cortex afterToolCall hook, installed by the harness. */
  afterToolCall?: AfterToolCallHook;
  /**
   * The real Cortex beforeToolCall hook (the permission gate), installed by
   * {@link installPermissionGate}. Consulted before every tool execution,
   * exactly where pi consults it.
   */
  beforeToolCall?: BeforeToolCallHook;
  /** Fail the next run with this error instead of producing a turn. */
  failWith: Error | null;
  /** Abort signal of the live run, or null when idle. */
  runSignal: AbortSignal | null;
}

export type AfterToolCallHook = (ctx: {
  toolCall: { name: string };
  assistantMessage?: unknown;
  args?: unknown;
  result: { content: unknown };
  isError: boolean;
}) => Promise<{ content?: unknown; terminate?: boolean } | undefined>;

export type BeforeToolCallHook = (
  ctx: { toolCall: { name: string }; args: unknown },
  signal?: AbortSignal,
) => Promise<{ block?: boolean; reason?: string } | undefined>;

/**
 * Bound on scripted turns per run, so a scenario that fails to terminate
 * fails as a test rather than as a hang. Deliberately above the talker's
 * hard maxTurns so a bounded-turns assertion measures the product's bound.
 */
const MAX_SCRIPTED_TURNS_PER_RUN = 40;

function usagePayload(cost: number) {
  return {
    input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const part = block as { type?: string; text?: unknown };
      return part.type === 'text' && typeof part.text === 'string' ? part.text : '';
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

export function createScriptedPiAgent(): ScriptedPiAgent {
  let eventHandler: ((event: PiEvent) => void) | null = null;
  let releaseRun: (() => void) | null = null;
  let rejectRun: ((err: Error) => void) | null = null;
  let idleResolve: (() => void) | null = null;
  let abortController: AbortController | null = null;
  let running = false;
  let callCounter = 0;

  /**
   * One run of the scripted loop, shared by prompt() and continue().
   * `input` is null for a continue, which resumes the same logical turn
   * without pushing new user input, exactly like pi's retry path.
   */
  async function runBody(input: string | AgentMessage[] | null): Promise<unknown> {
      running = true;
      const controller = new AbortController();
      abortController = controller;
      agent.runSignal = controller.signal;
      try {
        agent.emitEvent({ type: 'agent_start' });
        const runMessages: AgentMessage[] = input === null
          ? []
          : Array.isArray(input)
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
          // Pi polls steering again at the turn boundary after the hold.
          agent.state.messages.push(...(agent.steeringQueue.splice(0) as AgentMessage[]));
        }

        if (agent.failWith) {
          const err = agent.failWith;
          agent.failWith = null;
          (agent.state as Record<string, unknown>)['errorMessage'] = err.message;
          throw err;
        }
        delete (agent.state as Record<string, unknown>)['errorMessage'];

        let lastText = '';
        for (let turn = 0; turn < MAX_SCRIPTED_TURNS_PER_RUN; turn++) {
          const scripted: ScriptedTurn = agent.script.shift()
            ?? { text: agent.defaultText };
          agent.modelCalls += 1;
          const calls = scripted.calls ?? [];
          const text = scripted.text ?? agent.defaultText;
          lastText = text;

          const content: Array<Record<string, unknown>> = [];
          if (text.length > 0) content.push({ type: 'text', text });
          const callIds: string[] = [];
          for (const call of calls) {
            callCounter += 1;
            const id = call.id ?? `call-${callCounter}`;
            callIds.push(id);
            content.push({
              type: 'toolCall',
              id,
              name: call.name,
              arguments: call.args ?? {},
            });
          }

          const assistant = {
            role: 'assistant',
            content,
            stopReason: scripted.runErrorMessage !== undefined
              ? 'error'
              : scripted.stopReason ?? (calls.length > 0 ? 'toolUse' : 'stop'),
            ...(scripted.runErrorMessage !== undefined
              ? { errorMessage: scripted.runErrorMessage }
              : {}),
            usage: usagePayload(scripted.cost ?? 0.003),
            timestamp: Date.now(),
          } as unknown as AgentMessage;
          agent.state.messages.push(assistant);
          runMessages.push(assistant);

          // pi's recorded-failure shape: mirror the message's errorMessage
          // into state, end the run, and still emit agent_end. Cortex reads
          // the state error after prompt() resolves and throws, which is
          // what hands the failure to the retry ladder.
          if (scripted.runErrorMessage !== undefined) {
            (agent.state as Record<string, unknown>)['errorMessage'] =
              scripted.runErrorMessage;
            agent.emitEvent({
              type: 'turn_end', message: assistant, toolResults: [],
            } as unknown as PiEvent);
            agent.emitEvent({ type: 'agent_end', messages: runMessages } as unknown as PiEvent);
            return { content: text };
          }

          // Tool batch: pi executes every call, appends one toolResult
          // message per call, and only then emits turn_end.
          const toolResultMessages: AgentMessage[] = [];
          let terminateBatch = calls.length > 0;
          for (const [index, call] of calls.entries()) {
            const callId = callIds[index]!;
            const tool = (agent.state.tools as Array<{
              name: string;
              execute: (id: string, params: unknown) => Promise<unknown>;
            }>).find((candidate) => candidate.name === call.name);
            let raw: unknown;
            let isError = false;
            // The permission gate runs exactly where pi runs it: before the
            // tool, awaited, with the run's abort signal.
            const gate = agent.beforeToolCall
              ? await agent.beforeToolCall(
                { toolCall: { name: call.name }, args: call.args ?? {} },
                controller.signal,
              )
              : undefined;
            if (gate?.block) {
              raw = {
                content: [{ type: 'text', text: gate.reason ?? 'Blocked by permission policy.' }],
              };
              isError = true;
            } else if (!tool) {
              // Pi's own unknown-tool error result: no terminate, which is
              // exactly the shape that reopens the loop.
              raw = { content: [{ type: 'text', text: `Unknown tool: ${call.name}` }] };
              isError = true;
            } else {
              try {
                raw = await tool.execute(callId, call.args ?? {});
              } catch (err) {
                raw = {
                  content: [{
                    type: 'text',
                    text: err instanceof Error ? err.message : String(err),
                  }],
                };
                isError = true;
              }
            }
            const normalized = (raw && typeof raw === 'object' && 'content' in (raw as object))
              ? raw as { content: unknown; terminate?: boolean }
              : { content: [{ type: 'text', text: String(raw ?? '') }] };

            const after = await agent.afterToolCall?.({
              toolCall: { name: call.name },
              assistantMessage: assistant,
              args: call.args ?? {},
              result: normalized as { content: unknown },
              isError,
            });
            const finalContent = after?.content ?? normalized.content;
            const terminate = after?.terminate ?? normalized.terminate ?? false;
            if (!terminate) terminateBatch = false;

            const resultText = textOf(finalContent);
            agent.toolResults.push({ name: call.name, text: resultText, terminate });
            const resultMessage = {
              role: 'toolResult',
              toolCallId: callId,
              toolName: call.name,
              content: Array.isArray(finalContent)
                ? finalContent
                : [{ type: 'text', text: resultText }],
              isError,
              timestamp: Date.now(),
            } as unknown as AgentMessage;
            toolResultMessages.push(resultMessage);
            agent.state.messages.push(resultMessage);
            runMessages.push(resultMessage);
          }

          agent.emitEvent({
            type: 'turn_end',
            message: assistant,
            toolResults: toolResultMessages,
          } as unknown as PiEvent);

          // Pi checks the abort signal at the turn boundary, so a run
          // unblocked by an abort-raced permission ask unwinds here.
          if (controller.signal.aborted) {
            const err = new Error('Request was aborted.');
            err.name = 'AbortError';
            throw err;
          }
          if (calls.length === 0 || terminateBatch) break;
        }

        agent.state.messages.push(...(agent.followUpQueue.splice(0) as AgentMessage[]));
        agent.emitEvent({ type: 'agent_end', messages: runMessages } as unknown as PiEvent);
        return { content: lastText };
      } finally {
        running = false;
        agent.runSignal = null;
        abortController = null;
        idleResolve?.();
        idleResolve = null;
      }
      }

  const agent: ScriptedPiAgent = {
    state: { messages: [], systemPrompt: '', tools: [] },
    promptCalls: [],
    steeringQueue: [],
    followUpQueue: [],
    script: [],
    defaultText: 'ok',
    hold: false,
    toolResults: [],
    modelCalls: 0,
    continueCalls: 0,
    failWith: null,
    runSignal: null,

    subscribe(handler: (event: PiEvent) => void): () => void {
      eventHandler = handler;
      return () => { eventHandler = null; };
    },

    emitEvent(event: PiEvent): void {
      eventHandler?.(event);
    },

    async prompt(input: string | AgentMessage[]): Promise<unknown> {
      agent.promptCalls.push(input);
      return runBody(input);
    },

    /**
     * The retry path. Cortex's runTurnWithRetry calls continue() for every
     * attempt after the first, so a scripted ladder needs this to really run
     * rather than throw.
     */
    async continue(): Promise<unknown> {
      agent.continueCalls += 1;
      return runBody(null);
    },

    releaseRun(): void {
      releaseRun?.();
      releaseRun = null;
      rejectRun = null;
    },

    abort(): void {
      // The signal first: a run blocked inside a permission ask is unblocked
      // by the abort race, not by rejecting the hold.
      abortController?.abort();
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

// ---------------------------------------------------------------------------
// Facade assembly
// ---------------------------------------------------------------------------

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

export function testModel(): CortexModel {
  return wrapModel(
    { provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel,
    'anthropic',
    'claude-sonnet-4-20250514',
  );
}

/**
 * The real afterToolCall hook Cortex installs on a loop (the D17 terminate
 * guards and the working-tags reminder live in it). Built the same way the
 * loop's own construction path builds it, so the scripted batch runs the
 * production code rather than a test double of it.
 */
export function realAfterToolCall(loop: AgentLoop): AfterToolCallHook {
  const statics = AgentLoop as unknown as {
    buildPiAgentConfig: (params: {
      cortexConfig: AgentLoopConfig;
      cacheBreakpointState: { agentLoop: AgentLoop | null };
    }) => Record<string, unknown>;
  };
  const agentConfig = statics.buildPiAgentConfig({
    cortexConfig: { model: testModel(), workingDirectory: '/tmp/test-workspace' },
    cacheBreakpointState: { agentLoop: loop },
  });
  return agentConfig['afterToolCall'] as AfterToolCallHook;
}

/**
 * Install the REAL permission gate on a loop's scripted pi: the same
 * beforeToolCall hook the loop's own construction builds, carrying ask
 * identity, the pending-ask registry write, the verbatim rendered request,
 * and the abort race. With it wired, a scripted tool call really blocks on a
 * decision instead of the test simulating one.
 */
export function installPermissionGate(
  loop: AgentLoop,
  pi: ScriptedPiAgent,
  resolvePermission: NonNullable<AgentLoopConfig['resolvePermission']>,
): void {
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
      loopPath: loop.loopPath,
      resolvePermission,
    },
    cacheBreakpointState: { agentLoop: loop },
  });
  pi.beforeToolCall = agentConfig['beforeToolCall'] as BeforeToolCallHook;
}

/**
 * Build quick-lookup loops over scripted pi agents instead of real provider
 * loops. Setup runs on each pi BEFORE its prompt, because the lookup answers
 * in microtasks and configuring after a poll would race the whole run.
 */
export function stubLookupLoops(setup?: (pi: ScriptedPiAgent) => void): {
  pis: ScriptedPiAgent[];
  configs: AgentLoopConfig[];
} {
  const pis: ScriptedPiAgent[] = [];
  const configs: AgentLoopConfig[] = [];
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  vi.spyOn(AgentLoop, 'create').mockImplementation(async (config) => {
    const pi = createScriptedPiAgent();
    setup?.(pi);
    pis.push(pi);
    configs.push(config);
    return new AgentLoopCtor(pi, config, [], {
      enableSubAgentTool: false,
      enableLoadSkillTool: false,
    });
  });
  return { pis, configs };
}

/** The headline block the talker is actually fed on its next call. */
export function talkerHeadline(talkerLoop: AgentLoop): string | null {
  const provider = (talkerLoop as unknown as {
    headlineProvider: (() => string | null) | null;
  }).headlineProvider;
  if (typeof provider !== 'function') throw new Error('no headline provider wired');
  return provider();
}

export interface DuplexScenarioHarness {
  facade: CortexAgent;
  talkerLoop: AgentLoop;
  reasonerLoop: AgentLoop;
  talkerPi: ScriptedPiAgent;
  reasonerPi: ScriptedPiAgent;
}

export interface PassthroughScenarioHarness {
  facade: CortexAgent;
  reasonerLoop: AgentLoop;
  reasonerPi: ScriptedPiAgent;
}

const liveFacades: CortexAgent[] = [];

/** Tear down every facade a scenario built. Call from afterEach. */
export async function destroyLiveFacades(): Promise<void> {
  for (const facade of liveFacades.splice(0)) {
    await facade.destroy().catch(() => {});
  }
}

export function createDuplexScenario(
  overrides?: Partial<CortexAgentConfig>,
): DuplexScenarioHarness {
  const talkerPi = createScriptedPiAgent();
  const reasonerPi = createScriptedPiAgent();
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  const loopSlots = overrides?.slots ?? [];
  const reasonerLoop = new AgentLoopCtor(reasonerPi, {
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    slots: loopSlots,
    loopPath: 'reasoner',
    // The real ladder's first backoff is two minutes, which no test can wait
    // out; scenarios that exercise retries override this with something
    // short. Left at the default a scripted ladder simply never runs.
    ...(overrides?.retryPolicy !== undefined ? { retryPolicy: overrides.retryPolicy } : {}),
  });
  const talkerLoop = new AgentLoopCtor(talkerPi, {
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    slots: loopSlots,
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
      // Timers that would otherwise fire mid-scenario; scenarios that want
      // them set their own value.
      watchdogIntervalMs: 3_600_000,
      idleDigestionDelayMs: 3_600_000,
      ...duplexOverrides,
    },
    ...restOverrides,
  }, talkerLoop);
  liveFacades.push(facade);

  talkerPi.afterToolCall = realAfterToolCall(talkerLoop);
  reasonerPi.afterToolCall = realAfterToolCall(reasonerLoop);

  return { facade, talkerLoop, reasonerLoop, talkerPi, reasonerPi };
}

/**
 * A duplex facade assembled by the REAL {@link CortexAgent.create}, with one
 * substitution: the pi agent each loop wraps. Everything create() itself does
 * runs for real (permission brokering, the MCP multiplexer, the talker and
 * reasoner config builders, wireDuplex), so an assembled property that is
 * merely computed and never applied fails here rather than passing on the
 * strength of a config-builder unit test.
 *
 * The hooks installed on each scripted pi are built from the config create()
 * assembled for THAT loop, not from a fresh minimal one, so the brokered
 * resolver a reasoner tool call hits is the one create() wired.
 *
 * What the substitution still leaves out: pi-agent-core's own Agent (turn
 * construction, streaming, real tool dispatch) and every provider call.
 */
export interface RealDuplexScenarioHarness extends DuplexScenarioHarness {
  /** Every loop config create() assembled, in construction order. */
  loopConfigs: AgentLoopConfig[];
  /** Loops built through create(), by loopPath ('talker', 'reasoner', ...). */
  builtLoops: Map<string, { loop: AgentLoop; pi: ScriptedPiAgent }>;
}

export async function createRealDuplexScenario(
  config: Partial<CortexAgentConfig> = {},
): Promise<RealDuplexScenarioHarness> {
  const statics = AgentLoop as unknown as {
    buildPiAgentConfig: (params: {
      cortexConfig: AgentLoopConfig;
      cacheBreakpointState: { agentLoop: AgentLoop | null };
    }) => Record<string, unknown>;
    wireManagedPiAgent: (loop: AgentLoop, pi: PiAgent) => void;
  };
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  const loopConfigs: AgentLoopConfig[] = [];
  const builtLoops = new Map<string, { loop: AgentLoop; pi: ScriptedPiAgent }>();

  vi.spyOn(AgentLoop, 'create').mockImplementation(async (loopConfig) => {
    const pi = createScriptedPiAgent();
    const extras = loopConfig as {
      tools?: unknown[];
      enableSubAgentTool?: boolean;
      enableLoadSkillTool?: boolean;
    };
    const loop = new AgentLoopCtor(pi, loopConfig, extras.tools ?? [], {
      enableSubAgentTool: extras.enableSubAgentTool ?? true,
      enableLoadSkillTool: extras.enableLoadSkillTool ?? true,
    });
    // The real hooks, from the real assembled config: afterToolCall carries
    // the D17 terminate guards, beforeToolCall carries ask identity and
    // whatever resolver create() decided this loop should have.
    const agentConfig = statics.buildPiAgentConfig({
      cortexConfig: loopConfig,
      cacheBreakpointState: { agentLoop: loop },
    });
    pi.afterToolCall = agentConfig['afterToolCall'] as AfterToolCallHook;
    pi.beforeToolCall = agentConfig['beforeToolCall'] as BeforeToolCallHook | undefined;
    statics.wireManagedPiAgent(loop, pi);
    loopConfigs.push(loopConfig);
    builtLoops.set(loopConfig.loopPath ?? 'main', { loop, pi });
    return loop;
  });

  const facade = await CortexAgent.create({
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    ...config,
    mode: 'duplex',
    duplex: {
      minDeliverySpacingMs: 0,
      idlePollMs: 5,
      whenIdleDegradeMs: 60_000,
      watchdogIntervalMs: 3_600_000,
      idleDigestionDelayMs: 3_600_000,
      ...config.duplex,
    },
  });
  liveFacades.push(facade);

  const talker = builtLoops.get('talker');
  const reasoner = builtLoops.get('reasoner');
  if (!talker || !reasoner) throw new Error('create() did not build both resident loops');
  return {
    facade,
    talkerLoop: talker.loop,
    talkerPi: talker.pi,
    reasonerLoop: reasoner.loop,
    reasonerPi: reasoner.pi,
    loopConfigs,
    builtLoops,
  };
}

/** The same shape in passthrough: one loop, no talker, no control tools. */
export function createPassthroughScenario(
  overrides?: Partial<CortexAgentConfig>,
): PassthroughScenarioHarness {
  const reasonerPi = createScriptedPiAgent();
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  const reasonerLoop = new AgentLoopCtor(reasonerPi, {
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    slots: overrides?.slots ?? [],
  });
  const CortexAgentCtor = CortexAgent as unknown as TestCortexAgentConstructor;
  const facade = new CortexAgentCtor(reasonerLoop, {
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    mode: 'passthrough',
    ...overrides,
  });
  liveFacades.push(facade);
  reasonerPi.afterToolCall = realAfterToolCall(reasonerLoop);
  return { facade, reasonerLoop, reasonerPi };
}

/**
 * A stand-in sub-agent for scenarios that need a real tier-3 child: a real
 * AgentLoop over a scripted pi, injected through createChildAgent so no
 * provider is involved. Everything the parent touches (steering queue,
 * budget guard, event bridge, abort, destroy) is the real implementation.
 */
export function stubChildAgents(
  parent: AgentLoop,
  setup?: (pi: ScriptedPiAgent) => void,
): {
  children: Array<{ loop: AgentLoop; pi: ScriptedPiAgent; instructions: string }>;
} {
  const children: Array<{ loop: AgentLoop; pi: ScriptedPiAgent; instructions: string }> = [];
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  (parent as unknown as {
    createChildAgent: (params: { instructions: string; taskId: string }) => Promise<AgentLoop>;
  }).createChildAgent = async (params) => {
    const pi = createScriptedPiAgent();
    setup?.(pi);
    const loop = new AgentLoopCtor(pi, {
      model: testModel(),
      workingDirectory: '/tmp/test-workspace',
      initialBasePrompt: 'Child prompt',
      slots: [],
      loopPath: `${parent.loopPath}/${params.taskId}`,
    }, [], { enableSubAgentTool: false, enableLoadSkillTool: false });
    pi.afterToolCall = realAfterToolCall(loop);
    children.push({ loop, pi, instructions: params.instructions });
    return loop;
  };
  return { children };
}

// ---------------------------------------------------------------------------
// Assertions and polling
// ---------------------------------------------------------------------------

/** Poll until `predicate` holds; throws after `timeoutMs`. Never sleeps fixed. */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Let pending microtasks and short timers run without asserting anything.
 * Used only to give a NEGATIVE assertion ("nothing else happened") a chance
 * to be wrong; positive assertions always poll.
 */
export async function settle(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** The text of a pi prompt call, whichever shape it arrived in. */
export function promptText(call: string | AgentMessage[] | undefined): string {
  if (call === undefined) return '';
  if (typeof call === 'string') return call;
  return call
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');
}

/** Every pi prompt call as text, in order. */
export function promptTexts(pi: ScriptedPiAgent): string[] {
  return pi.promptCalls.map((call) => promptText(call));
}

export function roles(messages: AgentMessage[]): string[] {
  return messages.map((message) => String(message.role));
}

/** Talker-waking deliveries the router is still holding. */
export function heldDeliveryCount(facade: CortexAgent): number {
  return (facade as unknown as {
    router: { pendingDeliveryCount: number };
  }).router.pendingDeliveryCount;
}

/** The duplex facade's consent boundary. */
export function getBroker(facade: CortexAgent): PermissionBroker {
  return (facade as unknown as {
    router: { permissionBroker: PermissionBroker };
  }).router.permissionBroker;
}

/** Log entries of one type, in seq order. */
export function entriesOfType(
  facade: CortexAgent,
  type: SessionLogEntry['type'],
): SessionLogEntry[] {
  return facade.getLog().filter((entry) => entry.type === type);
}

/** Lifecycle entries carrying a given `data.event` tag. */
export function lifecycleEvents(facade: CortexAgent, event: string): SessionLogEntry[] {
  return facade.getLog().filter(
    (entry) => entry.type === 'lifecycle' &&
      (entry.data as { event?: string } | undefined)?.event === event,
  );
}
