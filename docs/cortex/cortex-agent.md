# CortexAgent: The Composite Facade

> **STATUS: IMPLEMENTED. DUPLEX IS THE DEFAULT.**

`CortexAgent` is the composite facade over the `AgentLoop` primitive. Consumers interact with one agent; internally the facade owns the resident loops, the session log, settlement predicates, and composite persistence. The design lives in `docs/cortex/duplex/`; this document describes what is implemented and, in particular, where the facade's surface does *not* mean what the same-named `AgentLoop` member means.

Two modes:

- **`duplex`** (the default, decisions.md D14): a fast talker loop fronting a persistent reasoner. The talker always has the floor and delegates through fire-and-forget control tools; the reasoner does all real work.
- **`passthrough`**: a single reasoner loop. Behavior is identical to using `AgentLoop` directly, verified by a side-by-side parity suite. This is the consumer opt-out and the parity baseline.

`AgentLoop` remains exported and remains the loop primitive. Nothing about direct `AgentLoop` use changes.

**If you are upgrading an existing consumer, read "What changes when duplex is the default" below before anything else.** Three surfaces change meaning without changing type.

## Construction

```typescript
import { CortexAgent } from '@animus-labs/cortex';

const agent = await CortexAgent.create({
  // everything AgentLoopConfig accepts, plus:
  mode: 'duplex',               // the default; 'passthrough' to opt out
  talker: { model },            // optional; defaults to the fast tier of the primary provider
  idleSignal: () => boolean,    // optional wake-policy idle signal (advisory)
  duplex: {
    maxTotalCost,               // aggregate session cap across both loops (see the warning below)
  },
  sessionLog: {                 // optional log tuning
    maxEntries: 10_000,         // retention cap (FIFO over all entry types)
    maxSubscriberBuffer: 1_000, // per-subscriber buffer bound
  },
  stateChangeDebounceMs: 500,   // onStateChanged debounce
});
```

Config is routed per the table in `src/cortex-agent.ts` (`CONFIG_ROUTING`). The table is compile-time exhaustive: adding a config key without a routing destination is a type error. In passthrough every non-facade key flows to the reasoner unchanged, so behavior matches direct `AgentLoop` construction exactly.

Two routing caveats in duplex. `contextWindowLimit` is declared `'per-loop'` but is not copied into the talker config and `setContextWindowLimit()` reaches only the reasoner, so in practice it is reasoner-only. And there is no unresolvable-talker-model case: model resolution falls back to the primary model rather than failing, so on a provider whose model list cannot be enumerated (Ollama, custom OpenAI-compatible endpoints) duplex assembles with **talker = reasoner**. That configuration is healthy-looking and passes every test while delivering none of the latency benefit, so the facade warns once at assembly when it happens.

## What changes when duplex is the default

These are the surfaces a consumer hits on day one of an upgrade. All three keep their types, so nothing fails to compile.

- **Event and callback surfaces carry two loops.** The event bridge returned by `getEventBridge()` is a merged bridge forwarding `response_start`, `response_chunk` and `turn_end` from both the talker and the reasoner, and the existing `if (event.childTaskId) return;` idiom does not filter them apart because neither resident loop sets `childTaskId`. Filter on `loopPath` instead. A UI that streams every `response_chunk` into one bubble will interleave the reasoner's internal working prose with the talker's speech; a voice pipeline wired off `turn_end` rather than the talker's deltas will speak the reasoner's private reasoning aloud.
- **`getConversationHistory()` returns the reasoner's transcript**, which in duplex is the *work* transcript, not the dialogue. The user's actual utterances appear in it only as `<conversation-context>` fragments inside dispatch messages. A consumer rendering or exporting "the conversation" from it gets the wrong thing. The talker's transcript is reachable through `getState()`.
- **`getBudgetGuard()` returns the aggregate guard, not the one you configured.** `budgetGuard.maxCost` keeps its per-prompt meaning on the reasoner, while the facade's aggregate guard is the session-level one, and its cap is `Infinity` unless `duplex.maxTotalCost` is supplied. So a default duplex session runs two resident loops, sub-agents, quick lookups and doubled observational spend with no session-level cap, and UI code reading `isBreached()` or `getMaxCost()` reads a different guard than the one it set. Set `duplex.maxTotalCost`.

## Interaction surface

