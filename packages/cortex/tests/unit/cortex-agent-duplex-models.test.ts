/**
 * Runtime model changes on a duplex facade reach the loops that assembly
 * would have given them to: an unpinned talker follows the reasoner's fast
 * tier across setModel(), and the per-loop dials fan out.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createRealDuplexScenario,
  destroyLiveFacades,
  entriesOfType,
  lifecycleEvents,
  waitUntil,
} from './duplex-scenario-harness.js';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiModel } from '../../src/agent-loop.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { CortexModel } from '../../src/model-wrapper.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await destroyLiveFacades();
});

function model(provider: string, id: string): CortexModel {
  return wrapModel({ provider, name: id } as PiModel, provider, id);
}

const SONNET = model('anthropic', 'claude-sonnet-4-20250514');
const HAIKU = model('anthropic', 'claude-haiku-4-5');
const GPT = model('openai', 'gpt-4o');
const GPT_MINI = model('openai', 'gpt-4o-mini');
const UNENUMERABLE = model('self-hosted-vllm', 'internal-70b');

/**
 * Fast-tier resolution keyed on the loop's own primary model, the way
 * resolveUtilityModels() behaves: a known provider gets its fast tier, an
 * unknown one falls back to the primary model itself.
 */
function stubFastTiers(): void {
  vi.spyOn(AgentLoop.prototype, 'getAutoResolvedUtilityModel')
    .mockImplementation(function (this: AgentLoop) {
      const primary = this.getModel();
      if (primary.provider === 'anthropic') return HAIKU;
      if (primary.provider === 'openai') return GPT_MINI;
      return primary;
    });
}

describe('setModel on a duplex facade', () => {
  it('re-mirrors an unpinned talker onto the new fast tier, and lookups follow it', async () => {
    stubFastTiers();
    const h = await createRealDuplexScenario({ model: SONNET });
    // Precondition: assembly mirrored the talker onto the fast tier.
    expect(h.talkerLoop.getModel().modelId).toBe('claude-haiku-4-5');

    h.facade.setModel(GPT);

    expect(h.reasonerLoop.getModel().modelId).toBe('gpt-4o');
    expect(h.talkerLoop.getModel().provider).toBe('openai');
    expect(h.talkerLoop.getModel().modelId).toBe('gpt-4o-mini');

    // A quick lookup spawned after the switch is built from the talker's
    // model, so it runs on the new provider too.
    h.talkerPi.script = [{
      text: 'Checking.',
      calls: [{ name: 'quick_lookup', args: { question: 'what is in the config?' } }],
    }];
    await h.facade.prompt('what is in the config?');
    await waitUntil(
      () => entriesOfType(h.facade, 'lookup_result').length === 1,
      2000, 'lookup answered',
    );
    const lookupConfig = h.loopConfigs.find((config) => config.loopPath?.startsWith('lookup/'));
    expect(lookupConfig?.model.modelId).toBe('gpt-4o-mini');
  });

  it('keeps a pinned talker model', async () => {
    stubFastTiers();
    const h = await createRealDuplexScenario({ model: SONNET, talker: { model: HAIKU } });
    h.facade.setModel(GPT);
    expect(h.reasonerLoop.getModel().modelId).toBe('gpt-4o');
    expect(h.talkerLoop.getModel().modelId).toBe('claude-haiku-4-5');
  });

  it('re-evaluates the talker fallback note when the switch changes it', async () => {
    stubFastTiers();
    const h = await createRealDuplexScenario({
      model: SONNET,
      duplex: { maxTotalCost: 25 },
    });
    expect(h.facade.getResolutionReport()).toEqual([]);

    // Onto a provider with no fast tier: the talker is now the primary, and
    // the mode stays duplex on a backend not known to be concurrent.
    h.facade.setModel(UNENUMERABLE);
    expect(h.talkerLoop.getModel().modelId).toBe('internal-70b');
    expect(h.facade.getResolutionReport().map((note) => note.code))
      .toEqual(['talker-model-fallback', 'duplex-not-concurrent']);

    // And back: both notes are gone, and the clearings are on the record.
    h.facade.setModel(SONNET);
    expect(h.talkerLoop.getModel().modelId).toBe('claude-haiku-4-5');
    expect(h.facade.getResolutionReport()).toEqual([]);
    expect(lifecycleEvents(h.facade, 'resolution_note_cleared')).toHaveLength(2);
  });
});

describe('per-loop dials on a duplex facade', () => {
  it('fans cache retention out to the talker', async () => {
    stubFastTiers();
    const h = await createRealDuplexScenario({ model: SONNET });
    h.facade.setCacheRetention('long');
    expect(h.reasonerLoop.getCacheRetention()).toBe('long');
    expect(h.talkerLoop.getCacheRetention()).toBe('long');
  });

  it('gives the talker a same-provider utility model and resets both', async () => {
    stubFastTiers();
    const h = await createRealDuplexScenario({ model: SONNET });
    const utility = model('anthropic', 'claude-haiku-test-utility');

    h.facade.setUtilityModel(utility);
    expect(h.reasonerLoop.getUtilityModel().modelId).toBe('claude-haiku-test-utility');
    expect(h.talkerLoop.getUtilityModel().modelId).toBe('claude-haiku-test-utility');
    // The talker's primary does not follow a utility override.
    expect(h.talkerLoop.getModel().modelId).toBe('claude-haiku-4-5');

    h.facade.resetUtilityModel();
    expect(h.reasonerLoop.isUtilityModelOverridden()).toBe(false);
    expect(h.talkerLoop.isUtilityModelOverridden()).toBe(false);
  });

  it('leaves the talker alone for a utility model from another provider', async () => {
    stubFastTiers();
    const h = await createRealDuplexScenario({ model: GPT, talker: { model: HAIKU } });
    h.facade.setUtilityModel(GPT_MINI);
    expect(h.reasonerLoop.getUtilityModel().modelId).toBe('gpt-4o-mini');
    expect(h.talkerLoop.isUtilityModelOverridden()).toBe(false);
  });
});
