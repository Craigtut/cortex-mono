/**
 * The resolution report: what an assembly resolved to, where that differs
 * from what the consumer asked for.
 *
 * Every test here drives a REAL CortexAgent.create(). The conditions being
 * reported are assembly outcomes, so a test that hand-built the collector and
 * fed it a hand-written resolution would pass while the facade computed
 * nothing, which is exactly how this branch shipped four tests over a feature
 * that was dead in production.
 *
 * The property under test that is easiest to lose is the one-source rule: the
 * `logger.warn` line and the `lifecycle` log entry are DERIVED from a note,
 * never written beside it. It is asserted as an equality between the surfaces
 * rather than against hand-written expectations, because two hand-written
 * expectations drift in exactly the way the rule exists to prevent.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createRealDuplexScenario,
  createScriptedPiAgent,
  destroyLiveFacades,
  testModel,
} from './duplex-scenario-harness.js';
import type { ScriptedPiAgent } from './duplex-scenario-harness.js';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import { CortexAgent } from '../../src/cortex-agent.js';
import type { CortexAgentConfig } from '../../src/cortex-agent.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { AgentLoopConfig, CortexLogger } from '../../src/types.js';
import type { ResolutionNote } from '../../src/resolution-report.js';

const extraFacades: CortexAgent[] = [];

afterEach(async () => {
  await destroyLiveFacades();
  for (const facade of extraFacades.splice(0)) {
    await facade.destroy().catch(() => {});
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A logger that records what it was told. */
function recordingLogger(): { logger: CortexLogger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => { warnings.push(message); },
      error: () => {},
    },
  };
}

/**
 * A model on a provider Cortex cannot enumerate, which is the real production
 * shape of the talker fallback (Ollama, custom OpenAI-compatible endpoints):
 * the model list lookup finds nothing, utility resolution hands back the
 * primary, and duplex assembles with talker = reasoner. Nothing is stubbed to
 * produce it.
 */
function unenumerableModel() {
  return wrapModel(
    { provider: 'self-hosted-vllm', name: 'internal-70b' } as PiModel,
    'self-hosted-vllm',
    'internal-70b',
  );
}

/** A same-provider utility model with an id auto-resolution cannot produce. */
const UTILITY_MODEL_ID = 'claude-haiku-test-only-utility';

function anthropicUtilityModel() {
  return wrapModel(
    { provider: 'anthropic', name: UTILITY_MODEL_ID } as PiModel,
    'anthropic',
    UTILITY_MODEL_ID,
  );
}

/** A second anthropic model, distinct from both the primary and the utility. */
function anthropicTalkerModel() {
  return wrapModel(
    { provider: 'anthropic', name: 'claude-haiku-4-5' } as PiModel,
    'anthropic',
    'claude-haiku-4-5',
  );
}

/** A talker on a different provider, so the utility constraint bites. */
function openAiTalkerModel() {
  return wrapModel(
    { provider: 'openai', name: 'gpt-4o-mini' } as PiModel,
    'openai',
    'gpt-4o-mini',
  );
}

function fakeSandbox() {
  return {
    initialize: async () => ({}),
    wrapSpawn: async (spec: unknown) => spec,
  } as never;
}

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

/**
 * A passthrough facade assembled by the real CortexAgent.create(), with the
 * same one substitution the duplex harness makes: the pi agent the loop
 * wraps. Two of the four conditions are not duplex-specific, so the report
 * has to be reachable and correct here too.
 */
async function createRealPassthroughScenario(
  config: Partial<CortexAgentConfig> = {},
): Promise<{ facade: CortexAgent; pi: ScriptedPiAgent }> {
  const statics = AgentLoop as unknown as {
    buildPiAgentConfig: (params: {
      cortexConfig: AgentLoopConfig;
      cacheBreakpointState: { agentLoop: AgentLoop | null };
    }) => Record<string, unknown>;
    wireManagedPiAgent: (loop: AgentLoop, pi: PiAgent) => void;
  };
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  let built: ScriptedPiAgent | null = null;

  vi.spyOn(AgentLoop, 'create').mockImplementation(async (loopConfig) => {
    const pi = createScriptedPiAgent();
    built = pi;
    const loop = new AgentLoopCtor(pi, loopConfig, [], {
      enableSubAgentTool: false,
      enableLoadSkillTool: false,
    });
    const agentConfig = statics.buildPiAgentConfig({
      cortexConfig: loopConfig,
      cacheBreakpointState: { agentLoop: loop },
    });
    pi.afterToolCall = agentConfig['afterToolCall'] as ScriptedPiAgent['afterToolCall'];
    statics.wireManagedPiAgent(loop, pi);
    return loop;
  });

  const facade = await CortexAgent.create({
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    ...config,
    mode: 'passthrough',
  });
  extraFacades.push(facade);
  if (!built) throw new Error('create() built no loop');
  return { facade, pi: built };
}

