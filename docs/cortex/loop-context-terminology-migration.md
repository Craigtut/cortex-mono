# Loop And Context Terminology Migration

> **STATUS: ACTIVE**
>
> Breaking terminology and API cleanup for Cortex and Cortex Code.

## Why

Cortex previously overloaded the word "session" across multiple time scales:

- long-lived persisted conversation state
- one `prompt()` execution
- the current context footprint sent to the model

That ambiguity made the codebase harder to reason about and led Cortex Code to display the wrong token metric in its footer.

## Clean Model

Use these terms consistently:

- **Session**: long-lived logical conversation/runtime continuity that can be persisted and resumed across many prompts.
- **Loop**: one `prompt()` execution, including all internal turns, tool calls, and follow-up work.
- **Turn**: one LLM call/response inside a loop.
- **Context**: the working prompt footprint sent to the model on a given turn.

## Breaking Changes

### EventBridge

| Old | New |
|---|---|
| `session_start` | `loop_start` |
| `session_end` | `loop_end` |

Update any event listeners, event enums, logs, and tests that subscribed to the old names.

### Current Context Token API

| Old | New |
|---|---|
| `agent.sessionTokenCount` | `agent.currentContextTokenCount` |
| `agent.updateSessionTokenCount(tokens)` | `agent.updateCurrentContextTokenCount(tokens)` |

`currentContextTokenCount` is the post-hoc token count from the most recent parent LLM turn. It is not a lifetime accumulator.

### New Consumer API

```ts
const estimated = agent.estimateCurrentContextTokens();
```

Use this for UI and guardrails when you need the best current estimate of context pressure between turns or after restoring persisted history.

Recommended display logic:

```ts
const displayedContextTokens = Math.max(
  agent.currentContextTokenCount,
  agent.estimateCurrentContextTokens(),
);
```

### Sub-Agent Usage

| Old | New |
|---|---|
| `SubAgentResult.usage.totalTokens` | `SubAgentResult.usage.contextTokens` |

This field represents the sub-agent's current context footprint at completion, not lifetime token usage.

### Cortex Code Session Metadata

Persisted Cortex Code session metadata now uses:

| Old | New |
|---|---|
| `tokenCount` | `contextTokenCount` |

The loader still accepts the old field when reading existing session files so local resumes keep working.

## Migration Checklist For Consumers

1. Rename EventBridge listeners to `loop_start` / `loop_end`.
   The old `session_*` names no longer exist.
2. Replace `sessionTokenCount` reads with `currentContextTokenCount`.
3. Use `estimateCurrentContextTokens()` anywhere the product needs to answer "how full is the current context window right now?"
4. Keep `SessionUsage` for lifetime reporting, persistence, and cost summaries.
5. Rename any product copy that said "session tokens" when it really meant "current context usage".

## Practical Guidance

- Use `SessionUsage` for lifetime analytics and billing summaries.
- Use `currentContextTokenCount` for the last exact parent-turn input size.
- Use `estimateCurrentContextTokens()` for footer/status displays, resume flows, and pre-flight model switching checks.
