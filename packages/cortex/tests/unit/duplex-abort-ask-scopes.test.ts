/**
 * Which abort scope drains the broker, per the facade-api.md abort table.
 *
 * The scenario suite's abort coverage uses a TOOL ask, which settles through
 * its own run's abort signal, so it passes whether or not the facade ever
 * calls the broker. These tests use a NETWORK ask instead: it carries no
 * abort signal (NetworkAccessRequest has none to pass), so the facade's
 * settleAll is the only thing that can unblock it, and a scope wired to the
 * wrong branch is visible rather than masked.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { CortexAgent } from '../../src/cortex-agent.js';
import type { BrokeredAskDecision } from '../../src/duplex/permission-broker.js';
import {
  createDuplexScenario,
  destroyLiveFacades,
  getBroker,
  lifecycleEvents,
  settle,
  waitUntil,
} from './duplex-scenario-harness.js';

afterEach(async () => {
  await destroyLiveFacades();
});

/**
 * Raise a signal-less work-side ask straight at the broker, the shape
 * WebFetch and the sandbox egress callback produce.
 */
function pendingEgressAsk(facade: CortexAgent): BrokeredAskDecision[] {
  const decisions: BrokeredAskDecision[] = [];
  void getBroker(facade).requestDecision({
    askId: 'ask-egress',
    loopPath: 'reasoner',
    loopPathApproximate: true,
    toolName: 'NetworkAccess',
    renderedRequest: 'NetworkAccess (webfetch): evil.example:443',
    kind: 'network',
  }).then((decision) => decisions.push(decision));
  return decisions;
}

describe('abort scope and the broker drain', () => {
  it("abort('conversation') does not answer a work-side request, and un-anchors it instead", async () => {
    // The conversation surface stopping is not an answer. Settling here
    // would report a denial the user never gave, and would kill work that
    // was only waiting to be asked about again.
    const h = createDuplexScenario();
    const decisions = pendingEgressAsk(h.facade);
    await waitUntil(() => getBroker(h.facade).pendingAskCount === 1, 2000, 'ask raised');

    await h.facade.abort('conversation');
    await settle();

    expect(decisions).toHaveLength(0);
    expect(getBroker(h.facade).pendingAskCount).toBe(1);

    // What the conversation abort DOES take is the consent anchor: the
    // voicing went with the talker's queues, so the user's next words must
    // not satisfy "an utterance after the voicing" for a request nobody
    // read to them. The ask stays pending, silent, and answerable.
    expect(getBroker(h.facade).getPendingAsks()).toMatchObject([
      { askId: 'ask-egress', voicedAtSeq: null },
    ]);
    expect(lifecycleEvents(h.facade, 'ask_voicing_deferred')).toHaveLength(1);
  });

  for (const scope of ['work', 'all'] as const) {
    it(`abort('${scope}') drains the broker: the signal-less ask is denied and recorded`, async () => {
      const h = createDuplexScenario();
      const decisions = pendingEgressAsk(h.facade);
      await waitUntil(() => getBroker(h.facade).pendingAskCount === 1, 2000, 'ask raised');

      await h.facade.abort(scope);

      await waitUntil(() => decisions.length === 1, 2000, 'ask settled by the abort');
      expect(decisions[0]!.decision).toBe('deny');
      expect(decisions[0]!.reason).toContain('Aborted before the user answered');
      expect(getBroker(h.facade).pendingAskCount).toBe(0);

      // The drop is in the log, caused by the ask it killed, so an audit
      // never sees a request that simply stops existing.
      const dropped = lifecycleEvents(h.facade, 'ask_dropped');
      expect(dropped).toHaveLength(1);
      expect(dropped[0]!.data).toMatchObject({ askId: 'ask-egress', cause: 'abort' });
      const askEntry = h.facade.getLog().find((entry) => entry.type === 'ask')!;
      expect(dropped[0]!.causedBy).toBe(askEntry.seq);
      // Nobody answered, so no ask_answer entry claims anyone did.
      expect(h.facade.getLog().some((entry) => entry.type === 'ask_answer')).toBe(false);
    });
  }
});
