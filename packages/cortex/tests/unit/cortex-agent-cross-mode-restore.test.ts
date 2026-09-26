/**
 * Restoring an artifact into an agent of the other mode
 * (facade/cross-mode-restore.ts, decisions.md D21): a degraded
 * `restore-mode-mismatch` note and its lifecycle entry say what was carried
 * and what is inactive, and a passthrough agent restoring a duplex artifact
 * takes the conversation the reasoner had not seen yet as context.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent } from '../../src/agent-loop.js';
import { CortexAgent } from '../../src/cortex-agent.js';
import type { CortexAgentConfig, CortexAgentStateV2 } from '../../src/cortex-agent.js';
import type { AgentLoopConfig } from '../../src/types.js';
import type { AgentMessage } from '../../src/context-manager.js';
import { ProviderManager } from '../../src/provider-manager.js';
import type { ResolutionNote } from '../../src/resolution-report.js';
import { createScriptedPiAgent } from './duplex-scenario-harness.js';

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

async function create(config: Partial<CortexAgentConfig> = {}): Promise<{
  facade: CortexAgent;
  loops: Map<string, AgentLoop>;
}> {
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  const loops = new Map<string, AgentLoop>();
  vi.spyOn(AgentLoop, 'create').mockImplementation(async (loopConfig) => {
    const loop = new AgentLoopCtor(createScriptedPiAgent(), loopConfig, [], {
      enableSubAgentTool: true,
      enableLoadSkillTool: true,
    });
    loops.set(loopConfig.loopPath ?? 'main', loop);
    return loop;
  });
  const facade = await CortexAgent.create({
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    model: await new ProviderManager().resolveModel('anthropic', 'claude-sonnet-4-6'),
    ...config,
  });
  facades.push(facade);
  return { facade, loops };
}

function note(facade: CortexAgent, code = 'restore-mode-mismatch'): ResolutionNote | undefined {
  return facade.getResolutionReport().find((candidate) => candidate.code === code);
}

const talkerTurn = { role: 'user', content: 'what changed?', timestamp: 1 } as AgentMessage;

/** A real duplex artifact, with conversation the reasoner has not seen yet. */
async function duplexArtifact(): Promise<CortexAgentStateV2> {
  const { facade } = await create();
  const state = await facade.getState();
  expect(state.router).toBeDefined();
  return {
    ...state,
    talkerHistory: [talkerTurn],
    router: {
      ...state.router!,
      conversationDeltas: [
        { speaker: 'user', text: 'rename it to parseConfig' },
        { speaker: 'assistant', text: 'On it.' },
      ],
      pendingDeliveries: ['Tests pass.'],
    },
  };
}

describe('restoring a duplex artifact into a passthrough agent', () => {
  it('records the writing mode in the artifact', async () => {
    const { facade: duplex } = await create();
    const { facade: passthrough } = await create({ mode: 'passthrough' });

    expect((await duplex.getState()).mode).toBe('duplex');
    expect((await passthrough.getState()).mode).toBe('passthrough');
  });

  it('records a degraded note and a lifecycle entry saying what is carried and inactive', async () => {
    const artifact = await duplexArtifact();
    const { facade } = await create({ mode: 'passthrough' });
    expect(note(facade)).toBeUndefined();

    await facade.restore(artifact);

    const mismatch = note(facade)!;
    expect(mismatch.severity).toBe('degraded');
    expect(mismatch.data).toEqual({
      artifactMode: 'duplex',
      agentMode: 'passthrough',
      conversationLinesHandedOver: 2,
      talkerHistoryLength: 1,
      resultsNotRelayed: 1,
    });
    expect(mismatch.detail).toContain('nothing reads them in passthrough');
    expect(mismatch.detail).toContain('1 result(s) the talker had not yet relayed');
    // Recorded after the log was replaced, so it lands in the restored log.
    const entry = facade.getLog().find((candidate) => candidate.type === 'lifecycle'
      && (candidate.data as { note?: ResolutionNote } | undefined)?.note?.code === 'restore-mode-mismatch');
    expect(entry?.content).toBe(mismatch.summary);
  });

  it('queues the conversation the reasoner had not seen on the single loop', async () => {
    const artifact = await duplexArtifact();
    const { facade, loops } = await create({ mode: 'passthrough' });

    await facade.restore(artifact);

    const queued = loops.get('main')!.getQueuedDeliveries();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toContain('User: rename it to parseConfig');
    expect(queued[0]).toContain('Assistant (conversation surface): On it.');
    expect(queued[0]).not.toContain('directive below');
  });

  it('carries the talker side without the handed-over lines, so a round trip does not repeat them', async () => {
    const artifact = await duplexArtifact();
    const { facade } = await create({ mode: 'passthrough' });

    await facade.restore(artifact);
    const state = await facade.getState();

    expect(state.router!.conversationDeltas).toEqual([]);
    expect(state.talkerHistory).toEqual([talkerTurn]);
    expect(state.router!.pendingDeliveries).toEqual(['Tests pass.']);
    // The hand-over itself persists as the loop's queued context.
    expect(state.queuedDeliveries!.reasoner.join('\n')).toContain('rename it to parseConfig');
  });

  it('reads an older artifact without a mode field by its shape', async () => {
    const { mode: _mode, ...legacy } = await duplexArtifact();
    expect('mode' in legacy).toBe(false);
    const { facade } = await create({ mode: 'passthrough' });

    await facade.restore(legacy);

    expect(note(facade)!.data).toMatchObject({ artifactMode: 'duplex', agentMode: 'passthrough' });
  });
});

describe('restoring a passthrough artifact into a duplex agent', () => {
  it('records a note that the talker starts without the conversation', async () => {
    const { facade: writer } = await create({ mode: 'passthrough' });
    const artifact = await writer.getState();
    expect(artifact.router).toBeUndefined();
    const { facade } = await create();

    await facade.restore(artifact);

    const mismatch = note(facade)!;
    expect(mismatch.data).toMatchObject({ artifactMode: 'passthrough', agentMode: 'duplex' });
    expect(mismatch.detail).toContain('starts with no history');
  });
});

describe('restoring in the same mode', () => {
  it('records no note, and clears the previous restore note', async () => {
    const duplex = await duplexArtifact();
    const { facade: writer } = await create({ mode: 'passthrough' });
    const passthrough = await writer.getState();
    const { facade } = await create({ mode: 'passthrough' });
    await facade.restore(duplex);
    expect(note(facade)).toBeDefined();

    await facade.restore(passthrough);

    expect(note(facade)).toBeUndefined();
  });
});
