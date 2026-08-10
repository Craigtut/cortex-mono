/**
 * SessionLog: the facade-owned append-only session record
 * (docs/cortex/duplex/log-and-context.md). Load-bearing contracts under
 * test: monotonic seq (timestamps collide under burst), snapshot reads
 * (never live references), replayable bounded subscriptions with gap
 * markers instead of backpressure, retention with spill, and monotonic seq
 * continuation across restore.
 */
import { describe, it, expect, vi } from 'vitest';
import { SessionLog } from '../../src/session-log.js';
import type {
  SessionLogEntry,
  SessionLogEvent,
  SessionLogReset,
} from '../../src/session-log.js';

function appendUtterance(log: SessionLog, content: string): SessionLogEntry {
  return log.append({ type: 'utterance', loopPath: 'main', content });
}

/** Poll until `predicate` holds; fails the test after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('SessionLog: append and seq', () => {
  it('assigns monotonic seqs starting at 1, even when timestamps collide', () => {
    const log = new SessionLog();
    const entries = Array.from({ length: 50 }, (_, i) => appendUtterance(log, `u${i}`));

    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    // Burst appends land within the same millisecond; seq still orders them.
    const timestamps = new Set(entries.map((e) => e.timestamp));
    expect(timestamps.size).toBeLessThan(50);
    expect(log.lastSeq).toBe(50);
  });

  it('stamps causedBy, wake, and data when provided and omits them otherwise', () => {
    const log = new SessionLog();
    const cause = appendUtterance(log, 'do the thing');
    const reply = log.append({
      type: 'reply',
      loopPath: 'main',
      content: 'done',
      causedBy: cause.seq,
      wake: 'when_idle',
      data: { runId: 'r1' },
    });

    expect(reply.causedBy).toBe(cause.seq);
    expect(reply.wake).toBe('when_idle');
    expect(reply.data).toEqual({ runId: 'r1' });
    expect('causedBy' in cause).toBe(false);
    expect('wake' in cause).toBe(false);
  });
});

describe('SessionLog: getLog snapshots', () => {
  it('deep-copies nested data, so no read surface shares objects with the log', () => {
    const log = new SessionLog();
    const appended = log.append({
      type: 'lifecycle',
      loopPath: 'main',
      content: 'spawned',
      data: { nested: { taskId: 'task-1' }, list: [{ step: 1 }] },
    });

    // Mutating nested structures on any returned copy must not reach the
    // log's retained entry.
    (appended.data!['nested'] as Record<string, unknown>)['taskId'] = 'mutated';
    (appended.data!['list'] as Array<Record<string, unknown>>)[0]!['step'] = 99;
    const fromLog = log.getLog()[0]!;
    expect(fromLog.data).toEqual({ nested: { taskId: 'task-1' }, list: [{ step: 1 }] });

    // And mutating a getLog() copy must not reach later reads.
    (fromLog.data!['nested'] as Record<string, unknown>)['taskId'] = 'also mutated';
    expect((log.getLog()[0]!.data!['nested'] as Record<string, unknown>)['taskId']).toBe('task-1');
  });

  it('returns a snapshot copy, never a live reference', () => {
    const log = new SessionLog();
    appendUtterance(log, 'first');
    const snapshot = log.getLog();
    appendUtterance(log, 'second');

    // The snapshot array does not grow with the log.
    expect(snapshot).toHaveLength(1);

    // Mutating a snapshot entry does not corrupt the log.
    snapshot[0]!.content = 'tampered';
    expect(log.getLog()[0]!.content).toBe('first');

    // data maps are detached too.
    const withData = log.append({
      type: 'lifecycle', loopPath: 'main', content: 'spawned', data: { taskId: 't1' },
    });
    const dataSnapshot = log.getLog(withData.seq)[0]!;
    dataSnapshot.data!['taskId'] = 'tampered';
    expect(log.getLog(withData.seq)[0]!.data).toEqual({ taskId: 't1' });
  });

  it('getLog(fromSeq) filters inclusively from the given seq', () => {
    const log = new SessionLog();
    for (let i = 0; i < 5; i += 1) appendUtterance(log, `u${i}`);

    expect(log.getLog(3).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(log.getLog(6)).toEqual([]);
    expect(log.getLog().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('SessionLog: subscriptions', () => {
  it('delivers appends synchronously to a sync subscriber (append-then-emit)', () => {
    const log = new SessionLog();
    const seen: number[] = [];
    log.subscribeLog((event) => {
      if (event.kind === 'entry') seen.push(event.entry.seq);
    });

    const entry = appendUtterance(log, 'hello');
    // Observed before append() returned control to any later code.
    expect(seen).toEqual([entry.seq]);
  });

  it('replays from a seq before delivering live entries, in order', () => {
    const log = new SessionLog();
    for (let i = 0; i < 4; i += 1) appendUtterance(log, `u${i}`);

    const seen: number[] = [];
    log.subscribeLog((event) => {
      if (event.kind === 'entry') seen.push(event.entry.seq);
    }, 3);
    expect(seen).toEqual([3, 4]);

    appendUtterance(log, 'live');
    expect(seen).toEqual([3, 4, 5]);
  });

  it('a subscriber without fromSeq gets live entries only', () => {
    const log = new SessionLog();
    appendUtterance(log, 'old');
    const seen: number[] = [];
    log.subscribeLog((event) => {
      if (event.kind === 'entry') seen.push(event.entry.seq);
    });
    appendUtterance(log, 'new');
    expect(seen).toEqual([2]);
  });

  it('unsubscribe stops delivery and is idempotent', () => {
    const log = new SessionLog();
    const seen: number[] = [];
    const unsubscribe = log.subscribeLog((event) => {
      if (event.kind === 'entry') seen.push(event.entry.seq);
    });

    appendUtterance(log, 'a');
    unsubscribe();
    unsubscribe();
    appendUtterance(log, 'b');
    expect(seen).toEqual([1]);
  });

  it('a throwing subscriber is logged and does not break peers or the log', () => {
    const warn = vi.fn();
    const log = new SessionLog({
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    const seen: number[] = [];
    log.subscribeLog(() => {
      throw new Error('subscriber bug');
    });
    log.subscribeLog((event) => {
      if (event.kind === 'entry') seen.push(event.entry.seq);
    });

    appendUtterance(log, 'a');
    appendUtterance(log, 'b');
    expect(seen).toEqual([1, 2]);
    expect(warn).toHaveBeenCalled();
  });

  it('subscriber entries are detached copies', () => {
    const log = new SessionLog();
    let received: SessionLogEntry | null = null;
    log.subscribeLog((event) => {
      if (event.kind === 'entry') received = event.entry;
    });
    appendUtterance(log, 'original');
    received!.content = 'tampered';
    expect(log.getLog()[0]!.content).toBe('original');
  });

  it('buffers for a slow async subscriber and preserves order', async () => {
    const log = new SessionLog();
    const seen: number[] = [];
    let release: (() => void) | null = null;

    log.subscribeLog(async (event) => {
      if (event.kind !== 'entry') return;
      seen.push(event.entry.seq);
      if (event.entry.seq === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });

    appendUtterance(log, 'a'); // starts the slow handling
    appendUtterance(log, 'b'); // buffered
    appendUtterance(log, 'c'); // buffered
    expect(seen).toEqual([1]);

    release!();
    await waitUntil(() => seen.length === 3);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('drops oldest events past the buffer bound and delivers one coalesced gap', async () => {
    const log = new SessionLog({ maxSubscriberBuffer: 2 });
    const events: SessionLogEvent[] = [];
    let release: (() => void) | null = null;

    log.subscribeLog(async (event) => {
      events.push(event);
      if (event.kind === 'entry' && event.entry.seq === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });

    appendUtterance(log, 'a'); // delivered, slow
    appendUtterance(log, 'b'); // buffered (1/2)
    appendUtterance(log, 'c'); // buffered (2/2)
    appendUtterance(log, 'd'); // overflows: drops b
    appendUtterance(log, 'e'); // overflows: drops c, coalesces into the gap

    release!();
    await waitUntil(() => events.length === 4);

    expect(events[0]).toEqual({ kind: 'entry', entry: expect.objectContaining({ seq: 1 }) });
    expect(events[1]).toEqual({ kind: 'gap', fromSeq: 2, toSeq: 3, dropped: 2 });
    expect(events[2]).toEqual({ kind: 'entry', entry: expect.objectContaining({ seq: 4 }) });
    expect(events[3]).toEqual({ kind: 'entry', entry: expect.objectContaining({ seq: 5 }) });
  });

  it('a subscriber added by a sync callback during an append receives that entry once', () => {
    const log = new SessionLog();
    appendUtterance(log, 'earlier');

    const received: number[] = [];
    let added = false;
    log.subscribeLog(() => {
      if (added) return;
      added = true;
      // Subscribing mid-emit with replay: the new subscriber must get the
      // in-flight entry from replay only, never a second live copy.
      log.subscribeLog((event) => {
        if (event.kind === 'entry') received.push(event.entry.seq);
      }, 1);
    });

    appendUtterance(log, 'during emit');
    expect(received).toEqual([1, 2]);

    // Later appends reach the new subscriber normally.
    appendUtterance(log, 'after emit');
    expect(received).toEqual([1, 2, 3]);
  });

  it('a subscriber added by a sync callback during an append, without fromSeq, starts after the in-flight entry', () => {
    const log = new SessionLog();
    const received: number[] = [];
    let added = false;
    log.subscribeLog(() => {
      if (added) return;
      added = true;
      // No replay position means live from here, and "here" excludes the
      // in-flight entry: the emit snapshots the subscriber set before
      // callbacks run. A subscriber that wants the in-flight entry passes
      // fromSeq (previous test).
      log.subscribeLog((event) => {
        if (event.kind === 'entry') received.push(event.entry.seq);
      });
    });

    appendUtterance(log, 'in flight');
    expect(received).toEqual([]);

    appendUtterance(log, 'after');
    expect(received).toEqual([2]);
  });

  it('slowness in one subscriber never delays a fast peer', () => {
    const log = new SessionLog();
    const fastSeen: number[] = [];
    log.subscribeLog(async () => {
      await new Promise<void>(() => {}); // never settles
    });
    log.subscribeLog((event) => {
      if (event.kind === 'entry') fastSeen.push(event.entry.seq);
    });

    appendUtterance(log, 'a');
    appendUtterance(log, 'b');
    expect(fastSeen).toEqual([1, 2]);
  });
});

describe('SessionLog: retention', () => {
  it('evicts oldest entries past maxEntries and reports them to onEvict', () => {
    const evicted: SessionLogEntry[] = [];
    const log = new SessionLog({
      maxEntries: 3,
      onEvict: (batch) => evicted.push(...batch),
    });

    for (let i = 0; i < 5; i += 1) appendUtterance(log, `u${i}`);

    expect(log.size).toBe(3);
    expect(log.getLog().map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(log.firstRetainedSeq).toBe(3);
    expect(evicted.map((e) => e.seq)).toEqual([1, 2]);
    // lastSeq keeps counting across eviction.
    expect(log.lastSeq).toBe(5);
  });

  it('an onEvict that throws does not fail the append', () => {
    const log = new SessionLog({
      maxEntries: 1,
      onEvict: () => {
        throw new Error('spill failed');
      },
    });
    expect(() => {
      appendUtterance(log, 'a');
      appendUtterance(log, 'b');
    }).not.toThrow();
    expect(log.getLog().map((e) => e.seq)).toEqual([2]);
  });

  it('replaying from an evicted range leads with a gap marker', () => {
    const log = new SessionLog({ maxEntries: 2 });
    for (let i = 0; i < 5; i += 1) appendUtterance(log, `u${i}`);

    const events: SessionLogEvent[] = [];
    log.subscribeLog((event) => events.push(event), 1);

    expect(events[0]).toEqual({ kind: 'gap', fromSeq: 1, toSeq: 3, dropped: 3 });
    expect(events.slice(1)).toEqual([
      { kind: 'entry', entry: expect.objectContaining({ seq: 4 }) },
      { kind: 'entry', entry: expect.objectContaining({ seq: 5 }) },
    ]);
  });

  it('replay from a fully retained range has no gap marker', () => {
    const log = new SessionLog({ maxEntries: 10 });
    for (let i = 0; i < 3; i += 1) appendUtterance(log, `u${i}`);
    const events: SessionLogEvent[] = [];
    log.subscribeLog((event) => events.push(event), 2);
    expect(events.every((e) => e.kind === 'entry')).toBe(true);
    expect(events).toHaveLength(2);
  });
});

describe('SessionLog: retention protects conversation over churn', () => {
  function appendChurn(log: SessionLog, content: string): SessionLogEntry {
    return log.append({ type: 'lifecycle', loopPath: 'reasoner', content });
  }

  it('evicts task churn while the conversation that generated it survives', () => {
    const log = new SessionLog({ maxEntries: 4 });

    appendUtterance(log, 'fix the flaky test');
    log.append({ type: 'reply', loopPath: 'talker', content: 'on it' });
    // A busy task fleet: churn at machine frequency.
    for (let i = 0; i < 8; i += 1) appendChurn(log, `task-event-${i}`);

    // Pre-fix this is ['task-event-4' .. 'task-event-7']: the conversation
    // is gone and only the churn that displaced it remains.
    const kept = log.getLog();
    expect(kept.map((e) => e.content)).toEqual([
      'fix the flaky test',
      'on it',
      'task-event-6',
      'task-event-7',
    ]);
    expect(log.size).toBe(4);
  });

  it('protects asks, answers, and errors alongside utterances and replies', () => {
    const log = new SessionLog({ maxEntries: 5 });
    log.append({ type: 'ask', loopPath: 'reasoner', content: 'may I run rm?' });
    log.append({ type: 'ask_answer', loopPath: 'talker', content: 'no' });
    log.append({ type: 'error', loopPath: 'reasoner', content: 'auth failed' });
    for (const type of ['delivery', 'directive', 'lookup_result', 'retrying'] as const) {
      log.append({ type, loopPath: 'reasoner', content: `churn-${type}` });
    }
    appendUtterance(log, 'what happened?');

    expect(log.getLog().map((e) => e.type)).toEqual([
      'ask', 'ask_answer', 'error', 'retrying', 'utterance',
    ]);
  });

  it('falls back to oldest-first over conversation once churn is exhausted', () => {
    const log = new SessionLog({ maxEntries: 2 });
    appendUtterance(log, 'u1');
    appendUtterance(log, 'u2');
    appendUtterance(log, 'u3');
    expect(log.getLog().map((e) => e.content)).toEqual(['u2', 'u3']);
  });

  it('spills evicted churn through onEvict in seq order', () => {
    const evicted: SessionLogEntry[] = [];
    const log = new SessionLog({ maxEntries: 2, onEvict: (batch) => evicted.push(...batch) });
    appendChurn(log, 'c1');
    appendUtterance(log, 'u1');
    appendChurn(log, 'c2');
    appendChurn(log, 'c3');

    expect(log.getLog().map((e) => e.content)).toEqual(['u1', 'c3']);
    expect(evicted.map((e) => e.content)).toEqual(['c1', 'c2']);
  });

  it('announces interior holes to a replaying subscriber, not just the leading one', () => {
    const log = new SessionLog({ maxEntries: 3 });
    appendUtterance(log, 'u1');   // seq 1, durable
    appendChurn(log, 'c2');       // seq 2, evicted
    appendUtterance(log, 'u3');   // seq 3, durable
    appendChurn(log, 'c4');       // seq 4, evicted
    appendUtterance(log, 'u5');   // seq 5, durable

    expect(log.getLog().map((e) => e.seq)).toEqual([1, 3, 5]);

    const events: SessionLogEvent[] = [];
    log.subscribeLog((event) => events.push(event), 1);

    // A hole between every retained entry, each one reported.
    expect(events).toEqual([
      { kind: 'entry', entry: expect.objectContaining({ seq: 1 }) },
      { kind: 'gap', fromSeq: 2, toSeq: 2, dropped: 1 },
      { kind: 'entry', entry: expect.objectContaining({ seq: 3 }) },
      { kind: 'gap', fromSeq: 4, toSeq: 4, dropped: 1 },
      { kind: 'entry', entry: expect.objectContaining({ seq: 5 }) },
    ]);
  });

  it('announces a trailing hole when the newest entries were the churn evicted', () => {
    const log = new SessionLog({ maxEntries: 2 });
    appendUtterance(log, 'u1');
    appendUtterance(log, 'u2');
    appendChurn(log, 'c3');

    expect(log.getLog().map((e) => e.seq)).toEqual([1, 2]);

    const events: SessionLogEvent[] = [];
    log.subscribeLog((event) => events.push(event), 1);
    expect(events[events.length - 1]).toEqual({
      kind: 'gap', fromSeq: 3, toSeq: 3, dropped: 1,
    });
  });

  /** A log with holes in the middle and at the end. */
  function holedLog(): SessionLog {
    const log = new SessionLog({ maxEntries: 3 });
    appendUtterance(log, 'u1');   // seq 1, kept
    appendChurn(log, 'c2');       // seq 2, evicted
    appendUtterance(log, 'u3');   // seq 3, kept
    appendChurn(log, 'c4');       // seq 4, evicted
    appendUtterance(log, 'u5');   // seq 5, kept
    appendChurn(log, 'c6');       // seq 6, evicted (trailing hole)
    return log;
  }

  it('getLogEvents reports the same holes the subscription replays', () => {
    const log = holedLog();
    expect(log.getLog().map((e) => e.seq)).toEqual([1, 3, 5]);

    const replayed: SessionLogEvent[] = [];
    log.subscribeLog((event) => replayed.push(event), 1);

    // Asserted against each other, not against a hand-written list: the
    // defect was the two surfaces disagreeing, so the test is the equality.
    expect(log.getLogEvents(1)).toEqual(replayed);
    expect(log.getLogEvents()).toEqual(replayed);
  });

  it('getLogEvents interleaves gaps with entries in seq order, trailing hole included', () => {
    const log = holedLog();
    expect(log.getLogEvents(1)).toEqual([
      { kind: 'entry', entry: expect.objectContaining({ seq: 1 }) },
      { kind: 'gap', fromSeq: 2, toSeq: 2, dropped: 1 },
      { kind: 'entry', entry: expect.objectContaining({ seq: 3 }) },
      { kind: 'gap', fromSeq: 4, toSeq: 4, dropped: 1 },
      { kind: 'entry', entry: expect.objectContaining({ seq: 5 }) },
      { kind: 'gap', fromSeq: 6, toSeq: 6, dropped: 1 },
    ]);
  });

  it('getLogEvents honors fromSeq and returns detached entry copies', () => {
    const log = holedLog();
    expect(log.getLogEvents(3)).toEqual([
      { kind: 'entry', entry: expect.objectContaining({ seq: 3 }) },
      { kind: 'gap', fromSeq: 4, toSeq: 4, dropped: 1 },
      { kind: 'entry', entry: expect.objectContaining({ seq: 5 }) },
      { kind: 'gap', fromSeq: 6, toSeq: 6, dropped: 1 },
    ]);

    const events = log.getLogEvents(1);
    const first = events[0]!;
    if (first.kind !== 'entry') throw new Error('expected an entry');
    first.entry.content = 'tampered';
    expect(log.getLog()[0]!.content).toBe('u1');
  });

  it('getLogEvents on a contiguous log is entries and nothing else', () => {
    const log = new SessionLog({ maxEntries: 10 });
    appendUtterance(log, 'a');
    appendUtterance(log, 'b');
    expect(log.getLogEvents(1).every((e) => e.kind === 'entry')).toBe(true);
    expect(log.getLogEvents(1)).toHaveLength(2);
  });

  it('a reset carries the holes in the log it restored', () => {
    const log = new SessionLog({ maxEntries: 2 });
    let reset: SessionLogReset | null = null;
    log.subscribeLog((event) => { if (event.kind === 'reset') reset = event; });

    // A persisted artifact that already had churn evicted from it, over cap
    // so the restore opens one more hole on the way in.
    log.restore([
      { seq: 1, type: 'utterance', timestamp: 1, loopPath: 'main', content: 'u1' },
      { seq: 3, type: 'lifecycle', timestamp: 3, loopPath: 'main', content: 'c3' },
      { seq: 5, type: 'reply', timestamp: 5, loopPath: 'main', content: 'r5' },
    ]);

    if (reset === null) throw new Error('expected a reset event');
    const delivered = reset as SessionLogReset;
    expect(delivered.entries.map((e) => e.seq)).toEqual([1, 5]);
    // Same holes the other two surfaces report over the same log.
    expect(delivered.gaps).toEqual(
      log.getLogEvents(log.firstRetainedSeq).filter((e) => e.kind === 'gap'),
    );
    expect(delivered.gaps).toEqual([{ kind: 'gap', fromSeq: 2, toSeq: 4, dropped: 3 }]);
  });

  it('a reset over a contiguous restore carries no gaps', () => {
    const log = new SessionLog();
    let reset: SessionLogReset | null = null;
    log.subscribeLog((event) => { if (event.kind === 'reset') reset = event; });
    log.restore([
      { seq: 1, type: 'utterance', timestamp: 1, loopPath: 'main', content: 'a' },
      { seq: 2, type: 'reply', timestamp: 2, loopPath: 'main', content: 'b' },
    ]);
    if (reset === null) throw new Error('expected a reset event');
    expect((reset as SessionLogReset).gaps).toEqual([]);
  });

  it('lastSeq is the seq space bound; newestRetainedSeq is the newest entry held', () => {
    // Churn-first eviction can take the NEWEST entry, so these two differ
    // with no restore involved. lastSeq naming an evicted entry is correct
    // for its job (bounding the trailing hole) and wrong for any reader
    // that wants "the newest thing I hold".
    const log = new SessionLog({ maxEntries: 5 });
    for (let i = 1; i <= 5; i += 1) appendUtterance(log, `u${i}`);
    appendChurn(log, 'c6');

    expect(log.getLog().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(log.lastSeq).toBe(6);
    expect(log.newestRetainedSeq).toBe(5);
    expect(log.newestRetainedSeq).toBe(log.getLog().at(-1)!.seq);
  });

  it('newestRetainedSeq is 0 on an empty log', () => {
    const log = new SessionLog();
    expect(log.newestRetainedSeq).toBe(0);
    appendUtterance(log, 'a');
    log.restore([]);
    expect(log.newestRetainedSeq).toBe(0);
  });

  it('an over-cap restore uses the same churn-first policy', () => {
    const log = new SessionLog({ maxEntries: 2 });
    log.restore([
      { seq: 1, type: 'utterance', timestamp: 1, loopPath: 'main', content: 'u1' },
      { seq: 2, type: 'lifecycle', timestamp: 2, loopPath: 'main', content: 'c2' },
      { seq: 3, type: 'delivery', timestamp: 3, loopPath: 'main', content: 'd3' },
      { seq: 4, type: 'reply', timestamp: 4, loopPath: 'main', content: 'r4' },
    ]);
    expect(log.getLog().map((e) => e.content)).toEqual(['u1', 'r4']);
  });
});

