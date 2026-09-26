/**
 * How a reasoner run's end reaches the conversation: which deliveries count
 * as the result, and what retires the delegation the run served.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createDuplexScenario,
  destroyLiveFacades,
  entriesOfType,
  lifecycleEvents,
  talkerHeadline,
  waitUntil,
  duplexRouterOf,
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

describe('a reasoner run that is stopped', () => {
  it('tells the user when its own spending limit stopped it, and retires the task', async () => {
    const h = createDuplexScenario({ budgetGuard: { maxTurns: 1 } });
    h.reasonerPi.hold = true;
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'migrate the schema' } }],
    }];
    // Turn 1 calls a tool, so the run needs a second turn the limit forbids.
    h.reasonerPi.script = [
      { text: '', calls: [{ name: 'NoSuchTool' }] },
      { text: 'Schema migrated.' },
    ];
    await h.facade.prompt('migrate the schema');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work started');
    expect(talkerHeadline(h.talkerLoop) ?? '').toContain('alias="task-1"');

    h.reasonerPi.releaseRun();
    await waitUntil(
      () => entriesOfType(h.facade, 'delivery').length === 1,
      2000, 'the stop was announced',
    );
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner idle');
    const notice = entriesOfType(h.facade, 'delivery')[0]!;
    expect(notice.content).toMatch(/spending limit/);
    expect((notice.data as { terminal?: boolean }).terminal).toBe(true);
    expect(talkerHeadline(h.talkerLoop) ?? '').not.toContain('alias="task-1"');
  });

  it('retires the task quietly when the user stopped the work', async () => {
    const h = createDuplexScenario();
    h.reasonerPi.hold = true;
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'migrate the schema' } }],
    }];
    await h.facade.prompt('migrate the schema');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work started');
    expect(talkerHeadline(h.talkerLoop) ?? '').toContain('alias="task-1"');

    await h.facade.abort('work');
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner idle');
    expect(talkerHeadline(h.talkerLoop) ?? '').not.toContain('alias="task-1"');
    // The user asked for it; nothing is announced back.
    expect(entriesOfType(h.facade, 'delivery')).toHaveLength(0);
  });

  it("retires tasks whose dispatch was still parked when the user stopped the work", async () => {
    const h = createDuplexScenario();
    h.reasonerPi.hold = true;
    h.talkerPi.script = [{ text: 'On it.', calls: [{ name: 'spawn_task', args: { instructions: 'migrate the schema' } }] }];
    await h.facade.prompt('migrate the schema');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work started');
    h.talkerPi.script = [{ text: 'Queued.', calls: [{ name: 'spawn_task', args: { instructions: 'rebuild the index' } }] }];
    await h.facade.prompt('then rebuild the index');
    // Precondition: task-2 never reached a run, so no run end can retire it.
    expect(h.reasonerLoop.pendingWakeDeliveryCount).toBe(1);
    expect(duplexRouterOf(h.facade).activeAliases()).toEqual(['task-1', 'task-2']);

    await h.facade.abort('work');
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner idle');
    expect(duplexRouterOf(h.facade).activeAliases()).toEqual([]);
  });

  it('retires tasks whose dispatch was still parked when the session limit stopped the work', async () => {
    // Two talker turns (0.006) fit; the reasoner's first turn crosses it.
    const h = createDuplexScenario({ duplex: { maxTotalCost: 0.008 } });
    h.reasonerPi.hold = true;
    h.talkerPi.script = [{ text: 'On it.', calls: [{ name: 'spawn_task', args: { instructions: 'migrate the schema' } }] }];
    h.reasonerPi.script = [{ text: '', calls: [{ name: 'NoSuchTool' }] }, { text: 'Schema migrated.' }];
    await h.facade.prompt('migrate the schema');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work started');
    h.talkerPi.script = [{ text: 'Queued.', calls: [{ name: 'spawn_task', args: { instructions: 'rebuild the index' } }] }];
    await h.facade.prompt('then rebuild the index');
    expect(h.reasonerLoop.pendingWakeDeliveryCount).toBe(1);
    expect(duplexRouterOf(h.facade).activeAliases()).toEqual(['task-1', 'task-2']);

    h.reasonerPi.releaseRun();
    await waitUntil(
      () => lifecycleEvents(h.facade, 'budget_breached').length === 1,
      2000, 'the session limit was breached',
    );
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner idle');
    expect(duplexRouterOf(h.facade).activeAliases()).toEqual([]);
  });

  it('after the session limit is breached, says so once and refuses new work', async () => {
    // One talker turn (0.003) fits; the reasoner's first turn crosses it.
    const h = createDuplexScenario({ duplex: { maxTotalCost: 0.005 } });
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'migrate the schema' } }],
    }];
    h.reasonerPi.script = [
      { text: '', calls: [{ name: 'NoSuchTool' }] },
      { text: 'Schema migrated.' },
    ];
    // The breach also stops the talker's run, which rejects the prompt.
    await h.facade.prompt('migrate the schema').catch(() => {});
    await waitUntil(
      () => lifecycleEvents(h.facade, 'budget_breached').length === 1,
      2000, 'the session limit was breached',
    );
    await waitUntil(
      () => entriesOfType(h.facade, 'delivery').length === 1,
      2000, 'the stop was announced',
    );
    expect(entriesOfType(h.facade, 'delivery')[0]!.content).toMatch(/spending limit has been reached/);
    expect(talkerHeadline(h.talkerLoop) ?? '').not.toContain('alias="task-1"');
    await waitUntil(() => !h.reasonerLoop.isLoopActive && !h.talkerLoop.isLoopActive, 2000, 'idle');

    // A new delegation is refused with a receipt the talker can relay, and
    // the reasoner is not woken for it.
    const reasonerRuns = h.reasonerPi.promptCalls.length;
    h.talkerPi.script = [{
      text: 'Let me start that.',
      calls: [{ name: 'spawn_task', args: { instructions: 'write the release notes' } }],
    }];
    // Every talker turn past the limit is stopped too, as in passthrough.
    await h.facade.prompt('write the release notes').catch(() => {});
    await waitUntil(
      () => h.talkerPi.toolResults.some((result) => result.text.includes('spending limit')),
      2000, 'refusal receipt',
    );
    expect(lifecycleEvents(h.facade, 'dispatch_refused').length).toBeGreaterThan(0);
    expect(h.reasonerPi.promptCalls).toHaveLength(reasonerRuns);
    expect(entriesOfType(h.facade, 'directive')).toHaveLength(1);
    expect(entriesOfType(h.facade, 'delivery')
      .filter((entry) => /spending limit has been reached/.test(entry.content))).toHaveLength(1);
  });
});
