/**
 * DuplexRouter: wake policy (interrupt / when_idle / silent with
 * producer-proposes/router-disposes), D19 backpressure (interrupt token
 * bucket with demotion, content-hash dedup, delegation caps, dispatch
 * dedup), the D18 conversation-delta buffer flushed inside dispatch
 * messages, the D17 receipt contract through the control tools, and the
 * liveness watchdog.
 *
 * The router is exercised both directly and through the actual control
 * tools (buildControlTools), so the router + control-tool pairing is tested
 * as one mechanism, not two.
 */
import { describe, it, expect, vi } from 'vitest';
import { DuplexRouter, DUPLEX_ROUTER_DEFAULTS } from '../../src/duplex/router.js';
import type { ReasonerDispatchOptions, RouterLogInput } from '../../src/duplex/router.js';
import { makeTestRouterPorts } from './duplex-test-ports.js';
import type { CauseTag } from '../../src/duplex/cause-tags.js';
import { buildControlTools } from '../../src/duplex/control-tools.js';
import {
  CONVERSATION_CONTEXT_OPEN,
  DELTA_OVERFLOW_MARKER,
} from '../../src/duplex/prompts.js';

interface Harness {
  router: DuplexRouter;
  log: Array<RouterLogInput & { seq: number }>;
  talkerDeliveries: Array<{ content: string; wake: boolean }>;
  askVoicings: Array<{ content: string; causeTag: CauseTag }>;
  reasonerDispatches: Array<{
    message: string;
    causeSeq: number | null;
    options?: ReasonerDispatchOptions;
  }>;
  lookupSpawns: Array<{ question: string; causeSeq: number | null }>;
  /** Force the next spawnLookup verdicts to a refusal (null = accept). */
  setLookupRefusal: (reason: string | null) => void;
  setTalkerIdle: (idle: boolean) => void;
  setIdleSignal: (signal: (() => boolean) | undefined) => void;
  /** Make dispatchToReasoner throw until cleared with null. */
  setDispatchError: (error: Error | null) => void;
  /** Change the talker's live-run discriminated cause set. */
  setTalkerCauseTags: (tags: readonly CauseTag[]) => void;
  /**
   * Override the reasoner's live-run cause set, which otherwise derives
   * from the directives actually dispatched. For tests that need a cause
   * set no dispatch in the test produced.
   */
  setReasonerCauseTags: (tags: readonly CauseTag[]) => void;
  advance: (ms: number) => void;
  now: () => number;
}

function createHarness(options?: ConstructorParameters<typeof DuplexRouter>[1] & {
  talkerCauseSeq?: number | null;
  talkerCauseTags?: readonly CauseTag[];
  reasonerCauseTags?: readonly CauseTag[];
}): Harness {
  let clock = 1_000_000;
  let talkerIdle = true;
  let idleSignal: (() => boolean) | undefined;
  let dispatchError: Error | null = null;
  let talkerCauseTags: readonly CauseTag[] = options?.talkerCauseTags ?? [];
  /**
   * Explicit override of the reasoner's live-run cause set. Null means "use
   * the derived set below", which is the default on purpose: see
   * {@link derivedReasonerCauseTags}.
   */
  let reasonerCauseTagsOverride: readonly CauseTag[] | null =
    options?.reasonerCauseTags ?? null;
  /** Directive seqs actually dispatched to the reasoner, in order. */
  const dispatchedCauseSeqs: number[] = [];
  const log: Array<RouterLogInput & { seq: number }> = [];
  const talkerDeliveries: Array<{ content: string; wake: boolean }> = [];
  const askVoicings: Array<{ content: string; causeTag: CauseTag }> = [];
  const reasonerDispatches: Harness['reasonerDispatches'] = [];
  const lookupSpawns: Array<{ question: string; causeSeq: number | null }> = [];
  let lookupRefusal: string | null = null;
  let nextLookupAlias = 1;
  let nextSeq = 1;

  /**
   * The reasoner's live-run cause set, derived from the directives actually
   * dispatched to it.
   *
   * Deliberately NOT a neutral `() => []`. An empty set means "this delivery
   * concludes no delegation", which is exactly the never-retires behavior the
   * retirement logic exists to remove, so a neutral stub would have every
   * test in this file quietly assert the old bug while the one test written
   * for retirement passed. Deriving from real dispatches means a test that
   * spawns and then delivers gets genuine retirement without its author
   * having to think about causation at all.
   *
   * Modelled as "every directive dispatched so far", which matches the
   * single-persistent-reasoner topology (D3): both a spawn and a steer parked
   * behind it land in the same loop's queue and are consumed by the same run.
   * Tests needing finer control set the override explicitly.
   */
  function derivedReasonerCauseTags(): readonly CauseTag[] {
    return dispatchedCauseSeqs.map((seq) => ({ kind: 'directive', seq } as CauseTag));
  }

  // Built from the shared factory: any port this file does not stub
  // throws when called, so a test cannot pass on an answer it never
  // asked for. This harness drives the whole router, so it stubs
  // everything; the guarantee is for the next port added upstream.
  const ports = makeTestRouterPorts({
    deliverToTalker: (content, wake) => talkerDeliveries.push({ content, wake }),
    voiceAskToTalker: (content, causeTag) => askVoicings.push({ content, causeTag }),
    talkerIdle: () => talkerIdle,
    spawnLookup: (question, causeSeq) => {
      if (lookupRefusal !== null) return { accepted: false, reason: lookupRefusal };
      lookupSpawns.push({ question, causeSeq });
      return { accepted: true, alias: `lk-${nextLookupAlias++}` };
    },
    dispatchToReasoner: (message, causeSeq, dispatchOptions) => {
      if (dispatchError) throw dispatchError;
      reasonerDispatches.push({
        message,
        causeSeq,
        ...(dispatchOptions !== undefined ? { options: dispatchOptions } : {}),
      });
      if (causeSeq !== null) dispatchedCauseSeqs.push(causeSeq);
    },
    appendLog: (input) => {
      const seq = nextSeq++;
      log.push({ ...input, seq });
      return seq;
    },
    currentTalkerCauseSeq: () => options?.talkerCauseSeq ?? null,
    currentTalkerCauseTags: () => talkerCauseTags,
    currentReasonerCauseTags: () => reasonerCauseTagsOverride ?? derivedReasonerCauseTags(),
    get idleSignal() {
      return idleSignal;
    },
  });

  const router = new DuplexRouter(ports, {
    // Fast defaults so tests poll real timers briefly instead of sleeping.
    minDeliverySpacingMs: 0,
    idlePollMs: 5,
    whenIdleDegradeMs: 10_000_000,
    now: () => clock,
    ...options,
  });

  return {
    router,
    log,
    talkerDeliveries,
    askVoicings,
    reasonerDispatches,
    lookupSpawns,
    setLookupRefusal: (reason) => { lookupRefusal = reason; },
    setTalkerIdle: (idle) => { talkerIdle = idle; },
    setIdleSignal: (signal) => { idleSignal = signal; },
    setDispatchError: (error) => { dispatchError = error; },
    setTalkerCauseTags: (tags) => { talkerCauseTags = tags; },
    setReasonerCauseTags: (tags) => { reasonerCauseTagsOverride = tags; },
    advance: (ms) => { clock += ms; },
    now: () => clock,
  };
}