describe('SessionLog: restore', () => {
  it('replaces contents and resumes seq numbering after the restored max', () => {
    const log = new SessionLog();
    appendUtterance(log, 'pre-restore');

    const artifact: SessionLogEntry[] = [
      { seq: 7, type: 'utterance', timestamp: 1, loopPath: 'main', content: 'a' },
      { seq: 9, type: 'reply', timestamp: 2, loopPath: 'main', content: 'b', causedBy: 7 },
    ];
    log.restore(artifact);

    expect(log.getLog().map((e) => e.seq)).toEqual([7, 9]);
    const next = appendUtterance(log, 'post-restore');
    expect(next.seq).toBe(10);
  });

  it('restore detaches from the caller array and sorts by seq', () => {
    const log = new SessionLog();
    const artifact: SessionLogEntry[] = [
      { seq: 3, type: 'reply', timestamp: 2, loopPath: 'main', content: 'b' },
      { seq: 1, type: 'utterance', timestamp: 1, loopPath: 'main', content: 'a' },
    ];
    log.restore(artifact);
    artifact[0]!.content = 'tampered';
    artifact.length = 0;

    expect(log.getLog().map((e) => [e.seq, e.content])).toEqual([[1, 'a'], [3, 'b']]);
  });

  it('an over-cap restore trims to retention without spilling through onEvict', () => {
    const onEvict = vi.fn();
    const log = new SessionLog({ maxEntries: 2, onEvict });
    const entries = Array.from({ length: 4 }, (_, i) => ({
      seq: i + 1,
      type: 'utterance' as const,
      timestamp: i + 1,
      loopPath: 'main',
      content: `u${i + 1}`,
    }));

    // Restored entries came FROM the persistence artifact; spilling the
    // overflow back through onEvict would re-persist them on every restore.
    log.restore(entries);
    log.restore(entries);
    expect(onEvict).not.toHaveBeenCalled();
    expect(log.size).toBe(2);
    expect(log.getLog().map((e) => e.seq)).toEqual([3, 4]);

    // Live appends still evict and spill normally afterwards.
    appendUtterance(log, 'live');
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict.mock.calls[0]![0].map((e: SessionLogEntry) => e.seq)).toEqual([3]);
  });

  it('an empty restore resets contents but never rewinds seq numbering', () => {
    const log = new SessionLog();
    appendUtterance(log, 'a');
    appendUtterance(log, 'b');
    log.restore([]);
    expect(log.getLog()).toEqual([]);
    expect(appendUtterance(log, 'c').seq).toBe(3);
  });
});

