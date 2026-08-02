# Duplex Architecture

> **STATUS: DESIGN, NOT IMPLEMENTED**

This folder documents the duplex restructure of Cortex: the migration from a single agentic loop to a composite agent with a fast conversational loop (the talker) fronting a persistent deep-work loop (the reasoner). The goal is sub-second first feedback to the user at all times, including while long-running agentic work is in flight, without losing any reasoning power underneath.

The restructure was motivated by a voice-driven consumer, but the responsiveness gains apply to every modality. Duplex is the default mode; consumers can opt out to the classic single-loop behavior.

## The One-Paragraph Version

Consumers interact with one `CortexAgent`. Internally it runs two instances of the loop primitive (renamed `AgentLoop`): a talker with a fast model and no blocking tools that always has the floor, and a reasoner (today's full agent, unchanged in capability) that does all real work and spawns sub-agents for parallel or long tasks. The talker delegates through five fire-and-forget control tools (spawn, steer, cancel, answer, lookup) that dispatch locally in under a millisecond and skip the follow-up LLM call; the reasoner's progress and results flow back through an append-only session log that the facade routes into each loop as ordinary messages or as ephemeral status injections. A wake policy decides when a finished piece of work interrupts the conversation, waits for a lull, or stays silent.

## Documents

| Document | Contents |
|---|---|
| [decisions.md](decisions.md) | The decision record: what was decided, what was rejected, and why |
| [architecture.md](architecture.md) | Tiers, roles, the AgentLoop primitive, the facade, topology rationale |
| [log-and-context.md](log-and-context.md) | The session log, entry types, delivery vs injection, cache and compaction constraints |
| [communication.md](communication.md) | Directives (down-channel), headlines and deliveries (up-channel), wake policy, permission brokering |
| [sub-agents.md](sub-agents.md) | Tier rules, quick lookups, parent-to-child steering, lifecycle and budgets |
| [facade-api.md](facade-api.md) | Consumer-facing API: config, slots, tools, events, persistence, modes |
| [migration-plan.md](migration-plan.md) | Phased build plan (P0 through P3), rollout, and the rename |
| [review-findings.md](review-findings.md) | Pre-implementation review register: what two independent reviews found and how each is resolved |

## Design Anchors

The architecture follows the pattern the industry converged on during 2025-2026:

- **Thinking Machines interaction models** (2026-05): a time-aware interaction model plus an asynchronous background model; delegation sends the full conversation, not a paraphrased query; results stream back and the interaction model chooses the moment to surface them.
- **Talker-Reasoner** (DeepMind, 2024) and successors (Ping-Ponder, SIGDIAL 2026): two loops interacting only through shared memory, with the fast loop reading latest-available state and tolerating staleness.
- **OpenAI Realtime, Gemini Live, LiveKit, Pipecat**: at the API layer, the fast loop's control surface is non-blocking tool calls (AsyncFC formalizes the fire-and-forget contract), which is the pattern adopted here for the talker's control tools.
- **Gemini Live API**: the `INTERRUPT` / `WHEN_IDLE` / `SILENT` result-scheduling vocabulary, adopted here as the wake policy.
- **OpenAI Realtime API**: the documented pending-result hallucination failure mode, addressed here by grounding rules on the talker.

Three internal audits of the existing codebase (public API surface, context pipeline, sub-agent coordination) shaped the mechanics; their constraints are folded into the relevant documents. Two further reviews (design-versus-code consistency, and an adversarial red-team) ran against the completed design before implementation; see review-findings.md.

Work happens on the `duplex-restructure` branch.
