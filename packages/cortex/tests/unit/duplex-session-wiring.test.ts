/**
 * Handler registration order in DuplexSession.wire(). On a shared event the
 * handler registered first runs first, so each of these pins one ordering
 * the session's semantics depend on.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createDuplexScenario,
  destroyLiveFacades,
  duplexRouterOf,
  entriesOfType,
  getBroker,
  waitUntil,
} from './duplex-scenario-harness.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await destroyLiveFacades();
});

describe('DuplexSession wiring order', () => {
  it('logs the talker reply before its conversation delta is buffered', async () => {
    const h = createDuplexScenario();
    const router = duplexRouterOf(h.facade);
    const repliesLoggedAtDelta: number[] = [];
    const original = router.noteTalkerReply.bind(router);
    vi.spyOn(router, 'noteTalkerReply').mockImplementation((text) => {
      repliesLoggedAtDelta.push(entriesOfType(h.facade, 'reply').length);
      original(text);
    });
    h.talkerPi.script = [{ text: 'Hello there.' }];
    await h.facade.prompt('hi');

    expect(repliesLoggedAtDelta).toEqual([1]);
  });

  it('logs a failure before the delivery that announces it', async () => {
    const h = createDuplexScenario();
    h.reasonerPi.failWith = new Error('401 Unauthorized: invalid x-api-key');
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'build the release' } }],
    }];
    await h.facade.prompt('build the release');
    await waitUntil(
      () => entriesOfType(h.facade, 'delivery').length === 1,
      2000, 'the failure was delivered',
    );

    const error = entriesOfType(h.facade, 'error').find((entry) => entry.loopPath === 'reasoner');
    const delivery = entriesOfType(h.facade, 'delivery')[0]!;
    expect(error).toBeDefined();
    expect(error!.seq).toBeLessThan(delivery.seq);
  });

  it('settles the run outcome before consumers see the run end', async () => {
    const h = createDuplexScenario();
    const deliveriesAtLoopEnd: number[] = [];
    h.facade.getEventBridge().on('loop_end', (event) => {
      if (event.loopPath !== 'reasoner' || event.childTaskId) return;
      deliveriesAtLoopEnd.push(entriesOfType(h.facade, 'delivery').length);
    });
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'count the files' } }],
    }];
    h.reasonerPi.script = [{ text: 'There are 42 files.' }];
    await h.facade.prompt('count the files');
    await waitUntil(() => deliveriesAtLoopEnd.length === 1, 2000, 'the reasoner run ended');

    // The implicit final-text delivery was already logged when the merged
    // stream forwarded loop_end: session handlers run before consumers'.
    expect(deliveriesAtLoopEnd).toEqual([1]);
  });
});

describe('the session owns the permission broker lifecycle', () => {
  function pendingNetworkAsk(h: ReturnType<typeof createDuplexScenario>): { reason: () => string | undefined } {
    let reason: string | undefined;
    void getBroker(h.facade).requestDecision({
      askId: 'ask-net-1',
      loopPath: 'reasoner',
      toolName: 'NetworkAccess',
      renderedRequest: 'NetworkAccess (shell): example.com:443',
      kind: 'network',
    }).then((decision) => { reason = decision.reason; });
    return { reason: () => reason };
  }

  it('a restore settles asks of the replaced session as deny', async () => {
    const h = createDuplexScenario();
    const ask = pendingNetworkAsk(h);
    expect(getBroker(h.facade).pendingAskCount).toBe(1);
    const state = await h.facade.getState();
    await h.facade.restore(state);
    await waitUntil(() => ask.reason() !== undefined, 2000, 'the ask settled');
    expect(ask.reason()).toContain('restored');
    expect(getBroker(h.facade).pendingAskCount).toBe(0);
  });

  it('destroy settles every pending ask so no resolver can hang', async () => {
    const h = createDuplexScenario();
    const ask = pendingNetworkAsk(h);
    await h.facade.destroy();
    await waitUntil(() => ask.reason() !== undefined, 2000, 'the ask settled');
    expect(ask.reason()).toContain('shut down');
  });
});
