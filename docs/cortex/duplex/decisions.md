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

This covers **mid-session writes**, not only construction. 2b-i wired initial slots to both loops but left `getContextManager()` returning the reasoner's manager, so a consumer updating a persona slot mid-session would silently diverge the two loops. The facade's `getContextManager()` therefore returns a fan-out view: writes reach both loops, reads come from the reasoner. A per-slot routing knob remains forbidden.

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
- **Injection by echo.** Tags are parsed from text, and untrusted text (tool output in deliveries, stdout in headlines, file contents in lookup results, users saying tag syntax) constantly enters the talker's context; an echoed `<answer>` would forge a permission decision. Tool calls cannot be echoed into existence: invocation requires a deliberate structured call. This closes echo, and only echo. **Persuasion is a separate threat and is not mitigated here**: injected text can still argue the talker into making a deliberate call, and tools are marginally worse than tags in this respect because each control-tool result lands in the talker's transcript, so prior `answer_ask(..., allow)` calls accumulate as few-shot precedent. Persuasion is handled by the router rules in D16, not by this decision.
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

---

The decisions below were added after the pre-implementation reviews. See review-findings.md for the findings that produced them.

## D16: Consent Is Bound by the Router, Not by the Talker

Validating that an askId exists and is pending establishes well-formedness, not authorization. The router enforces:

- exactly one ask is voiced at a time;
- `allow` is accepted only for the most-recently-voiced ask, only once, and **only from a talker turn whose causation chain includes a user utterance that arrived after the ask was voiced**. A turn triggered purely by a delivery, a headline refresh, or a lookup wake cannot grant permission, which is precisely the shape an injected-content persuasion attempt takes;
- `deny` is unrestricted;
- anything else returns a voiceable refusal and re-voices the pending ask. (The refusal costs one recovery turn and leaves the anomaly in the log.)

This makes the log's causation stamps load-bearing for security, not just for observability, so they are built in P2 with the log rather than added later.

**The broker must read the full cause set, never the latest-cause helper.** A run can consume several delivered items with different causes, and the loop exposes all of their tags; `latestCauseSeq` collapses that to one for log-stamping convenience. Collapsing before the check fails in both directions, and they are the same defect:

- **Denies real consent.** Ask voiced at seq 10, user says "yes" at seq 12, an unrelated delivery lands at seq 14, the run carries both. The helper returns 14, which is not an utterance, so a genuine "yes" is refused.
- **Grants consent nobody gave.** Same set, ask voiced at seq 22. The helper returns 25 > 22, so without a type filter the broker accepts a delivery the user never spoke, while the only real utterance predates the ask.

Over a homogeneous utterance-only set the collapse is coincidentally correct, which is exactly why this stays invisible until a second kind of tag exists. So: **cause tags are a discriminated shape carrying kind and seq**, not bare numbers, and the check filters by kind before aggregating. Resolving a bare seq against the log instead would work until retention evicted the entry; a self-describing tag cannot degrade that way. The broker reads the full set through its own port; the collapsing helper stays as-is for log stamping, which is a single-value field and forced to collapse.

One consequence to accept: a single-number `causedBy` on a log entry cannot express multi-cause, so a run that consumed two utterances stamps only the later one. Any consent audit or replay must reconstruct from the live tag set, never from the log alone, or it re-inherits the masking this rule exists to prevent.

As built (`src/duplex/cause-tags.ts`): a tag is `{kind: SessionLogEntryType, seq: number}`, with `kind` reusing the log's own entry-type union and stamped at the site that appended the causing entry rather than resolved later, so a tag cannot disagree with the log and cannot degrade when retention evicts. The loop's `causeTag` slot stays `unknown`, which is right for a general-purpose primitive, so `collectCauseTags` is the only validator between arbitrary input and a consent decision and must stay strict. It also flattens nested sets, because the truncation-repair delivery carries a whole prior set in one slot. The broker reads the full set through `DuplexRouterPorts.currentTalkerCauseTags()`; `currentTalkerCauseSeq` remains the log-stamping collapse and must never be used for consent. Secondary mitigation for the few-shot-precedent problem named in D8: control-tool results are bare uniform receipts, so the transcript carries as little imitable decision text as possible.

These are router rules and never prompt rules, because the talker's judgment is precisely what an attacker targets (review-findings.md F2). Ask entries carry per-ask nonces, a `voiced` state, and a mandatory verbatim `renderedRequest`; the talker reads destructive and escalation requests verbatim rather than summarizing them (F14).

## D17: Control Tools Never Fail Loudly

Every control-tool outcome, including schema-validation failure, unknown task id, and dispatch error, returns `terminate: true` with a bare uniform receipt the talker can voice. Control tools never throw and never return `isError`, because pi's error results omit `terminate` and therefore reopen the loop; combined with an unbounded default `maxTurns` that produces an unbounded retry cycle with no attacker involved (F9). The facade additionally sets a hard low `maxTurns` on the talker rather than inheriting consumer budget config, and failed dispatches produce a lifecycle entry the talker voices so a user instruction never vanishes silently.

**Two exceptions where terminate is deliberately withheld**, both guarding against a silent exchange (the user speaks, hears nothing, and the turn ends):

- **Empty spoken text.** Fast-tier models frequently emit a tool call with no preamble, and `terminate: true` then ends the turn with nothing said. The facade's `afterToolCall` wrapper suppresses terminate when the assistant message's user-facing text (after stripping working tags) is empty, forcing exactly one follow-up turn that speaks. This converts dead air into one extra fast-model call, and uses machinery that already exists: pi passes `assistantMessage` into the hook, and `afterResult.terminate` overrides the tool's value.
- **Truncation.** If the talker hits its output cap mid-tool-call, the call may never materialize, leaving a spoken acknowledgment with nothing dispatched and no error anywhere. The facade audits the talker's stop reason and runs a repair turn when a `maxTokens` stop produced no control-tool call.

## D18: Conversation Is Context, Not Instruction

Conversation deltas (both user utterances and talker replies) reach the reasoner queued rather than prompted, wrapped as explicitly context-only. Only a control-tool dispatch starts a reasoner turn.

**Mechanism, settled during 2b-i.** The deltas ride *inside* the next dispatch message as a `<conversation-context>` block, rather than going through the reasoner's loop-owned silent queue. The silent queue flushes only into real prompts, and sweep runs deliberately never flush it (the unwind accounting from Phase 0), so a dispatch parked behind a busy reasoner would have arrived without the conversation it points at. That breaks pointer-not-paraphrase in exactly the busy case this decision exists for. Carrying the block in the dispatch makes the pairing exact in every loop state. The contract this decision asserts (queued not prompted; only dispatches start turns) is unchanged. Without this, every "thanks, that's great" runs a full primary-model turn over the whole session context, and any utterance can drive an agent that acts (F3). Talker replies are included because the reasoner cannot interpret "yes, do that" without its antecedent (F4).

## D19: The Router Applies Backpressure

Wake classes describe intent; they do not bound rate. The router enforces an interrupt token bucket with demotion to `when_idle`, content-hash dedup across recent deliveries, per-turn and per-exchange delegation caps, dispatch dedup on `(loopPath, turnIndex, toolName, argsHash)` to absorb retry-induced double dispatch, and a facade-level aggregate budget guard that exists from the moment duplex is first assembled (F13, F3).

## D20: The Steer Fast-Path Is Removed

Steers always route through the reasoner. Delivering a steer straight to a named child saved one hop and removed the only loop exercising judgment between injected content and a tool-carrying agent (F11).