/** The notes the session log carries, in log order. */
function loggedNotes(facade: CortexAgent): ResolutionNote[] {
  return facade.getLog()
    .filter((entry) => entry.type === 'lifecycle' &&
      (entry.data as { event?: string } | undefined)?.event === 'resolution_note')
    .map((entry) => (entry.data as { note: ResolutionNote }).note);
}

function codes(notes: ResolutionNote[]): string[] {
  return notes.map((note) => note.code);
}

// ---------------------------------------------------------------------------
// Each note, driven by the assembly that earns it
// ---------------------------------------------------------------------------

describe('resolution report: the talker fallback', () => {
  it('reports duplex assembled with talker = reasoner, which nothing else can see', async () => {
    const { facade, talkerLoop, reasonerLoop } = await createRealDuplexScenario({
      model: unenumerableModel(),
    });

    // The precondition, asserted rather than assumed: this really is the
    // healthy-looking assembly that delivers none of the latency benefit.
    expect(talkerLoop.getModel().modelId).toBe(reasonerLoop.getModel().modelId);

    const note = facade.getResolutionReport()
      .find((candidate) => candidate.code === 'talker-model-fallback');
    expect(note).toBeDefined();
    expect(note!.severity).toBe('degraded');
    expect(note!.data).toEqual({
      provider: 'self-hosted-vllm',
      talkerModelId: 'internal-70b',
      reasonerModelId: 'internal-70b',
    });
    // Structured enough to render without the prose, and the prose names the
    // dial to turn.
    expect(note!.summary).toContain('internal-70b');
    expect(note!.remedy).toContain('talker.model');
  });

  it('says nothing when the consumer deliberately named the primary as the talker', async () => {
    // Same assembled outcome, different meaning: this consumer chose it.
    const primary = unenumerableModel();
    const { facade, talkerLoop, reasonerLoop } = await createRealDuplexScenario({
      model: primary,
      talker: { model: primary },
    });

    expect(talkerLoop.getModel().modelId).toBe(reasonerLoop.getModel().modelId);
    expect(codes(facade.getResolutionReport())).not.toContain('talker-model-fallback');
  });
});

describe('resolution report: the skipped talker utility model', () => {
  it('reports a utilityModel the talker could not take', async () => {
    const utility = anthropicUtilityModel();
    const { facade, talkerLoop, reasonerLoop } = await createRealDuplexScenario({
      utilityModel: utility,
      talker: { model: openAiTalkerModel() },
    });

    // Precondition: the reasoner runs what the consumer set and the talker
    // does not, which is the divergence the note exists to name.
    expect(reasonerLoop.getUtilityModel().modelId).toBe(UTILITY_MODEL_ID);
    expect(talkerLoop.getUtilityModel().modelId).not.toBe(UTILITY_MODEL_ID);

    const note = facade.getResolutionReport()
      .find((candidate) => candidate.code === 'talker-utility-model-skipped');
    expect(note).toBeDefined();
    expect(note!.severity).toBe('degraded');
    // The note reports what the talker ACTUALLY resolved to, not merely that
    // a provider mismatch existed in the config.
    expect(note!.data['talkerUtilityModelId']).toBe(talkerLoop.getUtilityModel().modelId);
    expect(note!.data['configuredUtilityModelId']).toBe(UTILITY_MODEL_ID);
    expect(note!.data['talkerModelId']).toBe('gpt-4o-mini');
  });

  it('says nothing when the talker took it, even on a different primary model', async () => {
    // Same provider, so the setting applies: an explicit talker model that is
    // neither the primary nor the utility model must not read as a skip.
    const utility = anthropicUtilityModel();
    const { facade, talkerLoop } = await createRealDuplexScenario({
      utilityModel: utility,
      talker: { model: anthropicTalkerModel() },
    });

    expect(talkerLoop.getModel().modelId).toBe('claude-haiku-4-5');
    expect(talkerLoop.getUtilityModel().modelId).toBe(UTILITY_MODEL_ID);
    expect(codes(facade.getResolutionReport())).not.toContain('talker-utility-model-skipped');
  });
});

