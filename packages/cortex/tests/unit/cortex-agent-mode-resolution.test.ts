/**
 * An omitted CortexAgent mode is resolved from backend concurrency
 * (decisions.md D21): duplex when both loops' models are served
 * concurrently, passthrough otherwise, with a note saying why. An explicit
 * mode always wins, and duplex on a backend not known to be concurrent
 * carries a warning note.
 *
 * Models come from the real creation paths (ProviderManager against a
 * synthetic Ollama server, pi-ai's catalog), so the capability each path
 * stamps is what the decision reads. Only the pi agent under each loop is
 * substituted.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent } from '../../src/agent-loop.js';
import { CortexAgent } from '../../src/cortex-agent.js';
import type { CortexAgentConfig } from '../../src/cortex-agent.js';
import type { AgentLoopConfig } from '../../src/types.js';
import type { CortexModel } from '../../src/model-wrapper.js';
import { ProviderManager } from '../../src/provider-manager.js';
import type { ResolutionNote } from '../../src/resolution-report.js';
import { createScriptedPiAgent } from './duplex-scenario-harness.js';
import { ollamaServer } from '../helpers/ollama.js';

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

const facades: CortexAgent[] = [];

afterEach(async () => {
  for (const facade of facades.splice(0)) await facade.destroy().catch(() => {});
  vi.restoreAllMocks();
});

/** Build a facade through the real create(), recording the loops it assembled. */
async function create(config: Partial<CortexAgentConfig> & { model: CortexModel }): Promise<{
  facade: CortexAgent;
  loopPaths: string[];
  loops: Map<string, AgentLoop>;
}> {
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  const loopPaths: string[] = [];
  const loops = new Map<string, AgentLoop>();
  vi.spyOn(AgentLoop, 'create').mockImplementation(async (loopConfig) => {
    const extras = loopConfig as { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean };
    const loop = new AgentLoopCtor(createScriptedPiAgent(), loopConfig, [], {
      enableSubAgentTool: extras.enableSubAgentTool ?? true,
      enableLoadSkillTool: extras.enableLoadSkillTool ?? true,
    });
    loopPaths.push(loopConfig.loopPath ?? 'main');
    loops.set(loopConfig.loopPath ?? 'main', loop);
    return loop;
  });
  const facade = await CortexAgent.create({
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    ...config,
  });
  facades.push(facade);
  return { facade, loopPaths, loops };
}

function note(facade: CortexAgent, code: string): ResolutionNote | undefined {
  return facade.getResolutionReport().find((candidate) => candidate.code === code);
}

function ollamaModel(options: { parallelRequests?: boolean } = {}): Promise<CortexModel> {
  return new ProviderManager().createOllamaModel({
    modelId: 'test',
    fetch: ollamaServer().fetch,
    ...options,
  });
}

