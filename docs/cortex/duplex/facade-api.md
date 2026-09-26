# Facade API: The Consumer Surface

> **STATUS: IMPLEMENTED AND DEFAULT.** Built across phases 0 through 2b-ii on the `duplex-restructure` branch and validated in Phase 3. Duplex is the default mode (D14); `mode: 'passthrough'` is the opt-out. See migration-plan.md for the honest boundary of what the test suite can see, and consumer-guide.md for what changes on upgrade.

The facade is named `CortexAgent`. Consumers interact with one agent; the talker/reasoner split is never exposed in the API. This document defines what the consumer sees and how existing surfaces map onto the composite.

## Construction and Modes

```typescript
const agent = await CortexAgent.create({
  // everything AgentLoopConfig has today, applied per the routing table below
  mode: 'duplex',              // the default (D14); pass 'passthrough' to opt out
  talker: {                    // optional overrides, all have defaults
    model,                     // default: fast tier resolved from the primary provider
    // toolset is the fixed control tools only (decisions.md D5/D8);
    // consumer tools never route here
  },
  idleSignal,                  // consumer callback: is the user/channel idle? (wake policy)
});
```

`passthrough` routes everything to the reasoner: single loop, today's behavior exactly. It is the opt-out and the parity baseline.

## Config Routing

Consumers set config once; the facade routes it. This table is the contract:

| Config | Destination |
|---|---|
| `model`, `thinkingLevel` | reasoner (talker has its own dial) |
| `tools` (consumer-supplied) | reasoner only (decisions.md D5) |
| `slots` | both loops, identical content, no per-slot routing (decisions.md D6) |
| `initialBasePrompt` | both loops in full; the talker's role prompt is appended to it. (Consumers supply one undifferentiated prompt, and D6 forbids a routing knob, so splitting identity from domain instructions is not possible without inventing a config field.) |
| `compaction` | both (independent managers); talker forced to a non-blocking posture internally |
| `budgetGuard` | facade aggregate (P2) + per-loop lifetime budgets (P1); the talker additionally gets a facade-set hard `maxTurns` that consumer config cannot raise |
| `retryPolicy` | reasoner and sub-agents; the talker gets fail-fast defaults so a transient error never becomes minutes of silence |
| `resolvePermission` | facade broker in duplex; direct passthrough otherwise. The talker loop receives no resolver (see communication.md deadlock note) |
| `resolveNetworkAccess` | facade broker, same ask pipeline |
| `toolExecution`, `disableTools`, `deferredTools`, `toolResultThresholds` | reasoner and sub-agents |
| `workingTags` | both (talker uses it to separate thinking from speech) |
| `contextWindowLimit`, `cacheRetention` | per loop, derived from each loop's model |
| `utilityModel` | per loop (the same-provider constraint is enforced per loop, not globally) |
| `maxConcurrentSubAgents`, `onBeforeSubAgentSpawn`, `canSpawnSubAgent` | reasoner pool; quick lookups have a separate small pool |
| `isAutoApprove` | facade broker (bypasses voicing when set) |
| `getApiKey`, `sandbox`, `envOverrides`, `logger`, `workingDirectory` | shared |
| MCP servers, skills | facade services, projected to reasoner and sub-agents; never to the talker |
| `sessionId` | facade derives distinct stable per-loop IDs from it |
| `persistResult` | shared, with origin context added |
| compaction/loop-complete/error callback family | facade-level, fanned in with origin context; see persistence trigger below |

Known cleanup folded into this work: `webFetch.maxPerLoop` and `bash.autoYieldThreshold`/`shellPath` are declared today but never threaded to the built-in tools; they get threaded or deleted (P0).

## Interaction Surface

- `prompt(input)`: routes to the talker (duplex) or reasoner (passthrough). Never throws on a busy loop: internally it always uses `deliver()`, never `AgentLoop.prompt()`, because the talker's gate is held during interrupt-woken turns and queued drains, and barge-in is voice's core event. Resolves against the turn that carries the input.
- `deliver(message)`: fire-and-forget input, same non-throwing guarantee, explicit target (`'conversation'` by default).
- `abort(scope?)`: `'conversation'`, `'work'`, or `'all'` (default). Semantics per scope below.
- `getLog(fromSeq?)`: a snapshot copy (never a live reference) of entries from a sequence number onward.
- `subscribeLog(cb, fromSeq?)`: push callback with replay from a sequence number, so a reconnecting UI can ask for everything since it last saw. Slow subscribers are buffered to a bound and then dropped with a gap marker rather than applying backpressure to the loops.
- `getResolutionReport()`: what assembly resolved to where it differs from what was asked for (a talker on the primary model, a skipped `utilityModel`, an unwired egress resolver, an uncapped session). Computed once at assembly; the `logger.warn` lines and the `lifecycle` log entries are derived from it. See cortex-agent.md.

