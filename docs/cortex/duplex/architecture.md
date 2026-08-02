# Duplex Architecture

> **STATUS: DESIGN, NOT IMPLEMENTED**

## Problem

Cortex's single loop makes responsiveness and depth mutually exclusive. A user message that arrives while the loop is ninety seconds into a tool batch waits for the batch, the turn, and often the whole logical task. For a voice consumer that dead air is fatal; for text consumers it is still the worst part of the experience. The fix is not interrupting generations (impossible over provider HTTP APIs; the turn is the atomic unit) but ensuring some loop always has a short next turn available to the user.

## Shape

```
                         consumer
                            |
                     CortexAgent (facade)
                            |
        +----------- session log (bus) ------------+
        |                                          |
   talker loop                               reasoner loop
   (AgentLoop)                                (AgentLoop)
   fast model, zero tools                     full model, all tools
   owns the floor                             owns the work
        |                                          |
        | quick lookups                            | spawns / steers
        v                                          v
   ephemeral read-only                      sub-agents (AgentLoop)
   sub-agents (facade-spawned)              tier 3, cannot spawn further
```

Everything in the diagram below the facade is invisible to consumers.

## The Primitive: AgentLoop

`AgentLoop` is today's `CortexAgent` class, renamed (see decisions.md D2). One class, three roles, differing only in configuration:

| | Talker | Reasoner | Sub-agent |
|---|---|---|---|
| Lifetime | session | session | one task |
| Model | fast tier (config dial) | primary | per-spawn |
| Tools | none (default) | full set + consumer tools | task-scoped |
| Compaction | own manager (observational default) | own manager | own manager |
| Working tags | on (thinking vs speaking, directives) | on | on |
| Prompted by | facade router | facade router + wake deliveries | reasoner or facade |
| Session ID | distinct, stable | distinct, stable | taskId (existing pattern) |

Every capability of today's agent (slots, ephemeral injection, cache breakpoints, budget guard, event bridge, MCP, skills) exists on every instance. Multiple AgentLoops per process is already the proven-normal case: every sub-agent is one today.

## Role: Talker

The talker's job is presence. It always has a short next turn available: small context, fast model, zero tools, capped output. It acknowledges instantly, answers what is answerable from injected context (status, conversation, small talk, clarification), delegates everything else by emitting directives, and performs the reasoner's deliveries in a register that suits the modality.

The talker is not a dumb relay. The shipped systems this design follows are explicit that the fast layer is a capable model. The split between talker and reasoner is a time budget, not intelligence: the talker handles anything answerable in one short turn from visible context; the reasoner handles anything needing tools, multi-step reasoning, or more than about a second of thought.

Grounding rule (system prompt, enforced by review in scenario tests): the talker condenses and rephrases delivered content; it never states facts about work in progress that are not present in its injected headlines or delivered messages, and never invents the outcome of unfinished work. This addresses the pending-result hallucination failure mode OpenAI documented in the Realtime API.

## Role: Reasoner

The reasoner is today's Cortex agent, unchanged in capability. It is persistent for the whole session and accumulates the durable understanding: codebase knowledge, design decisions, observational memory. All consumer-supplied tools are wired here.

The reasoner is also the scheduler of all work. New direction reaches it as delivered messages at its turn boundaries; it decides to handle work inline or spawn background sub-agents and continue. Because its turn-boundary frequency is the system's pickup latency, the reasoner's operational prompt nudges it to run long shell commands backgrounded and to delegate long parallelizable work to sub-agents.

Exactly one reasoner exists per session. Parallel reasoners were rejected because they fragment the session's accumulated context (decisions.md D3).

## Role: Sub-Agents

Tier 3. Spawned by the reasoner for parallel, long-running, or isolated work; also spawned by the facade in a restricted read-only form for talker-initiated quick lookups (decisions.md D13). Results deliver to the spawner through the existing background-completion path (hardened in P0; see migration-plan.md). Sub-agents cannot spawn further sub-agents.

The reasoner can steer a running sub-agent via the `SteerSubAgent` tool; this is a launch requirement (decisions.md D12, mechanics in sub-agents.md).

## The Facade: CortexAgent

The facade owns:

- the two resident loops and their configuration
- the session log and its routing (log-and-context.md)
- the directive parser attached to the talker's delta stream (communication.md)
- the wake policy and the consumer idle signal (communication.md)
- the permission broker (communication.md)
- quick-lookup spawning and the sub-agent caps (sub-agents.md)
- the unified event stream with loop-identity labels (facade-api.md)
- persistence of the composite state (facade-api.md)
- shared services: the MCP connection multiplexer, skill registration fan-out

Modes:

- `duplex` (default): as described here.
- `passthrough`: the facade routes prompts straight to the reasoner. Single loop, bit-for-bit today's behavior. Exists as the consumer opt-out and as the parity baseline for tests.

## Why This Is the Right Layer

pi-agent-core remains untouched. Its loop, steering queues, hooks (`transformContext`, `beforeToolCall`, `afterToolCall`), and event stream are sufficient primitives; every gap identified by the audits is orchestration above them. The one pi-level nicety identified (checking the abort signal before awaiting `beforeToolCall`) has a clean Cortex-side workaround (abort-racing the resolver in our wrapper).

## Latency Model

Voice-oriented numbers, text benefits proportionally:

- Talker first token: small cached prefix + fast model, target 200-500 ms.
- Talker acknowledgment of delegated work: same turn as the directive; dispatch fires mid-stream when the tag closes, before TTS finishes the sentence.
- Reasoner pickup of new direction: its next turn boundary (seconds when it is between tools; bounded by the longest foreground tool call otherwise, hence the backgrounding nudge).
- Deliverable to user: reasoner completion, then wake policy timing (interrupt is immediate; when_idle waits for the lull).

The natural conversational cover is real: the delay between starting an answer and the load-bearing fact arriving exceeds three seconds in human speech (measured in the MoshiRAG work), which is the window the talker exploits while work lands.
