# Communication: Control Tools, Headlines, Wake Policy, Permission Brokering

> **STATUS: DESIGN, NOT IMPLEMENTED**

The down-channel is a fixed set of fire-and-forget control tools on the talker; the up-channel is log routing. Neither direction ever blocks a loop on another loop.

## Down-Channel: Control Tools

The talker delegates through five control tools (decisions.md D8, which records the reversal from an earlier in-band-tags design). Each executes locally in under a millisecond (a dispatch into the facade router) and returns `terminate: true`, which pi-agent-core honors by skipping the automatic follow-up LLM call, so delegation costs zero extra rounds. The talker speaks its acknowledgment in the same turn, before the tool call, and the turn ends when the dispatch lands.

Control toolset (initial):

| Tool | Arguments | Facade action |
|---|---|---|
| `spawn_task` | `{ instructions }` | deliver new work to the reasoner |
| `steer_task` | `{ taskId?, message }` | deliver a redirect to the reasoner, or fast-path to a named running sub-agent |
| `cancel_task` | `{ taskId }` | abort the target, log a lifecycle entry |
| `answer_ask` | `{ askId, decision, reason? }` | settle the pending permission ask (validated against the pending-ask set) |
| `quick_lookup` | `{ question }` | spawn a read-only ephemeral sub-agent |

Design properties:

- **Zero extra round trips.** `terminate: true` on every control-tool result skips the follow-up call; the loop honors this today (`agent-loop.ts` `shouldTerminateToolBatch`).
- **Pointer, not paraphrase.** The reasoner receives the conversation deltas anyway (log routing), so tool arguments do not need to restate the user's request accurately; the reasoner reads the user's own words.
- **Injection-resistant by construction.** Untrusted text in the talker's context (tool output in deliveries, stdout in headlines, file contents in lookup results, users quoting syntax) cannot invoke a tool by being echoed; invocation requires a deliberate structured call, and `answer_ask` arguments validate against the live pending-ask set.
- **Standard machinery.** Schema validation, argument coercion, and structured retryable errors come from the existing tool path; there is no bespoke parser to build or maintain.
- **Precedent.** Every production system at the API layer uses tool calls for the fast loop's control surface: OpenAI Realtime async function calling, Gemini Live `NON_BLOCKING` functions, LiveKit's auto-exposed `get_running_tasks`/`cancel_task`, Pipecat, ElevenLabs. AsyncFC formalizes the fire-and-forget contract.

Working tags remain in use on the talker for their original purpose only: separating internal reasoning from spoken text.

## Up-Channel: Headlines and Deliveries

Two speeds, mapped to the two context channels (log-and-context.md):

**Headlines** (continuous): the facade maintains a compact status block per active loop and running sub-agent: state, current tool, duration, turns, token spend, last output lines. Sourced from event-bridge forwarding (enabled for background children in P0; today they are event-invisible, which makes the existing `Current:` surface dead code). View-injected into the talker every turn, outside BP3, token-capped. The talker answers "how's it going" from this block, with honest staleness ("last I saw, it was running the test suite").

**Deliveries** (discrete): when the reasoner completes work or reaches a milestone it emits a delivery: plain content, no schema (decisions.md D9). The facade logs it and routes it to the talker under the wake policy. The talker decides phrasing; grounding rules forbid inventing anything beyond the delivered content.

## Wake Policy

Adopted vocabulary from Gemini Live's result scheduling (decisions.md D10). Every delivery and ask carries a wake class:

| Class | Behavior |
|---|---|
| `interrupt` | start an unprompted talker turn immediately (the existing background-completion drain pattern: a delivered message starts a loop run) |
| `when_idle` | queue until the consumer-supplied idle signal fires (user not speaking, TTS not playing), then deliver |
| `silent` | append to the talker's transcript at its next natural turn; surfaced only when relevant |

The producer proposes the class (the reasoner can mark a milestone `silent` and a final result `when_idle`; permission asks are `interrupt`), and the facade's router applies defaults per entry type. The consumer supplies the idle signal; without one, `when_idle` degrades to `interrupt` after a configurable delay.

Stale results are never dropped (the Nova 2 Sonic position): a delivery that arrives after the user changed direction still enters the log and the talker's context; the talker reconciles conversationally. Explicit `cancel_task` is the only discard path.

## Permission Brokering

Today a permission ask blocks the asking loop while the consumer's `resolvePermission` callback decides. In duplex, asks flow through the conversation:

```
sub-agent hits ask-gated tool
  -> resolver wrapper creates ask entry {askId, loopPath, toolName, args}  (log, wake: interrupt)
  -> talker voices the ask
  -> user answers in speech/text
  -> talker calls answer_ask({askId, decision, reason})
  -> facade settles the pending resolver promise
  -> asking loop proceeds or receives the block
```

Required mechanics, from the coordination audit:

- **Ask identity.** The current resolver signature `(toolName, args)` is anonymous; with N loops the consumer cannot attribute or correlate. The wrapper adds `{askId, loopPath}` context (P1 loop-identity work).
- **Queryable pending set.** Today `pendingPermission` is one nullable slot per tracked child, readable only via snapshots. The broker keeps a facade-level collection so asks can be enumerated, voiced in order, and answered out of order.
- **Abort-race.** pi awaits `beforeToolCall` before checking the abort signal, so a pending ask currently hangs abort/destroy into the 8-second force-kill path. The Cortex wrapper races the consumer's decision against the loop's abort signal and returns a block on abort (P0; no pi change).
- **Timeout.** Asks carry an optional timeout with a configurable default resolution (deny with reason), so an unanswered ask cannot wedge a task forever.

In passthrough mode the broker is bypassed and `resolvePermission` behaves exactly as today.
