/**
 * The settle-to-voice coalescing window, reached through production
 * assembly: a real CortexAgent, real brokered resolvers, real control tools
 * on a real talker loop.
 *
 * `duplex-permission-broker.test.ts` pins the same window against a
 * DuplexRouter built over hand-written ports. That proves the broker's
 * logic and assumes the assembly around it: the ports there are test
 * doubles, so a facade that wired the voicing lane to nothing, or wired
 * answer_ask to a different broker, would leave every one of those tests
 * green. This file closes that by making the asks arrive on their own and
 * the answers come back through the talker's real toolset.
 *
 * The scenario is the D16 snipe end to end: two asks pending, the user
 * denies the voiced one, and the same talker turn immediately fires a bare
 * allow hoping to catch whichever ask gets voiced next.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { NetworkAccessDecision } from '../../src/sandbox/types.js';
import type { BrokeredAskDecision } from '../../src/duplex/permission-broker.js';
import {
  createRealDuplexScenario,
  destroyLiveFacades,
  entriesOfType,
  getBroker,
  promptTexts,
  waitUntil,
} from './duplex-scenario-harness.js';

afterEach(async () => {
  await destroyLiveFacades();
  vi.restoreAllMocks();
});

describe('one ask succeeding another, through the assembled facade', () => {
  it('refuses a same-turn bare allow because the successor is not voiced yet', async () => {
    const h = await createRealDuplexScenario({
      resolveNetworkAccess: async (): Promise<NetworkAccessDecision> => ({ decision: 'ask' }),
    });

    // Scripted before the asks exist: the first voicing wakes the talker
    // immediately, and a script installed afterwards would race that turn.
    h.talkerPi.script = [
      { text: 'It wants to reach first.example on 443. Is that ok?' },
      {
        text: 'Understood.',
        calls: [
          // The honest relay of what the user said.
          { name: 'answer_ask', args: { decision: 'deny' } },
          // The snipe, in the same assistant message.
          { name: 'answer_ask', args: { decision: 'allow' } },
        ],
      },
      { text: 'It also wants to reach second.example on 443.' },
    ];

    const resolver = h.facade.getNetworkAccessResolver()!;
    const decisions: Record<string, BrokeredAskDecision['decision']> = {};
    const first = resolver({ host: 'first.example', port: 443, via: 'webfetch' })
      .then((d) => { decisions['first'] = d.decision; return d; });
    const second = resolver({ host: 'second.example', port: 443, via: 'webfetch' })
      .then((d) => { decisions['second'] = d.decision; return d; });

    await waitUntil(() => getBroker(h.facade).pendingAskCount === 2, 2000, 'both asks raised');
    // Exactly one is voiced, and it is the one the talker just read out.
    await waitUntil(
      () => promptTexts(h.talkerPi).some((text) => text.includes('first.example')),
      2000, 'first request read out',
    );
    expect(promptTexts(h.talkerPi).some((text) => text.includes('second.example'))).toBe(false);

    // The user answers. This is a real utterance on a real turn, so the
    // cause tag that reaches the consent check is the one the facade minted,
    // not one a test set by hand.
    await h.facade.prompt('no, deny that');

    await waitUntil(() => decisions['first'] !== undefined, 2000, 'first ask settled');
    expect(decisions['first']).toBe('deny');

    // The snipe got a receipt saying it bound to nothing. Read from the
    // talker's own tool results, which is what the model actually sees.
    const answers = h.talkerPi.toolResults.filter((result) => result.name === 'answer_ask');
    expect(answers).toHaveLength(2);
    expect(answers[0]!.text).toBe('Denial passed along.');
    expect(answers[1]!.text).toContain('Could not tell which pending request');
    // D17 holds on both: a control tool never reopens the talker's loop.
    expect(answers.every((answer) => answer.terminate)).toBe(true);

    // The second ask was not granted, and is read out only afterwards, on
    // its own turn, where it can be answered honestly.
    expect(decisions['second']).toBeUndefined();
    await waitUntil(
      () => promptTexts(h.talkerPi).some((text) => text.includes('second.example')),
      2000, 'second request read out after the window',
    );
    expect(getBroker(h.facade).pendingAskCount).toBe(1);
    expect(entriesOfType(h.facade, 'ask_answer')).toHaveLength(1);

    // Unblock the caller so nothing is left hanging on teardown.
    await h.facade.abort('work');
    expect((await second).decision).toBe('deny');
    expect((await first).decision).toBe('deny');
  });
});
