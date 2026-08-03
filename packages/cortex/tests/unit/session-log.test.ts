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

  it('an empty restore resets contents but never rewinds seq numbering', () => {
    const log = new SessionLog();
    appendUtterance(log, 'a');
    appendUtterance(log, 'b');
    log.restore([]);
    expect(log.getLog()).toEqual([]);
    expect(appendUtterance(log, 'c').seq).toBe(3);
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