describe('omitted mode', () => {
  it('resolves to duplex on a hosted provider', async () => {
    const model = await new ProviderManager().resolveModel('anthropic', 'claude-sonnet-4-6');
    expect(model.capabilities?.concurrency).toBe('parallel');

    const { facade, loopPaths, loops } = await create({ model });

    expect(loopPaths).toEqual(['reasoner', 'talker']);
    // The auto-resolved fast tier, so the talker is a different model.
    expect(loops.get('talker')!.getModel().modelId).not.toBe('claude-sonnet-4-6');
    expect(note(facade, 'mode-resolved-passthrough')).toBeUndefined();
    expect(note(facade, 'duplex-not-concurrent')).toBeUndefined();
  });

  it('resolves to duplex when a hosted talker runs the same model as the reasoner', async () => {
    const pm = new ProviderManager();
    const reasoner = await pm.resolveModel('anthropic', 'claude-opus-4-7');
    const talker = await pm.resolveModel('anthropic', 'claude-opus-4-7');

    const { facade, loopPaths, loops } = await create({ model: reasoner, talker: { model: talker } });

    // A hosted API serves two requests for one model concurrently.
    expect(loopPaths).toEqual(['reasoner', 'talker']);
    expect(loops.get('talker')!.getModel().modelId).toBe(loops.get('reasoner')!.getModel().modelId);
    expect(note(facade, 'mode-resolved-passthrough')).toBeUndefined();
    expect(note(facade, 'duplex-not-concurrent')).toBeUndefined();
  });

  it('resolves to passthrough on Ollama, and says why', async () => {
    const model = await ollamaModel();
    expect(model.capabilities?.concurrency).toBe('serial');

    const { facade, loopPaths } = await create({ model });

    expect(loopPaths).toEqual(['main']);
    const resolved = note(facade, 'mode-resolved-passthrough');
    expect(resolved).toBeDefined();
    expect(resolved!.severity).toBe('info');
    expect(resolved!.data).toMatchObject({
      reasonerProvider: 'ollama',
      reasonerModelId: 'test',
      reasonerConcurrency: 'serial',
      talkerConcurrency: 'serial',
    });
    expect(resolved!.detail).toContain('serves one request at a time');
    expect(resolved!.remedy).toContain('parallelRequests: true');
  });

  it('resolves to duplex on Ollama with the parallel opt-in', async () => {
    const model = await ollamaModel({ parallelRequests: true });
    expect(model.capabilities?.concurrency).toBe('parallel');

    const { facade, loopPaths } = await create({ model });

    expect(loopPaths).toEqual(['reasoner', 'talker']);
    expect(note(facade, 'mode-resolved-passthrough')).toBeUndefined();
    expect(note(facade, 'duplex-not-concurrent')).toBeUndefined();
  });

  it('resolves to passthrough on a custom OpenAI-compatible endpoint', async () => {
    const model = await new ProviderManager().createCustomModel({
      baseUrl: 'http://localhost:8000/v1',
      modelId: 'local-model',
    });
    expect(model.capabilities?.concurrency).toBe('unknown');

    const { facade, loopPaths } = await create({ model });

    expect(loopPaths).toEqual(['main']);
    expect(note(facade, 'mode-resolved-passthrough')!.data).toMatchObject({
      reasonerProvider: 'custom',
      reasonerConcurrency: 'unknown',
    });
  });
});

describe('explicit mode', () => {
  it('runs duplex on a serial backend when asked, with a warning note', async () => {
    const model = await ollamaModel();

    const { facade, loopPaths } = await create({ model, mode: 'duplex' });

    expect(loopPaths).toEqual(['reasoner', 'talker']);
    const warning = note(facade, 'duplex-not-concurrent');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('degraded');
    expect(warning!.data).toMatchObject({ talkerConcurrency: 'serial', reasonerConcurrency: 'serial' });
    // Asked for, so there is no auto-resolution note.
    expect(note(facade, 'mode-resolved-passthrough')).toBeUndefined();
  });

  it('runs passthrough on a hosted provider when asked, with no mode notes', async () => {
    const model = await new ProviderManager().resolveModel('anthropic', 'claude-sonnet-4-6');

    const { facade, loopPaths } = await create({ model, mode: 'passthrough' });

    expect(loopPaths).toEqual(['main']);
    expect(facade.getResolutionReport()).toEqual([]);
  });
});

describe('setModel after assembly', () => {
  it('keeps the mode and warns when a pinned-talker duplex moves onto a serial reasoner', async () => {
    const pm = new ProviderManager();
    const hosted = await pm.resolveModel('anthropic', 'claude-sonnet-4-6');
    const talker = await pm.resolveModel('anthropic', 'claude-haiku-4-5');
    const { facade, loops } = await create({ model: hosted, talker: { model: talker } });
    expect(note(facade, 'duplex-not-concurrent')).toBeUndefined();

    facade.setModel(await ollamaModel());

    // Still duplex: the loops were assembled from the mode.
    expect(loops.get('talker')!.getModel().modelId).toBe('claude-haiku-4-5');
    expect(note(facade, 'duplex-not-concurrent')!.data).toMatchObject({
      talkerConcurrency: 'parallel',
      reasonerConcurrency: 'serial',
    });
  });
});
