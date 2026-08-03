# SubAgent Tool

Spawn independent cortex-based sub-agents for delegated work.

> **Priority: P0** - Fully implemented and shipped.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `instructions` | string | Yes | What the sub-agent should do. This becomes the sub-agent's initial prompt. |
| `tools` | string[] | No | Tool names to make available. Default: inherits parent's registered tools. |
| `systemPrompt` | string | No | Custom system prompt. Default: inherits parent's full system prompt (consumer content + Cortex operational rules). |
| `maxTurns` | number | No | Turn limit. Default: inherits parent's budget guard config. |
| `maxCost` | number | No | Cost limit. Default: inherits parent's budget guard config. |
| `background` | boolean | No | Run asynchronously. Default: false (blocks until complete). |

## Returns

**`content`** (sent to the LLM):

For **foreground** (blocking) sub-agents:
- The sub-agent's final text output
- Status: `completed`, `failed`, or `timed_out`
- Token/cost summary

For **background** sub-agents:
- A task ID for polling via the TaskOutput tool
- Confirmation that the sub-agent was spawned

Sub-agent outputs flow through the agent's [tool result persistence interceptor](../tool-result-persistence.md). When a sub-agent returns a large research result, the interceptor bookends it (head + tail preview) and, when a `persistResult` callback is configured, persists the full content to disk. The parent agent can then use the Read tool to pull in specific sections on demand. This protects the parent's context window without losing access to the sub-agent's findings.

**`details`** (sent to UI/logs only):
- Full sub-agent conversation history (all turns, tool calls, results)
- Detailed token usage breakdown
- Duration
- Model used
- Tools that were registered

## Execution Modes

### Foreground (default)

The parent agent blocks while the sub-agent runs to completion. The sub-agent's result is returned directly as the tool result. Use for quick, focused tasks where the parent needs the result to continue.

```
Parent calls SubAgent(instructions: "Summarize this file")
  → Sub-agent runs (may take several turns with tool calls)
  → Sub-agent produces final output
  → Result returned to parent as tool content
Parent continues with the result in context
```

### Background

The parent agent continues immediately. The sub-agent runs independently. Use for long-running tasks where the parent doesn't need the result right away.

```
Parent calls SubAgent(instructions: "Research this topic", background: true)
  → Sub-agent spawned, task ID returned immediately
  → Parent continues with other work
  → Sub-agent runs independently
  → On completion, parent is notified via follow-up message
  → Parent can also poll via TaskOutput tool
```

Background sub-agents use pi-agent-core's `getFollowUpMessages()` mechanism to notify the parent on completion. The notification includes the sub-agent's result, status, and usage summary.

## Sub-Agent Architecture

Each sub-agent is an independent `AgentLoop` instance with its own:
- **Message array**: No shared conversation history with the parent. The sub-agent starts fresh with only the `instructions` as its initial prompt.
- **Tool set**: Can be restricted from the parent's tools. The sub-agent cannot access tools the parent doesn't have. **The `SubAgent` and `load_skill` tools are always excluded from child agents.** Sub-agents cannot spawn further sub-agents, and they do not recursively load skills. If the `tools` parameter explicitly includes either excluded tool, it is silently stripped.
- **System prompt**: Defaults to the parent's system prompt. Can be overridden for specialized tasks (e.g., a research-focused prompt).
- **Budget guards**: Inherits from the parent's config by default. Can be tightened (but not loosened beyond the parent's limits).
- **Context manager**: The sub-agent gets its own ContextManager. Context slots are NOT inherited. The sub-agent starts with an empty slot region.
- **Working directory**: Inherits the parent's current working directory.
- **Built-in tool runtime**: Fresh cwd, read-tracking, WebFetch, and background-task state. Parent and child built-in tool state do not leak into each other.

Sub-agents share the parent's:
- **API key / provider configuration**: Same pi-ai model and authentication.
- **Permission resolver**: The same `beforeToolCall` hook applies. Sub-agents cannot bypass the parent's permission gates.
- **Working tags config**: Inherits `workingTags.enabled` from the parent by default.
- **Live MCP tool inventory**: The child inherits the parent tool wrappers that are connected at spawn time, so allowed MCP tools remain available without reconnecting.

## Steering and Cancellation

### Steering a Running Sub-Agent

The parent can send new context to a running background sub-agent via pi-agent-core's `agent.steer()` mechanism. This interrupts the sub-agent's current tool execution, injects the new context, and triggers a new LLM turn.

Consumers may define their own command patterns for interacting with running sub-agents (e.g., decision types that trigger steering with new context).

