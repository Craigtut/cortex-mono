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
    // tools intentionally absent by default (decisions.md D5)
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
| `initialBasePrompt` | reasoner; talker gets its own role prompt plus the consumer's identity content |
| `compaction` | both (independent managers); talker strategy tunable internally |
| `budgetGuard` | facade aggregate + per-loop lifetime budgets (P1) |
| `resolvePermission` | facade broker in duplex; direct passthrough otherwise |
| `getApiKey`, `sandbox`, `envOverrides`, `logger`, `workingDirectory` | shared |
| MCP servers, skills | facade services, projected to reasoner and sub-agents |
| `sessionId` | facade derives distinct stable per-loop IDs from it |

Known cleanup folded into this work: `webFetch.maxPerLoop` and `bash.autoYieldThreshold`/`shellPath` are declared today but never threaded to the built-in tools; they get threaded or deleted (P0).

## Interaction Surface

- `prompt(input)`: routes to the talker (duplex) or reasoner (passthrough). Returns when the immediate conversational turn settles, not when background work finishes.
- `deliver(message)`: fire-and-forget input that must not throw regardless of loop state (replaces the sharp prompt-throws/steer-drops dichotomy).
- `abort(scope?)`: `'conversation'` (talker turn), `'work'` (reasoner + its children), or `'all'` (default).
- `getLog()` / log subscription: the append-only session record (see log-and-context.md), including entry metadata (wake class, loop path, timestamps).

## Events

One merged stream via `getEventBridge()`, every event labeled with a loop path (`talker`, `reasoner`, `reasoner/task-7`, `lookup/lk-2`). The existing single-level `childTaskId` becomes this path (P1). Voice consumers route `talker` response deltas to TTS and everything else to UI; nothing else changes in the event vocabulary.

Callbacks (`onError`, `onTurnComplete`, `persistResult`, `resolvePermission` in passthrough) gain an origin context argument for the same reason.

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