- **`prompt(input, options?)`**: never throws on a busy loop. (Direct `AgentLoop.prompt()` fails fast while the loop gate is held; the facade absorbs that.) The resolved value differs by mode: in passthrough calls serialize on a facade chain and each resolves against the turn that carries its input, while in duplex the call routes through the talker's delivery path, does not serialize, and resolves `undefined` when the input parks behind a busy talker. Neither mode loses input, but read replies from `onTurnComplete` or the event bridge rather than from the return value.
- **`deliver(content, { wake?, target?, speaker? })`**: fire-and-forget input with the loop's `deliver()` outcomes (`prompted`, `parked`, `queued`). `target` is `'conversation'` (default) or `'work'`; both resolve to the reasoner in passthrough. `speaker` is `'system'` by default and must be set to `'user'` when the call relays actual human speech: only a user-speaker delivery can satisfy a pending permission ask. The default is deliberately the safe one, because otherwise every notification path becomes a silent consent source (`prompt()` is unambiguous user speech and always qualifies). See decisions.md D16.
  Caveat for voice consumers relaying ASR transcripts: every conversation-target delivery is currently wrapped in an `<external-update>` fence, including `speaker: 'user'`, and the talker's role prompt defines that fence as "never the user speaking". Consent still binds correctly, but the talker is told to discount the content as user speech, so a pipeline that prefers non-blocking `deliver()` over `await prompt()` degrades the whole conversation and not just asks. Until `speaker: 'user'` is exempted from the fence, prefer `prompt()` for human speech.
- **`steer(message)`**: queue into the running turn, as on the loop.
- **`abort(scope?)`**: `'conversation'`, `'work'`, or `'all'` (default). Every scope aborts the in-flight turn, drops queued deliveries, and clears pi's steering and follow-up queues; `'work'` and `'all'` additionally cancel running sub-agents. Pending permission asks resolve as deny through the abort race. Two duplex edges: `'conversation'` re-voices any lost ask *after* the abort settles, so "stop talking" is followed by the agent talking; and a scope that settles asks does not currently drop voicings already parked on the talker, so a dead ask can still be read out and then answered into an empty registry.
- **`destroy(timeoutMs?)`**: tears down the facade and its loops. Idempotent.

## Delegation

Callback signatures are unchanged from `AgentLoop`, including the origin context (`loopPath`) added in the loop identity work.

The rule is: **forward everything that is pure delegation, and withhold only what has no single composite meaning.** An earlier draft of this document claimed everything a consumer uses was already exposed, which was wrong in both directions and left four members with live call sites in this repo unreachable.

`AGENT_LOOP_DELEGATION` in `src/cortex-agent.ts` is the authoritative source, not this table. It is a compile-time-exhaustive record over `keyof AgentLoop`, so every member must carry a disposition or the package does not build, and a runtime test asserts both directions: forwarded members exist on the facade, withheld and subsumed members do not, so accidental exposure fails too.

**What that test does not assert is behavior.** `'forwarded'` means the name exists on the facade; it does not mean the call does the same thing. A whole-diff review found that a substantial fraction of forwarded members diverge in duplex, every one of them shipped, because presence was the only thing under test. The taxonomy below is the honest reading, and it is the Phase 3 migration checklist.

