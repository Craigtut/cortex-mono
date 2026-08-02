# Decision Record

> **STATUS: DESIGN, NOT IMPLEMENTED**

Decisions made during the 2026-08 design phase, with rationale and rejected alternatives. Newer decisions supersede older ones where they conflict.

## D1: Build at the Cortex Layer; Do Not Re-implement pi-agent-core

The only capability a pi-agent-core rewrite could theoretically add is token-level interruption of a running generation (the AsyncLM `[INTR]` mechanism). That requires controlling decode, which is impossible when composing provider HTTP APIs. In HTTP-land the turn is the atomic unit; responsiveness comes from keeping the fast loop's turns short, which is orchestration, which is Cortex's mandate. Every identified gap (steering surfacing, delivery primitives, permission brokering, the log) is implementable over existing pi hooks.

## D2: Naming

- `AgentLoop`: the loop primitive. This is today's `CortexAgent` class, renamed. It powers all three roles (talker, reasoner, sub-agent), so the name is role-neutral. "TaskAgent" and "ReasonerAgent" were rejected because the same class runs the talker.
- `CortexAgent`: the composite facade. Consumers keep interacting with "a Cortex agent"; the duplex machinery is internal.

## D3: Topology Is Talker + One Persistent Reasoner + Sub-Agents

Rejected: a pool of parallel task loops at tier 2.

Rationale: parallel reasoners fragment context. The reasoner must understand pretty much everything going on in the session; ephemeral or parallel task loops cold-start without the accumulated codebase understanding, design decisions, and observational memory that make long sessions work. One persistent reasoner preserves that. Parallelism comes from the reasoner spawning sub-agents (tier 3), which is today's proven machinery. This mirrors the Claude Code model: one main loop plus background tasks.

Consequences accepted: the reasoner is the scheduler of all work, and its turn-boundary frequency is the system's pickup latency. Mitigations: the talker acknowledges instantly regardless, long shell commands run backgrounded, and the reasoner's prompt nudges it to background anything long.

## D4: The Talker Is a Full AgentLoop

The talker is not a stripped-down chat wrapper. It has its own compaction (consumers rely on effectively infinite conversation), slots, working tags, and cache management. Default compaction strategy is observational, same as everything else; downgrading the talker to the classic strategy is a tuning option if duplicate observation cost proves material, not an architectural decision.

## D5: The Talker Has No Blocking Tools

The invariant is that the talker's turns are structurally incapable of blocking on tool execution, so the voice channel always has someone home. It carries exactly one fixed toolset: the control tools of D8, all of which are local, sub-millisecond dispatches into the facade. Consumer-supplied tools, I/O tools, and MCP tools are wired to the reasoner and never reach the talker. Status arrives by injection, never by a tool.

