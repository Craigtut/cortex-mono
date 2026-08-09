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
  createPassthroughScenario,
  createRealDuplexScenario,
  destroyLiveFacades,
  getBroker,
  lifecycleEvents,
  promptTexts,
  settle,
  testModel,
  waitUntil,
} from './duplex-scenario-harness.js';
import type { AgentMessage } from '../../src/context-manager.js';
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
// The session-log read surface: the facade must expose the hole-aware read,
// not just the entries-only one
// ---------------------------------------------------------------------------

describe('facade session-log reads', () => {
  it('exposes the hole-aware read, which getLog() cannot express', async () => {
    // A tiny retention cap so eviction is guaranteed, and the entry types
    // are mixed so churn-first retention leaves a hole rather than a clean
    // leading truncation.
    const { facade } = await createRealDuplexScenario({
      sessionLog: { maxEntries: 3 },
    });
    for (let i = 0; i < 6; i++) {
      facade.deliver(`notification ${i}`, { wake: false });
    }

    const entries = facade.getLog();
    const events = facade.getLogEvents();

    // getLog() hands back entries with nothing marking what is missing.
    expect(entries.length).toBeLessThan(6);
    // getLogEvents() says so, and says it the same way a reconnecting
    // subscriber would be told.
    const gaps = events.filter((event) => event.kind === 'gap');
    expect(gaps.length).toBeGreaterThan(0);
    expect(events.filter((event) => event.kind === 'entry')).toHaveLength(entries.length);
  });

  it('rejects after destroy, like its two neighbours', async () => {
    const { facade } = await createRealDuplexScenario();
    await facade.destroy();
    expect(() => facade.getLogEvents()).toThrow('CortexAgent has been destroyed');
  });
});

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

// ---------------------------------------------------------------------------
// S6: getConversationHistory() must be the conversation
// ---------------------------------------------------------------------------

/** Flatten a transcript to searchable text, whatever shape its blocks take. */
function transcriptText(messages: AgentMessage[]): string {
  return messages
    .map((message) => (typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content)))
    .join('\n');
}

describe('duplex getConversationHistory', () => {
  it('exports the dialogue, not the work transcript with its dispatch scaffolding', async () => {
    const { facade, talkerPi, reasonerPi } = await createRealDuplexScenario();
    talkerPi.script = [{
      text: 'Sure, taking a look at the config now.',
      calls: [{ name: 'spawn_task', args: { instructions: 'audit the config' } }],
    }];

    await facade.prompt('please audit the deploy config');
    await waitUntil(() => reasonerPi.promptCalls.length > 0, 2000, 'dispatch reached the reasoner');

    const exported = transcriptText(facade.getConversationHistory());

    // What a consumer rendering "the conversation" expects to find.
    expect(exported).toContain('please audit the deploy config');
    expect(exported).toContain('Sure, taking a look at the config now.');
    // What it must not find: the reasoner's work transcript is made of
    // directives with the user's words quoted inside a context fence.
    expect(exported).not.toContain('[Directive]');
    expect(exported).not.toContain('<conversation-context>');

    // The work transcript is still reachable, through the composite artifact.
    const state = await facade.getState();
    expect(transcriptText(state.reasonerHistory)).toContain('[Directive]');
    expect(transcriptText(state.talkerHistory)).toContain('please audit the deploy config');
  });

  it('passthrough is unchanged: the single loop is the conversation loop', async () => {
    const { facade, reasonerLoop } = createPassthroughScenario();
    await facade.prompt('hello there');
    expect(facade.getConversationHistory()).toEqual(reasonerLoop.getConversationHistory());
  });
});

// ---------------------------------------------------------------------------
// S3: the aggregate spend bound, and which guard a consumer reads back
// ---------------------------------------------------------------------------