/** Poll until `predicate` holds; fails the test after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function entryTypes(h: Harness): string[] {
  return h.log.map((entry) => entry.type);
}

// ---------------------------------------------------------------------------
// Wake policy
// ---------------------------------------------------------------------------

describe('wake policy', () => {
  it('silent deliveries go straight to the talker silent queue and never wake', () => {
    const h = createHarness();
    const result = h.router.deliverFromReasoner('milestone reached', 'silent');
    expect(result).toMatchObject({ delivered: true, wake: 'silent' });
    expect(h.talkerDeliveries).toHaveLength(1);
    expect(h.talkerDeliveries[0]!.wake).toBe(false);
    expect(h.talkerDeliveries[0]!.content).toContain('milestone reached');
    expect(h.router.pendingDeliveryCount).toBe(0);
  });

  it('interrupt deliveries reach the talker as wake content', async () => {
    const h = createHarness();
    h.setTalkerIdle(false); // interrupts do not wait for a lull
    const result = h.router.deliverFromReasoner('need a decision', 'interrupt');
    expect(result).toMatchObject({ delivered: true, wake: 'interrupt' });
    await waitUntil(() => h.talkerDeliveries.length === 1);
    expect(h.talkerDeliveries[0]!.wake).toBe(true);
  });

  it('when_idle holds while the channel is busy and delivers at the lull', async () => {
    const h = createHarness();
    h.setTalkerIdle(false);
    const result = h.router.deliverFromReasoner('finished the analysis', 'when_idle');
    expect(result).toMatchObject({ delivered: true, wake: 'when_idle' });
    expect(h.router.pendingDeliveryCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.talkerDeliveries).toHaveLength(0);

    h.setTalkerIdle(true);
    await waitUntil(() => h.talkerDeliveries.length === 1);
    expect(h.router.pendingDeliveryCount).toBe(0);
    expect(h.talkerDeliveries[0]!.wake).toBe(true);
  });

  it('defaults an unspecified wake class to when_idle', () => {
    const h = createHarness();
    const result = h.router.deliverFromReasoner('result', undefined);
    expect(result.wake).toBe('when_idle');
    const entry = h.log.find((item) => item.type === 'delivery')!;
    expect(entry.wake).toBe('when_idle');
    expect(entry.data).toMatchObject({ proposedWake: 'when_idle' });
  });

  it('a consumer idle signal overrides the talker-idle default', async () => {
    const h = createHarness();
    h.setTalkerIdle(true);
    h.setIdleSignal(() => false); // consumer says: user mid-utterance
    h.router.deliverFromReasoner('done', 'when_idle');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.talkerDeliveries).toHaveLength(0);

    h.setIdleSignal(() => true);
    await waitUntil(() => h.talkerDeliveries.length === 1);
  });

  it('a throwing idle signal is treated as not idle, not as a crash', async () => {
    const h = createHarness();
    h.setIdleSignal(() => { throw new Error('signal bug'); });
    h.router.deliverFromReasoner('done', 'when_idle');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.talkerDeliveries).toHaveLength(0);
    expect(h.router.pendingDeliveryCount).toBe(1);
  });

  it('when_idle degrades to interrupt after the configured delay', async () => {
    const h = createHarness({ whenIdleDegradeMs: 50 });
    h.setTalkerIdle(false); // never idle
    h.router.deliverFromReasoner('overdue result', 'when_idle');
    // The degrade clock uses the injected clock; move past the threshold.
    h.advance(60);
    await waitUntil(() => h.talkerDeliveries.length === 1);
    expect(h.talkerDeliveries[0]!.wake).toBe(true);
  });

  it('every delivery lands in the log before the talker sees it, with the disposed wake', () => {
    const h = createHarness();
    h.router.deliverFromReasoner('silent note', 'silent');
    const entry = h.log[0]!;
    expect(entry.type).toBe('delivery');
    expect(entry.wake).toBe('silent');
    expect(entry.content).toBe('silent note');
    expect(entry.loopPath).toBe('reasoner');
  });
});

// ---------------------------------------------------------------------------
// Backpressure: token bucket, dedup, spacing
// ---------------------------------------------------------------------------

describe('backpressure', () => {
  it('demotes interrupts to when_idle once the token bucket is empty, refilling over time', () => {
    const h = createHarness({ interruptBucketCapacity: 2, interruptRefillMs: 1_000 });
    h.setTalkerIdle(false);
    expect(h.router.deliverFromReasoner('a', 'interrupt').wake).toBe('interrupt');
    expect(h.router.deliverFromReasoner('b', 'interrupt').wake).toBe('interrupt');
    const demoted = h.router.deliverFromReasoner('c', 'interrupt');
    expect(demoted.wake).toBe('when_idle');
    const demotedEntry = h.log.filter((entry) => entry.type === 'delivery')[2]!;
    expect(demotedEntry.data).toMatchObject({ proposedWake: 'interrupt', demoted: true });

    // One refill period earns one token back.
    h.advance(1_100);
    expect(h.router.deliverFromReasoner('d', 'interrupt').wake).toBe('interrupt');
    expect(h.router.deliverFromReasoner('e', 'interrupt').wake).toBe('when_idle');
  });

  it('absorbs duplicate delivery content within the dedup window', () => {
    const h = createHarness({ deliveryDedupWindowMs: 1_000 });
    expect(h.router.deliverFromReasoner('same text', 'silent').delivered).toBe(true);
    const duplicate = h.router.deliverFromReasoner('same text', 'silent');
    expect(duplicate.delivered).toBe(false);
    expect(duplicate.reason).toMatch(/duplicate/);
    // Only one delivery entry and one talker handoff.
    expect(h.log.filter((entry) => entry.type === 'delivery')).toHaveLength(1);
    expect(h.talkerDeliveries).toHaveLength(1);

    // Outside the window the same content delivers again.
    h.advance(1_100);
    expect(h.router.deliverFromReasoner('same text', 'silent').delivered).toBe(true);
  });

  it('a deduped delivery leaves a delivery_absorbed lifecycle trace (S3)', () => {
    const h = createHarness({ reasonerCauseTags: [{ kind: 'directive', seq: 7 }] });
    expect(h.router.deliverFromReasoner('same text', 'silent').delivered).toBe(true);
    const duplicate = h.router.deliverFromReasoner('same text', 'silent', { implicit: true });
    expect(duplicate.delivered).toBe(false);
    // An absorbed duplicate still enters the audit trail.
    const absorbed = h.log.find(
      (entry) => entry.type === 'lifecycle' && (entry.data as { event?: string }).event === 'delivery_absorbed',
    );
    expect(absorbed).toBeDefined();
    expect(absorbed!.causedBy).toBe(7);
    expect(absorbed!.data).toMatchObject({ implicit: true });
  });

  it('bounds delivery_absorbed lifecycle entries per reasoner run', () => {
    const h = createHarness();
    expect(h.router.deliverFromReasoner('same text', 'silent').delivered).toBe(true);
    // A run re-emitting the same content in a loop: every repeat is
    // absorbed, but only a bounded number writes a lifecycle entry.
    for (let i = 0; i < 5; i++) {
      expect(h.router.deliverFromReasoner('same text', 'silent').delivered).toBe(false);
    }
    const absorbed = h.log.filter(
      (entry) => entry.type === 'lifecycle' && (entry.data as { event?: string }).event === 'delivery_absorbed',
    );
    expect(absorbed).toHaveLength(3);
    expect(absorbed[2]!.data).toMatchObject({ furtherAbsorbedSuppressed: true });

    // The bound is per reasoner run, not per session.
    h.router.noteReasonerRunStart();
    expect(h.router.deliverFromReasoner('same text', 'silent').delivered).toBe(false);
    expect(h.log.filter(
      (entry) => entry.type === 'lifecycle' && (entry.data as { event?: string }).event === 'delivery_absorbed',
    )).toHaveLength(4);
    h.router.noteReasonerRunEnd();
  });

  it('identical content under a new causing directive is delivered, not absorbed (S3)', () => {
    const h = createHarness({ reasonerCauseTags: [{ kind: 'directive', seq: 7 }] });
    expect(h.router.deliverFromReasoner('Scan complete: no issues.', 'silent').delivered).toBe(true);
    // "Run it again": a new directive, byte-identical result.
    h.setReasonerCauseTags([{ kind: 'directive', seq: 11 }]);
    expect(h.router.deliverFromReasoner('Scan complete: no issues.', 'silent').delivered).toBe(true);
    expect(h.log.filter((entry) => entry.type === 'delivery')).toHaveLength(2);
    expect(h.talkerDeliveries).toHaveLength(2);
  });

  it('enforces minimum inter-delivery spacing even under an always-idle signal', async () => {
    const h = createHarness({ minDeliverySpacingMs: 10_000_000 });
    h.setIdleSignal(() => true);
    h.router.deliverFromReasoner('first', 'when_idle');
    await waitUntil(() => h.talkerDeliveries.length === 1);
    h.router.deliverFromReasoner('second', 'when_idle');
    await new Promise((resolve) => setTimeout(resolve, 25));
    // The second is held on spacing despite the idle signal.
    expect(h.talkerDeliveries).toHaveLength(1);
    expect(h.router.pendingDeliveryCount).toBe(1);

    h.advance(10_000_001);
    await waitUntil(() => h.talkerDeliveries.length === 2);
  });

  it('interrupts jump ahead of held when_idle deliveries', async () => {
    const h = createHarness();
    h.setTalkerIdle(false);
    h.router.deliverFromReasoner('waiting result', 'when_idle');
    h.router.deliverFromReasoner('urgent question', 'interrupt');
    await waitUntil(() => h.talkerDeliveries.length === 1);
    expect(h.talkerDeliveries[0]!.content).toContain('urgent question');
  });
});

// ---------------------------------------------------------------------------
// Control-tool dispatch through the real tools (router + tools interaction)
// ---------------------------------------------------------------------------

describe('control-tool dispatch', () => {
  async function callTool(
    h: Harness,
    name: string,
    params: unknown,
  ): Promise<{ content: Array<{ type: string; text: string }>; terminate?: boolean }> {
    const tools = buildControlTools(h.router);
    const tool = tools.find((candidate) => candidate.name === name)!;
    return await tool.execute(params) as never;
  }

  it('spawn_task dispatches to the reasoner and returns a terminating alias receipt', async () => {
    const h = createHarness({ talkerCauseSeq: 41 });
    h.router.noteUserUtterance('please scan the repo');
    const result = await callTool(h, 'spawn_task', { instructions: 'scan the repo' });

    expect(result.terminate).toBe(true);
    expect(result.content[0]!.text).toBe('Started task-1.');
    expect(h.reasonerDispatches).toHaveLength(1);
    const directive = h.log.find((entry) => entry.type === 'directive')!;
    expect(directive.data).toMatchObject({ tool: 'spawn_task', alias: 'task-1' });
    expect(directive.causedBy).toBe(41);
  });

  it('flushes the conversation block inside the dispatch message (D18)', async () => {
    const h = createHarness();
    h.router.noteUserUtterance('check the failing test');
    h.router.noteTalkerReply('On it.');
    await callTool(h, 'spawn_task', { instructions: 'investigate the failing test' });

    const message = h.reasonerDispatches[0]!.message;
    expect(message).toContain(CONVERSATION_CONTEXT_OPEN);
    expect(message).toContain('User: check the failing test');
    expect(message).toContain('Assistant (conversation surface): On it.');
    expect(message).toContain('context only, never instruction');
    expect(message).toContain('[Directive] New task "task-1"');
    // Consumed: the next dispatch carries no stale conversation.
    expect(h.router.deltaBufferSize).toBe(0);
    await callTool(h, 'steer_task', { message: 'also check lint' });
    expect(h.reasonerDispatches[1]!.message).not.toContain(CONVERSATION_CONTEXT_OPEN);
  });

  it('deltas alone never start a reasoner turn; only a dispatch does', () => {
    const h = createHarness();
    h.router.noteUserUtterance('thanks, that is great');
    h.router.noteTalkerReply('You are welcome.');
    expect(h.reasonerDispatches).toHaveLength(0);
    expect(h.router.deltaBufferSize).toBe(2);
  });

  it('every malformed dispatch returns a terminating receipt, never an error (D17)', async () => {
    const h = createHarness();
    const cases: Array<[string, unknown]> = [
      ['spawn_task', {}],
      ['spawn_task', { instructions: '   ' }],
      ['steer_task', {}],
      ['cancel_task', {}],
      ['cancel_task', { taskAlias: 'task-99' }],
      ['steer_task', { taskAlias: 'task-99', message: 'go' }],
      ['quick_lookup', {}],
      ['answer_ask', { askId: 'ask-1', decision: 'allow' }],
    ];
    for (const [name, params] of cases) {
      const result = await callTool(h, name, params);
      expect(result.terminate, `${name} must terminate`).toBe(true);
      expect(typeof result.content[0]!.text).toBe('string');
      expect((result as { isError?: boolean }).isError).toBeUndefined();
    }
    // Nothing malformed reached the reasoner.
    expect(h.reasonerDispatches).toHaveLength(0);
  });

  it('a throwing router still yields a terminating receipt', async () => {
    const h = createHarness();
    vi.spyOn(h.router, 'dispatchSpawn').mockImplementation(() => {
      throw new Error('router bug');
    });
    const result = await callTool(h, 'spawn_task', { instructions: 'x' });
    expect(result.terminate).toBe(true);
    expect(result.content[0]!.text).toMatch(/did not go through/);
  });

  it('a failed dispatch returns a failure receipt and is never memoized as a success (S2)', async () => {
    const h = createHarness();
    h.router.noteUserUtterance('scan please');
    h.setDispatchError(new Error('reasoner deliver blew up'));

    const failed = await callTool(h, 'spawn_task', { instructions: 'scan the repo' });
    expect(failed.terminate).toBe(true);
    // The talker must not report work started that was never handed over.
    expect(failed.content[0]!.text).not.toMatch(/^Started/);
    expect(failed.content[0]!.text).toMatch(/did not go through|handoff failed/i);
    expect(h.reasonerDispatches).toHaveLength(0);
    // Not tracked as live work either.
    expect(h.router.getDelegations()).toHaveLength(0);
    const failure = h.log.find(
      (entry) => entry.type === 'lifecycle' && (entry.data as { event?: string }).event === 'dispatch_failed',
    );
    expect(failure).toBeDefined();

    // An identical retry in the same exchange re-dispatches instead of
    // replaying the memoized receipt.
    h.setDispatchError(null);
    const retry = await callTool(h, 'spawn_task', { instructions: 'scan the repo' });
    expect(retry.content[0]!.text).toMatch(/^Started task-/);
    expect(h.reasonerDispatches).toHaveLength(1);
    expect(h.router.getDelegations()).toHaveLength(1);
  });

  it('a failed steer dispatch is not memoized either', async () => {
    const h = createHarness();
    h.router.noteUserUtterance('adjust course');
    h.setDispatchError(new Error('down'));
    const failed = await callTool(h, 'steer_task', { message: 'focus on Europe' });
    expect(failed.content[0]!.text).not.toMatch(/^Redirect sent/);

    h.setDispatchError(null);
    const retry = await callTool(h, 'steer_task', { message: 'focus on Europe' });
    expect(retry.content[0]!.text).toBe('Redirect sent.');
    expect(h.reasonerDispatches).toHaveLength(1);
  });

  it('records refused and unknown-task dispatches as lifecycle entries (F11)', async () => {
    const h = createHarness();
    await callTool(h, 'cancel_task', { taskAlias: 'nope' });
    const refusal = h.log.find(
      (entry) => entry.type === 'lifecycle' && (entry.data as { event?: string }).event === 'dispatch_refused',
    );
    expect(refusal).toBeDefined();
    expect(refusal!.data).toMatchObject({ tool: 'cancel_task' });
  });

  it('absorbs a retry-induced duplicate dispatch, replaying the original receipt', async () => {
    const h = createHarness();
    h.router.noteUserUtterance('scan please');
    const first = await callTool(h, 'spawn_task', { instructions: 'scan the repo' });
    const retry = await callTool(h, 'spawn_task', { instructions: 'scan the repo' });
    expect(retry.content[0]!.text).toBe(first.content[0]!.text);
    expect(h.reasonerDispatches).toHaveLength(1);
    expect(h.router.getDelegations()).toHaveLength(1);
  });

  it('a deliberate repeat in a later turn re-dispatches: turnIndex is part of the dedup key (N2)', async () => {
    const h = createHarness();
    h.router.noteUserUtterance('push it along');
    const first = await callTool(h, 'steer_task', { message: 'hurry up' });
    expect(first.content[0]!.text).toBe('Redirect sent.');
    // Same turn: a retry-induced double is absorbed.
    const sameTurn = await callTool(h, 'steer_task', { message: 'hurry up' });
    expect(sameTurn.content[0]!.text).toBe('Redirect sent.');
    expect(h.reasonerDispatches).toHaveLength(1);

    // A later turn in the same exchange: the user watched the reasoner
    // ignore the first steer and the talker deliberately re-sends it. That
    // must dispatch again, not replay a receipt with nothing behind it.
    h.router.noteTalkerTurnEnd();
    const repeat = await callTool(h, 'steer_task', { message: 'hurry up' });
    expect(repeat.content[0]!.text).toBe('Redirect sent.');
    expect(h.reasonerDispatches).toHaveLength(2);
  });

  it('bounds dispatch_refused lifecycle entries per turn (N4)', async () => {
    const h = createHarness();
    h.router.noteUserUtterance('do things');
    for (let i = 0; i < 5; i++) {
      const refused = await callTool(h, 'spawn_task', {});
      // The receipt still comes back for every call.
      expect(refused.terminate).toBe(true);
    }
    const refusals = h.log.filter(
      (entry) => entry.type === 'lifecycle' && (entry.data as { event?: string }).event === 'dispatch_refused',
    );
    expect(refusals).toHaveLength(3);
    expect(refusals[2]!.data).toMatchObject({ furtherRefusalsSuppressed: true });

    // The bound is per turn, not per session.
    h.router.noteTalkerTurnEnd();
    await callTool(h, 'spawn_task', {});
    expect(h.log.filter(
      (entry) => entry.type === 'lifecycle' && (entry.data as { event?: string }).event === 'dispatch_refused',
    )).toHaveLength(4);
  });

  it('a CONSUMED utterance opens a fresh exchange: dedup and caps reset (SF-3)', async () => {
    const h = createHarness();
    h.setTalkerCauseTags([{ kind: 'utterance', seq: 1 }]);
    h.router.noteUserUtterance('scan please');
    await callTool(h, 'spawn_task', { instructions: 'scan the repo' });
    // The next utterance arrives AND the talker's next run carries its
    // tag: the exchange rolls over, so the deliberate repeat ("scan it
    // again") dispatches anew instead of replaying the memoized receipt.
    h.router.noteUserUtterance('scan it again');
    h.setTalkerCauseTags([{ kind: 'utterance', seq: 5 }]);
    const second = await callTool(h, 'spawn_task', { instructions: 'scan the repo' });
    expect(second.content[0]!.text).toBe('Started task-2.');
    expect(h.reasonerDispatches).toHaveLength(2);
  });

  it('a mid-batch barge-in does not defeat dispatch dedup (SF-3)', async () => {
    const h = createHarness();
    h.setTalkerCauseTags([{ kind: 'utterance', seq: 1 }]);
    h.router.noteUserUtterance('do X');
    const first = await callTool(h, 'spawn_task', { instructions: 'do X' });
    expect(first.content[0]!.text).toBe('Started task-1.');
    // The user barges in mid-batch: the facade notes the utterance at
    // arrival, but the LIVE run's cause set is unchanged (the barge-in
    // parked for the next run). The retry-induced identical call in the
    // same batch must replay the receipt, not spawn a second task doing
    // identical work.
    h.router.noteUserUtterance('wait, one more thing');
    const retry = await callTool(h, 'spawn_task', { instructions: 'do X' });
    expect(retry.content[0]!.text).toBe('Started task-1.');
    expect(h.reasonerDispatches).toHaveLength(1);
  });

  it('a mid-batch barge-in does not refresh exhausted delegation caps (SF-3)', async () => {
    const h = createHarness({ maxDispatchesPerTurn: 10, maxDispatchesPerExchange: 1 });
    h.setTalkerCauseTags([{ kind: 'utterance', seq: 1 }]);
    h.router.noteUserUtterance('do many things');
    await callTool(h, 'spawn_task', { instructions: 'thing one' });
    // Arrival alone must not hand the capped turn a fresh budget.
    h.router.noteUserUtterance('barge-in mid-batch');
    const refused = await callTool(h, 'spawn_task', { instructions: 'thing two' });
    expect(refused.content[0]!.text).toMatch(/limit reached for this exchange/i);
    expect(h.reasonerDispatches).toHaveLength(1);

    // Once the next run consumes the barge-in, the budget refreshes.
    h.setTalkerCauseTags([{ kind: 'utterance', seq: 4 }]);
    const allowed = await callTool(h, 'spawn_task', { instructions: 'thing two' });
    expect(allowed.content[0]!.text).toMatch(/^Started task-/);
    expect(h.reasonerDispatches).toHaveLength(2);
  });

  it('a run that consumes an utterance but dispatches nothing still rolls the exchange', async () => {
    const h = createHarness({ maxDispatchesPerTurn: 10, maxDispatchesPerExchange: 1 });
    h.setTalkerCauseTags([{ kind: 'utterance', seq: 1 }]);
    h.router.noteUserUtterance('kick off');
    await callTool(h, 'spawn_task', { instructions: 'thing one' });
    h.router.noteTalkerTurnEnd();

    // The user speaks again and the consuming run just acknowledges,
    // calling no control tool. Its turn end fires while the utterance tag
    // is still live on the run; that boundary is the only chance to
    // observe the consumption before the run's cleanup clears the tags.
    h.router.noteUserUtterance('now the next thing');
    h.setTalkerCauseTags([{ kind: 'utterance', seq: 5 }]);
    h.router.noteTalkerTurnEnd();

    // A later run woken by a reasoner delivery carries no utterance tag.
    // Its dispatch must run against the budget the consumed utterance
    // refreshed, not be refused as if the user never spoke.
    h.setTalkerCauseTags([{ kind: 'delivery', seq: 9 }]);
    const allowed = await callTool(h, 'spawn_task', { instructions: 'thing two' });
    expect(allowed.content[0]!.text).toMatch(/^Started task-/);
    expect(h.reasonerDispatches).toHaveLength(2);
  });

  it('a delivery- or directive-caused run never refreshes the exchange budget (SF-3)', async () => {
    const h = createHarness({ maxDispatchesPerTurn: 10, maxDispatchesPerExchange: 1 });
    h.setTalkerCauseTags([{ kind: 'utterance', seq: 1 }]);
    h.router.noteUserUtterance('kick off');
    await callTool(h, 'spawn_task', { instructions: 'thing one' });
    // A later run woken by a background delivery is not the user speaking:
    // D16's shape (utterance-kind only) gates the rollover too.
    h.setTalkerCauseTags([{ kind: 'delivery', seq: 9 }]);
    const refused = await callTool(h, 'spawn_task', { instructions: 'thing two' });
    expect(refused.content[0]!.text).toMatch(/limit reached for this exchange/i);
    expect(h.reasonerDispatches).toHaveLength(1);
  });

  it('enforces the per-turn delegation cap with a voiceable refusal', async () => {
    const h = createHarness({ maxDispatchesPerTurn: 2, maxDispatchesPerExchange: 10 });
    h.router.noteUserUtterance('do many things');
    await callTool(h, 'spawn_task', { instructions: 'thing one' });
    await callTool(h, 'spawn_task', { instructions: 'thing two' });
    const refused = await callTool(h, 'spawn_task', { instructions: 'thing three' });
    expect(refused.terminate).toBe(true);
    expect(refused.content[0]!.text).toMatch(/limit reached for this turn/i);
    expect(h.reasonerDispatches).toHaveLength(2);

    // The next turn boundary resets the per-turn cap.
    h.router.noteTalkerTurnEnd();
    const allowed = await callTool(h, 'spawn_task', { instructions: 'thing three' });
    expect(allowed.content[0]!.text).toMatch(/^Started task-/);
  });

  it('enforces the per-exchange delegation cap across turns', async () => {
    const h = createHarness({ maxDispatchesPerTurn: 10, maxDispatchesPerExchange: 2 });
    h.router.noteUserUtterance('do many things');
    await callTool(h, 'spawn_task', { instructions: 'thing one' });
    h.router.noteTalkerTurnEnd();
    await callTool(h, 'spawn_task', { instructions: 'thing two' });
    h.router.noteTalkerTurnEnd();
    const refused = await callTool(h, 'spawn_task', { instructions: 'thing three' });
    expect(refused.content[0]!.text).toMatch(/limit reached for this exchange/i);
    expect(h.reasonerDispatches).toHaveLength(2);
  });

  it('cancel_task is exempt from the delegation caps and marks the delegation', async () => {
    const h = createHarness({ maxDispatchesPerTurn: 1 });
    h.router.noteUserUtterance('start then stop');
    await callTool(h, 'spawn_task', { instructions: 'long scan' });
    const cancel = await callTool(h, 'cancel_task', { taskAlias: 'task-1' });
    expect(cancel.content[0]!.text).toBe('Cancelling task-1.');
    expect(h.reasonerDispatches).toHaveLength(2);
    expect(h.reasonerDispatches[1]!.message).toContain('Cancel task "task-1"');
    expect(h.router.getDelegations()[0]).toMatchObject({ alias: 'task-1', cancelled: true });

    const again = await callTool(h, 'cancel_task', { taskAlias: 'task-1' });
    expect(again.content[0]!.text).toMatch(/already cancelled/);
    expect(h.reasonerDispatches).toHaveLength(2);
  });

  it('retires a delegation once a result lands against its directive', async () => {
    // Nothing marked a delegation complete before: it was added on spawn and
    // removed only by a failed handover or a restore, so a finished task sat
    // in the status block beside an idle reasoner for the rest of the
    // session, and activeAliases() kept naming it to the watchdog.
    const h = createHarness();
    await callTool(h, 'spawn_task', { instructions: 'build the release' });
    expect(h.router.getDelegations()[0]).toMatchObject({
      alias: 'task-1',
      completedAt: null,
    });

    // No explicit cause set here on purpose: the harness derives the
    // reasoner's live-run causation from the directive the spawn actually
    // dispatched, so this is the whole real path (dispatch, consume, deliver)
    // rather than a hand-placed tag that only this test knows to supply.
    h.router.deliverFromReasoner('the release is built', 'when_idle');

    expect(h.router.getDelegations()[0]!.completedAt).toBe(h.now());
    // And the same set produced the log stamp, from one port.
    expect(h.log.find((entry) => entry.type === 'delivery')!.causedBy)
      .toBe(h.reasonerDispatches[0]!.causeSeq);
  });

  it('matches the result against the FULL reasoner cause set, not the collapsed seq', async () => {
    // A run routinely consumes several directives (a spawn with a steer
    // parked behind it). The collapsing helper keeps only the newest, so a
    // retirement written against it would leave the spawn's delegation live
    // forever, which is the same defect D16 documents on the consent path.
    const h = createHarness();
    await callTool(h, 'spawn_task', { instructions: 'build the release' });
    const spawnSeq = h.log.find((entry) => entry.type === 'directive')!.seq;

    h.setReasonerCauseTags([
      { kind: 'directive', seq: spawnSeq },
      { kind: 'directive', seq: spawnSeq + 99 },
    ]);
    h.router.deliverFromReasoner('done', 'when_idle');
    expect(h.router.getDelegations()[0]!.completedAt).toEqual(expect.any(Number));
  });

  it('a progress note does not retire the work it reports on', async () => {
    const h = createHarness({ watchdogIntervalMs: 200 });
    h.setTalkerIdle(true);
    await callTool(h, 'spawn_task', { instructions: 'build the release' });
    const spawnSeq = h.log.find((entry) => entry.type === 'directive')!.seq;
    h.setReasonerCauseTags([{ kind: 'directive', seq: spawnSeq }]);

    // silent is a milestone by contract (the reasoner's role prompt), and
    // the watchdog's synthetic delivery says the work is STILL running.
    h.router.deliverFromReasoner('step one done', 'silent');
    expect(h.router.getDelegations()[0]!.completedAt).toBeNull();

    h.router.noteReasonerRunStart();
    h.advance(250);
    await waitUntil(() => h.talkerDeliveries.some((d) => d.content.includes('still running')));
    expect(h.router.getDelegations()[0]!.completedAt).toBeNull();
  });

  it('a steer takes a completed delegation back out of the completed state', async () => {
    // The reasoner is persistent and users iterate on a task that already
    // reported, so retirement marks rather than deletes: the alias stays
    // resolvable and a redirect makes it live work again.
    const h = createHarness();
    await callTool(h, 'spawn_task', { instructions: 'design the caching layer' });
    const spawnSeq = h.log.find((entry) => entry.type === 'directive')!.seq;
    h.setReasonerCauseTags([{ kind: 'directive', seq: spawnSeq }]);
    h.router.deliverFromReasoner('first cut of the design', 'when_idle');
    expect(h.router.getDelegations()[0]!.completedAt).toEqual(expect.any(Number));

    const steer = await callTool(h, 'steer_task', {
      taskAlias: 'task-1',
      message: 'use an LRU rather than a TTL',
    });
    expect(steer.content[0]!.text).toBe('Redirect sent to task-1.');
    expect(h.router.getDelegations()[0]!.completedAt).toBeNull();

    // And the result of the REDIRECTED run retires it again, which only
    // works because the steer's own seq joined the delegation's set.
    const steerSeq = h.log.filter((entry) => entry.type === 'directive').at(-1)!.seq;
    h.setReasonerCauseTags([{ kind: 'directive', seq: steerSeq }]);
    h.router.deliverFromReasoner('switched to LRU', 'when_idle');
    expect(h.router.getDelegations()[0]!.completedAt).toEqual(expect.any(Number));
  });

  it('ages a delegation out when no attributable result ever arrives', async () => {
    const h = createHarness({ delegationMaxAgeMs: 60_000 });
    await callTool(h, 'spawn_task', { instructions: 'something that never reports' });
    h.advance(59_000);
    expect(h.router.getDelegations()).toHaveLength(1);
    h.advance(2_000);
    expect(h.router.getDelegations()).toHaveLength(0);
  });

  it('steer_task without an alias sends a general redirect', async () => {
    const h = createHarness();
    const result = await callTool(h, 'steer_task', { message: 'focus on Europe' });
    expect(result.content[0]!.text).toBe('Redirect sent.');
    expect(h.reasonerDispatches[0]!.message).toContain('Redirect for the work in progress: focus on Europe');
  });

  it('quick_lookup spawns a facade lookup and never dispatches to the reasoner (D13)', async () => {
    const h = createHarness();
    const result = await callTool(h, 'quick_lookup', { question: 'what does resolveModel do?' });
    expect(result.terminate).toBe(true);
    expect(result.content[0]!.text).toMatch(/Looking into that/);
    expect(h.reasonerDispatches).toHaveLength(0);
    expect(h.lookupSpawns).toHaveLength(1);
    expect(h.lookupSpawns[0]!.question).toBe('what does resolveModel do?');
    // The spawn carries the directive seq for causation binding.
    const directive = h.log.find((entry) => entry.type === 'directive')!;
    expect(h.lookupSpawns[0]!.causeSeq).toBe(directive.seq);
  });

  it('a refused lookup spawn is a visible receipt and a logged refusal, never memoized', async () => {
    const h = createHarness();
    h.setLookupRefusal('lookup limit reached (2/2 running)');
    const refused = await callTool(h, 'quick_lookup', { question: 'q' });
    expect(refused.terminate).toBe(true);
    expect(refused.content[0]!.text).toMatch(/Could not start that lookup \(lookup limit reached/);
    const refusal = h.log.find(
      (entry) => entry.type === 'lifecycle' && (entry.data as { event?: string }).event === 'dispatch_refused',
    );
    expect(refusal).toBeDefined();
    expect(refusal!.data).toMatchObject({ tool: 'quick_lookup' });

    // The pool drained: an identical retry in the same turn spawns instead
    // of replaying the refusal.
    h.setLookupRefusal(null);
    const retry = await callTool(h, 'quick_lookup', { question: 'q' });
    expect(retry.content[0]!.text).toMatch(/Looking into that/);
    expect(h.lookupSpawns).toHaveLength(1);
  });

  it('deliverLookupResult logs a lookup_result, wakes the talker, and joins the reasoner deltas', async () => {
    const h = createHarness();
    h.setTalkerIdle(true);
    await callTool(h, 'quick_lookup', { question: 'what port does the server use?' });
    const directive = h.log.find((entry) => entry.type === 'directive')!;

    h.router.deliverLookupResult({
      alias: 'lk-1',
      question: 'what port does the server use?',
      status: 'completed',
      answer: 'Port 8080, set in config/server.ts.',
      causeSeq: directive.seq,
      durationMs: 1200,
    });

    const entry = h.log.find((item) => item.type === 'lookup_result')!;
    expect(entry.loopPath).toBe('lookup/lk-1');
    expect(entry.content).toContain('Port 8080');
    expect(entry.causedBy).toBe(directive.seq);
    expect(entry.wake).toBe('interrupt');

    await waitUntil(() => h.talkerDeliveries.length === 1);
    expect(h.talkerDeliveries[0]!.wake).toBe(true);
    expect(h.talkerDeliveries[0]!.content).toContain('<background-update>');
    expect(h.talkerDeliveries[0]!.content).toContain('Port 8080');

    // Shared context (D13): the reasoner sees the result with its next
    // dispatch.
    await callTool(h, 'spawn_task', { instructions: 'unrelated work' });
    const dispatch = h.reasonerDispatches[0]!.message;
    expect(dispatch).toContain('Quick lookup');
    expect(dispatch).toContain('Port 8080');
  });

  it('a timed-out lookup is delivered visibly, not dropped', async () => {
    const h = createHarness();
    h.setTalkerIdle(true);
    h.router.deliverLookupResult({
      alias: 'lk-1',
      question: 'q',
      status: 'timed_out',
      answer: '',
      causeSeq: null,
      durationMs: 30_000,
    });
    const entry = h.log.find((item) => item.type === 'lookup_result')!;
    expect(entry.content).toMatch(/did not complete: it timed out/);
    await waitUntil(() => h.talkerDeliveries.length === 1);
    expect(h.talkerDeliveries[0]!.content).toMatch(/did not complete/);
  });

  it('lookup interrupts draw from the token bucket and demote when it is empty', async () => {
    const h = createHarness({ interruptBucketCapacity: 1, interruptRefillMs: 1_000_000 });
    h.setTalkerIdle(false);
    const outcome = (alias: string) => ({
      alias,
      question: 'q',
      status: 'completed' as const,
      answer: `answer from ${alias}`,
      causeSeq: null,
      durationMs: 10,
    });
    h.router.deliverLookupResult(outcome('lk-1'));
    h.router.deliverLookupResult(outcome('lk-2'));
    const entries = h.log.filter((item) => item.type === 'lookup_result');
    expect(entries[0]!.wake).toBe('interrupt');
    expect(entries[1]!.wake).toBe('when_idle');
    expect(entries[1]!.data).toMatchObject({ demoted: true });
  });

  it('overflowing the delta buffer trims oldest lines behind a marker', async () => {
    const h = createHarness({ deltaBufferMaxChars: 50 });
    h.router.noteUserUtterance('a'.repeat(40));
    h.router.noteTalkerReply('b'.repeat(40));
    h.router.noteUserUtterance('keep this line');
    await callTool(h, 'spawn_task', { instructions: 'go' });
    const message = h.reasonerDispatches[0]!.message;
    expect(message).toContain(DELTA_OVERFLOW_MARKER);
    expect(message).toContain('keep this line');
    expect(message).not.toContain('a'.repeat(40));
  });
});

// ---------------------------------------------------------------------------
// Steer and cancel against a live reasoner run
// ---------------------------------------------------------------------------

describe('steer and cancel against a live run', () => {
  async function callTool(h: Harness, name: string, params: unknown): Promise<unknown> {
    const tool = buildControlTools(h.router).find((candidate) => candidate.name === name)!;
    return await tool.execute(params);
  }

  it('sends redirects and stops to the live run at its next turn boundary', async () => {
    const h = createHarness();
    await callTool(h, 'spawn_task', { instructions: 'scan the repo' });
    await callTool(h, 'steer_task', { taskAlias: 'task-1', message: 'skip vendored code' });
    expect(h.reasonerDispatches[0]!.options).toBeUndefined();
    expect(h.reasonerDispatches[1]!.options).toEqual({ atTurnBoundary: true });
  });

  it('asks for the live run to be stopped only when it serves nothing but cancelled work', async () => {
    const solo = createHarness();
    await callTool(solo, 'spawn_task', { instructions: 'scan the repo' });
    await callTool(solo, 'cancel_task', { taskAlias: 'task-1' });
    expect(solo.reasonerDispatches[1]!.options).toEqual({ atTurnBoundary: true, abortLiveRun: true });

    const shared = createHarness();
    await callTool(shared, 'spawn_task', { instructions: 'scan the repo' });
    await callTool(shared, 'spawn_task', { instructions: 'write the report' });
    await callTool(shared, 'cancel_task', { taskAlias: 'task-1' });
    expect(shared.reasonerDispatches[2]!.options).toEqual({ atTurnBoundary: true });
  });

  it('drops a result caused only by cancelled work, and logs what it withheld', async () => {
    const h = createHarness();
    h.setTalkerIdle(true);
    await callTool(h, 'spawn_task', { instructions: 'scan the repo' });
    await callTool(h, 'cancel_task', { taskAlias: 'task-1' });

    const dropped = h.router.deliverFromReasoner('partial scan results', 'when_idle');
    expect(dropped.delivered).toBe(false);
    expect(h.log.filter((entry) => entry.type === 'delivery')).toHaveLength(0);
    const record = h.log.find((entry) =>
      (entry.data as { event?: string } | undefined)?.event === 'delivery_dropped_cancelled');
    expect(record?.data).toMatchObject({ content: 'partial scan results' });

    // Positive control: once the run also serves live work, results flow.
    await callTool(h, 'spawn_task', { instructions: 'write the report' });
    expect(h.router.deliverFromReasoner('report written', 'when_idle').delivered).toBe(true);
    await waitUntil(() => h.talkerDeliveries.length === 1);
  });
});

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

describe('liveness watchdog', () => {
  it('synthesizes a when_idle progress delivery for a long-silent run', async () => {
    const h = createHarness({ watchdogIntervalMs: 200 });
    h.setTalkerIdle(true);
    h.router.noteReasonerRunStart();
    h.advance(250); // silence exceeds the interval on the injected clock
    await waitUntil(() => h.talkerDeliveries.length === 1);
    expect(h.talkerDeliveries[0]!.content).toMatch(/still running/);
    const entry = h.log.find((item) => item.type === 'delivery')!;
    expect(entry.data).toMatchObject({ synthetic: true });
    expect(entry.wake).toBe('when_idle');
  });

  it('says a run blocked on a permission ask is waiting on the user', async () => {
    const h = createHarness({ watchdogIntervalMs: 200 });
    h.setTalkerIdle(true);
    h.router.noteReasonerRunStart();
    void h.router.permissionBroker.requestDecision({
      askId: 'ask-1',
      loopPath: 'reasoner',
      toolName: 'Bash',
      renderedRequest: 'Bash: npm publish',
      kind: 'tool',
    });
    // Precondition: the ask is pending, so the run really is blocked on it.
    expect(h.router.permissionBroker.getPendingAsks()).toHaveLength(1);
    h.advance(250);
    await waitUntil(() => h.log.some(
      (entry) => entry.type === 'delivery' && (entry.data as { synthetic?: boolean }).synthetic === true,
    ));
    const entry = h.log.find(
      (item) => item.type === 'delivery' && (item.data as { synthetic?: boolean }).synthetic === true,
    )!;
    expect(entry.content).toMatch(/waiting for the user's permission answer \(Bash\)/);
    expect(entry.content).not.toMatch(/no update/);
    h.router.destroy();
  });

  it('stays quiet while the reasoner is idle or recently productive', async () => {
    const h = createHarness({ watchdogIntervalMs: 200 });
    // Idle: no run in flight.
    h.advance(1_000);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(h.talkerDeliveries).toHaveLength(0);

    // Productive: a delivery resets the silence clock.
    h.router.noteReasonerRunStart();
    h.advance(150);
    h.router.deliverFromReasoner('progress', 'silent');
    h.advance(150); // total 300 since start, but only 150 since output
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(h.talkerDeliveries).toHaveLength(1); // just the silent progress
    h.router.noteReasonerRunEnd();
  });
});

// ---------------------------------------------------------------------------
// State management (abort scopes, restore, destroy)
// ---------------------------------------------------------------------------

describe('router state management', () => {
  it('dropPendingDeliveries clears held deliveries but keeps their log entries', async () => {
    const h = createHarness();
    h.setTalkerIdle(false);
    h.router.deliverFromReasoner('undelivered result', 'when_idle');
    expect(h.router.pendingDeliveryCount).toBe(1);
    const dropped = h.router.dropPendingDeliveries();
    expect(dropped).toBe(1);
    expect(h.router.pendingDeliveryCount).toBe(0);
    // Retained in the log, not delivered (facade-api.md abort table).
    expect(h.log.filter((entry) => entry.type === 'delivery')).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.talkerDeliveries).toHaveLength(0);
  });

  it('waitForDeliveriesSettled resolves when the queues drain or drop', async () => {
    const h = createHarness();
    h.setTalkerIdle(false);
    h.router.deliverFromReasoner('held', 'when_idle');
    let settled = false;
    void h.router.waitForDeliveriesSettled().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(settled).toBe(false);
    h.router.dropPendingDeliveries();
    await waitUntil(() => settled);
  });

  it('resetForRestore clears delegations, deltas, dedup, and queues', async () => {
    const h = createHarness();
    h.router.noteUserUtterance('scan');
    const tools = buildControlTools(h.router);
    await tools.find((tool) => tool.name === 'spawn_task')!.execute({ instructions: 'scan' });
    h.setTalkerIdle(false);
    h.router.deliverFromReasoner('result', 'when_idle');

    h.router.resetForRestore();
    expect(h.router.getDelegations()).toHaveLength(0);
    expect(h.router.deltaBufferSize).toBe(0);
    expect(h.router.pendingDeliveryCount).toBe(0);
    // Post-restore, the same content is not treated as a duplicate.
    expect(h.router.deliverFromReasoner('result', 'silent').delivered).toBe(true);
  });

  it('destroy stops intake and timers', () => {
    const h = createHarness();
    h.router.destroy();
    const result = h.router.deliverFromReasoner('late', 'when_idle');
    expect(result.delivered).toBe(false);
  });
});
