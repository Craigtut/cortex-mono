/**
 * SessionLog: the facade-owned, append-only record of a CortexAgent session.
 *
 * The log is the routing bus between loops, the wake policy's input, the
 * consumer's persistence artifact, and the audit trail of the session
 * (docs/cortex/duplex/log-and-context.md). It is NOT a context surface: no
 * loop's prompt is ever built by projecting log entries into synthetic
 * messages (decisions.md D7). Content reaches models through the loop's
 * deliver() primitive or view injection; the log only records.
 *
 * Headlines (moment-to-moment task activity) are explicitly not entries:
 * they are facade state rebuilt per turn and would grow the log at
 * tool-call frequency. Durable milestones are `lifecycle` entries.
 */

import type { CortexLogger } from './types.js';
import { NOOP_LOGGER } from './noop-logger.js';

// ---------------------------------------------------------------------------
// Entry types
// ---------------------------------------------------------------------------

/**
 * The session log entry vocabulary (docs/cortex/duplex/log-and-context.md).
 *
 * - `utterance`: consumer input, appended by the facade before it routes.
 * - `reply`: user-facing text a conversation-holding loop produced.
 * - `directive`: a talker control-tool dispatch (produced in duplex mode).
 * - `delivery`: reasoner output routed toward the conversation (duplex).
 * - `error`: a classified error surfaced by a loop's error handler.
 * - `retrying`: a scheduled background retry (transient failure).
 * - `lifecycle`: durable milestones: sub-agent spawns, completions,
 *   cancellations, dead-lettered deliveries, aborts.
 * - `ask` / `ask_answer`: permission asks brokered through conversation
 *   (produced in duplex mode; the types are part of the artifact contract).
 * - `lookup_result`: a quick-lookup sub-agent's result (duplex).
 *
 * The runtime array is the source of truth; the union derives from it so a
 * validator over the vocabulary (isCauseTag) can never drift from the type.
 */
export const SESSION_LOG_ENTRY_TYPES = [
  'utterance',
  'reply',
  'directive',
  'delivery',
  'error',
  'retrying',
  'lifecycle',
  'ask',
  'ask_answer',
  'lookup_result',
] as const;

export type SessionLogEntryType = (typeof SESSION_LOG_ENTRY_TYPES)[number];

/**
 * Wake policy vocabulary (decisions.md D10), stamped on entries destined for
 * a conversation loop: `interrupt` starts an unprompted turn now,
 * `when_idle` waits for a lull, `silent` surfaces only when relevant.
 */
export type WakeClass = 'interrupt' | 'when_idle' | 'silent';

/**
 * One session log entry. Entries are immutable once appended; every read
 * surface returns copies, never live references.
 */
export interface SessionLogEntry {
  /**
   * Monotonic sequence number, unique within the session. The ordering
   * authority: timestamps collide under burst, seq never does.
   */
  seq: number;
  /** Entry type (see {@link SessionLogEntryType}). */
  type: SessionLogEntryType;
  /** Epoch ms when the entry was appended. */
  timestamp: number;
  /** Path identity of the loop (or facade surface) that produced the entry. */
  loopPath: string;
  /** The entry's text payload. */
  content: string;
  /**
   * Causation stamp: the seq of the entry that caused this one, present on
   * entries produced by a facade-initiated run (a reply to an utterance, a
   * lifecycle event of a spawn made during a run). Load-bearing for D16
   * consent binding in duplex mode, not just observability, which is why it
   * is part of the schema from the first assembly.
   */
  causedBy?: number;
  /** Wake class, for entries routed toward a conversation loop. */
  wake?: WakeClass;
  /** Structured per-type payload (task ids, ask ids, statuses, categories). */
  data?: Record<string, unknown>;
}