describe('resolution report: the uncapped session', () => {
  it('reports the missing session ceiling as info, not as a degradation', async () => {
    const { facade } = await createRealDuplexScenario();

    const note = facade.getResolutionReport()
      .find((candidate) => candidate.code === 'duplex-cost-cap-unset');
    expect(note).toBeDefined();
    // Nothing is broken here: a default is in force that a consumer may want
    // to change. Severity is the whole distinction, so it is pinned.
    expect(note!.severity).toBe('info');
    expect(facade.getAggregateBudgetGuard()!.getMaxCost()).toBe(Infinity);
    expect(note!.remedy).toContain('duplex.maxTotalCost');
  });

  it('carries the per-prompt cap that consumers mistake for a session cap', async () => {
    const { facade } = await createRealDuplexScenario({
      budgetGuard: { maxTurns: 100, maxCost: 10 },
    });

    const note = facade.getResolutionReport()
      .find((candidate) => candidate.code === 'duplex-cost-cap-unset')!;
    // The number they did set, so a consumer can render "you set $10 per
    // prompt, that is not a session ceiling" without re-reading its config.
    expect(note.data['perPromptMaxCost']).toBe(10);
  });
});

describe('resolution report: a healthy duplex assembly', () => {
  it('produces no notes at all, and the same assembly uncapped produces one', async () => {
    const { facade, talkerLoop, reasonerLoop } = await createRealDuplexScenario({
      duplex: { maxTotalCost: 25 },
    });

    // Positive preconditions, so an empty report cannot pass vacuously: this
    // is a real duplex (two different models, the talker on the fast tier)
    // with a real session ceiling.
    expect(talkerLoop.getModel().modelId).not.toBe(reasonerLoop.getModel().modelId);
    expect(reasonerLoop.getModel().modelId).toBe('claude-sonnet-4-20250514');
    expect(facade.getAggregateBudgetGuard()!.getMaxCost()).toBe(25);

    expect(facade.getResolutionReport().filter((note) => note.severity === 'degraded'))
      .toEqual([]);
    expect(facade.getResolutionReport()).toEqual([]);
    expect(loggedNotes(facade)).toEqual([]);

    // And the collector is not simply inert: drop the one thing that was
    // configured and the same assembly earns exactly one note.
    const { facade: uncapped } = await createRealDuplexScenario();
    expect(codes(uncapped.getResolutionReport())).toEqual(['duplex-cost-cap-unset']);
  });
});

// ---------------------------------------------------------------------------
// One source, derived surfaces
// ---------------------------------------------------------------------------

