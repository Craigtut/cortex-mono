/**
 * steer_task and cancel_task against a reasoner that is mid-run: a redirect
 * has to reach the run doing the work (at its next turn boundary, not after
 * it finishes), and a cancel has to stop the work and withhold its result.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createDuplexScenario,
  destroyLiveFacades,
  duplexRouterOf,
  entriesOfType,
  lifecycleEvents,
  promptTexts,
  stubChildAgents,
  waitUntil,
} from './duplex-scenario-harness.js';
import type { AgentMessage } from '../../src/context-manager.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await destroyLiveFacades();
});

function textOf(message: AgentMessage): string {
  const content = message.content as unknown;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => ((block as { text?: unknown }).text as string | undefined) ?? '')
    .join('');
}

function directiveSeq(facade: Parameters<typeof entriesOfType>[0], tool: string): number {
  const entry = entriesOfType(facade, 'directive')
    .find((candidate) => (candidate.data as { tool?: string }).tool === tool);
  if (!entry) throw new Error(`no ${tool} directive logged`);
  return entry.seq;
}

describe('steer_task during a live reasoner run', () => {
  it('lands at the next turn boundary of the run doing the work', async () => {
    const h = createDuplexScenario();
    h.reasonerPi.hold = true;
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'survey caching libraries' } }],
    }];
    h.reasonerPi.script = [
      { text: 'Looking at the first library.' },
      { text: 'lru-cache is the only MIT option that fits.' },
    ];
    await h.facade.prompt('survey caching libraries');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work started');

    h.talkerPi.script = [{
      text: 'Will do.',
      calls: [{ name: 'steer_task', args: { taskAlias: 'task-1', message: 'only MIT licensed ones' } }],
    }];
    await h.facade.prompt('only MIT licensed ones please');
    // Precondition: the redirect is waiting on the busy reasoner.
    expect(h.reasonerLoop.pendingWakeDeliveryCount).toBe(1);

    h.reasonerPi.releaseRun();
    await waitUntil(() => entriesOfType(h.facade, 'delivery').length >= 1, 2000, 'result delivered');
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner idle');

    // The same run took the redirect: no second run was needed for it.
    expect(h.reasonerPi.promptCalls).toHaveLength(1);
    const transcript = h.reasonerPi.state.messages;
    const steerIndex = transcript.findIndex(
      (message) => message.role === 'user' && textOf(message).includes('only MIT licensed ones'),
    );
    const answerIndex = transcript.findIndex(
      (message) => message.role === 'assistant' && textOf(message).includes('lru-cache'),
    );
    expect(steerIndex).toBeGreaterThan(-1);
    expect(steerIndex).toBeLessThan(answerIndex);

    // The result answers the redirect, so it carries the steer's causation.
    const delivery = entriesOfType(h.facade, 'delivery')[0]!;
    expect(delivery.content).toBe('lru-cache is the only MIT option that fits.');
    expect(delivery.causedBy).toBe(directiveSeq(h.facade, 'steer_task'));
  });

  it('does not let a redirect overtake new work parked ahead of it', async () => {
    const h = createDuplexScenario();
    h.reasonerPi.hold = true;
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'first job' } }],
    }];
    await h.facade.prompt('do the first job');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'first job started');

    h.talkerPi.script = [{
      text: 'Queued, and noted.',
      calls: [
        { name: 'spawn_task', args: { instructions: 'second job' } },
        { name: 'steer_task', args: { taskAlias: 'task-2', message: 'use the staging data' } },
      ],
    }];
    await h.facade.prompt('then the second job, on staging data');
    expect(h.reasonerLoop.pendingWakeDeliveryCount).toBe(2);

    h.reasonerPi.releaseRun();
    await waitUntil(() => h.reasonerPi.promptCalls.length === 2, 2000, 'second run');
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner idle');
    // The redirect about task-2 opened the next run together with task-2
    // itself, never the run that was still on task-1.
    const second = promptTexts(h.reasonerPi)[1]!;
    expect(second).toContain('second job');
    expect(second).toContain('use the staging data');
  });
});

describe('cancel_task during a live reasoner run', () => {
  it('stops a run that serves only the cancelled task and withholds its result', async () => {
    const h = createDuplexScenario();
    h.reasonerPi.hold = true;
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'rebuild the search index' } }],
    }];
    await h.facade.prompt('rebuild the search index');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work started');

    h.reasonerPi.script = [{ text: 'Stopped the index rebuild.' }];
    h.talkerPi.script = [{
      text: 'Cancelling it.',
      calls: [{ name: 'cancel_task', args: { taskAlias: 'task-1' } }],
    }];
    await h.facade.prompt('never mind, cancel that');

    await waitUntil(
      () => lifecycleEvents(h.facade, 'cancelled_run_stopped').length === 1,
      2000, 'the run was stopped',
    );
    // The cancel itself still reaches the reasoner, after the abort, so it
    // can clean up whatever the task left behind.
    await waitUntil(() => h.reasonerPi.promptCalls.length === 2, 2000, 'cancel delivered');
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner idle');
    expect(promptTexts(h.reasonerPi)[1]).toContain('task-1');

    // Nothing about the cancelled task reaches the user, and the withheld
    // reply is on the record.
    expect(entriesOfType(h.facade, 'delivery')).toHaveLength(0);
    const dropped = lifecycleEvents(h.facade, 'delivery_dropped_cancelled');
    expect(dropped).toHaveLength(1);
    expect((dropped[0]!.data as { content?: string }).content).toBe('Stopped the index rebuild.');
  });

  it('steers the stop into a run that also serves live work', async () => {
    const h = createDuplexScenario();
    h.reasonerPi.hold = true;
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'tidy the imports' } }],
    }];
    await h.facade.prompt('tidy the imports');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'first run started');

    // Two more tasks park behind the busy reasoner, so the next run serves
    // both of them.
    h.talkerPi.script = [{
      text: 'Queued both.',
      calls: [
        { name: 'spawn_task', args: { instructions: 'update the changelog' } },
        { name: 'spawn_task', args: { instructions: 'bump the version' } },
      ],
    }];
    await h.facade.prompt('then update the changelog and bump the version');
    expect(h.reasonerLoop.pendingWakeDeliveryCount).toBe(2);
    h.reasonerPi.script = [{ text: 'Imports tidied.' }];
    h.reasonerPi.hold = true;
    h.reasonerPi.releaseRun();
    await waitUntil(() => h.reasonerPi.promptCalls.length === 2, 2000, 'second run started');

    h.reasonerPi.script = [
      { text: 'Working on both.' },
      { text: 'Version bumped to 2.1.0.' },
    ];
    h.talkerPi.script = [{
      text: 'Dropping the changelog.',
      calls: [{ name: 'cancel_task', args: { taskAlias: 'task-2' } }],
    }];
    await h.facade.prompt('skip the changelog');

    h.reasonerPi.releaseRun();
    await waitUntil(() => entriesOfType(h.facade, 'delivery').length >= 2, 2000, 'result delivered');
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner idle');

    // Not stopped: the run still had task-3 to finish, and it took the
    // cancel at its turn boundary rather than in a run of its own.
    expect(lifecycleEvents(h.facade, 'cancelled_run_stopped')).toHaveLength(0);
    expect(h.reasonerPi.promptCalls).toHaveLength(2);
    expect(h.reasonerPi.state.messages.some(
      (message) => message.role === 'user' && textOf(message).includes('task-2'),
    )).toBe(true);
    expect(entriesOfType(h.facade, 'delivery').map((entry) => entry.content))
      .toEqual(['Imports tidied.', 'Version bumped to 2.1.0.']);
  });
});

describe('cancel_task and background work the cancelled task started', () => {
  it('withholds a background sub-agent result that arrives after its task was cancelled', async () => {
    const h = createDuplexScenario();
    const spawned = stubChildAgents(h.reasonerLoop, (pi) => {
      pi.hold = true;
      pi.defaultText = 'The index has 40 stale shards.';
    });
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'audit the search index' } }],
    }];
    h.reasonerPi.script = [
      { calls: [{ name: 'SubAgent', args: { instructions: 'count stale shards', background: true } }] },
      { text: 'Started a helper to count stale shards.' },
    ];
    await h.facade.prompt('audit the search index');
    await waitUntil(() => spawned.children.length === 1, 2000, 'helper spawned');
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'spawning run over');
    expect(entriesOfType(h.facade, 'delivery').map((entry) => entry.content))
      .toEqual(['Started a helper to count stale shards.']);

    h.reasonerPi.script = [{ text: 'Noted, dropping the audit.' }];
    h.talkerPi.script = [{
      text: 'Cancelling it.',
      calls: [{ name: 'cancel_task', args: { taskAlias: 'task-1' } }],
    }];
    await h.facade.prompt('forget the audit');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 2, 2000, 'cancel delivered');
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'cancel run over');

    // The helper finishes after the cancel; its result opens a drain run.
    h.reasonerPi.script = [{ text: 'The helper found 40 stale shards.' }];
    spawned.children[0]!.pi.releaseRun();
    await waitUntil(() => h.reasonerPi.promptCalls.length === 3, 2000, 'drain run');
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'drain run over');

    // Precondition: the drain run's reply did reach the router's intake.
    const dropped = lifecycleEvents(h.facade, 'delivery_dropped_cancelled')
      .map((entry) => (entry.data as { content?: string }).content);
    expect(dropped).toContain('The helper found 40 stale shards.');
    expect(entriesOfType(h.facade, 'delivery').map((entry) => entry.content))
      .not.toContain('The helper found 40 stale shards.');
  });
});

describe('cancel_task ordering', () => {
  it('marks the task cancelled before its directive reaches log subscribers', async () => {
    const h = createDuplexScenario();
    h.reasonerPi.hold = true;
    h.talkerPi.script = [{ text: 'On it.', calls: [{ name: 'spawn_task', args: { instructions: 'rebuild the index' } }] }];
    await h.facade.prompt('rebuild the index');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work started');

    const seenAtEntry: boolean[] = [];
    h.facade.subscribeLog((event) => {
      if (event.kind !== 'entry') return;
      if ((event.entry.data as { tool?: string } | undefined)?.tool !== 'cancel_task') return;
      seenAtEntry.push(duplexRouterOf(h.facade).getDelegations()[0]!.cancelled);
    });
    h.talkerPi.script = [{ text: 'Cancelling.', calls: [{ name: 'cancel_task', args: { taskAlias: 'task-1' } }] }];
    await h.facade.prompt('cancel that');
    expect(seenAtEntry).toEqual([true]);
    h.reasonerPi.releaseRun();
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner idle');
  });
});
