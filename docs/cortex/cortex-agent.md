# CortexAgent: The Composite Facade

> **STATUS: PASSTHROUGH IMPLEMENTED; DUPLEX IN DEVELOPMENT**

`CortexAgent` is the composite facade over the `AgentLoop` primitive. Consumers interact with one agent; internally the facade owns the resident loop(s), the session log, settlement predicates, and composite persistence. The design lives in `docs/cortex/duplex/`; this document describes what is implemented today.

Two modes:

- **`passthrough`** (the current default): a single reasoner loop. Behavior is identical to using `AgentLoop` directly, verified by a side-by-side parity suite. This is the consumer opt-out and the parity baseline.
- **`duplex`**: a fast talker loop fronting the reasoner. Not implemented yet; requesting it throws rather than silently degrading to passthrough. It becomes the default when it lands (decisions.md D14 in the duplex folder).

`AgentLoop` remains exported and remains the loop primitive. `CortexAgent` is additive; nothing about direct `AgentLoop` use changes.

## Construction

```typescript
import { CortexAgent } from '@animus-labs/cortex';

const agent = await CortexAgent.create({
  // everything AgentLoopConfig accepts, plus:
  mode: 'passthrough',          // default today
  sessionLog: {                 // optional log tuning
    maxEntries: 10_000,         // retention cap (ring buffer)
    maxSubscriberBuffer: 1_000, // per-subscriber buffer bound
  },
  stateChangeDebounceMs: 500,   // onStateChanged debounce
  // Reserved for duplex (accepted, unused until then):
  // talker: { model },         // talker model override
  // idleSignal: () => boolean, // wake-policy idle signal
});
```

Config is routed per the table in `src/cortex-agent.ts` (`CONFIG_ROUTING`). The table is compile-time exhaustive: adding a config key without a routing destination is a type error. In passthrough every non-facade key flows to the reasoner unchanged, so behavior matches direct `AgentLoop` construction exactly.

## Interaction surface

- **`prompt(input, options?)`**: never throws on a busy loop. Concurrent calls serialize; each resolves against the turn that carries its input. (Direct `AgentLoop.prompt()` fails fast while the loop gate is held; the facade absorbs that.)
- **`deliver(content, { wake?, target? })`**: fire-and-forget input with the loop's `deliver()` outcomes (`prompted`, `parked`, `queued`). `target` is `'conversation'` (default) or `'work'`; both resolve to the reasoner in passthrough.
- **`steer(message)`**: queue into the running turn, as on the loop.
- **`abort(scope?)`**: `'conversation'`, `'work'`, or `'all'` (default). Every scope aborts the in-flight turn, drops queued deliveries, and clears pi's steering and follow-up queues; `'work'` and `'all'` additionally cancel running sub-agents. Pending permission asks resolve as deny through the abort race.
- **`destroy(timeoutMs?)`**: tears down the facade and its loops. Idempotent.

Everything else a consumer uses on `AgentLoop` (slots, models, thinking levels, MCP, skills, sub-agents, direct completions, compaction hooks, callback registration) is exposed on the facade and delegates to the reasoner in passthrough. Callback signatures are unchanged, including the origin context (`loopPath`) added in the loop identity work.

## The session log

The facade keeps an append-only session log: the routing bus and audit trail of the session, and part of the persistence artifact. It is not a context surface; no prompt is ever built from it.

Entry types: `utterance`, `reply`, `directive`, `delivery`, `error`, `retrying`, `lifecycle`, `ask`, `ask_answer`, `lookup_result`. In passthrough the facade produces `utterance` (consumer input), `reply` (user-facing turn text), `error` and `retrying` (from the error and retry handlers), and `lifecycle` (sub-agent spawns, completions, failures, dead-lettered deliveries, aborts). The remaining types belong to duplex machinery (control tools, the permission broker, quick lookups) and exist now as part of the artifact contract.

Entries carry:

- **`seq`**: monotonic sequence number, the ordering authority (timestamps collide under burst).
- **`loopPath`**: producer identity.
- **`causedBy`**: causation stamp. An entry produced by a facade-initiated run (a reply to an utterance, an error in that run, a spawn made during it) carries the seq of the utterance that caused it; a completion lifecycle entry carries its spawn entry's seq. Entries from runs the facade did not initiate (a background delivery drain, a sweep run for parked content) carry no stamp rather than a guessed one.
- **`wake`** and **`data`**: wake class (duplex) and structured per-type payload.

Reads and subscriptions:

- **`getLog(fromSeq?)`**: snapshot copy, never a live reference.
- **`subscribeLog(cb, fromSeq?)`**: push subscription with replay from a seq. Ordering is append-then-emit: an entry reaches subscribers before the events of the run it triggers. Synchronous callbacks are invoked inline; a callback that returns a promise is awaited, with later events buffered to the configured bound and then dropped oldest-first with a gap marker (`{ kind: 'gap', fromSeq, toSeq, dropped }`) instead of applying backpressure to the loops. Unsubscribe is idempotent.

Retention: the log holds at most `sessionLog.maxEntries` entries (default 10,000), evicting oldest-first. When `persistResult` is configured, evicted entries are spilled through it (as JSON lines under the synthetic tool name `_session_log`) before leaving memory. Replaying from below retention yields a leading gap marker.

## Composite persistence

`getState()` returns the versioned composite artifact:

```typescript
{
  version: 2,
  log:             [...],   // the session log
  talkerHistory:   [...],   // post-slot messages (empty in passthrough)
  reasonerHistory: [...],
  talkerMemory:    {...},   // observational state (null in passthrough)
  reasonerMemory:  {...},
  usage: {
    total:   {...},         // aggregate across every loop
    perLoop: { talker, reasoner },
  },
}
```

`getState()` is async: it snapshots only at a consistent point (loop gate empty, never mid-run), so the log and histories always match. `restore(state)` accepts a v2 artifact, a v1 artifact (`{ version: 1, history, memory?, usage? }`), or a bare message array; v1 shapes restore into the reasoner with an empty log, so existing single-history sessions upgrade transparently.

Restore rules:

- Rejected while any loop is running or any sub-agent is active.
- Per-loop ordering holds internally: history first, then observational state (the observation watermark aligns to the post-slot history length).
- Usage restore is a baseline: the facade reports `restoredBaseline + live deltas`, so repeated restores are idempotent and `getSessionUsage()` totals survive restores without double-counting. Note `SessionUsage.totalCost` includes direct/utility completion spend (observer, reflector, summarization, WebFetch, Bash utility calls).
- A v2 artifact with talker content restored into a passthrough facade carries the talker side through opaquely: `getState()` round-trips it unchanged, and restored talker spend stays in the aggregate.

`onStateChanged(handler)` is the persistence trigger: debounced (`stateChangeDebounceMs`, default 500 ms), fired with a consistent `getState()` snapshot after state-changing activity settles (log appends, run completions, compaction, observation). Consumers persist on this rather than on `onLoopComplete`, which becomes ambiguous once multiple loops exist.

## Settlement predicates

Two distinct facts, each with a synchronous getter and an awaitable form, all built on loop-gate depth (not the prompting flag, which reads idle while gate tasks are queued):

- **`conversationIdle`** / **`waitForConversationIdle()`**: no facade prompt queued or running, and the conversation loop's gate empty. In passthrough the conversation loop is the reasoner.
- **`workSettled`** / **`waitForWorkSettled()`**: conversation idle, no active sub-agents, no parked wake deliveries, no pending permission asks. Queued silent deliveries do not count; silent content deliberately waits for the next prompt.

The awaitable forms are event-driven (gate tail, sub-agent completion promises) and are the foundation the Phase 3 scenario tests build on.

## Parity

`tests/unit/cortex-agent-parity.test.ts` drives `AgentLoop` directly and `CortexAgent` in passthrough side by side over identical mock loops and asserts equivalence of pi-level interaction, events, callbacks (with origin context), history, turn results, retry schedules, abort behavior, and usage. Parity is measured against the current (post Phase 0/1) behavior.