Entries carry a monotonic `seq`, a `loopPath`, a wake class, timestamps, and a `causedBy` seq when the entry belongs to a router-initiated run. The ordering rule is append-then-emit: a log entry is appended before the events of the run it triggers, so a consumer merging the two streams never sees events for an entry it has not received. A `reply` entry carries the same run identity as the response deltas that streamed it, so a UI can dedupe rather than rendering the text twice.

Abort semantics, per scope:

| | `conversation` | `work` | `all` |
|---|---|---|---|
| in-flight turns | talker | reasoner + children | both |
| queued deliveries to the target | dropped | dropped | dropped |
| pending asks from the target | resolved as deny | resolved as deny | resolved as deny |
| quick lookups | cancelled | untouched | cancelled |
| pi steering/follow-up queues | cleared | cleared | cleared |
| completed-but-undelivered results | retained in the log, not delivered | same | same |

Concurrency contract: concurrent `prompt()` calls never throw; `restore()` is rejected while any loop is running; the consumer idle signal is advisory, with the facade enforcing its own minimum inter-delivery spacing so an always-idle or never-idle signal cannot break the wake policy.

How the non-throwing part is achieved differs by mode, and the difference is visible to a consumer that awaits the return value. In passthrough, calls serialize on a facade chain and each resolves against its own turn. In duplex, `promptDuplex()` routes through the talker's delivery path instead, which does not serialize and which resolves `undefined` when the input parks behind a busy talker rather than waiting for the turn that eventually consumes it. Both are non-blocking and neither loses input, but a consumer that reads the resolved value of `prompt()` as "the reply to this input" is only correct in passthrough. Read replies from `onTurnComplete` or the event bridge instead.

**Two passthrough footnotes**, from building 2a. Both keep the contracts above while differing in mechanism, and both resolve in 2b.

- `prompt()` is specified as always routing through `deliver()`. In passthrough it instead serializes on a facade chain and calls the reasoner's `prompt()` directly, because `deliver()` carries no `DirectCompletionOptions` (dropping them would be a silent parity break) and a parked delivery has no turn promise, so "resolves against the turn that carries the input" is unimplementable through it. The `deliver()` route is a talker and barge-in mechanism; it belongs to 2b, where the talker needs non-throwing input under an interrupt-woken turn.
- The abort table's "completed-but-undelivered results are retained in the log, not delivered" holds in duplex, where the router owns delivery. In passthrough those completions are logged as lifecycle entries *and* still delivered by the existing background drain, because suppressing delivery requires the router. Parity with today's single-loop behavior wins here.
- Facade `abort()` clears the loop's queues (both pi queues plus silent and parked-wake content) where direct `AgentLoop.abort()` does not. This follows the abort table above, so it is intended rather than accidental, but it is a genuine behavioral difference for a consumer migrating: content parked by `steer()` survives a direct loop abort and does not survive a facade abort. A consumer that relied on the former needs to re-issue after aborting.

The facade is not yet a drop-in replacement for `AgentLoop`. See the delegation table in `docs/cortex/cortex-agent.md` for what is forwarded, what is subsumed, and what is deliberately withheld; that table is the migration checklist Phase 3 plans against, and it is kept accurate by a structural test rather than by review.

## Events

One merged stream via `getEventBridge()`, every event labeled with a loop path (`talker`, `reasoner`, `reasoner/task-7`, `lookup/lk-2`) in its **own `loopPath` field**.

The label does not reuse `childTaskId`, which keeps meaning "this event came from a sub-agent". An earlier 2b-i draft did reuse it, which silently killed the long-established `if (event.childTaskId) return;` idiom: a main-loop `turn_end` arrived labeled `childTaskId: 'reasoner'`, so three filters in cortex-code and any consumer-side budget guard went completely dead against a duplex facade. The tell was that the facade's own aggregate guard needed `includeChildUsage: true` just to observe main-loop events, which meant the encoding was wrong rather than the guard.