### Cancelling a Sub-Agent

`cancelSubAgent(taskId)` on the parent agent cancels a running sub-agent:

- The child agent is fully destroyed (loop aborted, tool processes killed, MCP connections closed).
- The tracked completion promise resolves with `status: 'cancelled'`.
- Any result already queued for delivery is purged, and a result arriving after the cancel is discarded, so cancelled work is never delivered to the loop.
- A pending permission ask on the child is dismissed via the abort signal passed to the consumer resolver, and the child's `waiting-for-permission` status is cleared.
- Returns `false` when the task ID is not an active sub-agent.

A cancelled **foreground** child reports `status: 'cancelled'` (not `failed`) to the SubAgent tool. Foreground sub-agents can also be implicitly cancelled if the parent's own loop is aborted (e.g., tick timeout).

## Concurrency

Multiple background sub-agents can run simultaneously. The concurrency limit is configurable on the `AgentLoop`:

```typescript
const agent = await AgentLoop.create({
  model,
  workingDirectory,
  maxConcurrentSubAgents: 4,  // default
  // ...
});
```

Attempting to spawn beyond the limit returns an error in `content` telling the parent agent that the sub-agent budget is exhausted. The parent can wait for a running sub-agent to complete or cancel one to free a slot.

## Event Bridge

Sub-agent events flow through the same event bridge as the parent. Each sub-agent gets its own event session scope for traceability:

- `agent_start` / `agent_end` events include the sub-agent's task ID
- Tool call events within the sub-agent are tagged with the sub-agent's session
- The consumer can correlate sub-agent events to the parent tick that spawned them

## Consumer Lifecycle Hooks

Cortex emits events that the consumer can hook into for lifecycle management:

- **`onSubAgentSpawned(taskId, instructions)`**: A sub-agent was created. The consumer can track it (e.g., insert a row in `agent_tasks` table).
- **`onSubAgentCompleted(taskId, result, status, usage)`**: A sub-agent finished. The consumer can process results (e.g., deliver via heartbeat trigger, update task status).
- **`onSubAgentFailed(taskId, error)`**: A sub-agent errored. The consumer can handle the failure.
- **`onBackgroundResultDelivery(taskIds)`**: Queued background completions (sub-agent or Bash) are about to be delivered to the parent loop. Fires once per completion, not per re-attempt.
- **`onBackgroundResultDeadLettered(result)`**: Cortex gave up delivering a background completion: attempts exhausted, total delivery time over budget, a fatal error (e.g., failed authentication), or the agent shut down before delivering it. The `result` carries the task ID, attempt count, last error, and the formatted message that never reached the loop.

These hooks are how a consumer's orchestration layer integrates without cortex knowing about the orchestrator's existence.

### Delivery Durability and Dead-Lettering

A background completion delivered while the loop is busy is queued and drained when the loop goes idle. A failed delivery is unwound from history (so a re-attempt cannot duplicate the completion body) and re-queued, bounded by a capped attempt count and a total elapsed delivery budget. Completions that cannot be re-attempted productively are dead-lettered rather than dropped or retried forever.

`getDeadLetteredBackgroundResults()` returns the bounded dead-letter list (newest last; oldest entries are evicted past the cap). The list survives `destroy()`, which itself dead-letters anything still queued, so an application can surface undelivered completed work to the user or re-drive it.

## Relationship to Consumer Orchestration

The cortex SubAgent tool provides the **spawning and execution mechanism**. Consumers may implement their own orchestration layer that wraps SubAgentManager for domain-specific lifecycle management (e.g., tying sub-agent results to application events, persisting task state to a database, or delivering results through a notification pipeline).

| Concern | Cortex SubAgent | Consumer Orchestrator |
|---------|----------------|----------------------|
| Spawn a sub-agent | Yes | Calls cortex to spawn |
| Run to completion | Yes | Monitors via lifecycle hooks |
| Cancel/steer | Yes | Triggers cancel/steer via application logic |
| Track in database | No | Writes to its own task store |
| Deliver results | Returns to parent | Delivers via application-specific mechanisms |
| Timeout management | Budget guards | May add additional timeouts |
| Concurrency limits | Enforces max concurrent | May impose its own lower limits |

The orchestrator is consumer-level logic. Cortex provides the substrate.

## Claude/Codex Sub-Agents (Future)

For tasks that benefit from external agent runtimes (Claude CLI, Codex CLI, etc.), the consumer can bridge to subprocess-based SDKs at the application level. This is consumer-level orchestration, not built into Cortex. The SubAgent tool only spawns Cortex-based agents.