(Earlier draft of this decision said "zero tools" with delegation via in-band tags; superseded by D8's reversal. The property being protected, no blocking tools, is unchanged.)

## D6: No Consumer-Facing Slot Routing

Rejected: a per-slot policy (talker-only / reasoner-only / both) on the facade API.

Consumer slots apply to both loops. The consumer should not know the talker/reasoner split exists; that dynamic is Cortex's internal concern. If a large slot ever becomes a talker latency problem, Cortex may optimize placement internally without any API change.

## D7: The Log Is a Bus, Not a Context Projection

Rejected: injecting log-derived synthetic messages into each loop's prompt view via `transformContext`.

The context-pipeline audit killed the projection approach for durable content: view-only injections silently vanish on exactly the turns compaction fires, the observational-memory watermark requires the post-slot source array to be append-only, and insertions between a tool call and its results corrupt tool-call grouping, breakpoint simulation, and compaction atomicity simultaneously.

Instead, the log is an append-only coordination record and routing bus. Content reaches models through exactly two sanctioned channels, split by durability:

- Durable entries (deliverables, directives, permission asks, conversation deltas) are delivered as real transcript messages at turn boundaries, via the same path background results use today.
- Churn (task headlines, live activity) is view-injected outside the BP3 cache boundary, which is today's `<background-tasks>` mechanism.

## D8: Delegation Is a Control Toolset (Reversal of the Tags Draft)

The talker delegates via five fire-and-forget control tools: `spawn_task`, `steer_task`, `cancel_task`, `answer_ask`, `quick_lookup`. Each executes locally in under a millisecond (an array push into the facade) and returns `terminate: true`, which pi-agent-core already honors by skipping the automatic follow-up LLM call (`agent-loop.ts` `shouldTerminateToolBatch`). The spoken acknowledgment streams before the tool call in the same turn, so delegation costs zero extra LLM round trips.

Rejected, after initially being chosen: in-band directive tags parsed from the talker's text stream. The reversal rationale:

- **Wrong-layer transposition.** The control-token systems (MoshiRAG `<ret>`, DuplexOmni `[THINK]`, DuplexSLA's action channel) are custom-trained models that control decode; a token is their only possible interface. Every production system at the HTTP API layer (OpenAI Realtime, Gemini Live, LiveKit, Pipecat, ElevenLabs) uses tool calls for the fast loop's control surface. AsyncFC formalizes the pattern: standard call-return contract, future-style immediate return, no retraining.
- **Injection.** Tags are parsed from text, and untrusted text (tool output in deliveries, stdout in headlines, file contents in lookup results, users saying tag syntax) constantly enters the talker's context; an echoed `<answer>` would forge a permission decision. Tool calls cannot be echoed into existence, and `answer_ask` arguments validate against the pending-ask set.
- **Reliability.** Models are trained heavily on schema'd tool calls with validation and structured retryable errors; bespoke tag grammar on a fast-tier model fails silently.
- **The latency case for tags was overstated.** With `terminate: true` there is no follow-up call; the only remaining difference is dispatch-at-tag-close versus dispatch-at-message-end, which equals the duration of any post-delegation speech, typically nothing and promptable to nothing.

Delegation remains a pointer, not a paraphrase: the reasoner receives the conversation deltas regardless, so tool arguments do not need to restate the user's request accurately.

## D9: No Deliverable Schema

Rejected: a structured deliverable format (`{headline, spoken, full}`).

Over-engineering. The reasoner delivers plain content; the talker is a full agent and decides what to say. The rule that survives is grounding: the talker condenses and rephrases what was delivered, and never states facts not present in deliveries or headlines.

## D10: Wake Policy Vocabulary

Adopted from Gemini Live's result scheduling: a log entry destined for the talker carries `interrupt` (start an unprompted talker turn now), `when_idle` (deliver at the next lull, gated on a consumer-supplied idle signal), or `silent` (available in context, surfaced only when relevant).

## D11: Permission Asks Broker Through the Talker

A reasoner or sub-agent permission ask becomes a log entry with an ask ID, wakes the talker (`interrupt`), is voiced to the user, and the spoken answer returns via the talker's `answer_ask` control tool, which settles the pending resolver. Requires ask identity, a queryable pending-ask collection, and abort-raced resolution (the current resolver await is uninterruptible; Cortex's wrapper fixes this by racing the consumer's decision against the abort signal, no pi change needed).

## D12: Parent-to-Child Steering Is a Launch Requirement

Rejected: cancel-and-respawn as the interim redirect mechanism for running sub-agents.

The reasoner must be able to steer a running sub-agent. Children are full AgentLoops and already have steering queues; the missing pieces are addressability (typed child handles, steer-by-taskId on the sub-agent manager) and a reasoner-facing `SteerSubAgent` tool. The chain: user speaks, talker calls `steer_task`, facade delivers to the reasoner, reasoner calls `SteerSubAgent(taskId, message)`, child's queue drains at its next turn boundary.

## D13: Quick Lookups Are Facade-Spawned, Log-Mediated

While the reasoner is mid-turn and deaf, small factual questions ("what does resolveModel do?") cannot wait for its turn boundary. The facade spawns ephemeral read-only sub-agents for talker-initiated lookups: no write tools, no decision authority, small separate concurrency cap, results wake the talker. Lookup results are appended to the log, so the reasoner sees them at its next turn; shared context is preserved and nothing forks.

## D14: Duplex Is the Default; Passthrough Is the Opt-Out

Both modes are built. Passthrough routes the facade straight to the reasoner and reproduces today's single-loop behavior exactly; it exists for consumers who want it and for parity testing. Duplex ships as the default. Rationale: faster first feedback is close to a pure gain in every modality, and the reasoner is unchanged, so no reasoning power is lost. The accepted tradeoff is a slightly longer time-to-final-answer (acknowledgment plus handoff) in exchange for dramatically better time-to-first-feedback, plus one small-model call per exchange.

## D15: Tier Depth Is Hard-Capped

Tasks at tier 3 (sub-agents) cannot spawn further sub-agents. The reasoner spawns sub-agents; sub-agents are leaves. The existing `enableSubAgentTool: false` hardcode for children becomes configuration that the facade sets by tier.