describe('resolution report: one source, three surfaces', () => {
  it('the log entries and the report are the same notes, not two descriptions', async () => {
    const { logger, warnings } = recordingLogger();
    const { facade } = await createRealDuplexScenario({
      logger,
      model: unenumerableModel(),
    });

    const report = facade.getResolutionReport();
    // More than one note, so an accidental single-element coincidence cannot
    // carry the equality.
    expect(codes(report)).toEqual(['talker-model-fallback', 'duplex-cost-cap-unset']);

    // Asserted as an equality between the surfaces. A hand-written expected
    // shape here would be a second description of the same fact, which is the
    // drift this rule exists to prevent.
    expect(loggedNotes(facade)).toEqual(report);
    expect(warnings).toEqual(
      report.map((note) => `[CortexAgent] ${note.detail} ${note.remedy}`),
    );
  });

  it('hands out copies: a consumer cannot rewrite the record the log was built from', async () => {
    const { facade } = await createRealDuplexScenario({ model: unenumerableModel() });

    const report = facade.getResolutionReport();
    report[0]!.summary = 'rewritten';
    report[0]!.data['provider'] = 'rewritten';
    report.length = 0;

    expect(facade.getResolutionReport()).toHaveLength(2);
    expect(facade.getResolutionReport()[0]!.summary).not.toBe('rewritten');
    expect(loggedNotes(facade)[0]!.data['provider']).toBe('self-hosted-vllm');
  });

  it('is fixed at assembly: later model changes neither add nor remove notes', async () => {
    // Eager, not lazy on first read. A lazily computed report would observe
    // post-assembly mutation and present it as an assembly fact, and its log
    // entries would appear whenever the consumer happened to look.
    const { facade, talkerLoop, reasonerLoop } = await createRealDuplexScenario({
      duplex: { maxTotalCost: 25 },
    });
    expect(facade.getResolutionReport()).toEqual([]);

    talkerLoop.setModel(reasonerLoop.getModel());
    expect(talkerLoop.getModel().modelId).toBe(reasonerLoop.getModel().modelId);
    expect(facade.getResolutionReport()).toEqual([]);
    expect(loggedNotes(facade)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The one note that is not an assembly fact
// ---------------------------------------------------------------------------

describe('resolution report: the unwired egress resolver', () => {
  it('is recorded at the first prompt, once, and reaches every surface', async () => {
    const { logger, warnings } = recordingLogger();
    const { facade } = await createRealDuplexScenario({
      logger,
      duplex: { maxTotalCost: 25 },
      sandbox: fakeSandbox(),
      resolveNetworkAccess: async () => ({ decision: 'ask' as const }),
    });

    // Not knowable at assembly: a consumer wires the resolver on the line
    // after create() returns, so the report is empty until something has
    // happened that the wiring should have preceded.
    expect(facade.getResolutionReport()).toEqual([]);

    await facade.prompt('hello');
    const report = facade.getResolutionReport();
    expect(codes(report)).toEqual(['network-resolver-unwired']);
    expect(report[0]!.severity).toBe('degraded');
    // It claims only what is observable. Asserting the absence of the old
    // inference, not just the presence of the new wording: "fails closed" is
    // a statement about consumer wiring Cortex cannot see, and it was false
    // for the first consumer that read it.
    expect(report[0]!.detail).not.toContain('fail closed');
    expect(report[0]!.detail).toContain('never voiced to the talker');
    expect(loggedNotes(facade)).toEqual(report);
    expect(warnings).toEqual(
      report.map((note) => `[CortexAgent] ${note.detail} ${note.remedy}`),
    );

    // Once, not once per prompt: the report is a set of facts, not a stream.
    await facade.prompt('again');
    expect(facade.getResolutionReport()).toHaveLength(1);
    expect(loggedNotes(facade)).toHaveLength(1);
  });

  it('says nothing when the consumer took the resolver', async () => {
    const { facade } = await createRealDuplexScenario({
      duplex: { maxTotalCost: 25 },
      sandbox: fakeSandbox(),
      resolveNetworkAccess: async () => ({ decision: 'ask' as const }),
    });
    expect(facade.getNetworkAccessResolver()).toBeDefined();

    await facade.prompt('hello');
    expect(facade.getResolutionReport()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Passthrough
// ---------------------------------------------------------------------------

describe('resolution report: passthrough', () => {
  it('is empty for a healthy passthrough assembly', async () => {
    const { facade } = await createRealPassthroughScenario();

    // The precondition that makes the empty report meaningful: this really is
    // an assembled passthrough agent, not a facade that failed to wire.
    expect(facade.getModel().modelId).toBe('claude-sonnet-4-20250514');
    expect(facade.getAggregateBudgetGuard()).toBeNull();
    expect(facade.getResolutionReport()).toEqual([]);
  });

  it('never reports the unwired egress resolver, where the same wiring in duplex does', async () => {
    // The note's subject is the broker, and passthrough has none:
    // getNetworkAccessResolver() hands back the consumer's own function
    // unchanged there, so calling it would change nothing and never calling
    // it proves nothing. Reported anyway, this lit permanently for the first
    // real consumer, which is pinned passthrough and wires its sandbox to its
    // own decision function.
    const sandbox = fakeSandbox();
    const resolveNetworkAccess = async () => ({ decision: 'ask' as const });

    const { facade: passthrough } = await createRealPassthroughScenario({
      sandbox,
      resolveNetworkAccess,
    });
    await passthrough.prompt('hello');

    // Positive precondition: the prompt really ran, so the check point this
    // note is recorded from was actually reached rather than skipped.
    expect(passthrough.getLog().filter((entry) => entry.type === 'utterance'))
      .toHaveLength(1);
    expect(passthrough.getResolutionReport()).toEqual([]);
    expect(loggedNotes(passthrough)).toEqual([]);

    // The second positive precondition, and the one that makes the silence
    // above a decision rather than an accident: the SAME sandbox and the SAME
    // resolver, differing only in mode, still produce the note. Deliberately
    // not asserted by calling getNetworkAccessResolver() on the passthrough
    // facade, which would set the handed-out flag and suppress the note for
    // the wrong reason.
    const { facade: duplex } = await createRealDuplexScenario({
      duplex: { maxTotalCost: 25 },
      sandbox,
      resolveNetworkAccess,
    });
    await duplex.prompt('hello');
    expect(codes(duplex.getResolutionReport())).toEqual(['network-resolver-unwired']);
  });
});