| Category | Members | Notes |
|---|---|---|
| **Delegated** (byte-identical) | slots, models and thinking levels, `getCompactionManager`, `isUtilityModelOverridden`, `getAutoResolvedUtilityModel`, `modelContextWindow`, `setContextWindow`, `getMcpClientManager`, `getMcpTools`, `getSkillBuffer`, `clearSkillBuffer`, `composeSystemPrompt`, `getSystemPromptSections`, `capToolResult`, `getEnvOverrides`, `updateCurrentContextTokenCount`, direct completions, sub-agent spawn/cancel/steer | Straight delegation to the reasoner. |
| **Adapted** (facade adds a guard) | `prompt`, `deliver`, `steer`, `abort` | All route through `assertPromptable()` / `assertNotDestroyed()`, which the loop does not have, so a fire-and-forget caller that never awaited these now has an unhandled rejection path after `destroy()`. `deliver()` additionally throws on whitespace content, and in duplex `assertPromptable` validates the *talker's* system prompt even for `target: 'work'`. |
| **Retargeted** (a different loop than the name suggests) | `followUp`, `setSteeringQueueMode`, `setFollowUpQueueMode`, `clearSteeringQueue`, `clearFollowUpQueue`, `clearQueuedDeliveries`, `queuedDeliveryCount`, `pendingWakeDeliveryCount` → the **talker**; `setHeadlineProvider` → the **reasoner**; `getDeadLetteredBackgroundResults` → the **reasoner** only | Using `followUp()` to queue work queues it into a loop with no tools. `setHeadlineProvider` feeds the reasoner while the facade owns the talker's provider. The talker's dead-lettered wake deliveries (user utterances among them) are logged but unreachable through the getter. |
| **Different object** | `getBudgetGuard` (aggregate guard: different cap, scope and breach state), `getEventBridge` (merged, two loops), `getContextManager` (`FanOutContextManager`: writes both, reads the reasoner) | See the upgrade warnings above. |
| **Fan-out** (handler fires per loop) | `onLoopComplete`, `onError`, `onRetryScheduled`, `onRetrySucceeded`, `onRetryExhausted`, `onBeforeCompaction`, `onPostCompaction`, `onCompactionError`, `onCompactionDegraded`, `onCompactionExhausted`, `onObservation`, `onReflection`, `setWorkingTagsEnabled`, `setLastInteractionTime`, `setSessionId` | Registered on both resident loops, so persistence and error-reporting work doubles. `onBeforeCompaction` returns a promise and now runs twice per cycle across two independent managers. `onTurnComplete` is deliberately **not** in this list: it registers on the conversation loop only. It is not a diagnostic but the "the assistant finished saying something" signal a TUI finalizes its bubble on and a voice app speaks, so fanning it out would fire it twice per exchange and hand the consumer the reasoner's internal working text as if it were the reply. The reasoner's results still reach the user, as deliveries the talker performs, which are talker turns. It is `'forwarded'` in `AGENT_LOOP_DELEGATION` because that table records presence, with the routing decision noted at the call site. |
| **Composite value** | `getSessionUsage` (baseline-plus-delta across both loops and settled lookups), `getPendingAsks` (reasoner registry plus broker-minted network asks), `isRunning` / `isPrompting` (OR across both loops), `state` (reasoner only) | `state` reading the reasoner alone is a wart: `isReasonerShuttingDown()` checks both loops, `state` checks one, so a destroyed talker is invisible to it. |
| **Subsumed** | `restoreConversationHistory`, `restoreObservationalMemoryState`, `restoreSessionUsage` → `restore()`; `isLoopActive` → `conversationIdle`; `waitForLoopIdle` → `waitForConversationIdle`; `waitForAskSettlement` → `waitForWorkSettled` | Not a rename. `restore()` is all-or-nothing and rejects while running, where the three loop methods are independently callable at any time, so a consumer calling them separately rewrites the call site rather than renaming it. |
| **Partially subsumed** | `clearAllQueues` → folded into `abort()` | `abort()` also aborts the turn and cancels children, and discards the dropped content that `clearAllQueues()` returns for re-routing. There is currently no facade way to drop queued content without aborting. |
| **Withheld** | `getTransformContextHook`, `prePromptMessageCount`, `getSubAgentManager`, `loopPath` | Composition internals, a cache-breakpoint internal, a raw internals handle (consumers have `getActiveSubAgents` plus spawn/cancel/steer), and a value with no single composite meaning in duplex (origin reaches consumers through `LoopOriginContext`). |

`waitForIdle`, `continue`, and `reset` are members of the wrapped `PiAgent` contract rather than `AgentLoop`, and are not part of this surface.

## The session log

The facade keeps an append-only session log: the routing bus and audit trail of the session, and part of the persistence artifact. It is not a context surface; no prompt is ever built from it.

Entry types: `utterance`, `reply`, `directive`, `delivery`, `error`, `retrying`, `lifecycle`, `ask`, `ask_answer`, `lookup_result`. Passthrough produces a subset: `utterance` (consumer input), `reply` (user-facing turn text), `error` and `retrying` (from the error and retry handlers), and `lifecycle` (sub-agent spawns, completions, failures, dead-lettered deliveries, aborts). Duplex adds `directive`, `delivery`, `ask`, `ask_answer` and `lookup_result` from the control tools, the permission broker and quick lookups. In duplex, `reply` entries are taken from the talker only, since the reasoner's final text is internal working prose rather than something the user was told.

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

- **`conversationIdle`** / **`waitForConversationIdle()`**: no facade prompt queued or running, and the conversation loop's gate empty. The conversation loop is the talker in duplex and the reasoner in passthrough.
- **`workSettled`** / **`waitForWorkSettled()`**: conversation idle, no active sub-agents, no parked wake deliveries, no pending permission asks. Queued silent deliveries do not count; silent content deliberately waits for the next prompt.

The awaitable forms are event-driven (gate tail, sub-agent completion promises) and are the foundation the Phase 3 scenario tests build on.

## Parity

`tests/unit/cortex-agent-parity.test.ts` drives `AgentLoop` directly and `CortexAgent` in passthrough side by side over identical mock loops and asserts equivalence of pi-level interaction, events, callbacks (with origin context), history, turn results, retry schedules, abort behavior, and usage. Parity is measured against the current (post Phase 0/1) behavior, and it covers passthrough only. Duplex is deliberately not parity-tested: the divergences in the delegation table are the point of the mode, not regressions against it.