/** Input to {@link SessionLog.append}: everything but the seq and timestamp. */
export interface SessionLogAppendInput {
  type: SessionLogEntryType;
  loopPath: string;
  content: string;
  causedBy?: number;
  wake?: WakeClass;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Subscription events
// ---------------------------------------------------------------------------

/**
 * Marker delivered to a subscriber in place of entries it will never see:
 * either entries evicted by retention before its replay position, or
 * entries dropped because the subscriber fell behind its buffer bound.
 */
export interface SessionLogGap {
  kind: 'gap';
  /** First seq in the dropped range. */
  fromSeq: number;
  /** Last seq in the dropped range. */
  toSeq: number;
  /** Number of entries dropped in the range. */
  dropped: number;
}

/**
 * Delivered when {@link SessionLog.restore} replaces the log wholesale. It
 * is not a gap: a gap says "you missed some entries", where a restore says
 * "the timeline you have been rendering is no longer this session". A
 * subscriber that treated one as the other would append restored entries
 * underneath stale ones.
 *
 * The event carries the restored log rather than telling the subscriber to
 * go read it, so the handoff is atomic. Re-reading through `getLog()` from
 * the callback would race any append landing between the two calls, and the
 * subscriber would render that entry twice.
 */
export interface SessionLogReset {
  kind: 'reset';
  /**
   * The restored log in full: every retained entry, oldest first.
   *
   * Retained, not contiguous. A restored artifact can arrive with holes
   * (it was persisted from a log that had already evicted churn) and the
   * cap can open more on the way in, so check {@link gaps} before
   * rendering this as an unbroken timeline.
   */
  entries: SessionLogEntry[];
  /**
   * Holes inside the restored range, in seq order, computed by the same
   * function that builds replay and {@link SessionLog.getLogEvents}. Empty
   * in the ordinary case.
   *
   * Precomputed rather than left to the consumer, who would otherwise have
   * to scan `entries` for seq discontinuity and would mostly not bother:
   * that is precisely the silent-holes rendering this field exists to
   * prevent. To render in order, merge the two by seq.
   */
  gaps: SessionLogGap[];
  /**
   * The seq the next appended entry will carry. Pass it to
   * {@link SessionLog.subscribeLog} to resume from exactly here: a later
   * reconnect gets everything appended after this reset and nothing it has
   * already been handed.
   *
   * This is the log's counter, and it is the counter that answers the
   * question. `restore()` never lowers it (appends stay monotonic across a
   * restore), so it is not "one past the newest restored entry" and must
   * not be described as one: restoring an artifact that ends at seq 2 into
   * a session that reached seq 5 resumes at 6, not at 3. An earlier version
   * of this event carried `lastSeq` and `firstRetainedSeq` read off the
   * same counter but documented as bounds of the restored entries, which
   * they were not: after an empty restore they named a range of entries
   * that had just been discarded, and a UI storing `lastSeq` as its
   * watermark reconnected above everything the reset had handed it and
   * silently rendered nothing.
   *
   * Bounds of the restored entries are deliberately not fields. `entries`
   * carries them exactly (`entries[0]`, `entries.at(-1)`), and a second
   * copy of a derivable fact is a second thing that can be wrong.
   */
  nextSeq: number;
}

/** What a subscriber receives: an entry, a gap marker, or a restore reset. */
export type SessionLogEvent =
  | { kind: 'entry'; entry: SessionLogEntry }
  | SessionLogGap
  | SessionLogReset;

/**
 * Subscriber callback. A synchronous callback is invoked inline at append
 * time (append-then-emit: the entry reaches subscribers before the events
 * of any run it triggers). A callback that returns a promise is awaited
 * before the next event is delivered; events arriving meanwhile are
 * buffered up to the configured bound and then dropped oldest-first with a
 * gap marker, never applying backpressure to the loops.
 */
export type SessionLogSubscriber = (event: SessionLogEvent) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SessionLogOptions {
  /**
   * Retention cap: the log keeps at most this many entries. The log is the
   * persistence artifact and never compacts, so without a cap it would
   * grow unboundedly in a long session. Default: 10000.
   *
   * Overflow comes off churn first and conversational history only once
   * churn is exhausted (see {@link DURABLE_ENTRY_TYPES}); the cap itself
   * still bounds the whole log.
   */
  maxEntries?: number;
  /**
   * Per-subscriber buffer bound for slow (async) subscribers. When a
   * subscriber's pending queue exceeds this, the oldest buffered events are
   * dropped and replaced with a gap marker. Default: 1000.
   */
  maxSubscriberBuffer?: number;
  /** Diagnostics logger. Default: silent. */
  logger?: CortexLogger;
  /**
   * Called with entries evicted by the retention cap, so an owner can spill
   * them to durable storage before they leave memory. Errors are swallowed
   * (eviction must never fail the append that triggered it).
   *
   * **The spill is not monotonic across calls.** Eviction takes churn from
   * anywhere in the log, so a later call can hand over a lower seq than an
   * earlier one did: seq 500 goes out while a conversational seq 200 is
   * still held, and 200 follows once churn runs out. Each batch is ordered
   * internally, and every entry carries its own seq, so a reader that
   * sorts on ingest is fine. A reader that assumes append-order and treats
   * the spill as a growing tail is not.
   */
  onEvict?: (evicted: SessionLogEntry[]) => void;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_SUBSCRIBER_BUFFER = 1_000;

/**
 * Entry types retention protects: what a human would call the conversation,
 * plus the errors that explain it. These are evicted only once every
 * disposable entry is already gone.
 *
 * The rest is churn: `lifecycle`, `delivery`, `directive`, `lookup_result`,
 * and `retrying` are produced at machine frequency (a busy task fleet emits
 * spawn, completion, and delivery entries continuously), while a session
 * accumulates utterances at human frequency. A flat FIFO therefore lets an
 * hour of task chatter push out the first half of the conversation, which
 * inverts what a reader of the log actually wants back.
 *
 * `error` sits with the durable set rather than with churn: it is rare
 * enough that protecting it crowds out nothing, and it is the entry a
 * consumer most needs when reconstructing why a session went wrong.
 *
 * **The ask record is protected, the consent record is not, and that is
 * deliberate.** `ask` and `ask_answer` survive; the `ask_voiced` anchor the
 * D16 allow rule compares against is a `lifecycle` entry and is churn, so a
 * long session can retain the request and the answer while dropping the
 * voicing between them. Two reasons to leave it that way. The split is by
 * entry TYPE, and keeping one lifecycle subtype would mean reading `data`
 * inside the retention policy, turning a rule into a heuristic that the
 * next subtype has to argue with. And the log was never the consent
 * authority: D16 requires an audit to reconstruct from the live cause-tag
 * set precisely because a single `causedBy` cannot express multi-cause, so
 * promoting the anchor would buy a more complete narrative, not a sounder
 * check. What the durable set claims is the conversational record, not a
 * replayable consent trail. Making the anchor durable properly means
 * promoting `ask_voiced` to a real entry type, which is a persisted-artifact
 * vocabulary change (the cause-tag kind union reuses this type) and wants
 * its own decision.
 */
const DURABLE_ENTRY_TYPES: ReadonlySet<SessionLogEntryType> = new Set<SessionLogEntryType>([
  'utterance',
  'reply',
  'ask',
  'ask_answer',
  'error',
]);

// ---------------------------------------------------------------------------
// Subscriber state
// ---------------------------------------------------------------------------

interface SubscriberState {
  cb: SessionLogSubscriber;
  /** Events not yet delivered (drained in order). */
  queue: SessionLogEvent[];
  /** Coalesced drop range awaiting delivery ahead of the queue. */
  pendingGap: { fromSeq: number; toSeq: number; dropped: number } | null;
  /**
   * Restore notification awaiting delivery, held outside the queue so the
   * buffer bound can never drop it. A subscriber that missed this and then
   * received post-restore entries would splice a new session onto an old
   * one, which is worse than the staleness the event exists to prevent.
   */
  pendingReset: SessionLogReset | null;
  /** True while the drain loop is running (sync or awaiting a slow cb). */
  draining: boolean;
  unsubscribed: boolean;
}

// ---------------------------------------------------------------------------
// SessionLog
// ---------------------------------------------------------------------------

export class SessionLog {
  private entries: SessionLogEntry[] = [];
  private nextSeq = 1;
  private readonly maxEntries: number;
  private readonly maxSubscriberBuffer: number;
  private readonly logger: CortexLogger;
  private readonly onEvict: ((evicted: SessionLogEntry[]) => void) | undefined;
  private readonly subscribers = new Set<SubscriberState>();

  constructor(options?: SessionLogOptions) {
    this.maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxSubscriberBuffer = Math.max(
      1,
      options?.maxSubscriberBuffer ?? DEFAULT_MAX_SUBSCRIBER_BUFFER,
    );
    this.logger = options?.logger ?? NOOP_LOGGER;
    this.onEvict = options?.onEvict;
  }

  /**
   * Highest seq ever issued in this session; 0 before the first append.
   *
   * **Not** the newest entry the log holds, and the difference is not a
   * corner case: churn-first retention can evict the newest entry, so a log
   * holding seqs 1 to 5 can report a `lastSeq` of 6. Use it as the upper
   * bound of the seq space (which is what makes a trailing hole detectable)
   * and {@link newestRetainedSeq} for the newest entry actually held.
   */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /**
   * Seq of the newest entry still retained, or 0 when the log is empty.
   * Cheap: the alternative is `getLog().at(-1)?.seq`, which copies the
   * whole log to read one number.
   */
  get newestRetainedSeq(): number {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1]!.seq : 0;
  }

  /**
   * Seq of the oldest entry still retained. When eviction has run, seqs
   * below this exist only wherever the onEvict spill put them. Equals
   * nextSeq when the log is empty.
   *
   * Not a promise of contiguity above it: retention evicts churn before
   * conversation, so seqs above this one can be missing too. Replay
   * announces every hole; do not derive one from this value alone.
   */
  get firstRetainedSeq(): number {
    return this.entries.length > 0 ? this.entries[0]!.seq : this.nextSeq;
  }

  /** Number of retained entries. */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Append an entry: stamp seq and timestamp, retain, then emit to
   * subscribers. Synchronous subscribers observe the entry before this
   * method returns, which is what makes append-then-emit ordering hold for
   * an owner that appends and then starts the run the entry describes.
   */
  append(input: SessionLogAppendInput): SessionLogEntry {
    const entry: SessionLogEntry = {
      seq: this.nextSeq,
      type: input.type,
      timestamp: Date.now(),
      loopPath: input.loopPath,
      content: input.content,
    };
    this.nextSeq += 1;
    if (input.causedBy !== undefined) entry.causedBy = input.causedBy;
    if (input.wake !== undefined) entry.wake = input.wake;
    if (input.data !== undefined) entry.data = { ...input.data };

    this.entries.push(entry);
    this.applyRetention();

    // Snapshot the subscriber set: a sync callback may subscribe during
    // this emit, and iterating the live set would hand the new subscriber
    // this entry a second time (replay already delivered it).
    for (const sub of [...this.subscribers]) {
      this.pushToSubscriber(sub, { kind: 'entry', entry: cloneEntry(entry) });
      this.drain(sub);
    }
    return cloneEntry(entry);
  }

  /**
   * Snapshot copy of retained entries with seq >= fromSeq (all retained
   * entries when omitted). Never a live reference: the array and each entry
   * are copies, so a caller cannot corrupt the log and the log cannot
   * mutate under the caller.
   *
   * **Entries only: this does not report holes.** Retention evicts churn
   * before conversation, so a snapshot can be missing entries from the
   * middle or the end of its range and nothing in the array says so. A
   * surface that renders a timeline should use {@link getLogEvents}, which
   * returns exactly what {@link subscribeLog} would replay. This stays for
   * callers that want the entries and nothing else.
   */
  getLog(fromSeq?: number): SessionLogEntry[] {
    const from = fromSeq ?? 0;
    const startIdx = this.entries.findIndex((entry) => entry.seq >= from);
    if (startIdx === -1) return [];
    return this.entries.slice(startIdx).map(cloneEntry);
  }

  /**
   * Snapshot of the log as an event sequence: the retained entries with
   * seq >= fromSeq, interleaved with gap markers for every hole in the
   * range, in seq order.
   *
   * This is the snapshot counterpart of {@link subscribeLog}'s replay and
   * is built by the same function, so the two cannot disagree about where
   * the holes are. Use it wherever a subscription would render a timeline
   * but a one-shot read is what you have.
   */
  getLogEvents(fromSeq?: number): SessionLogEvent[] {
    return this.buildReplayEvents(fromSeq ?? 1);
  }

  /**
   * Subscribe to log events with replay: retained entries with
   * seq >= fromSeq are delivered first (behind a gap marker when the range
   * reaches below retention), then live appends in order. Returns an
   * idempotent unsubscribe function. Subscriber exceptions are logged and
   * swallowed; a throwing subscriber never breaks the log or its peers.
   *
   * Without fromSeq the subscription is live from here, and "here" excludes
   * an append currently emitting: the emit snapshots the subscriber set
   * before callbacks run, so a subscription made by a sync subscriber
   * callback starts at the NEXT append. Pass fromSeq to include the
   * in-flight entry (replay covers it exactly once).
   */
  subscribeLog(cb: SessionLogSubscriber, fromSeq?: number): () => void {
    const sub: SubscriberState = {
      cb,
      queue: [],
      pendingGap: null,
      pendingReset: null,
      draining: false,
      unsubscribed: false,
    };

    if (fromSeq !== undefined) {
      for (const event of this.buildReplayEvents(Math.max(1, fromSeq))) {
        this.pushToSubscriber(sub, event);
      }
    }

    this.subscribers.add(sub);
    this.drain(sub);

    return () => {
      sub.unsubscribed = true;
      this.subscribers.delete(sub);
    };
  }

  /**
   * Replace the log wholesale from a persisted artifact. Sequence numbering
   * resumes after the highest restored seq so appends stay monotonic across
   * a restore. Entries are defensively copied and sorted by seq.
   *
   * Every live subscriber is handed a {@link SessionLogReset} carrying the
   * restored log, ahead of any later append. Without it a subscriber has no
   * way to notice the replacement short of polling, so a UI attached before
   * the restore would keep rendering a session that no longer exists.
   */
  restore(entries: SessionLogEntry[]): void {
    const restored = entries.map(cloneEntry).sort((a, b) => a.seq - b.seq);
    // The retention cap applies on restore too, under the same churn-first
    // policy as a live append, but WITHOUT the onEvict spill: these entries
    // came from the persistence artifact, so spilling the overflow back
    // through persistResult would re-persist the same entries on every
    // restore.
    this.entries = selectUnderCap(restored, this.maxEntries).kept;
    const maxSeq = restored.length > 0 ? restored[restored.length - 1]!.seq : 0;
    this.nextSeq = Math.max(this.nextSeq, maxSeq + 1);

    const nextSeq = this.nextSeq;
    // Holes computed once from the same builder replay and getLogEvents
    // use, so the three descriptions of this log cannot diverge.
    const gaps = this.buildReplayEvents(this.firstRetainedSeq)
      .filter((event): event is SessionLogGap => event.kind === 'gap');
    for (const sub of [...this.subscribers]) {
      // Anything already queued describes the replaced session, so it is
      // discarded rather than delivered after the reset.
      sub.queue.length = 0;
      sub.pendingGap = null;
      // One deep copy of the retained log per subscriber, inside this
      // frame. At the default 10,000-entry cap that is 10,000 clones per
      // subscriber (structuredClone on every `data`), so the cost of a
      // restore scales with maxEntries times subscriber count. Raising
      // maxEntries raises this too. Per-subscriber rather than one shared
      // array on purpose: subscribers must not be able to mutate each
      // other's view, and N is 1 or 2 in every shape we ship.
      sub.pendingReset = {
        kind: 'reset',
        entries: this.entries.map(cloneEntry),
        gaps: gaps.map((gap) => ({ ...gap })),
        nextSeq,
      };
      this.drain(sub);
    }
  }

  /** Drop every subscriber (owner teardown). Queued events are discarded. */
  clearSubscribers(): void {
    for (const sub of this.subscribers) {
      sub.unsubscribed = true;
    }
    this.subscribers.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The retained entries from `from` onward as an event sequence, with a
   * gap marker for every hole.
   *
   * The single definition of "what does this range look like", shared by
   * replay, {@link getLogEvents}, and the restore reset. Three surfaces
   * describing the same holes three times is how they end up disagreeing,
   * which they did: replay reported holes and the snapshot did not, so the
   * same session rendered honestly through a subscription and with silent
   * holes through a one-shot read.
   *
   * Holes exist because retention is churn-first, so the retained set is
   * not a contiguous suffix: seqs can be missing from the middle and from
   * the end. Seqs are contiguous over the session as a whole, so a missing
   * range of width n held exactly n entries and `dropped` is exact.
   *
   * The trailing hole is bounded by `lastSeq` (highest seq ever issued),
   * not by the newest retained entry: the newest entry is exactly what
   * churn-first eviction can take, and bounding by it would hide that.
   */
  private buildReplayEvents(from: number): SessionLogEvent[] {
    const events: SessionLogEvent[] = [];
    let expected = from;
    const announceGap = (toSeq: number): void => {
      if (toSeq < expected) return;
      events.push({ kind: 'gap', fromSeq: expected, toSeq, dropped: toSeq - expected + 1 });
    };
    for (const entry of this.entries) {
      if (entry.seq < from) continue;
      if (entry.seq > expected) announceGap(entry.seq - 1);
      events.push({ kind: 'entry', entry: cloneEntry(entry) });
      expected = entry.seq + 1;
    }
    announceGap(this.lastSeq);
    return events;
  }

  /**
   * Evict past the retention cap, churn before conversation, spilling via
   * onEvict. `maxEntries` still bounds the whole log exactly as before;
   * what changed is only which entries pay for the overflow.
   */
  private applyRetention(): void {
    if (this.entries.length <= this.maxEntries) return;
    const { kept, evicted } = selectUnderCap(this.entries, this.maxEntries);
    this.entries = kept;
    if (this.onEvict) {
      try {
        this.onEvict(evicted);
      } catch (err) {
        this.logger.warn('session log onEvict threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Buffer an event for a subscriber, dropping oldest-first into a
   * coalesced gap when the bound is exceeded.
   */
  private pushToSubscriber(sub: SubscriberState, event: SessionLogEvent): void {
    sub.queue.push(event);
    while (sub.queue.length > this.maxSubscriberBuffer) {
      const droppedEvent = sub.queue.shift()!;
      if (droppedEvent.kind === 'reset') {
        // Unreachable: a reset is held in pendingReset, never queued. Kept
        // as a total case so the union stays exhaustively handled.
        sub.pendingReset = droppedEvent;
      } else if (droppedEvent.kind === 'entry') {
        const seq = droppedEvent.entry.seq;
        if (sub.pendingGap) {
          sub.pendingGap.toSeq = seq;
          sub.pendingGap.dropped += 1;
        } else {
          sub.pendingGap = { fromSeq: seq, toSeq: seq, dropped: 1 };
        }
      } else if (sub.pendingGap) {
        sub.pendingGap.fromSeq = Math.min(sub.pendingGap.fromSeq, droppedEvent.fromSeq);
        sub.pendingGap.toSeq = Math.max(sub.pendingGap.toSeq, droppedEvent.toSeq);
        sub.pendingGap.dropped += droppedEvent.dropped;
      } else {
        sub.pendingGap = {
          fromSeq: droppedEvent.fromSeq,
          toSeq: droppedEvent.toSeq,
          dropped: droppedEvent.dropped,
        };
      }
    }
  }

  /**
   * Deliver a subscriber's pending events in order. Runs synchronously
   * until the callback returns a promise, then continues asynchronously;
   * at most one drain runs per subscriber at a time.
   */
  private drain(sub: SubscriberState): void {
    if (sub.draining) return;
    sub.draining = true;
    while (!sub.unsubscribed) {
      const event = this.takeNext(sub);
      if (!event) break;
      let result: void | Promise<void>;
      try {
        result = sub.cb(event);
      } catch (err) {
        this.logger.warn('session log subscriber threw', {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (result && typeof (result as Promise<void>).then === 'function') {
        // Slow subscriber: the drain continues once the callback settles.
        // The draining flag stays set until then, so appends made in the
        // meantime only buffer (bounded by pushToSubscriber) and a second
        // concurrent drain can never start.
        void (result as Promise<void>)
          .catch((err) => {
            this.logger.warn('session log subscriber rejected', {
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .then(() => {
            sub.draining = false;
            this.drain(sub);
          });
        return;
      }
    }
    sub.draining = false;
  }

  /**
   * Next event for a subscriber: a pending restore first (it supersedes
   * everything older), then a coalesced gap, then the queue.
   */
  private takeNext(sub: SubscriberState): SessionLogEvent | null {
    if (sub.pendingReset) {
      const reset = sub.pendingReset;
      sub.pendingReset = null;
      return reset;
    }
    if (sub.pendingGap) {
      const gap = sub.pendingGap;
      sub.pendingGap = null;
      return { kind: 'gap', ...gap };
    }
    return sub.queue.shift() ?? null;
  }
}

/**
 * Detached copy of an entry. `data` is deep-copied: a shallow copy would
 * share nested objects, letting a caller mutate the log (or the log mutate
 * under a caller) through them, breaking the never-a-live-reference
 * contract every read surface promises.
 */
function cloneEntry(entry: SessionLogEntry): SessionLogEntry {
  const copy: SessionLogEntry = { ...entry };
  if (entry.data !== undefined) copy.data = structuredClone(entry.data);
  return copy;
}

/**
 * Split entries into what fits under `cap` and what has to go, dropping
 * churn oldest-first and only then falling back to durable entries
 * oldest-first (see {@link DURABLE_ENTRY_TYPES}). Both halves stay in seq
 * order, so the kept array remains sorted and a spill arrives in the order
 * the entries were written.
 *
 * Live appends and over-cap restores share this, because "which entries
 * survive the cap" is one question and answering it two ways is how the two
 * paths drift apart.
 *
 * Cost: O(cap), two passes over the retained array plus a Set, where the
 * flat FIFO it replaced was one splice. Measured at 0.062 ms per append at
 * the 10,000 default, and it runs only on appends that actually overflow.
 * It scales with `maxEntries`, so a much larger cap pays proportionally.
 */
function selectUnderCap(
  entries: readonly SessionLogEntry[],
  cap: number,
): { kept: SessionLogEntry[]; evicted: SessionLogEntry[] } {
  let remaining = entries.length - cap;
  if (remaining <= 0) return { kept: [...entries], evicted: [] };

  const dropped = new Set<number>();
  for (let i = 0; i < entries.length && remaining > 0; i += 1) {
    if (!DURABLE_ENTRY_TYPES.has(entries[i]!.type)) {
      dropped.add(i);
      remaining -= 1;
    }
  }
  // Churn alone did not cover the overflow: the rest comes off the front of
  // the conversation, which is the flat-FIFO behavior and the right floor.
  for (let i = 0; i < entries.length && remaining > 0; i += 1) {
    if (!dropped.has(i)) {
      dropped.add(i);
      remaining -= 1;
    }
  }

  const kept: SessionLogEntry[] = [];
  const evicted: SessionLogEntry[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    (dropped.has(i) ? evicted : kept).push(entries[i]!);
  }
  return { kept, evicted };
}
