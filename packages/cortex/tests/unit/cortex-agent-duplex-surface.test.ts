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
  promptTexts,
  waitUntil,
} from './duplex-scenario-harness.js';
import { testModel } from './duplex-scenario-harness.js';
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
// Shared: a network egress ask, which blocks a resolver without ever
// entering a loop's own pending-ask registry.
// ---------------------------------------------------------------------------

export {};
