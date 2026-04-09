# Observational Memory Compaction Strategy

**STATUS**: Proposal
**Date**: 2026-04-07
**Related docs**: [compaction-strategy.md](./compaction-strategy.md), [cortex-architecture.md](./cortex-architecture.md), [context-manager.md](./context-manager.md)
**Inspiration**: [Mastra Observational Memory](https://mastra.ai/research/observational-memory)

---

## Problem Statement

Cortex's current Layer 2 compaction (conversation summarization) is synchronous and blocking. When context usage hits 70%, the agentic loop pauses mid-turn to run an LLM summarization call, emit lifecycle events, and rebuild context. This creates a noticeable interruption: the agent stalls, the consumer's `onBeforeCompaction` handler runs synchronously, and the user experiences a gap in responsiveness.

Mastra's observational memory research demonstrates a fundamentally different approach: continuous background observation that compresses conversation history incrementally, so context never needs to stop and compact. Their system achieves 5-40x compression ratios while scoring 84-95% on LongMemEval (beating oracle baselines), and the append-only observation format preserves prompt cache efficiency.

This document proposes adding observational memory as an alternative Layer 2 strategy in Cortex, selectable by the consumer at configuration time. The existing summarization strategy remains available and is the default.

---

## Design Principles

1. **Consumer-selectable strategy.** The consumer chooses between `'summarization'` (current Layer 2) and `'observational'` (new) at configuration time. Cortex does not decide which is better for a given use case. Both strategies are always available.

2. **No new external dependencies.** Cortex does not import Mastra. The observational memory implementation is built from first principles within Cortex, using Cortex's existing `CompleteFn` (the same LLM completion interface used by summarization compaction) for Observer and Reflector calls.

3. **Background-first, non-blocking.** The Observer runs asynchronously between LLM calls or in the background during tool execution. The agentic loop never blocks for observation. Activation (swapping raw messages for observations) is an instant, zero-LLM-cost operation.

4. **Cortex owns no persistence.** Observations, buffered chunks, and watermarks are held in memory within the `CompactionManager`. The consumer can persist and restore them via the existing `getConversationHistory()` / `restoreConversationHistory()` contract and new observation-specific hooks.

5. **Slots remain sacred.** Observations are injected into the conversation history region, never into slots. The slot region is still managed independently by the consumer via `ContextManager`.

6. **Layers 1 and 3 are unchanged.** Microcompaction (Layer 1) and emergency truncation (Layer 3) continue to operate exactly as documented. The observational memory strategy replaces only Layer 2.

7. **Cache-optimized.** Observations form a stable, append-only prefix in the conversation history region. New observations are appended; old messages are removed from the tail of the observed region. This preserves the prefix cache boundary.

---

## Architecture Overview

### Strategy Selection

```typescript
interface CortexCompactionConfig {
  microcompaction: MicrocompactionConfig;
  compaction: CompactionConfig;      // Layer 2 summarization (existing)
  failsafe: FailsafeConfig;
  adaptive: AdaptiveThresholdConfig;

  // NEW: Layer 2 strategy selection
  layer2Strategy?: 'summarization' | 'observational';  // default: 'summarization'
  observational?: ObservationalMemoryConfig;            // config when strategy is 'observational'
}
```

When `layer2Strategy` is `'summarization'` (or omitted), the existing compaction system is used unchanged. When `'observational'`, the new system takes over Layer 2.

### Context Layout with Observational Memory

```
Message Array Layout (observational memory active):

SLOT REGION (0..N-1)              -- Persistent, named, managed by ContextManager
  |
OBSERVATION REGION (N..O)         -- Observations (stable, append-only, cache-friendly)
  |  [observation summary msg 1]  -- user-role message with <observations> content
  |  [continuation hint msg]      -- user-role message with current-task + suggested-response
  |
RAW MESSAGE REGION (O+1..M)      -- Recent unobserved messages (grows until threshold)
  |
PREFIX CACHE BOUNDARY             -- Providers cache the longest unchanged prefix
  |
EPHEMERAL CONTEXT (injected)      -- Per-call via transformContext, never stored
  |
USER PROMPT                       -- Current tick input
```

The observation region replaces the compaction summary message from the summarization strategy. Both are user-role messages in the conversation history region. The key difference: observations grow incrementally (append-only), while the summary is replaced entirely on each compaction.

---

## Two-Agent System

### Observer

The Observer is an LLM that watches raw conversation messages and extracts structured observations. It runs in the background at configurable token intervals, producing observation "chunks" that are buffered until activation.

**Responsibilities:**
- Extract structured observations from raw messages (facts, preferences, decisions, tool outcomes, user assertions)
- Track the current task and suggested next response (continuation hints)
- Produce temporally anchored observations with timestamps and priority levels
- Distinguish user assertions from questions, track state changes
- Group related observations (e.g., sequences of tool calls into outcome summaries)

**Output format:** Structured text with emoji-based priority levels (borrowed from Mastra's proven format):
```
Date: Apr 7, 2026
* 🔴 (14:30) User requested refactoring of auth module to use JWT
* 🟡 (14:32) Agent read src/auth.ts, found session-based auth at lines 45-120
  * -> identified 3 middleware functions to update
  * -> noted Express 4.x dependency constraint
* 🔴 (14:35) User clarified: must maintain backward compatibility with existing sessions
* ✅ (14:40) Auth module refactored, tests passing
```

**Model selection:** The Observer uses the utility model configured on the `CortexAgent` (not the primary model). Observation is a compression task, not a reasoning task; a smaller, faster model is appropriate and reduces cost. The consumer can override this via `observational.observerModel`.

### Reflector

The Reflector is an LLM that condenses observations when they grow too large. It reorganizes, merges related items, identifies patterns, drops superseded context, and produces a compressed observation set.

**Responsibilities:**
- Condense observations below the reflection threshold
- Merge related observations across dates
- Identify and preserve cross-cutting patterns and key decisions
- Mark and carry forward completion markers (task done signals)
- Progressive compression with retry at increasing compression levels

**Model selection:** Also uses the utility model by default. The consumer can override via `observational.reflectorModel`.

---

## Processing Pipeline

### Phase 1: Token Counting (every `transformContext` call)

On every `transformContext` invocation, count the tokens in the raw message region (messages after the observation region, before ephemeral content). This is the "pending token count" that drives all threshold decisions.

```
pendingTokens = estimateTokens(messages[observationEnd..historyEnd])
```

### Phase 2: Background Buffering (async, non-blocking)

When `pendingTokens` crosses a buffer interval boundary (default: every 20% of `messageTokens` threshold), launch an async Observer call in the background:

1. Extract the unobserved messages since the last buffer/observation
2. Include the most recent observations as context for the Observer (tail-truncated to `previousObserverTokens`)
3. Call the Observer LLM via `CompleteFn`
4. Parse the output into an observation chunk
5. Store the chunk in an in-memory buffer

The async buffering runs concurrently with the agentic loop. It does not block `transformContext` or the LLM call. If the Observer call is still in flight when the next `transformContext` fires, it is skipped (no duplicate buffering).

### Phase 3: Activation (instant, zero-LLM-cost)

When `pendingTokens` exceeds `messageTokens` (default: 30,000 tokens):

1. Merge all buffered observation chunks into the observation region
2. Remove the raw messages that were observed (everything before the retention floor)
3. Update the continuation hint message
4. Reset the buffer

This is a pure in-memory array operation. No LLM call. The agentic loop is not blocked.

**Retention floor:** After activation, a configurable amount of raw messages are retained (default: 20% of `messageTokens`, roughly 6,000 tokens). This ensures the agent always has some full-fidelity recent context, similar to the preserved tail in summarization compaction.

### Phase 4: Reflection (async, non-blocking)

When the observation region's token count exceeds `observationTokens` (default: 40,000 tokens):

1. Launch an async Reflector call
2. The Reflector receives all current observations and produces a condensed version
3. On completion, replace the observation region with the condensed observations
4. If the Reflector's output is still too large, retry with increasing compression guidance (up to 4 levels)

Reflection also runs in the background. If the observation region is near the threshold but reflection hasn't completed yet, the system continues; Layer 3 (emergency truncation) serves as the safety net.

### Phase 5: Synchronous Fallback (blocking, rare)

If `pendingTokens` exceeds `blockAfter` (default: 1.2x `messageTokens`, i.e., 36,000 tokens) and buffered observations are not yet ready, a synchronous Observer call runs as a last resort. This blocks the agentic loop briefly but prevents context overflow.

This should be rare: it only fires when the conversation grows faster than the async Observer can process, which implies rapid multi-turn exchanges with minimal tool use.

---

## Watermark System

The observational memory system tracks two watermarks:

### Message Watermark

An index (or message ID/timestamp) marking the boundary between "observed" and "unobserved" messages in conversation history. Messages before the watermark have been processed by the Observer and converted into observations. Messages after the watermark are raw and unprocessed.

After activation:
- Messages before the watermark are removed from conversation history
- The watermark advances to the new oldest raw message
- A retention floor of raw messages is preserved for full-fidelity context

### Observation Watermark

Tracks which observations have been processed by the Reflector. When reflection runs, it processes all observations and produces a condensed set. The watermark advances to include the reflected observations.

### Watermark Storage

Both watermarks are held in-memory on the `CompactionManager` (or the new `ObservationalMemoryEngine`). The consumer can persist and restore them alongside conversation history using the existing hooks.

```typescript
interface ObservationalMemoryState {
  observations: string;                    // current observation text
  continuationHint: {
    currentTask: string;
    suggestedResponse: string;
  } | null;
  messageWatermark: number;                // index of oldest unobserved message
  observationTokenCount: number;           // current observation token count
  bufferedChunks: ObservationChunk[];      // pending chunks not yet activated
  reflectionGeneration: number;            // how many times reflection has run
}

interface ObservationChunk {
  observations: string;
  messageTokensObserved: number;
  createdAt: string;
  currentTask?: string;
  suggestedResponse?: string;
}
```

---

## Integration with CompactionManager

The `CompactionManager` gains a new internal component: `ObservationalMemoryEngine`. This engine encapsulates all observation/reflection logic and is instantiated only when `layer2Strategy === 'observational'`.

### Modified `applyInTransformContext` Flow

```
Every LLM call in the agentic loop:
  transformContext fires:
    1. Tier 1 insertion-time cap (unchanged)
    2. Ephemeral context injection (unchanged)
    3. Sanitize messages (unchanged)
    4. Layer 1: Microcompaction (unchanged)
    5. Layer 2: STRATEGY SWITCH
       IF strategy === 'summarization':
         Existing Layer 2 (summarization at 70% threshold)
       IF strategy === 'observational':
         a. Count pending tokens in raw message region
         b. Check buffer interval -> launch async Observer if crossed
         c. Check activation threshold -> activate buffered chunks if exceeded
         d. Check reflection threshold -> launch async Reflector if exceeded
         e. Check blockAfter threshold -> sync Observer as last resort
    6. Layer 3: Emergency truncation (unchanged, uses model context window)
    7. Return final context to model
```

### Key Implementation Details

**Observation injection:** Observations are injected as user-role messages in the conversation history region, after slots and before raw messages. This mirrors how the summarization summary message is positioned. The observation messages are:

1. A "memory context" message containing the `<observations>` block, prefixed by a preamble explaining what observations are
2. A "continuation hint" message containing `<current-task>` and `<suggested-response>` in a `<system-reminder>` tag

**Raw message removal:** When activation fires, raw messages that have been observed are removed from `agent.state.messages`. The observation messages replace them. The `_prePromptMessageCount` boundary is adjusted accordingly, just as it is after summarization compaction today.

**Background task management:** Async Observer and Reflector calls are fire-and-forget Promises tracked by the engine. The engine ensures:
- At most one Observer call in flight at a time
- At most one Reflector call in flight at a time
- Calls are aborted when the agent is destroyed
- Failed calls are logged but do not crash the agentic loop

---

## Configuration

```typescript
interface ObservationalMemoryConfig {
  /**
   * Observer configuration.
   */
  observer?: {
    /**
     * Token count of unobserved messages that triggers observation activation.
     * When unobserved message tokens exceed this, buffered observations activate
     * and raw messages are removed.
     * @default 30_000
     */
    messageTokens?: number;

    /**
     * Token interval for async background observation buffering.
     * Can be an absolute token count (e.g., 5000) or a fraction of messageTokens
     * (e.g., 0.2 = buffer every 20% of threshold).
     * Set to false to disable async buffering (sync-only mode).
     * @default 0.2
     */
    bufferTokens?: number | false;

    /**
     * Controls how many raw message tokens to retain after activation.
     * Ratio (0-1): fraction of messageTokens to activate. Retention = messageTokens * (1 - ratio).
     * e.g., 0.8 with messageTokens: 30000 -> retain ~6000 tokens.
     * @default 0.8
     */
    bufferActivation?: number;

    /**
     * Token threshold above which synchronous (blocking) observation is forced.
     * Multiplier (1-2) of messageTokens, or absolute token count (>= 2).
     * @default 1.2
     */
    blockAfter?: number;

    /**
     * Token budget for previous observations sent to the Observer as context.
     * Tail-truncated to this budget. Set to 0 to omit, false to disable truncation.
     * @default 2000
     */
    previousObserverTokens?: number | false;

    /**
     * Custom instructions appended to the Observer's system prompt.
     * Use to customize observation behavior for domain-specific needs.
     */
    instruction?: string;
  };

  /**
   * Reflector configuration.
   */
  reflector?: {
    /**
     * Token count of observations that triggers reflection.
     * When observation tokens exceed this, the Reflector condenses them.
     * @default 40_000
     */
    observationTokens?: number;

    /**
     * Ratio (0-1) controlling when async reflection buffering starts.
     * When observation tokens reach observationTokens * bufferActivation,
     * reflection runs in the background.
     * @default 0.5
     */
    bufferActivation?: number;

    /**
     * Token threshold above which synchronous (blocking) reflection is forced.
     * Multiplier (1-2) of observationTokens, or absolute token count (>= 2).
     * @default 1.2
     */
    blockAfter?: number;

    /**
     * Custom instructions appended to the Reflector's system prompt.
     */
    instruction?: string;
  };

  /**
   * Override the model used for Observer calls.
   * Defaults to the CortexAgent's utility model.
   */
  observerModel?: 'primary' | 'utility';

  /**
   * Override the model used for Reflector calls.
   * Defaults to the CortexAgent's utility model.
   */
  reflectorModel?: 'primary' | 'utility';
}
```

### Defaults

| Setting | Default | Rationale |
|---------|---------|-----------|
| `observer.messageTokens` | 30,000 | Mastra's default; ~10-15 dense agent turns |
| `observer.bufferTokens` | 0.2 (6,000) | Buffer every 20% of threshold; 4-5 chunks before activation |
| `observer.bufferActivation` | 0.8 | Retain ~6,000 tokens of raw messages after activation |
| `observer.blockAfter` | 1.2 (36,000) | Sync fallback at 120% of threshold |
| `observer.previousObserverTokens` | 2,000 | Small context window for Observer continuity |
| `reflector.observationTokens` | 40,000 | Mastra's default; allows substantial observation accumulation |
| `reflector.bufferActivation` | 0.5 | Start background reflection at 50% of threshold |
| `reflector.blockAfter` | 1.2 (48,000) | Sync fallback at 120% of threshold |
| `observerModel` | `'utility'` | Observation is compression, not reasoning |
| `reflectorModel` | `'utility'` | Reflection is compression, not reasoning |

---

## Lifecycle Events

The observational memory strategy emits events through the existing CompactionManager event system, plus new observation-specific events:

### Existing Events (reused)

- **`onBeforeCompaction`**: Emitted before activation (when raw messages will be removed). The consumer can flush state.
- **`onPostCompaction`**: Emitted after activation with a `CompactionResult`. The consumer can re-seed or update state.
- **`onCompactionDegraded`**: Emitted if sync Observer fails and Layer 3 fires as fallback.
- **`onCompactionExhausted`**: Emitted if all layers fail.

### New Events

```typescript
interface ObservationalMemoryEvents {
  /**
   * Fired when the Observer produces new observations (sync or async).
   * Useful for persistence and debugging.
   */
  onObservation?: (event: {
    observations: string;
    tokensObserved: number;
    observationTokens: number;
    currentTask?: string;
    suggestedResponse?: string;
    async: boolean;                // true if from background buffering
    durationMs: number;
  }) => void;

  /**
   * Fired when buffered observations are activated (raw messages removed).
   */
  onActivation?: (event: {
    chunksActivated: number;
    tokensActivated: number;       // raw message tokens removed
    observationTokens: number;     // observation tokens added
    messagesRemoved: number;       // raw messages removed from history
  }) => void;

  /**
   * Fired when the Reflector condenses observations.
   */
  onReflection?: (event: {
    tokensBefore: number;
    tokensAfter: number;
    compressionLevel: number;      // 0-4
    durationMs: number;
  }) => void;
}
```

These events are registered on `CortexAgent`:

```typescript
agent.onObservation((event) => { /* persist observations */ });
agent.onActivation((event) => { /* update UI, log */ });
agent.onReflection((event) => { /* persist condensed observations */ });
```

---

## Observer and Reflector Prompts

### Observer System Prompt

The Observer system prompt instructs the LLM to extract observations from conversation history. It is adapted from Mastra's proven prompt (which achieves 84-95% on LongMemEval) with modifications for Cortex's general-purpose nature:

**Key sections:**
1. **Role**: "You are the memory consciousness of an AI assistant"
2. **Extraction instructions**: How to identify facts, preferences, decisions, tool outcomes, state changes, temporal anchoring
3. **Output format**: Date-grouped observations with emoji priorities, `<current-task>`, `<suggested-response>`
4. **Guidelines**: Observation density, grouping, completion tracking, user message capture

The full prompt is approximately 4,000 tokens. It is defined as a constant in Cortex and is not consumer-configurable (the consumer can append instructions via `observer.instruction`, but cannot replace the core prompt).

### Reflector System Prompt

The Reflector prompt instructs the LLM to condense observations while preserving all critical information. It includes the Observer's extraction instructions (so the Reflector understands the format it is condensing) and adds reflection-specific guidance:

**Key sections:**
1. **Role**: "You are the observation reflector"
2. **Reference to Observer instructions**: Full Observer extraction rules embedded for context
3. **Reflection guidance**: Merge related items, preserve dates, carry forward completion markers, condense older observations more aggressively
4. **Compression levels**: Progressive compression guidance (levels 0-4) applied on retry when output is still too large

---

## Interaction with Existing Compaction Layers

### Layer 1 (Microcompaction): Unchanged

Microcompaction continues to operate on tool results in the raw message region. When observations activate and raw messages are removed, the microcompaction cache is reset (same as after summarization compaction). Microcompaction does not touch the observation region.

### Layer 2 (Observational Memory): Replaces Summarization

When `layer2Strategy === 'observational'`, the summarization path (`runCompaction`, `shouldCompact`, `partitionHistory`) is not invoked. All Layer 2 logic is handled by the `ObservationalMemoryEngine`.

The adaptive threshold system (`AdaptiveThresholdConfig`) is adapted for observational memory: when the user is idle, the `messageTokens` threshold is lowered so observation activates sooner, reducing token costs for autonomous sessions. The same `recentWindowMs` / `idleWindowMs` / reduction parameters apply.

### Layer 3 (Emergency Truncation): Unchanged

Emergency truncation at 90% of the model's context window remains the safety net. If observation and reflection fail or cannot keep up, Layer 3 drops the oldest messages mechanically. The observation region messages are treated as conversation history and can be truncated if necessary (though this should be extremely rare if Layer 2 is functioning).

---

## State Persistence

Cortex does not persist state. The consumer is responsible for persisting and restoring observation state across session restarts. Cortex provides the hooks:

### Saving State

```typescript
// Existing API
const history = agent.getConversationHistory();

// New API for observation state
const omState = agent.getObservationalMemoryState();
// Returns: ObservationalMemoryState | null (null if not using observational strategy)
```

### Restoring State

```typescript
// Existing API
agent.restoreConversationHistory(history);

// New API for observation state
agent.restoreObservationalMemoryState(omState);
```

The consumer typically saves both conversation history and observation state together in `onLoopComplete` or a custom persistence hook.

---

## Comparison: Summarization vs. Observational Memory

| Aspect | Summarization | Observational Memory |
|--------|--------------|---------------------|
| **Blocking** | Yes (LLM call during transformContext) | No (async buffering; activation is instant) |
| **Compression quality** | High (full conversation as input) | High (5-40x compression, 84-95% LongMemEval) |
| **Cost** | Primary model (expensive) | Utility model (cheaper) |
| **Cache efficiency** | Summary replaces entire prefix (cache invalidation) | Append-only observations (cache-friendly) |
| **Continuity** | Summary preserves key decisions | Continuation hints (current task + suggested response) |
| **Progressive loss** | Summarizing summaries degrades | Reflection condenses; observations are first-class |
| **Configuration** | Simple (threshold + preserved turns) | More parameters (thresholds, buffer intervals, retention) |
| **Best for** | Short-to-medium sessions, simple flows | Long-running sessions, autonomous agents, high-throughput |

### When to Use Which

**Summarization** (default):
- Sessions that rarely hit compaction (< 200k context usage)
- Simple consumer setups where minimal configuration is preferred
- Use cases where the brief blocking pause is acceptable

**Observational Memory**:
- Long-running autonomous sessions (always-on agents)
- High-throughput coding sessions with many tool calls
- Consumers who need uninterrupted agentic loops (no blocking compaction)
- Sessions where cache efficiency is critical (high-volume, cost-sensitive)

---

## Implementation Plan

### Module Structure

```
packages/cortex/src/compaction/
  index.ts                        -- CompactionManager (updated with strategy switch)
  microcompaction.ts              -- Layer 1 (unchanged)
  compaction.ts                   -- Layer 2 summarization (unchanged)
  failsafe.ts                     -- Layer 3 (unchanged)
  observational/                  -- NEW: Layer 2 observational memory
    index.ts                      -- ObservationalMemoryEngine (main orchestrator)
    observer.ts                   -- Observer agent prompts, parsing, and runner
    reflector.ts                  -- Reflector agent prompts, parsing, and runner
    buffering.ts                  -- Async buffering coordinator
    types.ts                      -- ObservationalMemoryConfig, state types
    constants.ts                  -- Default thresholds, prompt constants
```

### Implementation Sequence

1. **Types and configuration** (`types.ts`, `constants.ts`)
   - Define `ObservationalMemoryConfig`, `ObservationalMemoryState`, `ObservationChunk`
   - Add `layer2Strategy` and `observational` to `CortexCompactionConfig`
   - Define default values

2. **Observer** (`observer.ts`)
   - Port and adapt Observer system prompt from Mastra (general-purpose, no Mastra-specific references)
   - Implement `formatMessagesForObserver()` (converts `AgentMessage[]` to Observer input)
   - Implement `parseObserverOutput()` (extracts observations, current-task, suggested-response)
   - Implement `runObserver()` (calls `CompleteFn` with Observer prompt)
   - Implement degenerate repetition detection

3. **Reflector** (`reflector.ts`)
   - Port and adapt Reflector system prompt
   - Implement `runReflector()` with progressive compression retry (levels 0-4)
   - Implement `validateCompression()` (check output is below threshold)
   - Implement `parseReflectorOutput()`

4. **Buffering coordinator** (`buffering.ts`)
   - Manage async Observer and Reflector Promises
   - Track buffer boundaries and in-flight operations
   - Implement interval-based trigger logic
   - Handle abort/cleanup on agent destruction

5. **ObservationalMemoryEngine** (`index.ts`)
   - Main orchestrator: integrates Observer, Reflector, and buffering
   - Implements the Layer 2 path in `applyInTransformContext()`
   - Manages observation state (observations text, watermarks, chunks)
   - Handles activation (swap raw messages for observations)
   - Emits lifecycle events
   - Provides state save/restore API

6. **CompactionManager integration** (`../index.ts`)
   - Add strategy switch in `applyInTransformContext()`
   - Instantiate `ObservationalMemoryEngine` when `layer2Strategy === 'observational'`
   - Wire new events through to `CortexAgent`
   - Adapt adaptive threshold for observational memory

7. **CortexAgent integration** (`../../cortex-agent.ts`)
   - Add `onObservation()`, `onActivation()`, `onReflection()` event registration
   - Add `getObservationalMemoryState()` and `restoreObservationalMemoryState()`
   - Wire Observer/Reflector `CompleteFn` (using utility model by default)

8. **Tests**
   - Unit tests for Observer prompt formatting and output parsing
   - Unit tests for Reflector prompt and compression validation
   - Unit tests for buffering coordinator (interval triggers, dedup)
   - Unit tests for activation (message removal, watermark advancement)
   - Integration tests for the full pipeline (mock LLM)
   - Tests for strategy switching (summarization vs. observational)
   - Tests for adaptive threshold with observational memory

---

## Open Questions

### 1. Observation Persistence Granularity

Should `getObservationalMemoryState()` return a single opaque state object, or should observations and chunks be accessible individually for more granular persistence?

**Recommendation:** Single opaque state object. Cortex does not prescribe persistence strategies. The consumer serializes and deserializes the entire state blob.

### 2. Cross-Session Observations

Mastra supports `resource` scope (observations shared across threads/sessions). Should Cortex support this?

**Recommendation:** Not in the initial implementation. Cortex sessions are independent. Cross-session memory is a consumer concern; the consumer can merge observation states across sessions using the save/restore API.

### 3. Retrieval Mode

Mastra's retrieval mode gives the agent a `recall` tool to browse raw messages behind observations. Should Cortex support this?

**Recommendation:** Not initially. This requires message persistence infrastructure that Cortex does not own. The consumer can implement a recall tool as a custom registered tool if needed, using the observation group ranges and their own message storage.

### 4. Observer Model Choice

Should the Observer/Reflector always use the utility model, or should they support using a specific model independent of the primary/utility pair?

**Recommendation:** Default to utility model. Allow override to `'primary'` via config. Do not support arbitrary model specification (that would require a third model resolution path). The consumer can set their utility model to whatever they prefer for observation quality.

### 5. Interaction with Consumer's `onBeforeCompaction`

The existing summarization strategy emits `onBeforeCompaction` before compaction starts, which consumers use to flush domain-specific state (e.g., Animus's observational memory processing). With the new observational memory strategy, when should this event fire?

**Recommendation:** Fire `onBeforeCompaction` before activation (when raw messages are about to be removed). This gives the consumer the same signal to flush state before conversation history changes. The semantics are identical: "Cortex is about to modify conversation history; flush anything you need to preserve."

---

## Risks and Mitigations

### Risk: Observer quality with utility model

The utility model may be lower quality than the primary model, potentially producing less useful observations.

**Mitigation:** Mastra demonstrates strong results with Gemini Flash (a "utility" tier model), scoring 84%+ on LongMemEval. The Observer task (extracting structured notes from conversation) is well-suited to smaller models. The consumer can override to `'primary'` if needed.

### Risk: Async operations and race conditions

Background Observer/Reflector calls run concurrently with the agentic loop. Multiple calls could conflict.

**Mitigation:** The buffering coordinator enforces at-most-one-in-flight per operation type. Activation is an atomic swap operation that runs synchronously in `transformContext`. The observation state is only modified in `transformContext` (single-threaded relative to the agentic loop).

### Risk: Large observation regions consuming context

If observations accumulate faster than reflection can condense them, the observation region could grow large.

**Mitigation:** The Reflector threshold (default 40,000 tokens) caps observation growth. The Reflector retries with progressive compression (up to 4 levels). Layer 3 emergency truncation serves as the ultimate safety net.

### Risk: Increased complexity for consumers

The observational strategy has more configuration parameters and state to manage than summarization.

**Mitigation:** All parameters have sensible defaults derived from Mastra's production-tested values. The consumer only needs to set `layer2Strategy: 'observational'` to opt in. Advanced tuning is optional.