describe('SessionLog: restore notifies subscribers', () => {
  /**
   * The symptom, not the internal state change: a UI subscribed before the
   * restore renders the replaced session and has no way to know.
   */
  function renderingSubscriber(log: SessionLog): { rendered: () => string[] } {
    let view: SessionLogEntry[] = [];
    log.subscribeLog((event) => {
      if (event.kind === 'reset') view = [...event.entries];
      else if (event.kind === 'entry') view.push(event.entry);
    });
    return { rendered: () => view.map((e) => e.content) };
  }

  it('a subscriber attached before a restore ends up rendering the restored log', () => {
    const log = new SessionLog();
    appendUtterance(log, 'old-1');
    appendUtterance(log, 'old-2');

    const ui = renderingSubscriber(log);
    appendUtterance(log, 'old-3');
    expect(ui.rendered()).toEqual(['old-3']);

    log.restore([
      { seq: 40, type: 'utterance', timestamp: 1, loopPath: 'main', content: 'restored-1' },
      { seq: 41, type: 'reply', timestamp: 2, loopPath: 'main', content: 'restored-2' },
    ]);

    // Pre-fix this still reads ['old-3']: the replaced session, forever.
    expect(ui.rendered()).toEqual(['restored-1', 'restored-2']);

    appendUtterance(log, 'after');
    expect(ui.rendered()).toEqual(['restored-1', 'restored-2', 'after']);
    expect(ui.rendered()).toEqual(log.getLog().map((e) => e.content));
  });

  it('the reset carries the restored log and detached entry copies', () => {
    const log = new SessionLog();
    const events: SessionLogEvent[] = [];
    log.subscribeLog((event) => events.push(event));

    log.restore([
      { seq: 7, type: 'utterance', timestamp: 1, loopPath: 'main', content: 'a', data: { n: 1 } },
      { seq: 9, type: 'reply', timestamp: 2, loopPath: 'main', content: 'b' },
    ]);

    expect(events).toHaveLength(1);
    const reset = events[0]!;
    if (reset.kind !== 'reset') throw new Error('expected a reset event');
    // The payload is the log, asserted against the log rather than against
    // a hand-computed expectation.
    expect(reset.entries).toEqual(log.getLog());
    expect(reset.entries.map((e) => e.seq)).toEqual([7, 9]);

    // Detached: mutating the delivered copy cannot reach the log.
    reset.entries[0]!.content = 'tampered';
    (reset.entries[0]!.data as { n: number }).n = 99;
    expect(log.getLog()[0]!.content).toBe('a');
    expect(log.getLog()[0]!.data).toEqual({ n: 1 });
  });

  it('an empty restore still tells subscribers the session is gone', () => {
    const log = new SessionLog();
    appendUtterance(log, 'a');
    const ui = renderingSubscriber(log);
    appendUtterance(log, 'b');

    log.restore([]);

    expect(ui.rendered()).toEqual([]);
  });

  /**
   * The reset's seq field is a resume cursor, so it is tested by resuming,
   * not by comparing it to a number the test worked out for itself. A
   * hand-computed expectation is exactly how the field it replaced went
   * wrong: read off the counter, checked against the counter, and described
   * as something else entirely.
   */
  function reconnectAfterReset(
    log: SessionLog,
    reset: SessionLogEvent,
  ): SessionLogEntry[] {
    if (reset.kind !== 'reset') throw new Error('expected a reset event');
    const resumed: SessionLogEntry[] = [];
    log.subscribeLog((event) => {
      if (event.kind === 'entry') resumed.push(event.entry);
    }, reset.nextSeq);
    return resumed;
  }

  it('reconnecting at reset.nextSeq resumes with no gap and no repeat', () => {
    const log = new SessionLog();
    appendUtterance(log, 'pre-1');
    appendUtterance(log, 'pre-2');

    let reset: SessionLogEvent | null = null;
    log.subscribeLog((event) => { if (event.kind === 'reset') reset = event; });

    // The probe case: a live log at seq 2 restoring an artifact that ends
    // BELOW it. Seq numbering does not rewind, so a cursor derived from the
    // restored entries would sit far below the next append.
    log.restore([
      { seq: 1, type: 'utterance', timestamp: 1, loopPath: 'main', content: 'restored-1' },
    ]);
    const after = appendUtterance(log, 'after-restore');

    const resumed = reconnectAfterReset(log, reset!);
    expect(resumed.map((e) => e.content)).toEqual(['after-restore']);
    expect(resumed.map((e) => e.seq)).toEqual([after.seq]);
  });

  it('reconnecting at reset.nextSeq works after an empty v1-shaped restore', () => {
    // cortex-code's /resume takes this path on every resume: a v1 artifact
    // restores an empty log into a session that has already appended.
    const log = new SessionLog();
    appendUtterance(log, 'pre-1');
    appendUtterance(log, 'pre-2');
    appendUtterance(log, 'pre-3');

    let reset: SessionLogEvent | null = null;
    log.subscribeLog((event) => { if (event.kind === 'reset') reset = event; });

    log.restore([]);
    const first = appendUtterance(log, 'first-after-resume');

    const resumed = reconnectAfterReset(log, reset!);
    // The defect this pins: the reset used to report a range naming the
    // pre-restore entries it had just discarded, so a UI storing it as a
    // watermark reconnected past everything and rendered an empty timeline.
    expect(resumed.map((e) => e.content)).toEqual(['first-after-resume']);
    expect(resumed.map((e) => e.seq)).toEqual([first.seq]);
  });

  it('reconnecting at reset.nextSeq before any later append yields nothing, not a gap', () => {
    const log = new SessionLog();
    appendUtterance(log, 'pre');
    let reset: SessionLogEvent | null = null;
    log.subscribeLog((event) => { if (event.kind === 'reset') reset = event; });
    log.restore([
      { seq: 1, type: 'utterance', timestamp: 1, loopPath: 'main', content: 'restored' },
    ]);

    if (reset === null) throw new Error('expected a reset event');
    // Asserted before it is used: passing undefined to subscribeLog means
    // "live from here", which would make this pass with no cursor at all.
    expect(typeof (reset as SessionLogReset).nextSeq).toBe('number');
    const events: SessionLogEvent[] = [];
    log.subscribeLog((event) => events.push(event), (reset as SessionLogReset).nextSeq);
    expect(events).toEqual([]);
  });

  it('the whole restored log plus everything after it reconstructs the session', () => {
    const log = new SessionLog();
    appendUtterance(log, 'pre');

    let reset: SessionLogReset | null = null;
    log.subscribeLog((event) => { if (event.kind === 'reset') reset = event; });
    log.restore([
      { seq: 3, type: 'utterance', timestamp: 1, loopPath: 'main', content: 'r-1' },
      { seq: 4, type: 'reply', timestamp: 2, loopPath: 'main', content: 'r-2' },
    ]);
    appendUtterance(log, 'later');

    if (reset === null) throw new Error('expected a reset event');
    const resumed = reconnectAfterReset(log, reset);
    // What a reconnecting UI ends up holding equals the log itself: the
    // reset's entries, then everything from its cursor onward.
    expect([...(reset as SessionLogReset).entries, ...resumed]).toEqual(log.getLog());
  });

  it('discards content queued before the restore rather than delivering it after', async () => {
    const log = new SessionLog();
    let release: (() => void) | null = null;
    const seen: SessionLogEvent[] = [];
    log.subscribeLog(async (event) => {
      seen.push(event);
      if (seen.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    });

    appendUtterance(log, 'blocking');
    await waitUntil(() => release !== null);
    // These queue behind the blocked callback and belong to the old session.
    appendUtterance(log, 'stale-1');
    appendUtterance(log, 'stale-2');

    log.restore([
      { seq: 60, type: 'utterance', timestamp: 1, loopPath: 'main', content: 'restored' },
    ]);
    release!();

    await waitUntil(() => seen.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.map((e) => e.kind)).toEqual(['entry', 'reset']);
    expect(seen.some((e) => e.kind === 'entry' && e.entry.content.startsWith('stale')))
      .toBe(false);
  });

  it('a slow subscriber cannot have the reset dropped by the buffer bound', async () => {
    const log = new SessionLog({ maxSubscriberBuffer: 2 });
    let release: (() => void) | null = null;
    const seen: SessionLogEvent[] = [];
    log.subscribeLog(async (event) => {
      seen.push(event);
      if (seen.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    });

    appendUtterance(log, 'blocking');
    await waitUntil(() => release !== null);
    log.restore([
      { seq: 80, type: 'utterance', timestamp: 1, loopPath: 'main', content: 'restored' },
    ]);
    // A burst well past the bound, all of it after the restore.
    for (let i = 0; i < 10; i += 1) appendUtterance(log, `burst-${i}`);
    release!();

    await waitUntil(() => seen.some((e) => e.kind === 'reset'));
    const reset = seen.find((e) => e.kind === 'reset')!;
    expect(reset).toMatchObject({ kind: 'reset' });
    // And it arrives before any post-restore entry, never after.
    const resetIdx = seen.indexOf(reset);
    const firstEntryAfter = seen.findIndex(
      (e, i) => i > 0 && e.kind === 'entry' && e.entry.content.startsWith('burst'),
    );
    expect(firstEntryAfter).toBeGreaterThan(resetIdx);
  });
});

describe('SessionLog: clearSubscribers', () => {
  it('drops every subscriber', () => {
    const log = new SessionLog();
    const seen: number[] = [];
    log.subscribeLog((event) => {
      if (event.kind === 'entry') seen.push(event.entry.seq);
    });
    log.clearSubscribers();
    appendUtterance(log, 'a');
    expect(seen).toEqual([]);
  });
});