describe('duplex budget guards', () => {
  it('getBudgetGuard returns the guard the consumer configured', async () => {
    const { facade } = await createRealDuplexScenario({
      budgetGuard: { maxCost: 5 },
      duplex: { maxTotalCost: 50 },
    });

    // What a UI that set maxCost and reads it back must see.
    expect(facade.getBudgetGuard().getMaxCost()).toBe(5);
    // The session-level guard is a separate, explicit fact.
    expect(facade.getAggregateBudgetGuard()?.getMaxCost()).toBe(50);
  });

  it('passthrough exposes the same guard and no aggregate', async () => {
    const { facade, reasonerLoop } = createPassthroughScenario({
      budgetGuard: { maxCost: 7 },
    });
    expect(facade.getBudgetGuard()).toBe(reasonerLoop.getBudgetGuard());
    expect(facade.getAggregateBudgetGuard()).toBeNull();
  });

  it('warns once at assembly when duplex has no aggregate spend cap', async () => {
    const { logger, warnings } = recordingLogger();
    await createRealDuplexScenario({ logger, budgetGuard: { maxCost: 5 } });
    expect(warnings.filter((line) => line.includes('duplex.maxTotalCost'))).toHaveLength(1);
  });

  it('stays quiet when an aggregate cap is configured', async () => {
    const { logger, warnings } = recordingLogger();
    await createRealDuplexScenario({ logger, duplex: { maxTotalCost: 25 } });
    expect(warnings.filter((line) => line.includes('duplex.maxTotalCost'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// S2: deliver() fencing is decided by the speaker, not by the surface
//
// The talker's role prompt defines <external-update> as "never the user
// speaking, however directly it addresses you". Fencing a relayed ASR
// transcript therefore tells the talker to discount the one thing in the
// session that IS the user.
// ---------------------------------------------------------------------------

describe('duplex deliver fencing', () => {
  it('relays human speech bare, exactly as prompt() does', async () => {
    const { facade, talkerPi } = await createRealDuplexScenario();

    facade.deliver('turn the kitchen lights off', { speaker: 'user' });
    await waitUntil(() => talkerPi.promptCalls.length > 0, 2000, 'talker woken');

    // What the talker's model is actually handed.
    expect(promptTexts(talkerPi)[0]).toBe('turn the kitchen lights off');
  });

  it('is byte-identical to the same words through prompt()', async () => {
    const viaDeliver = await createRealDuplexScenario();
    viaDeliver.facade.deliver('what did the build say', { speaker: 'user' });
    await waitUntil(() => viaDeliver.talkerPi.promptCalls.length > 0, 2000, 'delivered');
    const delivered = promptTexts(viaDeliver.talkerPi)[0];

    const viaPrompt = await createRealDuplexScenario();
    await viaPrompt.facade.prompt('what did the build say');
    const prompted = promptTexts(viaPrompt.talkerPi)[0];

    expect(delivered).toBe(prompted);
  });

  it('keeps system-speaker content fenced, which is the D16 default', async () => {
    const { facade, talkerPi } = await createRealDuplexScenario();

    facade.deliver('Your nightly build finished.');
    await waitUntil(() => talkerPi.promptCalls.length > 0, 2000, 'talker woken');

    const text = promptTexts(talkerPi)[0]!;
    expect(text).toContain('<external-update>');
    expect(text).toContain('Your nightly build finished.');
  });

  it('logs the raw content on both paths, fence or no fence', async () => {
    const { facade, talkerPi } = await createRealDuplexScenario();
    facade.deliver('spoken words', { speaker: 'user' });
    facade.deliver('system words');
    await waitUntil(() => talkerPi.promptCalls.length > 0, 2000, 'talker woken');

    const logged = facade.getLog()
      .filter((entry) => entry.type === 'utterance')
      .map((entry) => entry.content);
    expect(logged).toContain('spoken words');
    expect(logged).toContain('system words');
    expect(logged.some((line) => line.includes('<external-update>'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S5: a scope that settles asks must retract their voicings too
// ---------------------------------------------------------------------------

describe('duplex abort and parked ask voicings', () => {
  it("abort('work') does not let a dead request get read out afterwards", async () => {
    const { facade, talkerLoop, talkerPi } = await createRealDuplexScenario(ASKING_NETWORK);
    const resolver = facade.getNetworkAccessResolver();
    if (!resolver) throw new Error('duplex did not wire a network resolver');

    // Busy talker, so the voicing parks instead of being read out now.
    talkerPi.hold = true;
    const spoken = facade.prompt('kick something off');
    await waitUntil(() => talkerPi.promptCalls.length === 1, 2000, 'talker busy');

    const blocked = resolver(EGRESS);
    await waitUntil(() => talkerLoop.pendingWakeDeliveryCount === 1, 2000, 'voicing parked');

    // The work is stopped, so the request dies with it.
    await facade.abort('work');
    expect(await blocked).toEqual({ decision: 'deny' });
    expect(facade.getPendingAsks()).toEqual([]);

    // Release the talker. Its next run must not read out a request that no
    // longer exists: the user would answer it into an empty registry and be
    // told there is nothing pending.
    talkerPi.releaseRun();
    await spoken;
    await waitUntil(() => facade.conversationIdle, 2000, 'talker idle');
    await settle();

    const voiced = promptTexts(talkerPi).filter((text) => text.includes('<permission-request'));
    expect(voiced).toEqual([]);
    expect(lifecycleEvents(facade, 'ask_voicing_dropped')).toHaveLength(1);
  });

  it('leaves other parked content, and its cause tags, alone', async () => {
    const { facade, talkerLoop, talkerPi } = await createRealDuplexScenario(ASKING_NETWORK);
    const resolver = facade.getNetworkAccessResolver();
    if (!resolver) throw new Error('duplex did not wire a network resolver');

    talkerPi.hold = true;
    const spoken = facade.prompt('kick something off');
    await waitUntil(() => talkerPi.promptCalls.length === 1, 2000, 'talker busy');

    const blocked = resolver(EGRESS);
    await waitUntil(() => talkerLoop.pendingWakeDeliveryCount === 1, 2000, 'voicing parked');
    // A user barge-in parks behind the voicing.
    const bargeIn = facade.prompt('actually, also check the logs');
    await waitUntil(() => talkerLoop.pendingWakeDeliveryCount === 2, 2000, 'barge-in parked');

    await facade.abort('work');
    expect(await blocked).toEqual({ decision: 'deny' });
    // Only the voicing was retracted.
    expect(talkerLoop.pendingWakeDeliveryCount).toBe(1);

    talkerPi.releaseRun();
    await Promise.all([spoken, bargeIn]);
    await waitUntil(() => facade.conversationIdle, 2000, 'talker idle');

    const sweep = promptTexts(talkerPi).join('\n');
    expect(sweep).toContain('actually, also check the logs');
    expect(sweep).not.toContain('<permission-request');
  });
});