**Voice consumers must use the sanitized delta stream, not raw `response_chunk`.** Working tags are stripped only at `turn_end` today, so raw deltas carry `<working>` content that TTS would speak aloud. The facade emits a separate sanitized talker-delta event with holdback buffering across chunk boundaries (text after a `<` is held until the tag is disambiguated). Consumers cannot do this themselves because tags split across chunks.

Callbacks (`onError`, `onTurnComplete`, `persistResult`, `resolvePermission` in passthrough) gain an origin context argument for the same reason.

### Usage and cost

A single aggregate across every loop, sub-agent, quick lookup, and utility call, with per-loop attribution preserved. Three current gaps make this more than bookkeeping:

- **Direct and utility completions reach no accounting surface at all.** `directComplete`/`structuredComplete`/`utilityComplete` stash usage in a field with no public reader; it never reaches session usage, any budget guard, or any event. That class covers the observational observer and reflector, L2 summarization, WebFetch summarization, and Bash's utility calls. Duplex doubles the observational share (two resident loops observing overlapping content, exactly the cost D4 says to watch), so the aggregate guard would otherwise ship blind and could not stop a runaway reflector. Fix: accumulate this usage per loop under a category tag and emit a usage event for it.
- **Composition must dedupe children.** Per-loop session usage already includes forwarded child events, so the aggregate is the sum of per-loop totals with each child counted exactly once via a bridge-of-record rule (every child forwards to exactly one parent bridge; lookups are owned by the facade's bridge). `SubAgentResult.usage` is never re-added on top; a consumer doing that today already double-counts foreground children.
- **Restore is a baseline, not a replay.** Loops restart at zero, so the facade owns the aggregate as `restoredBaseline + live deltas` rather than summing live counters. The v2 artifact stores a per-loop breakdown, since a single blob erases attribution across a restore.

### Settlement and persistence

`onLoopComplete` is ambiguous with multiple loops, so the facade exposes `onStateChanged` (debounced) plus `getState()`, and the consumer persists on that rather than on any single loop's completion. A snapshot is taken only at a consistent point: the log and both histories are captured atomically, never mid-reasoner-task on a talker completion.

Two distinct predicates, both awaitable, because "the conversation settled" and "all work settled" are different facts:

- `conversationIdle`: the talker's gate is empty.
- `workSettled`: reasoner idle, no active sub-agents or lookups, no queued wake deliveries, no pending asks.

Both are built on loop-gate depth rather than the loop's `_isPrompting` flag, which reads idle while gate tasks are still queued. The awaitable form is needed by the P3 scenario tests, so it is built in P2.

## Persistence

The persisted artifact becomes a versioned composite:

```
{
  version: 2,
  log:              [...],          // the session log
  talkerHistory:    [...],          // post-slot messages
  reasonerHistory:  [...],
  talkerMemory:     {...},          // observational state, order-coupled to its history
  reasonerMemory:   {...},
  usage:            {...},          // single aggregate; restore is idempotent, not additive
  router:           {...},          // optional: alias counter, tasks, held results, pending deltas
}
```

Rules carried over from the audits:

- Per-loop restore ordering holds: history before observational state (the watermark is aligned to post-slot history length).
- Restore is guarded against running loops (no guard exists today).
- Usage restore stops being additive so a composite restore cannot double-count.
- A version-1 artifact (today's single history) restores into the reasoner with an empty talker and a log synthesized from nothing; sessions upgrade transparently.

Sub-agent state remains non-persistent (tasks are re-derivable from the log's directive/lifecycle entries; resumable tasks are out of scope for launch). The router's session state is persisted (`router`, optional so earlier artifacts still restore): the task alias counter, the tracked tasks, results logged but not yet handed to the talker, and conversation deltas the reasoner has not seen. Tasks still outstanding at restore are reported as interrupted, not resumed.

## What Consumers Should Notice

In duplex mode, from the outside:

- First feedback on any input arrives in well under a second.
- "How's it going" answers come from live status without interrupting work.
- Long work continues across conversational exchanges, and its results surface at sensible moments (the wake policy), not mid-sentence.
- Permission asks arrive as conversation, not as frozen loops.

Everything else (slots, skills, MCP, sandboxing, budget limits, persistence hooks) behaves as documented today, with the noted signature additions for origin identity.
