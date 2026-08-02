# Facade API: The Consumer Surface

> **STATUS: DESIGN, NOT IMPLEMENTED**

The facade is named `CortexAgent`. Consumers interact with one agent; the talker/reasoner split is never exposed in the API. This document defines what the consumer sees and how existing surfaces map onto the composite.

## Construction and Modes

```typescript
const agent = await CortexAgent.create({
  // everything CortexAgentConfig has today, applied per the routing table below
  mode: 'duplex',              // default; 'passthrough' opts out
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
- `getLog(fromOffset?)` / log subscription: the append-only session record (see log-and-context.md), including entry metadata (wake class, loop path, timestamps).

Abort semantics, per scope:

| | `conversation` | `work` | `all` |
|---|---|---|---|
| in-flight turns | talker | reasoner + children | both |
| queued deliveries to the target | dropped | dropped | dropped |
| pending asks from the target | resolved as deny | resolved as deny | resolved as deny |
| quick lookups | cancelled | untouched | cancelled |
| pi steering/follow-up queues | cleared | cleared | cleared |
| completed-but-undelivered results | retained in the log, not delivered | same | same |

Concurrency contract: concurrent `prompt()` calls are serialized by the facade rather than throwing; `restore()` is rejected while any loop is running; the consumer idle signal is advisory, with the facade enforcing its own minimum inter-delivery spacing so an always-idle or never-idle signal cannot break the wake policy.

## Events

One merged stream via `getEventBridge()`, every event labeled with a loop path (`talker`, `reasoner`, `reasoner/task-7`, `lookup/lk-2`). The existing single-level `childTaskId` becomes this path (P1).

**Voice consumers must use the sanitized delta stream, not raw `response_chunk`.** Working tags are stripped only at `turn_end` today, so raw deltas carry `<working>` content that TTS would speak aloud. The facade emits a separate sanitized talker-delta event with holdback buffering across chunk boundaries (text after a `<` is held until the tag is disambiguated). Consumers cannot do this themselves because tags split across chunks.

Callbacks (`onError`, `onTurnComplete`, `persistResult`, `resolvePermission` in passthrough) gain an origin context argument for the same reason.

Usage and cost: a single aggregate across every loop, sub-agent, quick lookup, and utility call (observer, reflector, summarization), with per-loop attribution preserved so consumers can render a breakdown. Today background children forward nothing, direct and utility completions bypass session usage entirely, and restore is additive; all three are fixed as part of the aggregate.

Persistence trigger: `onLoopComplete` is ambiguous with multiple loops, so the facade exposes an explicit `onStateChanged` (debounced) plus `getState()`, and the consumer persists on that rather than on any single loop's completion. `isRunning` reports conversation and work separately, since "the conversation settled" and "all background work settled" are now different facts.

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
}
```

Rules carried over from the audits:

- Per-loop restore ordering holds: history before observational state (the watermark is aligned to post-slot history length).
- Restore is guarded against running loops (no guard exists today).
- Usage restore stops being additive so a composite restore cannot double-count.
- A version-1 artifact (today's single history) restores into the reasoner with an empty talker and a log synthesized from nothing; sessions upgrade transparently.

Sub-agent state remains non-persistent (tasks are re-derivable from the log's directive/lifecycle entries; resumable tasks are out of scope for launch).

## What Consumers Should Notice

In duplex mode, from the outside:

- First feedback on any input arrives in well under a second.
- "How's it going" answers come from live status without interrupting work.
- Long work continues across conversational exchanges, and its results surface at sensible moments (the wake policy), not mid-sentence.
- Permission asks arrive as conversation, not as frozen loops.

Everything else (slots, skills, MCP, sandboxing, budget limits, persistence hooks) behaves as documented today, with the noted signature additions for origin identity.
