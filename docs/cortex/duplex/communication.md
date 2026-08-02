# Communication: Directives, Headlines, Wake Policy, Permission Brokering

> **STATUS: DESIGN, NOT IMPLEMENTED**

No tool calls are used for cross-loop communication in either direction. The down-channel is in-band text; the up-channel is log routing.

## Down-Channel: Directives

The talker delegates by emitting working-tag directives inside its normal text stream. The facade attaches a streaming parser to the talker's delta events (extending the existing working-tags system, which currently parses only at `turn_end` via the event bridge) and dispatches each directive the moment its closing tag arrives, while the rest of the sentence is still streaming to TTS.

Directive set (initial):

| Tag | Meaning | Facade action |
|---|---|---|
| `<task>instructions</task>` | new work | deliver to reasoner |
| `<steer id="...">text</steer>` | redirect work | deliver to reasoner (or to a named sub-agent via the reasoner) |
| `<cancel id="..."/>` | stop work | abort target loop, log lifecycle entry |
| `<answer ask="id">decision</answer>` | permission answer | settle the pending ask |
| `<lookup>question</lookup>` | quick factual lookup | facade spawns read-only sub-agent |

Design properties:

- **Zero round trips.** A directive costs nothing beyond the tokens of the tag. There is no tool-result turn, no second LLM call for the talker.
- **Pointer, not paraphrase.** The reasoner receives the conversation deltas anyway (log routing), so the directive does not need to restate the user's request accurately; the reasoner reads the user's own words. This removes the lossy-orchestrator failure mode of tool-call delegation.
- **Precedent.** MoshiRAG's `<ret>` token, DuplexOmni's `[THINK]`/`[WAIT]`, DuplexSLA's action channel: the convergent industry pattern is delegation as a token in the output stream.

Parsing rules follow the existing working-tags conventions (flat tags, no nesting, unclosed tag tolerated at stream end). Directives are stripped from the user-facing text exactly like `<working>` content.

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

Stale results are never dropped (the Nova 2 Sonic position): a delivery that arrives after the user changed direction still enters the log and the talker's context; the talker reconciles conversationally. Explicit `<cancel>` is the only discard path.

## Permission Brokering

Today a permission ask blocks the asking loop while the consumer's `resolvePermission` callback decides. In duplex, asks flow through the conversation:

```
sub-agent hits ask-gated tool
  -> resolver wrapper creates ask entry {askId, loopPath, toolName, args}  (log, wake: interrupt)
  -> talker voices the ask
  -> user answers in speech/text
  -> talker emits <answer ask="id">allow|deny reason</answer>
  -> facade settles the pending resolver promise
  -> asking loop proceeds or receives the block
```

Required mechanics, from the coordination audit:

- **Ask identity.** The current resolver signature `(toolName, args)` is anonymous; with N loops the consumer cannot attribute or correlate. The wrapper adds `{askId, loopPath}` context (P1 loop-identity work).
- **Queryable pending set.** Today `pendingPermission` is one nullable slot per tracked child, readable only via snapshots. The broker keeps a facade-level collection so asks can be enumerated, voiced in order, and answered out of order.
- **Abort-race.** pi awaits `beforeToolCall` before checking the abort signal, so a pending ask currently hangs abort/destroy into the 8-second force-kill path. The Cortex wrapper races the consumer's decision against the loop's abort signal and returns a block on abort (P0; no pi change).
- **Timeout.** Asks carry an optional timeout with a configurable default resolution (deny with reason), so an unanswered ask cannot wedge a task forever.

In passthrough mode the broker is bypassed and `resolvePermission` behaves exactly as today.
