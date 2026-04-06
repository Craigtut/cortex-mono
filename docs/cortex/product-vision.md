# Cortex: Product Vision

## The Problem

Modern LLM agent frameworks treat the context window as a flat, append-only buffer. You push messages in, the conversation grows, and eventually you hit the limit. At that point, most frameworks either truncate from the front (losing critical context) or summarize everything into a lossy blob. Neither approach gives you real control.

This becomes a serious problem for agents that need to operate continuously: long-running sessions, autonomous agents, agents that manage complex state across many turns. These agents need context that is both highly dynamic (changing every call) and highly stable (preserving prompt cache across calls). Those two goals are in direct tension, and no existing framework resolves that tension well.

Cortex exists to solve this problem. It provides fine-grained, structured control over what the model sees, organized to maximize prompt cache stability even as context changes dynamically throughout operation.

## Origin

Cortex was originally built for [Animus](https://github.com/Craigtut/animus), an autonomous AI assistant with a persistent inner life. Animus operates on a heartbeat loop: every tick, it gathers context from multiple sources (observations, memories, emotional state, active contacts, goals, tasks), runs an agentic loop with tool access, and produces responses. This creates a uniquely demanding context management problem:

- Context changes every tick, but most of it changes incrementally, not wholesale.
- Some context is permanent (identity, core memories), some is semi-stable (goals, recent observations), and some is fully ephemeral (current emotional state, tick trigger details).
- The agent runs indefinitely, so context will inevitably exceed the window. Compaction must be graceful, not catastrophic.
- Cost matters. Prompt caching discounts (up to 90% on Anthropic) make the difference between viable and prohibitively expensive for a continuously running agent.

No existing agentic loop framework provided the level of context control needed. The underlying loop library, `@mariozechner/pi-agent-core`, is deliberately minimal: it provides the agentic loop and nothing else. Cortex wraps it with everything needed to manage context in production: structured slots, ephemeral injection, three-layer compaction, skills, tools, and provider management.

## Core Insight: Context as a Managed Surface

The central idea behind Cortex is that the context window is not a chat log. It is a **managed surface** that the application dynamically composes before every LLM call. Different regions of that surface have different lifecycles, different stability characteristics, and different relationships to prompt caching.

Cortex structures the context window into four distinct regions:

```
┌─────────────────────────────────────────────────┐
│  SLOT REGION                                    │  Named, persistent, stability-ordered
│  Position 0..N-1                                │  Most stable content at the top
├─────────────────────────────────────────────────┤
│  CONVERSATION HISTORY                           │  Grows organically with the agentic loop
│  Positions N..M                                 │  Managed by compaction when it grows too large
├ ─ ─ ─ ─ ─ PREFIX CACHE BOUNDARY ─ ─ ─ ─ ─ ─ ─ ┤
│  EPHEMERAL CONTEXT                              │  Rebuilt every LLM call
│  Never persisted                                │  Changes here never invalidate the cache above
├─────────────────────────────────────────────────┤
│  CURRENT PROMPT                                 │  The input for this call
└─────────────────────────────────────────────────┘
```

This layout is not incidental. It is the product of a key optimization: **stable content at the top, volatile content at the bottom**. All major LLM providers (Anthropic, OpenAI, Google) cache the longest unchanged prefix from the start of the request. By placing the most stable content first and the most volatile content last, Cortex maximizes the portion of each request that hits cache.

## Slots: Named, Ordered Context Blocks

Slots are persistent, named content blocks at the start of the message array. They are defined at agent creation with a fixed order. The consumer populates them with whatever content makes sense for their domain.

The ordering is the key design decision. The first slot (position 0) is the most stable and gets the best cache life. Content that rarely changes (identity, credentials, core configuration) goes first. Content that changes more frequently (recent observations, active tasks) goes later. When a slot in the middle updates, the prefix before it survives in cache; only that slot and everything after it incurs a cache miss.

This enables a pattern that would be impossible with a flat context buffer: **the consumer can update a single aspect of context without invalidating everything else.** If only the "goals" slot changes, the identity slot, the user profile slot, and the project context slot all remain cached.

For Animus, this manifests as splitting observation streams into separate slots (thoughts, experiences, messages), each with its own update cadence. When only thought observations compress, the experience and message observation slots remain cached. This granularity is what makes continuous operation cost-effective.

Cortex imposes no formatting on slot content. The consumer provides the full string, including any XML wrapping or structure they choose. Cortex just places it at the right position. This keeps the framework general-purpose while giving consumers complete control over what the model sees.

## Ephemeral Context: Volatile Without Cost

Ephemeral context is content the model should see for a single call but that should not persist in conversation history. It is injected at the end of the message array via `transformContext`, below the prefix cache boundary.

This placement is intentional: because ephemeral content sits below the cache boundary, it can change every single call without invalidating any of the cached content above it. The slots stay cached, the conversation history stays cached, and only the ephemeral region and current prompt are billed at full input price.

## Three-Layer Compaction: Graceful Context Management

Context grows. For a continuously running agent, it will always eventually exceed the window. Cortex handles this with a graduated three-layer compaction strategy that avoids cliff-edge failures:

**Layer 1 (Microcompaction):** Progressively trim old tool results. Tool outputs (file reads, bash results, web fetches) are the largest individual items in context. Microcompaction reduces them in stages: first to semantic bookends (head + tail), then to one-line placeholders. The agent's own analytical text is never touched. This is pure string manipulation with zero LLM calls, triggered at 40%, 50%, and 60% of context capacity. Between threshold crossings, the trimmed content is stable, so the prefix cache rebuilds.

**Layer 2 (Summarization):** At 70% capacity, summarize older conversation history into a structured summary while preserving a tail of recent turns verbatim. This uses the primary model (not a cheaper utility model) because the summary is the only record of what happened during agentic loops. The consumer receives `onBeforeCompaction` and `onPostCompaction` events to coordinate domain-specific work.

**Layer 3 (Emergency Truncation):** If summarization fails or context still exceeds 90%, drop the oldest turns one at a time. This is a safety net, not a primary strategy.

The key insight is that slots are never touched by compaction. They are managed independently by the consumer and rebuilt from authoritative sources. This means the agent's core context (identity, configuration, observation summaries, goals) survives indefinitely, regardless of how many compaction cycles occur.


## Design Principles

1. **Context is a managed surface, not a chat log.** Structure it, order it for caching, update it granularly.

2. **Stable at the top, volatile at the bottom.** Maximize the prefix cache hit rate across calls.

3. **Graduated compaction, not cliff edges.** Cheap operations first (string trimming), expensive operations only when needed (LLM summarization), emergency fallbacks as a safety net.

4. **Mechanism, not policy.** Cortex provides hooks and callbacks. Consumers implement domain-specific logic. No application concerns leak into the framework.

5. **Slots are sacred.** Core context survives indefinitely, independent of conversation history compaction.

6. **No persistence opinions.** The consumer owns storage. Cortex owns the in-memory context surface.

## The Full Picture

Cortex wraps `@mariozechner/pi-agent-core` with production capabilities: MCP tool support, tool permissions, budget guards, a skill system with progressive disclosure, event logging, built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebFetch, SubAgent), and multi-provider management with OAuth support.

But the core value, the reason Cortex exists as a separate framework, is the context management layer. The slot system, the ephemeral region, and the three-layer compaction strategy together give consumers fine-grained control over a highly dynamic context surface while maximizing prompt cache stability. For continuously running agents, this is the difference between a viable architecture and one that degrades, costs too much, or simply breaks.
