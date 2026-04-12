# Observational Memory Architecture

**STATUS**: Architecture (supersedes `observational-memory-strategy.md`)
**Date**: 2026-04-10
**Related docs**: [compaction-strategy.md](./compaction-strategy.md), [cortex-architecture.md](./cortex-architecture.md), [context-manager.md](./context-manager.md)
**Research basis**: [Mastra Observational Memory](https://mastra.ai/research/observational-memory) (source analysis of `mastra-ai/mastra` repository, April 2026)

---

## Overview

Observational memory is an alternative compaction strategy that replaces Layers 1 and 2 (microcompaction + conversation summarization) with a continuous, background-driven compression system. Two background LLM agents (Observer and Reflector) maintain a compressed event log of the conversation, enabling near-infinite session length with high memory fidelity and prompt cache efficiency.

Observational memory is the default compaction strategy. Consumers can opt into the legacy "classic" compaction (L1 + L2) if needed.

### Why This Exists

The current Layer 2 (conversation summarization) has three limitations for long-running sessions:

1. **Blocking**: The agentic loop pauses for an LLM summarization call at 70% context utilization.
2. **Lossy compression**: Narrative summaries lose event-level granularity. Summarizing summaries compounds the loss.
3. **Cache-hostile**: The entire summary is replaced on each compaction, invalidating the prompt prefix cache.

Observational memory solves all three: observation runs in the background (non-blocking), produces event logs rather than narrative prose (preserving granularity through reflection cycles), and uses an append-only format (cache-friendly).

### Core Insight

The system is modeled on human cognition: a "subconscious" observer watches the conversation and extracts structured notes, while a reflector periodically reorganizes and condenses those notes. The main agent (actor) sees only the compressed observations plus a tail of recent raw messages. This achieves 5-40x compression while scoring 84-95% on LongMemEval benchmarks (beating oracle baselines where the LLM was given only the relevant raw conversations).

---

## Design Decisions

These decisions were made during architecture review and override any conflicting assumptions in the earlier strategy proposal.

### 1. Replaces L2, L1 Becomes Cache-Aware

When observational memory is active, conversation summarization (L2) is replaced by the observer/reflector system. L1 (microcompaction) remains active in both strategies and operates in a **cache-aware, token-offset-based** mode: trimming is gated on whether the prompt cache has expired, and trim decisions are based on each tool result's token distance from the most recent message rather than discrete percentage thresholds.

**L1 behavior** (applies to both classic and observational strategies; see [compaction-strategy.md](./compaction-strategy.md#layer-1-tool-result-trimming-microcompaction) for the full algorithm):

- **Cache check**: Cortex resolves the active provider's cache TTL from `PROVIDER_CACHE_CONFIG` based on the current `CacheRetention` setting (Anthropic short: 5 min / long: 1 hr; OpenAI short: 10 min / long: 24 hr; Google/Mistral/Azure: no caching, L1 runs freely). On each `transformContext`, L1 checks whether the elapsed time since the last LLM call exceeds the TTL.
- **Trim floor**: Even when the cache is cold, L1 only runs above 25% context utilization. This prevents pointless work on nearly empty contexts.
- **Hot zone**: When trimming runs, tool results within `max(hotZoneMinTokens, contextWindow * hotZoneRatio)` tokens of the most recent message stay full. Defaults: 16,000 tokens floor, 5% ratio. Non-reproducible tools get an extended hot zone.
- **Progressive bookend degradation**: Beyond the hot zone, bookend size shrinks linearly across the degradation span (default 40% of context window) from `bookendMaxChars` (2,000) down to `bookendMinChars` (256).
- **Beyond the degradation span**: Tool results become placeholder (most categories) or clear (ephemeral only).

In the observational strategy, L1 runs **after** the observer/reflector activates buffered chunks and trims observed messages from the source history. L1 then trims any remaining tool results in the unobserved tail before the prompt is sent to the LLM. This lets the observer process full-fidelity source messages while the LLM prompt benefits from tool result trimming.

**Phase 0** (insertion-time cap) always runs regardless of strategy or cache state. It caps individual tool results at `maxResultTokens` and enforces `maxAggregateTurnTokens`. This is a safety mechanism that prevents a single massive tool result from blowing up context.

Layer 3 (emergency truncation) is unchanged and serves as the safety valve.

### 2. Percentage-Based Thresholds on Total Context Utilization

Thresholds are expressed as percentages of the total context window, not fixed token amounts. This supports any context window size from 32k to 1M+.

The observation threshold is based on **total context window utilization**, not just message tokens. This includes system prompt, consumer slots, the observation slot, and raw messages. If a consumer bloats their slots, the effective message budget shrinks and observation activates sooner.

### 3. Observations Live in a Context Slot

Observations are stored in a Cortex-managed context slot (`_observations`) at the last slot position (after all consumer slots, before conversation history). This provides:

- Stable prefix for cache optimization (observation content changes infrequently)
- Clean separation from conversation history
- Consistent slot management via the existing `ContextManager`

The slot is managed internally by the `ObservationalMemoryEngine`. Consumers never interact with it directly.

### 4. Dynamic Buffer Intervals

Buffer intervals are computed dynamically at each turn boundary based on current context utilization. The interval targets roughly 4 buffer cycles between the current utilization and the activation threshold, capped at a maximum token count to prevent oversized observer calls on large windows. This adapts naturally to any context window size and any consumer slot configuration without assuming a fixed "message budget."

### 5. Consumer Hooks for Coordination

Two method-level event hooks notify consumers of observation lifecycle events: `agent.onObservation()` and `agent.onReflection()`. These follow the same registration pattern as `agent.onBeforeCompaction()` (multiple handlers, register at any time). They enable consumers with their own compaction systems (e.g., Animus's thought/experience compression) to coordinate their compaction timing with Cortex's.

### 6. Optional Recall via Consumer-Provided Search

Cortex provides an opinionated but minimal recall tool interface. Observations include timestamps. A consumer can provide a `search` function that accepts a query and optional time range. Cortex registers a recall tool that wraps it. Consumers own message persistence and search implementation.

### 7. Observer/Reflector Prompts

Default prompts are adapted from Mastra's proven prompts (94.87% on LongMemEval). Consumers can append custom instructions but cannot replace the core prompt. This ensures a quality baseline while allowing domain-specific customization.

### 8. No Observation Editing

Agents cannot directly edit their observations. Corrections flow naturally through the observer: the user says "no, I meant X," the next observation captures the correction, and the reflector reconciles it with the original. A `triggerObservation()` method allows consumers to force an observation cycle if needed (e.g., after a critical correction).

### 9. No Pinned Observations

Observations are not pinnable. Long-term memory that must survive indefinitely is a consumer concern (vector databases, persistent storage). The observation system is for context compression, not permanent storage. Archive pointers and observation group ranges are not used; consumers who need recall implement their own persistence and search.

### 10. L3 Never Truncates Observations

Emergency truncation only removes raw messages, never observation content. If messages are growing faster than the observer can compress, a synchronous observation is forced before any truncation happens.

---

## Configuration

### Strategy Selection

```typescript
interface CortexCompactionConfig {
  // Strategy selection
  strategy?: 'observational' | 'classic';  // default: 'observational'

  // Classic-specific (used when strategy === 'classic')
  microcompaction?: Partial<MicrocompactionConfig>;
  compaction?: Partial<CompactionConfig>;
  adaptive?: Partial<AdaptiveThresholdConfig>;

  // Observational-specific (used when strategy === 'observational')
  observational?: Partial<ObservationalMemoryConfig>;

  // Always active regardless of strategy
  failsafe?: Partial<FailsafeConfig>;
}
```

When `strategy` is `'observational'` (or omitted), observational memory handles compression. L1 threshold trimming and L2 summarization are disabled. When `'classic'`, the existing L1 + L2 + L3 system operates unchanged.

### ObservationalMemoryConfig

```typescript
interface ObservationalMemoryConfig {
  /**
   * Percentage of total context window utilization that triggers observation
   * activation. When total context (system prompt + slots + observations +
   * messages) exceeds this fraction of the context window, buffered
   * observations activate and raw messages are trimmed.
   * @default 0.9
   */
  activationThreshold?: number;

  /**
   * Maximum token count per async buffer observation. Caps how many tokens
   * of unobserved messages a single observer call will process. Prevents
   * oversized observer calls on large context windows.
   * The actual interval is computed dynamically (see Observer System section).
   * Internally clamped to utilityModelContextWindow * 0.6 to ensure the
   * observer input fits within the utility model's context window.
   * @default 30_000
   */
  bufferTokenCap?: number;

  /**
   * Minimum tokens of unobserved messages before a buffer observation runs.
   * Prevents thrashing when the context window is nearly full or on very
   * small windows.
   * @default 5_000
   */
  bufferMinTokens?: number;

  /**
   * Target number of buffer cycles between current utilization and the
   * activation threshold. Higher = more frequent, smaller observer calls.
   * Lower = fewer, larger observer calls.
   * @default 4
   */
  bufferTargetCycles?: number;

  /**
   * Fraction of the context window at which reflection triggers.
   * When the observation slot exceeds this percentage of the context window,
   * the Reflector condenses it. Scales naturally across all window sizes.
   * Internally clamped to utilityModelContextWindow * 0.5 to ensure the
   * reflector input fits within the utility model's context window.
   * @default 0.20
   */
  reflectionThreshold?: number;

  /**
   * Fraction of reflectionThreshold at which async reflection buffering
   * begins. e.g., 0.5 = start background reflection at 50% of threshold.
   * @default 0.5
   */
  reflectionBufferActivation?: number;

  /**
   * Token budget for previous observations sent to the Observer as context.
   * Provides continuity between observation cycles.
   * @default 2_000
   */
  previousObserverTokens?: number;

  /**
   * Custom instructions appended to the Observer's system prompt.
   * Use for domain-specific observation behavior.
   */
  observerInstruction?: string;

  /**
   * Custom instructions appended to the Reflector's system prompt.
   * Use for domain-specific reflection behavior.
   */
  reflectorInstruction?: string;

  /**
   * Optional recall tool. When provided, Cortex registers a recall tool
   * that enables the agent to search through persisted conversation history.
   * The consumer owns message persistence and search implementation.
   */
  recall?: {
    search: (
      query: string,
      options?: { timeRange?: { start?: Date; end?: Date } }
    ) => Promise<RecallResult[]>;
  };
}
```

### Event Types

```typescript
interface ObservationEvent {
  /** The raw messages that were compressed and removed from context. */
  compactedMessages: AgentMessage[];
  /** The observation text those messages were compressed into. */
  observations: string;
  /** Total context utilization (0-1) at the time of activation. */
  contextUtilization: number;
  /** Whether this was a sync (blocking) or async (buffered) observation. */
  sync: boolean;
  /** Timestamp of the observation. */
  timestamp: Date;
}

interface ReflectionEvent {
  /** Observations before reflection. */
  previousObservations: string;
  /** Observations after reflection. */
  newObservations: string;
  /** How many reflection generations have occurred in this session. */
  generationCount: number;
  /** Compression level used (0-4). */
  compressionLevel: number;
  /** Timestamp of the reflection. */
  timestamp: Date;
}

interface RecallResult {
  /** The message or tool result content. */
  content: string;
  /** When the message occurred. */
  timestamp: Date;
  /** Type of content. */
  type: 'message' | 'tool-result' | 'tool-call';
  /** Message role. */
  role?: 'user' | 'assistant';
}
```

---

## Context Layout

When observational memory is active, the message array layout is:

```
Message Array:
┌─────────────────────────────────────────┐
│ SLOT REGION (0..N-1)                    │  Consumer-managed, named slots
│   [slot 0: system context]              │
│   [slot 1: thoughts]                    │
│   [slot 2: experiences]                 │
│                                         │
│ OBSERVATION SLOT (N)                    │  Cortex-managed, last slot position
│   [observations + current-task +        │  Stable prefix, cache-friendly
│    suggested-response]                  │  Changes only on activation/reflection
│                                         │
├─────────────────────────────────────────┤
│ RAW MESSAGE REGION (N+1..M)             │  Unobserved messages, append-only
│   [user message]                        │  Grows between observation cycles
│   [assistant response]                  │
│   [tool_use + tool_result]              │
│   [user message]                        │
│   ...                                   │
│                                         │
│ EPHEMERAL CONTEXT (injected)            │  Per-call, never stored
│   [skill buffer, background tasks]      │
│                                         │
│ CURRENT INPUT                           │  This turn's prompt
└─────────────────────────────────────────┘

Cache behavior:
  Slots + Observation slot = stable prefix → CACHE HIT (between activations)
  Raw messages = appending suffix → new tokens each turn
  On activation: observation slot updates, raw messages trimmed → partial cache miss
  On reflection: observation slot rewritten → full cache miss (rare)
```

### Slot Registration

When `strategy === 'observational'`, Cortex appends `'_observations'` to the consumer's slot list during agent construction. This is transparent to the consumer:

- Consumer configures: `slots: ['system-context', 'thoughts', 'experiences']`
- Cortex internally registers: `['system-context', 'thoughts', 'experiences', '_observations']`
- `slotCount` becomes 4 (consumer's 3 + 1 internal)
- All compaction operations use `slotCount` to skip the slot region, naturally including the observation slot

The observation slot content is a user-role message containing:
1. Context preamble (instructions for the agent on how to use observations)
2. `<observations>` block with the formatted observation log
3. `<current-task>` with the agent's current task
4. `<suggested-response>` with a continuation hint

---

## Observer System

### When It Runs

The observer runs asynchronously in the background. The interval between observer calls is computed dynamically at each turn boundary based on current context utilization. There is no fixed "message budget"; the system adapts to whatever space is actually available.

**Interval calculation (at each `turn_end`):**

```typescript
// Current state
const totalTokens = systemPromptTokens + slotTokens + observationTokens + messageTokens;
const currentUtilization = totalTokens / contextWindow;

// How many tokens remain before activation triggers?
const tokensUntilActivation = (activationThreshold - currentUtilization) * contextWindow;

// Target N buffer cycles between now and activation
const dynamicInterval = tokensUntilActivation / bufferTargetCycles;

// Cap at maximum (prevent huge observer calls, respect utility model window)
// Floor at minimum (prevent thrashing when nearly full)
const effectiveBufferCap = Math.min(bufferTokenCap, utilityModelContextWindow * 0.6);
const bufferInterval = Math.max(
  Math.min(dynamicInterval, effectiveBufferCap),
  bufferMinTokens
);
```

**How this adapts:**

- `bufferTargetCycles` (default 4) controls granularity: the system aims for ~4 observer calls between current state and activation
- `effectiveBufferCap` (bufferTokenCap clamped to utility model window) prevents oversized observer calls
- `bufferMinTokens` (default 5k) prevents thrashing near the activation threshold
- As the window fills up, intervals naturally shorten (more frequent, smaller buffers)
- If consumer slots grow mid-session, `tokensUntilActivation` shrinks, intervals shorten automatically
- No assumption about how much space is "for messages" vs other context

**Example scenarios** (assuming 15k of system prompt + consumer slots, negligible observations early in session):

| Context Window | At 50% Util | Tokens Until 90% | Dynamic Interval | Capped At |
|---|---|---|---|---|
| 32k | 16k used | ~13k | ~3.2k | 5k (floor) |
| 100k | 50k used | ~40k | ~10k | 10k |
| 200k | 100k used | ~80k | ~20k | 20k |
| 500k | 250k used | ~200k | ~50k | 30k (cap) |
| 1M | 500k used | ~400k | ~100k | 30k (cap) |

As utilization increases toward 90%, intervals shrink:

| Context Window | At 80% Util | Tokens Until 90% | Dynamic Interval | Capped At |
|---|---|---|---|---|
| 100k | 80k used | ~10k | ~2.5k | 5k (floor) |
| 200k | 160k used | ~20k | ~5k | 5k |
| 1M | 800k used | ~100k | ~25k | 25k |

### Trigger Mechanism

At each agentic turn boundary (`turn_end` event):

1. Compute unobserved message tokens (messages after the observation watermark)
2. If unobserved tokens >= `bufferInterval` AND no observer is currently in flight:
   - Snapshot the unobserved messages
   - Launch the observer asynchronously (do not await)
   - Track the in-flight promise
3. When the observer completes:
   - Parse the output (observations, current-task, suggested-response)
   - Store as a buffered observation chunk
   - Advance the buffer watermark

### Activation

In `applyInTransformContext()` (fires before each LLM call):

1. Compute total context utilization
2. If utilization >= `activationThreshold` (90%):
   a. If buffered observation chunks exist:
      - Merge all completed chunks into the observation slot content
      - Remove observed messages from `agent.state.messages` (messages covered by completed chunks only; in-flight observer messages stay as raw)
      - Reset completed buffer state
   b. If utilization is still >= `activationThreshold` after step (a) (no buffers existed, or buffers weren't enough):
      - Run the observer synchronously on remaining unbuffered messages
      - Merge sync observations into the observation slot
      - Remove the observed messages
   c. Update `_prePromptMessageCount`
   d. Reset microcompaction cache
   e. Fire `onObservation` with the compacted messages and new observations
   f. Check observation slot tokens against reflection threshold

**In-flight observer handling:** Activation only removes messages covered by completed buffer chunks. If an async observer call is in-flight, its messages remain in context as raw messages. When the in-flight observer completes, its chunk becomes the first chunk for the next activation cycle.

```
Before activation:
  [slots] [chunk1 ✓] [chunk2 ✓] [observer in-flight...] [unbuffered]

After activation:
  [slots] [observation slot updated] [in-flight msgs kept] [unbuffered]
```

### Observer Prompt

Adapted from Mastra's observer prompt. Key structure:

```
System: "You are the memory consciousness of an AI assistant. Your
observations will be the ONLY information the assistant has about
past interactions."

Input:
  - Previous observations (tail-truncated to previousObserverTokens)
  - Formatted message history (with timestamps, tool results)

Output (XML):
  <observations>
  Date: Apr 10, 2026
  * 🔴 (14:30) [high-priority observation]
  * 🟡 (14:32) [medium-priority observation]
    * -> [detail]
    * ✅ [completed item]
  </observations>

  <current-task>
  - Primary: What the agent is currently working on
  - Secondary: Other pending tasks
  </current-task>

  <suggested-response>
  Hint for the agent's next message after observation activates
  </suggested-response>
```

Priority levels (inter-agent signaling, guides the reflector):
- 🔴 Critical: user facts, preferences, assertions, key decisions
- 🟡 Medium: project details, tool results, contextual information
- 🟢 Low: background context, minor details
- ✅ Completed: resolved tasks, answered questions

The consumer can append domain-specific instructions via `observerInstruction`.

### Message Formatting for Observer

Messages are formatted with temporal context for the observer:

```typescript
function formatMessagesForObserver(messages: AgentMessage[]): string {
  // Each message formatted as:
  // **role (HH:mm)**: content
  // Tool calls: formatted with tool name, key arguments, result summary
  // Tool results: formatted with tool name and content
  // Timestamps derived from message metadata or inferred from position
}
```

Tool results receive special formatting: the tool name is prominent, results are presented with enough context for the observer to extract takeaways without needing the full output.

---

## Reflector System

### When It Runs

The reflector condenses observations when the observation slot exceeds the effective reflection threshold. The threshold is percentage-based, scaling with the context window and clamped to the utility model's capacity:

```typescript
const effectiveReflectionThreshold = Math.min(
  contextWindow * reflectionThreshold,    // default: 20% of context window
  utilityModelContextWindow * 0.5         // ensure input fits in utility model
);
```

Like the observer, the reflector runs asynchronously.

### Trigger Mechanism

After each observation activation:

1. Estimate tokens in the observation slot
2. If observation tokens >= `effectiveReflectionThreshold * reflectionBufferActivation` (50%):
   - Launch the reflector asynchronously
3. If observation tokens >= `effectiveReflectionThreshold`:
   - If a buffered reflection is ready, swap it in
   - Otherwise, force a synchronous reflection

### Compression Levels

The reflector retries with escalating compression when output exceeds the target:

| Level | Detail | Guidance |
|---|---|---|
| 0 | Full | No compression guidance (first attempt) |
| 1 | 8/10 | Gentle: condense beginning more |
| 2 | 6/10 | Aggressive: merge repeated tool calls |
| 3 | 4/10 | Heavy: summarize oldest 50-70% into paragraphs |
| 4 | 2/10 | Maximum: collapse ALL tool sequences to outcomes only |

Maximum 3 retries from starting level. Each reflection increments `generationCount`.

### Reflector Prompt

Adapted from Mastra's reflector prompt:

```
System: "You are the observation reflector. Your reason for existing
is to reflect on all the observations, re-organize and streamline
them, and draw connections and conclusions between observations.

IMPORTANT: your reflections are THE ENTIRETY of the assistant's
memory. Any information you do not add to your reflections will be
immediately forgotten."

Guidance:
  - Preserve dates/times when present
  - Combine related items
  - Preserve ✅ completion markers
  - Condense older observations more aggressively, retain detail for recent
  - User assertions ("User stated X") take precedence over questions
```

The consumer can append domain-specific instructions via `reflectorInstruction`.

---

## Threshold System

### Total Context Utilization

All threshold decisions use total context utilization:

```typescript
const totalTokens = systemPromptTokens + slotTokens + observationTokens + messageTokens;
const utilization = totalTokens / contextWindow;
```

This means:
- If consumer slots grow, message budget shrinks, observation activates sooner
- If the consumer calls `setContextWindowLimit()` to a smaller value, all thresholds adjust
- The system gracefully handles any context window size

### Utility Model Context Window Constraints

Both the observer and reflector run on the utility model. Their inputs must fit within the utility model's context window. Two internal clamps enforce this:

```typescript
// Observer: each buffer call must fit in the utility model
const effectiveBufferCap = Math.min(
  bufferTokenCap,                         // consumer config (default 30k)
  utilityModelContextWindow * 0.6         // 60% of utility model window
);
// The remaining 40% accommodates the observer prompt (~4k tokens),
// previous observations context (~2k tokens), and output.

// Reflector: the full observation input must fit in the utility model
const effectiveReflectionThreshold = Math.min(
  contextWindow * reflectionThreshold,    // 20% of primary model window
  utilityModelContextWindow * 0.5         // 50% of utility model window
);
// The remaining 50% accommodates the reflector prompt (which embeds the
// full observer instructions for format understanding) and output.
```

These clamps are internal implementation details, not consumer-facing configuration. They ensure correct behavior regardless of the utility model's capabilities. With common utility models (128k-200k context), the effective caps are 77k-120k for the observer and 64k-100k for the reflector, which are in the right range for quality output.

If the consumer uses a utility model with a very small context window, both observer and reflector calls are naturally bounded to fit, at the cost of more frequent observation and reflection cycles.

### Token Estimation

Uses the existing dual-tracking approach:
- Heuristic: `estimateTokens(text)` = `Math.ceil(text.length / 4)`
- Post-hoc: `_currentContextTokenCount` from the last API response
- Working value: `Math.max(heuristic, postHoc)` to avoid underestimating

### Activation Flow Summary

```
turn_end event fires
  └→ Compute total context utilization
  └→ Compute dynamic bufferInterval from tokensUntilActivation
  └→ Check unobserved message tokens since last buffer
       └→ If unobservedTokens >= bufferInterval AND no observer in flight:
            └→ Snapshot unobserved messages
            └→ Launch async observer (do not await)

transformContext fires (before next LLM call)
  └→ Phase 0: Insertion-time cap (always, regardless of strategy)
  └→ Build context snapshot
  └→ Compute total utilization
       ├→ If utilization >= activationThreshold (90%):
       │    ├→ Activate completed buffers, trim observed messages
       │    ├→ If still >= activationThreshold: force sync observation
       │    ├→ Fire onObservation
       │    └→ Check observation tokens for reflection threshold
       └→ If utilization >= L3 threshold (90% of MODEL window):
            └→ Emergency truncation (messages only, never observations)
  └→ Return final context
```

### Distinction Between Activation Threshold and L3 Threshold

- **Activation threshold** (default 0.9): percentage of the **effective context window** (consumer-imposed limit or model window). This is where observations activate.
- **L3 threshold** (default 0.9): percentage of the **model context window** (the actual model limit). This is the hard safety valve.

When `contextWindowLimit` is set below the model window, there is a gap between activation and L3. For example, with a 200k model window and 100k limit:
- Activation at 90k (90% of 100k)
- L3 at 180k (90% of 200k)

This gap provides ample room for the observation system to operate before the hard limit is hit.

---

## Integration with Existing Compaction

### What Changes in `CompactionManager`

The `applyInTransformContext()` method gains a strategy switch:

```typescript
async applyInTransformContext(context, getHistory, setHistory, getSourceHistory, setSourceHistory) {
  // Phase 0: Insertion-time cap (always runs)
  await this.applyInsertionCap(sourceMessages, slotCount);

  // Compute utilization
  const currentTokens = this.estimateCurrentContextTokens(context);
  const utilization = currentTokens / this._contextWindow;

  if (this._strategy === 'observational') {
    // Observational memory path
    context = await this.observationalEngine.applyInTransformContext(
      context, utilization, getHistory, setHistory, getSourceHistory, setSourceHistory
    );
  } else {
    // Classic path (existing L1 + L2)
    history = await this.microcompaction.apply(history, ...);
    if (shouldCompact(totalAfterMicro, ...)) {
      await runCompaction(...);
    }
  }

  // L3: Emergency truncation (always, uses model window)
  if (shouldTruncate(totalNow, this._modelContextWindow, ...)) {
    // For observational: truncate messages only, never observations
    emergencyTruncate(history, ...);
  }

  return context;
}
```

### What Stays the Same

- Phase 0 insertion-time cap: unchanged, always runs
- L1 cache-aware microcompaction: active in both strategies (only runs when cache is cold)
- Layer 3 emergency truncation: unchanged, always active
- `_currentContextTokenCount` tracking via `turn_end` events: unchanged
- `_contextWindow` / `_modelContextWindow` distinction: unchanged
- Error handling and `isContextOverflow`: unchanged

### What Is Disabled

When `strategy === 'observational'`:
- L2 summarization (`runCompaction()`): disabled, replaced by observer/reflector
- Adaptive threshold system: not applicable (observational memory uses its own threshold system)
- `onBeforeCompaction` / `onPostCompaction`: not fired (replaced by `onObservation` / `onReflection`)

### Migration Path

Observational memory is the default. No configuration change is needed to use it:

```typescript
// Default: observational memory (zero config)
const agent = await CortexAgent.create({
  // observational memory active with sensible defaults
});

// With hooks (method-level, like onBeforeCompaction)
const agent = await CortexAgent.create({});
agent.onObservation((event) => {
  // persist compacted messages if desired
});
agent.onReflection((event) => {
  // coordinate consumer-side compaction
});

// Opt into classic compaction
const agent = await CortexAgent.create({
  compaction: {
    strategy: 'classic',
  }
});
```

---

## Session State

### Saving State

```typescript
// Existing API (conversation history after slots, excludes observation slot)
const history = agent.getConversationHistory();

// New API for observation state
const omState = agent.getObservationalMemoryState();
// Returns: ObservationalMemoryState | null (null if not using observational strategy)
```

### ObservationalMemoryState

```typescript
interface ObservationalMemoryState {
  /** Current observation text (the slot content). */
  observations: string;

  /** Continuation hints from the last observer run. */
  continuationHint: {
    currentTask: string;
    suggestedResponse: string;
  } | null;

  /** Current observation token estimate. */
  observationTokenCount: number;

  /** How many reflection cycles have occurred. */
  generationCount: number;

  /** Buffered observation chunks not yet activated. */
  bufferedChunks: ObservationChunk[];
}

interface ObservationChunk {
  /** The observation text produced by the observer. */
  observations: string;
  /** Token count of messages that were observed. */
  messageTokensObserved: number;
  /** When this chunk was created. */
  createdAt: Date;
  /** Current task from this observation (latest wins on activation). */
  currentTask?: string;
  /** Suggested response from this observation (latest wins on activation). */
  suggestedResponse?: string;
}
```

### Restoring State

```typescript
// Existing API
agent.restoreConversationHistory(history);

// New API
agent.restoreObservationalMemoryState(omState);
// Internally: sets the observation slot content, restores metadata
```

The consumer typically saves both in `onLoopComplete`:

```typescript
agent.onLoopComplete(() => {
  const history = agent.getConversationHistory();
  const omState = agent.getObservationalMemoryState();
  persist({ history, omState });
});
```

And restores after creation:

```typescript
const agent = await CortexAgent.create(config);
agent.restoreConversationHistory(saved.history);
if (saved.omState) {
  agent.restoreObservationalMemoryState(saved.omState);
}
```

### Session Resumption

On resumption, the agent starts with:
- Observation slot populated with previous observations
- `<current-task>` and `<suggested-response>` providing continuity
- Conversation history restored (may include unobserved messages from the previous session)
- Buffered observation chunks that completed before the session was saved are restored alongside other state. In-flight (incomplete) observer operations are lost.

**Buffer rebuild on resumption:** Completed chunks from the previous session are available immediately after restore. The existing async buffering machinery handles resumption naturally:

1. On `restoreObservationalMemoryState()`, Cortex immediately kicks off the first async buffer on any unobserved messages (non-blocking head start before the consumer calls `prompt()`)
2. On the first `turn_end`, the dynamic interval calculation detects unobserved messages and continues async buffering, chunked at `bufferTokenCap`
3. Each subsequent turn rebuilds more of the buffer through normal operation

**Hot resumption edge case:** If the session is restored at high utilization (e.g., 89%) and the first agent turn pushes past the activation threshold, the sync fallback handles it: one blocking observer call on the unbuffered messages, immediate activation, messages trimmed. After that, async buffering is caught up and operates normally. This is at most one blocking pause on the first turn after a hot resumption.

The `<suggested-response>` is particularly valuable on resumption: it tells the agent what it should say next after the gap, enabling smooth continuation even though the raw conversational flow may be sparse.

---

## Recall Tool (Optional)

### When to Use

Recall is for consumers who persist raw messages and want the agent to search back through them. It is entirely optional. Without it, observations are the sole memory and the system works fine for most use cases.

### Architecture

The consumer provides a `search` function. Cortex wraps it in a tool.

```typescript
// Consumer configuration
const agent = await CortexAgent.create({
  compaction: {
    strategy: 'observational',
    observational: {
      recall: {
        search: async (query, options) => {
          // Consumer's search implementation
          // Could use: vector DB, full-text search, SQL, etc.
          return results;
        },
      },
    },
  },
});
```

### Tool Schema

The recall tool registered for the agent:

```typescript
{
  name: 'recall',
  description: 'Search through past conversation history for specific details. ' +
    'Use when your observations mention something but lack the detail needed, ' +
    'or when you need exact content (code, errors, quotes, URLs).',
  parameters: {
    query: { type: 'string', description: 'What to search for' },
    timeRange: {
      type: 'object',
      description: 'Optional time range to narrow results. ' +
        'Use timestamps from your observations for precision.',
      properties: {
        start: { type: 'string', description: 'ISO date string' },
        end: { type: 'string', description: 'ISO date string' },
      },
    },
  },
}
```

### Prompt Instructions

When recall is configured, the observation context preamble includes:

```
Your observations include dates and timestamps. When you need more
detail behind an observation, use the recall tool with the relevant
time range from the observation's timestamp for precision.

Use recall when:
- You need exact content: code, error messages, file paths, specific numbers
- Your observations mention something but lack detail to fully answer
- You want to verify an observation before acting on it

Do not use recall when:
- Your observations already have enough detail
- The question is about general facts or preferences
```

### Temporal Anchoring

The key value Cortex adds to recall is temporal context from observations. The agent sees:

```
Date: 2026-04-10
- 🔴 (14:30) Agent researched auth middleware...
```

And can call:

```
recall(query: "auth middleware research", timeRange: { start: "2026-04-10T14:00", end: "2026-04-10T15:00" })
```

The time range narrows the consumer's search space regardless of their backend (vector, full-text, SQL).

---

## Implementation Plan

### Module Structure

```
packages/cortex/src/compaction/
  index.ts                        -- CompactionManager (updated with strategy switch)
  microcompaction.ts              -- Layer 1 (unchanged)
  compaction.ts                   -- Layer 2 summarization (unchanged)
  failsafe.ts                     -- Layer 3 (updated: never truncate observations)
  observational/                  -- NEW: Observational memory system
    index.ts                      -- ObservationalMemoryEngine (main orchestrator)
    observer.ts                   -- Observer prompts, message formatting, output parsing
    reflector.ts                  -- Reflector prompts, compression levels, output parsing
    buffering.ts                  -- Async buffering coordinator (observer + reflector)
    types.ts                      -- All observational memory types
    constants.ts                  -- Default config, prompt constants
    recall-tool.ts                -- Recall tool factory (conditional registration)
```

### Integration Points in Existing Code

#### `packages/cortex/src/types.ts`

- Add `strategy?: 'observational' | 'classic'` to `CortexCompactionConfig`
- Add `observational?: Partial<ObservationalMemoryConfig>` to `CortexCompactionConfig`
- Add `ObservationalMemoryConfig`, `ObservationalMemoryState`, `ObservationChunk` types
- Add `ObservationEvent`, `ReflectionEvent`, `RecallResult` types

#### `packages/cortex/src/compaction/index.ts` (CompactionManager)

- Add `_strategy` field, set from config
- Instantiate `ObservationalMemoryEngine` when `strategy === 'observational'`
- Add strategy switch in `applyInTransformContext()`
- Wire observer/reflector `CompleteFn` (utility model via `utilityComplete`)
- Add `getObservationalMemoryState()` / `restoreObservationalMemoryState()` methods
- Add `triggerObservation()` method (force sync observation)

#### `packages/cortex/src/compaction/failsafe.ts`

- When observational memory is active, `emergencyTruncate()` must skip observation slot messages
- Add `observationSlotIndex` parameter to identify which messages to protect

#### `packages/cortex/src/cortex-agent.ts`

- In constructor: when `strategy === 'observational'`, append `'_observations'` to slot list
- Wire `ObservationalMemoryEngine` with `utilityComplete` for observer/reflector calls
- Wire `turn_end` event to trigger async buffer check
- Add `onObservation(handler)` / `onReflection(handler)` event registration methods (method-level, consistent with `onBeforeCompaction` pattern, supports multiple handlers)
- Add `getObservationalMemoryState()` / `restoreObservationalMemoryState()` public API
- Add `triggerObservation()` public API
- Register recall tool when `observational.recall` is provided

#### `packages/cortex/src/context-manager.ts`

- No changes needed. The `_observations` slot is registered through the existing slot mechanism.

### Implementation Sequence

1. **Types and configuration** (`observational/types.ts`, `observational/constants.ts`, updates to `types.ts`)
   - Define all interfaces, types, defaults
   - Add strategy field to `CortexCompactionConfig`

2. **Observer** (`observational/observer.ts`)
   - Observer system prompt (adapted from Mastra)
   - `formatMessagesForObserver()`: converts `AgentMessage[]` to observer input
   - `parseObserverOutput()`: extracts observations, current-task, suggested-response from XML
   - `runObserver()`: calls `CompleteFn` with observer prompt, returns parsed output
   - Degenerate repetition detection (retry once on looping output)

3. **Reflector** (`observational/reflector.ts`)
   - Reflector system prompt (adapted from Mastra)
   - `runReflector()`: calls `CompleteFn` with reflector prompt
   - Progressive compression retry (levels 0-4, max 3 retries)
   - `validateCompression()`: check output is below threshold

4. **Buffering coordinator** (`observational/buffering.ts`)
   - Manages async observer and reflector promises
   - At-most-one-in-flight per operation type
   - Buffer interval calculation and trigger logic
   - Abort/cleanup on agent destruction
   - Failed calls logged but do not crash the agentic loop

5. **ObservationalMemoryEngine** (`observational/index.ts`)
   - Main orchestrator class
   - `applyInTransformContext()`: activation check, buffer swap, message trimming
   - `onTurnEnd()`: buffer interval check, async observer trigger
   - State management (observation text, watermarks, chunks, generation count)
   - Observation slot content assembly (preamble + observations + continuation hints)
   - `getState()` / `restoreState()` for session persistence
   - `triggerObservation()` for manual sync observation
   - Event emission (onObservation, onReflection)

6. **Recall tool** (`observational/recall-tool.ts`)
   - `createRecallTool(searchFn)`: factory that produces a `CortexTool`
   - Wraps consumer's search function with temporal parsing
   - Conditional registration (only when `recall` config is provided)

7. **CompactionManager integration** (`index.ts`)
   - Strategy switch in constructor and `applyInTransformContext()`
   - Wire `ObservationalMemoryEngine` with `CompleteFn` and event handlers
   - Expose state save/restore through to engine

8. **CortexAgent integration** (`cortex-agent.ts`)
   - Slot registration for `_observations`
   - Event wiring (turn_end to engine, engine events to consumer hooks)
   - Public API surface (state, events, triggerObservation)
   - Recall tool registration

9. **Tests**
   - Unit: observer prompt formatting and output parsing
   - Unit: reflector prompt and compression validation
   - Unit: buffering coordinator (interval triggers, dedup, abort)
   - Unit: activation (message removal, slot update, watermark)
   - Unit: total context utilization calculation
   - Integration: full pipeline with mocked LLM
   - Integration: strategy switching (classic vs observational)
   - Integration: session state save/restore
   - Integration: recall tool registration and execution

---

## Open Questions (Minor)

### 1. First Observation Cold Start

On the very first observation cycle, no previous observations exist. The observer runs on the initial batch of messages with an empty previous-observations context. This should work naturally (the observer just extracts observations without dedup context), but worth verifying during implementation that the prompt handles the empty case gracefully.

### 2. Reflector Async Buffering Details

Mastra supports async reflection buffering (start at 50% of threshold). The exact mechanics of how buffered reflection swaps into the observation slot while potentially new observations are also being buffered need careful implementation to avoid race conditions. The buffering coordinator must ensure atomic state transitions.

### 3. Dynamic Interval Recalculation

The buffer interval is recomputed at each `turn_end` from current total utilization. When consumer slots change size mid-session, `tokensUntilActivation` changes and the interval adjusts automatically. Implementation must avoid caching the interval across turns.

### 4. Observation Slot Size for Session Resumption

On session resumption with a large observation history, the observation slot may contain significant token counts. This is expected and correct (it's the compressed memory). But it means the effective message budget on resumption is smaller than at session start. The dynamic threshold system handles this naturally.
