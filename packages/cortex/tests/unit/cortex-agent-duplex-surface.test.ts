/**
 * Consumer-visible duplex facade surfaces, driven as sessions.
 *
 * Every test here reproduces the symptom a consumer sees rather than the
 * internal state change behind it: what text the talker's model is actually
 * handed, what a settlement predicate reports while a resolver is blocked,
 * what an exported conversation contains, and which budget guard a UI reads
 * back. The harness is the Phase 3 scripted-pi one, so the tool batch, the
 * terminate guards, and the real permission gate all run.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createRealDuplexScenario,
  destroyLiveFacades,
  getBroker,
  settle,
  testModel,
  waitUntil,
} from './duplex-scenario-harness.js';
import type { CortexAgentConfig } from '../../src/cortex-agent.js';
import type { NetworkAccessRequest } from '../../src/sandbox/types.js';
import type { CortexLogger } from '../../src/types.js';

afterEach(async () => {
  await destroyLiveFacades();
  vi.restoreAllMocks();
});

/** A logger that records what it was told, for the assembly warnings. */
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

// ---------------------------------------------------------------------------
// N6: contextWindowLimit is declared per-loop and must be per-loop
// ---------------------------------------------------------------------------

describe('duplex contextWindowLimit routing', () => {
  it('applies the configured limit to the talker, not the reasoner alone', async () => {
    const { talkerLoop, reasonerLoop } = await createRealDuplexScenario({
      contextWindowLimit: 50_000,
    });

    // The compaction budget the loop actually runs on. The talker holds the
    // conversation, so a reasoner-only limit leaves the fastest-growing
    // surface uncapped.
    expect(reasonerLoop.effectiveContextWindow).toBe(50_000);
    expect(talkerLoop.effectiveContextWindow).toBe(50_000);
  });

  it('setContextWindowLimit reaches both resident loops', async () => {
    const { facade, talkerLoop, reasonerLoop } = await createRealDuplexScenario();

    facade.setContextWindowLimit(40_000);

    expect(reasonerLoop.effectiveContextWindow).toBe(40_000);
    expect(talkerLoop.effectiveContextWindow).toBe(40_000);

    facade.setContextWindowLimit(null);
    expect(talkerLoop.effectiveContextWindow).toBe(testModel().contextWindow);
  });
});

// ---------------------------------------------------------------------------
// N1: settlement predicates must read the facade's merged ask registry
//
// A network egress ask is the case that separates the two registries: it is
// minted by the broker and never enters any loop's own pending-ask map, so a
// predicate reading the reasoner's map reports settled while the resolver
// that raised it is still blocked.
// ---------------------------------------------------------------------------

/** Config whose network resolver always defers to the user. */
const ASKING_NETWORK: Partial<CortexAgentConfig> = {
  resolveNetworkAccess: async () => ({ decision: 'ask' as const }),
};

const EGRESS: NetworkAccessRequest = {
  host: 'example.com',
  via: 'shell',
} as NetworkAccessRequest;

describe('duplex settlement predicates and broker-minted asks', () => {
  it('workSettled stays false while a network resolver is blocked', async () => {
    const { facade, talkerPi } = await createRealDuplexScenario(ASKING_NETWORK);
    const resolver = facade.getNetworkAccessResolver();
    if (!resolver) throw new Error('duplex did not wire a network resolver');

    let resolverSettled = false;
    const blocked = resolver(EGRESS).then((decision) => {
      resolverSettled = true;
      return decision;
    });

    // The ask is voiced, which wakes the talker; wait for that turn to end
    // so nothing but the ask itself can hold the predicate down.
    await waitUntil(() => facade.getPendingAsks().length === 1, 2000, 'ask raised');
    await waitUntil(() => facade.conversationIdle, 2000, 'talker idle again');

    expect(resolverSettled).toBe(false);
    expect(facade.workSettled).toBe(false);

    // And the awaitable form does not resolve either.
    let settledEarly = false;
    void facade.waitForWorkSettled().then(() => { settledEarly = true; });
    await settle();
    expect(settledEarly).toBe(false);

    // Answering releases both the resolver and the wait.
    const askId = facade.getPendingAsks()[0]!.askId;
    getBroker(facade).answer(askId, 'deny', undefined);
    await expect(blocked).resolves.toEqual({ decision: 'deny' });
    await waitUntil(() => settledEarly, 2000, 'waitForWorkSettled resolves');
    expect(facade.workSettled).toBe(true);
    expect(talkerPi.promptCalls.length).toBeGreaterThan(0);
  });
});
