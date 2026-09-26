/**
 * How a reasoner run's end reaches the conversation: which deliveries count
 * as the result, and what retires the delegation the run served.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createDuplexScenario,
  destroyLiveFacades,
  entriesOfType,
  talkerHeadline,
  waitUntil,
} from './duplex-scenario-harness.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await destroyLiveFacades();
});

describe('silent progress notes and the final result', () => {
  it('still delivers the final text of a run whose only Deliver was silent', async () => {
    const h = createDuplexScenario();
    h.reasonerPi.hold = true;
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'profile the importer' } }],
    }];
    h.reasonerPi.script = [
      {
        text: '',
        calls: [{ name: 'Deliver', args: { content: 'Halfway through the profile.', wake: 'silent' } }],
      },
      { text: 'The importer spends 80% of its time in JSON parsing.' },
    ];
    await h.facade.prompt('profile the importer');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work dispatched');
    // Precondition: the task is live before the run ends.
    expect(talkerHeadline(h.talkerLoop) ?? '').toContain('alias="task-1"');

    h.reasonerPi.releaseRun();
    await waitUntil(
      () => entriesOfType(h.facade, 'delivery').length === 2,
      2000, 'the progress note and the result were both delivered',
    );
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner idle');

    const deliveries = entriesOfType(h.facade, 'delivery');
    expect(deliveries[0]!.content).toBe('Halfway through the profile.');
    expect(deliveries[0]!.wake).toBe('silent');
    expect(deliveries[1]!.content).toBe('The importer spends 80% of its time in JSON parsing.');
    expect((deliveries[1]!.data as { implicit?: boolean }).implicit).toBe(true);
    // The implicit result concluded the task, so it stops being live work.
    expect(talkerHeadline(h.talkerLoop) ?? '').not.toContain('alias="task-1"');
  });

  it('does not repeat the final text after a concluding Deliver', async () => {
    const h = createDuplexScenario();
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'profile the importer' } }],
    }];
    h.reasonerPi.script = [
      {
        text: '',
        calls: [{ name: 'Deliver', args: { content: 'JSON parsing dominates.', wake: 'when_idle' } }],
      },
      { text: 'Delivered the profile summary.' },
    ];
    await h.facade.prompt('profile the importer');
    await waitUntil(
      () => entriesOfType(h.facade, 'delivery').length === 1,
      2000, 'the result was delivered',
    );
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner idle');
    expect(h.reasonerPi.modelCalls).toBe(2);
    expect(entriesOfType(h.facade, 'delivery').map((entry) => entry.content))
      .toEqual(['JSON parsing dominates.']);
  });
});
