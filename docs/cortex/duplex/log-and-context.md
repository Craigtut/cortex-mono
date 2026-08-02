# The Session Log and Context Mechanics

> **STATUS: DESIGN, NOT IMPLEMENTED**

## What the Log Is

The log is the facade-owned, append-only record of the session: every user utterance, talker reply, directive, delivery, permission ask and answer, and task lifecycle event, in one totally ordered sequence. It is:

- the routing bus between loops
- the wake policy's input
- the consumer's persistence artifact
- the audit trail of the session

## What the Log Is Not

The log is not a context surface. No loop's prompt is built by projecting log entries into synthetic view messages. This was the original design and it was rejected (decisions.md D7) after the context-pipeline audit identified three violations, all in current code:

1. **View injections vanish on compaction turns.** After observational activation or L2 summarization, the post-slot view is rebuilt from the source array (`compaction/observational/index.ts:317-339`, `compaction/index.ts:916-921`), so anything that existed only in the returned view silently disappears from the prompt on exactly those turns.
2. **The observational watermark requires an append-only source.** Buffering tracks an index into the post-slot source history (`compaction/observational/buffering.ts:409-459`); the only sanctioned mutation is front-truncation. Foreign insertions desync the watermark into silent observation loss or an orphaned-toolResult provider 400.
3. **Tool-call-group adjacency.** Any insertion between an assistant tool call and its consecutive tool results corrupts group detection (`compaction/tool-call-groups.ts:39-81`), L2/L3 atomicity, toolResult merge runs, and the cache-breakpoint index simulation (`cache-breakpoints.ts:190-195`) simultaneously.

## The Two Sanctioned Channels

Content reaches a model through exactly two mechanisms, chosen by durability:

### Durable Content: Real Messages

Deliverables, directives, conversation deltas, permission asks: anything a loop must remember becomes a real message in that loop's transcript, delivered at a turn boundary via the loop's `deliver()` primitive. This is the same path background sub-agent results use today (`drainPendingBackgroundResults`, hardened in P0 for capped re-queue-on-failure).

`deliver()` is a state machine over (loop-gate depth, pi run state, abort state) with four outcomes, specified in P1 rather than P0 because the semantics are subtle:

| State | Action | Note |
|---|---|---|
| idle, wake wanted | prompt | starts a turn |
| idle, no wake (`silent`) | pi steering queue | drains at the *start* of the next run; Cortex's wrapper currently no-ops steering when idle, so the facade reaches pi directly |
| running | steer | lands at the next turn boundary |
| gate held, pi idle (retry backoff, drain window) | steer | the state the original three-way spec omitted |

A message delivered into a running turn extends that turn, so it inherits its budget window, retry window, and consumer promise. The implementation lives inside the loop gate; a check-then-call version has a time-of-check race against `prompt()`, which throws whenever the gate is held.

Real messages are append-only source content, which makes them:

- cache-friendly (the prefix only extends)
- compaction-safe (they participate in summarization and observation like any message)
- persistence-free (they ride the loop's existing history)

Message shape constraints from the audit: user-role, non-whitespace string content, timestamp set. Whitespace-only content is silently dropped at conversion; toolResult-role synthetics merge into adjacent runs and can 400; assistant-role synthetics with error stop reasons get stripped.

### Churn: View Injection Outside BP3

Task headlines and live activity (current tool, duration, token count, last output lines) change every tick and must never enter a transcript or the cached prefix. They use the existing `<background-tasks>` mechanism: view-injected in `transformContext` after the BP3 boundary (`cortex-agent.ts:3340-3350`), rebuilt every call, absent on compaction turns by design, never observed, never persisted.

Rules for the headline block, from the audit:

- It stays outside `stableInjectionCount` so BP3 accounting is untouched.
- It is built inside `buildInjectedAndSanitizedContextSnapshot` so token estimation and compaction utilization see it.
- It budgets its own tokens (hard cap); injected user-role content is never trimmed by microcompaction, so an unbounded block would inflate utilization and trigger early source compaction without itself shrinking.

## Log Entry Types

| Entry | Producer | Routed to | Channel |
|---|---|---|---|
| `utterance` | consumer via facade | talker (its prompt), reasoner (silent delta, D18) | real message |
| `reply` | talker | log; reasoner (silent delta, batched with the utterance it answers) | real message |
| `error` / `retrying` | error and retry handlers | talker (retrying: headline; fatal: interrupt delivery) | mixed |
| `directive` | talker control tools | facade router, then reasoner or target sub-agent | real message (steer) |
| `delivery` | reasoner | talker, per wake policy | real message |
| `headline` | event bridges, task registry | talker (and reasoner for its children) | view injection |
| `ask` / `ask_answer` | permission broker | talker / originating resolver | real message / promise settle |
| `lookup_result` | quick-lookup sub-agent | talker (wake) and reasoner (delta at next turn) | real message |
| `lifecycle` | facade | log only | none |

`lookup_result` routing is the shared-context guarantee of decisions.md D13: the reasoner sees everything the talker learned, so context never forks.

## Cache Discipline Per Loop

Each loop keeps its own transcript, its own stable session ID (`sessionId` per instance for prefix-cache routing; children already use taskId, `cortex-agent.ts:4917-4918`), and its own cache breakpoints. The composite adds no cross-loop cache coupling:

- Talker prefix: system prompt + slots + compacted history. Deliveries append; headlines stay outside BP3. Target: near-total cache reads per utterance.
- Reasoner prefix: unchanged from today.
- The step-0 mirror rule holds everywhere: mid-loop writes to `agent.state.messages` (including `setSlot`) are clobbered by the next `transformContext` mirror (`cortex-agent.ts:3275`) and never reach pi's loop array. The facade therefore writes slots only between prompts, or uses the per-call re-patch pattern (`cortex-agent.ts:3319-3333`) if a mid-loop surface ever becomes necessary.

## Compaction Interactions

- Every loop runs its own compaction manager. The talker compacts (infinite conversation is a consumer expectation); observational is the default strategy on both resident loops, with classic as a talker tuning option if duplicate observation cost across overlapping content proves material (decisions.md D4).
- **The talker runs a non-blocking compaction posture.** Its synchronous observer fallback is disabled, leaving emergency truncation as the only in-band path, because a blocking observer call inside `transformContext` is multi-second dead air on the presence loop and would recur at every activation for the whole session. Staggering thresholds between loops does not help the user who is mid-conversation when the talker crosses its own.
- The facade schedules deferred digestion (pending observation buffers, threshold compaction) during idle-signal windows for both loops, and staggers their thresholds so blocking work on the reasoner never coincides with a talker activation.
- The log itself never compacts. Since it is also the persistence artifact, it carries a retention policy (ring buffer over lifecycle and headline-source entries, spill to `persistResult`) defined before the v2 schema freezes.
- Persisted-result breadcrumbs (`[Result persisted: <path>]`) inside delivered content assume a shared filesystem; both resident loops share `workingDirectory` and the persist layout, so a delivered breadcrumb remains resolvable by the reasoner. The talker has no Read tool and simply speaks around them.
