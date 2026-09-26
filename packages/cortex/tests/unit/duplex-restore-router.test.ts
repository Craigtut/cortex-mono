/**
 * What the duplex router knows about the session has to survive getState()
 * and restore(): task aliases the transcript already uses, results that were
 * logged but never reached the talker, and tasks whose run the restore
 * ended.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createDuplexScenario,
  createPassthroughScenario,
  destroyLiveFacades,
  entriesOfType,
  heldDeliveryCount,
  lifecycleEvents,
  promptTexts,
  talkerHeadline,
  waitUntil,
} from './duplex-scenario-harness.js';
import type { CortexAgentStateV2 } from '../../src/cortex-agent.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await destroyLiveFacades();
});

async function sessionWithOneFinishedTask(): Promise<CortexAgentStateV2> {
  const source = createDuplexScenario();
  source.talkerPi.script = [{
    text: 'On it.',
    calls: [{ name: 'spawn_task', args: { instructions: 'scan the repo' } }],
  }];
  source.reasonerPi.script = [{ text: 'Scan finished.' }];
  await source.facade.prompt('scan the repo');
  await waitUntil(() => entriesOfType(source.facade, 'delivery').length === 1, 2000, 'result');
  await source.facade.waitForWorkSettled();
  return source.facade.getState();
}

async function spawnReceipt(h: ReturnType<typeof createDuplexScenario>): Promise<string> {
  h.talkerPi.script = [{
    text: 'Starting that.',
    calls: [{ name: 'spawn_task', args: { instructions: 'write the report' } }],
  }];
  await h.facade.prompt('now write the report');
  return h.talkerPi.toolResults.find((result) => result.name === 'spawn_task')!.text;
}

describe('restoring the task alias counter', () => {
  it('continues numbering after the aliases the restored transcript uses', async () => {
    const state = await sessionWithOneFinishedTask();
    expect(state.router?.nextAliasNumber).toBe(2);

    const target = createDuplexScenario();
    await target.facade.restore(state);
    expect(await spawnReceipt(target)).toBe('Started task-2.');
  });

  it('recovers the counter from the log for an artifact without router state', async () => {
    const state = await sessionWithOneFinishedTask();
    delete state.router;

    const target = createDuplexScenario();
    await target.facade.restore(state);
    expect(await spawnReceipt(target)).toBe('Started task-2.');
  });
});

describe('restoring what the router still held', () => {
  it('hands a result logged but never delivered to the restored talker', async () => {
    // A channel that never goes idle holds the when_idle result.
    const source = createDuplexScenario({ idleSignal: () => false });
    source.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'scan the repo' } }],
    }];
    source.reasonerPi.script = [{ text: 'Found three unused modules.' }];
    await source.facade.prompt('scan the repo');
    await waitUntil(() => entriesOfType(source.facade, 'delivery').length === 1, 2000, 'result');
    await waitUntil(() => !source.reasonerLoop.isLoopActive, 2000, 'reasoner idle');
    // Precondition: logged, held by the router, never handed to the talker.
    expect(heldDeliveryCount(source.facade)).toBe(1);
    const state = await source.facade.getState();
    expect(state.router?.pendingDeliveries).toEqual(['Found three unused modules.']);

    const target = createDuplexScenario();
    await target.facade.restore(state);
    // Restore starts no turn; the result surfaces with the user's next one.
    expect(target.talkerPi.promptCalls).toHaveLength(0);
    target.talkerPi.script = [{ text: 'It found three unused modules.' }];
    await target.facade.prompt('did the scan finish?');
    expect(promptTexts(target.talkerPi)[0]).toContain('Found three unused modules.');
  });

  it('reports a task whose run did not survive as interrupted, not live', async () => {
    const source = createDuplexScenario();
    source.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'migrate the schema' } }],
    }];
    // A run that ends without concluding anything leaves the task open.
    source.reasonerPi.script = [{ text: '' }];
    await source.facade.prompt('migrate the schema');
    await source.facade.waitForWorkSettled();
    const state = await source.facade.getState();
    expect(state.router?.delegations.map((delegation) => delegation.completedAt)).toEqual([null]);

    const target = createDuplexScenario();
    await target.facade.restore(state);
    expect(lifecycleEvents(target.facade, 'delegation_interrupted')).toHaveLength(1);
    expect(talkerHeadline(target.talkerLoop) ?? '').not.toContain('alias="task-1"');
    target.talkerPi.script = [{ text: 'That migration was interrupted.' }];
    await target.facade.prompt('how is the migration going?');
    expect(promptTexts(target.talkerPi)[0]).toContain('no longer running: task-1 (migrate the schema)');
  });
});

describe('restoring queued silent deliveries', () => {
  it('queues the talker silent deliveries again', async () => {
    const source = createDuplexScenario();
    source.facade.deliver('the build is green', { wake: false });
    // Precondition: it waits on the talker's silent queue at capture time.
    expect(source.talkerLoop.queuedDeliveryCount).toBe(1);
    const state = await source.facade.getState();
    expect(state.queuedDeliveries?.talker).toHaveLength(1);

    const target = createDuplexScenario();
    await target.facade.restore(state);
    expect(target.talkerLoop.getQueuedDeliveries()).toEqual(state.queuedDeliveries!.talker);

    // It surfaces with the user's next turn, as it would have.
    target.talkerPi.script = [{ text: 'Good news on the build.' }];
    await target.facade.prompt('anything new?');
    expect(promptTexts(target.talkerPi)[0]).toContain('the build is green');
  });

  it('queues the reasoner silent deliveries again in passthrough', async () => {
    const source = createPassthroughScenario();
    source.facade.deliver('context for later', { wake: false });
    expect(source.reasonerLoop.queuedDeliveryCount).toBe(1);
    const state = await source.facade.getState();
    expect(state.queuedDeliveries).toEqual({ talker: [], reasoner: ['context for later'] });

    const target = createPassthroughScenario();
    await target.facade.restore(state);
    expect(target.reasonerLoop.getQueuedDeliveries()).toEqual(['context for later']);
  });

  it('carries a restored duplex talker queue through a passthrough round trip', async () => {
    const source = createDuplexScenario();
    source.facade.deliver('keep this', { wake: false });
    const state = await source.facade.getState();

    const passthrough = createPassthroughScenario();
    await passthrough.facade.restore(state);
    const roundTrip = await passthrough.facade.getState();
    expect(roundTrip.queuedDeliveries?.talker).toEqual(state.queuedDeliveries!.talker);
  });

  it('omits the field when nothing is queued', async () => {
    const source = createDuplexScenario();
    expect(source.talkerLoop.queuedDeliveryCount).toBe(0);
    expect(await source.facade.getState()).not.toHaveProperty('queuedDeliveries');
  });
});
