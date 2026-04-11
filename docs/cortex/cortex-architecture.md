# Cortex Architecture

> **STATUS: IMPLEMENTED**

`@animus-labs/cortex` is a standalone package that wraps `@mariozechner/pi-agent-core` into a production-grade agent. It adds the capabilities pi-agent-core deliberately omits: MCP tool support, tool permissions, budget guards, context compaction, skill system, and event logging. Session persistence is the consumer's responsibility; cortex provides lifecycle hooks and serialization helpers.

It does NOT contain application-specific logic (thoughts, emotions, decisions, persona). Those are concerns of the consumer (e.g., a heartbeat system or application-specific pipeline). Think of it as: pi-agent-core provides the bare agentic loop; cortex provides everything needed to wire that loop into real applications.

## Package Structure

```
packages/cortex/
  src/
    index.ts                    # Public API
    cortex-agent.ts             # Wraps pi-agent-core Agent with production concerns
    context-manager.ts          # Slot-based context management
    provider-manager.ts         # Provider discovery, OAuth login/refresh, API key validation
    provider-registry.ts        # Static provider metadata and utility model defaults
    model-wrapper.ts            # Model resolution and CortexModel opaque type
    error-classifier.ts         # Regex-based error classification
    budget-guard.ts             # Turn count, cost, and wall-clock limits
    event-bridge.ts             # Pi events -> normalized events for logging
    schema-converter.ts         # Zod -> JSON Schema -> TypeBox conversion
    token-estimator.ts          # Heuristic token estimation for compaction triggers
    working-tags.ts             # Working tag parsing and response delivery
    types.ts                    # Package-specific types
    tools/
      index.ts                  # Tool registration entry point
      runtime.ts                # Per-agent mutable tool runtime state
      bash.ts                   # Bash shell execution
      bash-safety.ts            # 7-layer safety checks for shell commands
      cwd-tracker.ts            # Working directory tracking across bash calls
      read.ts                   # Read file contents
      read-registry.ts          # Tracks which files have been read (read-before-write)
      write.ts                  # Write/create files (atomic writes)
      edit.ts                   # String replacement edits
      glob.ts                   # File pattern matching
      grep.ts                   # Regex content search
      web-fetch.ts              # URL content fetching
      web-fetch-cache.ts        # Cache for web fetch results
      task-output.ts            # Background task output polling
  package.json
```

## Why a Separate Package

- Previous agent abstractions (e.g., adapter/session interfaces) normalized SDK differences. Pi Agent Core does not fit that abstraction: its value is direct control over the loop, not conforming to a normalized interface.
- A standalone package can be reused across future Animus Labs projects.
- Subprocess-based SDK orchestration (e.g., Claude CLI, Codex CLI) remains available as a consumer-level concern, not built into Cortex.

## Context Management

### Temporal Model

Cortex uses four distinct time scales:

- **Session**: the long-lived logical conversation/runtime continuity that can be persisted and resumed across many prompts.
- **Loop**: one `prompt()` execution, including all internal turns, tool calls, and follow-up work.
- **Turn**: one LLM call/response inside a loop.
- **Context**: the working prompt footprint sent to the model on a given turn.

These terms are intentionally not interchangeable. Session persistence is a consumer concern. Loop orchestration, turn handling, and current-context pressure are Cortex concerns.

### Always-Warm Agent

There is no cold/warm/active state machine. A single `Agent` instance persists for the lifetime of the process. The system prompt is set once and rarely changes. Context is managed through two complementary mechanisms:

1. **`replaceMessages()`**: Updates persistent context slots in `agent.state.messages`. Used for content that changes infrequently. Consumers define how many slots exist and what they contain.
2. **`transformContext` hook**: Injects ephemeral per-call context that should NOT persist in `agent.state.messages`. Ephemeral content should be placed at the end of the message array to avoid invalidating the prefix cache.

### The ContextManager

The `ContextManager` manages the content an agent sees through two mechanisms: persistent **slots** (named content blocks at the start of the message array) and **ephemeral context** (per-call content injected via `transformContext`, never stored).

See **`context-manager.md`** for the full design: message array layout, slot API, ephemeral context API, composability with other `transformContext` hooks, and prefix caching implications.

### Session Persistence

Pi-agent-core is in-memory only. `agent.state` is JSON-serializable. Cortex does NOT own persistence to disk. Instead, it provides lifecycle hooks and serialization helpers that the consumer uses to implement their own storage:

- **`getConversationHistory()`**: Returns the conversation history (everything between slots and ephemeral) as a JSON-serializable array. After compaction, this returns the compacted version. The consumer snapshots this to their storage.
- **`restoreConversationHistory(messages)`**: Injects saved conversation history after the slot region on startup.
- **`onLoopComplete` event**: Fires when the full agentic loop finishes (maps to pi-agent-core's `agent_end` event, not `turn_end`). A single loop may contain many internal turns (tool calls, follow-ups, steering). The consumer listens to this to trigger checkpoints. One snapshot per loop, not per turn.

This design means cortex has zero storage dependencies. The consumer decides where to persist (SQLite, filesystem, Redis, nowhere) and when to checkpoint beyond the basic lifecycle events.

## Capabilities (Gap Fills)

These are capabilities pi-agent-core deliberately omits that cortex implements.

### MCP Tool Support

Pi-agent-core has no MCP support. Tools are direct `AgentTool` objects with `execute()` functions.
Cortex owns its own in-process tool contract and adapts it to pi-agent-core only at the final registration boundary.

Cortex acts as a **unified MCP client**, connecting to all tool sources through standard MCP protocol. It uses the MCP SDK `Client` class with the appropriate transport for each server:

- **Consumer domain tools**: The consumer provides its own MCP tool server (e.g., a subprocess exposing domain-specific tools like memory, tasks, messaging). Cortex connects via stdio transport, calls `tools/list` to discover available tools, then wraps each as an `AgentTool` object. On `execute()`, the client calls `tools/call` on the MCP server and returns the result. These tools are registered by the consumer, not built into Cortex.
- **Plugin tools**: Cortex connects to each plugin's MCP server via its configured transport (stdio for stdio-based plugins, HTTP for HTTP-based plugins). Discovery works the same way: `tools/list` on connection, wrap as `AgentTool` objects.
- **Dynamic lifecycle**: Tools are added and removed as plugins install or uninstall, without tearing down the agent session. On plugin install, Cortex opens a new MCP client connection and registers the discovered tools. On uninstall, it closes the connection and removes those tools.
- **Dynamic discovery**: On each MCP client connection, Cortex calls `tools/list` to discover the server's available tools. This means tool inventories are always derived from the server, not hardcoded.

Built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebFetch, SubAgent) are NOT delivered via MCP. They are native in-process Cortex tools that Cortex adapts to pi-agent-core when synchronizing the tool inventory. See the Built-in Tools section below.

### Built-in Tools

Built-in tools are native Cortex tools defined directly in Cortex. These run in-process with no MCP overhead and are adapted to pi-agent-core at the registration boundary.

- **Bash**: Execute shell commands and return output.
- **Read**: Read file contents from the filesystem.
- **Write**: Write content to a file.
- **Edit**: Make targeted edits to existing files (string replacement).
- **Glob**: Search for files by name patterns.
- **Grep**: Search file contents with regex patterns.
- **WebFetch**: Fetch content from URLs.
- **SubAgent**: Spawn a sub-agent for delegated work.

Mutable built-in tool state is scoped per agent runtime. That includes cwd tracking, read tracking, WebFetch loop counters/cache ownership, and background task ownership. Parent and child agents get fresh built-in tool instances so they do not share mutable closures.

Built-in tools are registered automatically when `CortexAgent.create()` is called, using the `workingDirectory` from the agent config. The consumer does not need to create or pass tool instances. To exclude specific built-in tools, use the `disableTools` config option:

```typescript
const agent = await CortexAgent.create({
  model,
  workingDirectory: cwd,
  disableTools: ['WebFetch', 'Bash'], // Exclude specific tools
});
```

Permissions are enforced through the `beforeToolCall` hook used for both built-in and MCP tools. Built-in tool schemas use TypeBox directly since they are defined within Cortex. SubAgent is a special case: it delegates work to a child Cortex agent.

### Schema Conversion (Zod -> TypeBox)

Pi-agent-core uses TypeBox + AJV for tool parameter schemas. Cortex provides a conversion utility:

```typescript
// Zod -> JSON Schema (via zod-to-json-schema) -> TypeBox Type.Unsafe()
function zodToTypebox(zodSchema: z.ZodType): TSchema {
  const jsonSchema = zodToJsonSchema(zodSchema);
  return Type.Unsafe(jsonSchema);
}
```

One-way conversion at the tool registration boundary. Consumer code continues using Zod. Built-in tools (Bash, Read, Write) use TypeBox directly since they are defined within Cortex, not converted from Zod.

### Tool Permission Gate

Pi-agent-core has no permission system. Cortex implements permissions via the `beforeToolCall` hook:

- Accepts a permission resolver function from the consumer
- Supports a structured result: `allow`, `block`, or `ask`
- Accepts booleans for backward compatibility: `true` -> `allow`, `false` -> `block`
- `ask` currently blocks the tool call with an approval-needed reason. Cortex does not run an in-band approval flow for the consumer.

The consumer provides the resolver; cortex provides the hook integration.

### Budget Guards

Pi-agent-core has no limits on turns or cost.

Cortex provides optional, configurable guards. All default to unlimited (no enforcement):

- **Max turns**: Count LLM turns via `turn_end` events. Default: `Infinity`. On breach, force-stop the loop.
- **Max cost**: Track via `AssistantMessage.cost.total`. Default: `Infinity`. On breach, force-stop the loop.

These are safety rails for runaway loops, not user-facing budget enforcement. Application-level budgeting (weekly/monthly spend limits, user-configurable caps) is the consumer's responsibility.

### Context Compaction

Pi-agent-core has no compaction. Only the `transformContext` hook.

Cortex implements compaction in `transformContext` with two selectable strategies:

- **Observational memory** (default): Two background LLM agents (Observer and Reflector) continuously compress conversation history into structured event logs stored in a dedicated context slot. Non-blocking, cache-friendly, and suitable for long-running sessions. See [observational-memory-architecture.md](./observational-memory-architecture.md).
- **Classic** (`strategy: 'classic'`): Three-layer system with microcompaction (tool result trimming), LLM-based conversation summarization, and emergency truncation. See [compaction-strategy.md](./compaction-strategy.md).

Both strategies preserve context slots untouched and use Layer 3 emergency truncation as a safety valve. The consumer selects the strategy via `compaction.strategy` in the agent config.

### Skill System

Pi-agent-core has no concept of skills. Skills are handled at the application layer in `pi-coding-agent`, not in the library.

Cortex implements a full skill system with three core capabilities:

- **Progressive disclosure**: Only skill names and descriptions are in context at startup (~100 tokens per skill). Full skill content loads on demand via a `load_skill` AgentTool.
- **Ephemeral injection**: Loaded skill content lives in the ephemeral context region (via a skillBuffer read by `transformContext`), not in conversation history. It persists for the duration of the current agentic loop, then disappears on the next tick.
- **Dynamic context injection**: Skills can contain preprocessor markers (shell commands, in-process JavaScript scripts, variable substitution) that execute at load time, replacing markers with live runtime data before the agent sees the content.

The skill registry is config-driven: the consumer provides paths to SKILL.md files from any source (plugins, user directories, built-ins). Cortex does not scan directories. Skills are added/removed dynamically as plugins install/uninstall.

See **`skill-system.md`** for the full design: SKILL.md format, SkillRegistry, load_skill tool, ephemeral injection, preprocessor system, consumer API, and future sub-agent skill execution.

### Working Tags (Response Delivery)

When an agent runs multi-turn agentic loops, it generates intermediate text (reasoning, analysis, planning) mixed with user-facing text (acknowledgments, progress updates, final answers). Working tags let the agent wrap internal content in `<working>` XML tags. Text outside these tags is direct communication for the user. Both stay in conversation history; the difference is only in delivery.

This feature is enabled by default and configurable via `CortexAgentConfig.workingTags.enabled`. When enabled, Cortex appends a "Response Delivery" section to its operational rules in the system prompt.

At the streaming level, Cortex passes raw text through with zero buffering. At turn completion, Cortex parses the complete text into a structured `AgentTextOutput` object with `userFacing`, `working`, and `raw` properties. The consumer decides per-channel what to deliver (e.g., SMS sends `userFacing` only; the frontend renders everything with working content dimmed).

See **`working-tags.md`** for the full design: tag rules, system prompt guidance, event model, parsing utilities, consumer integration, and multi-layer response delivery framework.

### Model Tiers

Cortex uses two model tiers: a **primary model** for all consumer-facing work (agentic loop, direct LLM calls like THOUGHT/REFLECT) and a **utility model** for internal operations the user never sees (WebFetch summarization, safety classifier, compaction).

See **`model-tiers.md`** for the full design: tier definitions, provider default mapping, same-provider constraint, configuration API, and frontend implications.

### System Prompt Management

Cortex assembles a system prompt from two layers: a **cortex default** (operational foundation: rules, tool guidance, safety, environment info) and a **consumer layer** (domain-specific content like persona, instructions, etc.). The cortex default is always present; the consumer appends after it.

See **`system-prompt.md`** for the full design: all seven default sections, how the consumer appends, platform-aware tool guidance, and caching implications.

Cortex provides a `setBasePrompt(newPrompt: string)` method for when the application prompt needs to change:

- **Triggers for rebuild**: Consumer-detected (e.g., persona changes, plugin install/remove, settings changes).
- **Non-destructive**: Rebuilding does NOT tear down the session or lose conversation history.
- **Cortex default is stable**: The default sections almost never change (platform/shell/tools don't change at runtime). Rebuilds are driven by consumer content changes.

### Event Bridge

Pi-agent-core emits 10 events across 4 scopes. Cortex normalizes these into a consumer-facing event stream for logging and monitoring.

**Pi-agent-core events:**

| Scope | Event | Description |
|-------|-------|-------------|
| Agent | `agent_start` | Agent begins processing a prompt |
| Agent | `agent_end` | Agent finishes all work (including follow-ups) |
| Turn | `turn_start` | New LLM turn begins |
| Turn | `turn_end` | LLM turn completes (response + tool execution) |
| Message | `message_start` | LLM response streaming begins |
| Message | `message_update` | Incremental streaming content (text deltas, tool call deltas) |
| Message | `message_end` | LLM response streaming complete |
| Tool | `tool_execution_start` | Tool begins executing |
| Tool | `tool_execution_update` | Tool progress update (mid-execution) |
| Tool | `tool_execution_end` | Tool execution complete (with result or error) |

**Mapping to consumer event types** (consumers define their own event enum):

| Pi Event | Consumer Event | Notes |
|----------|-------------|-------|
| `agent_start` | `loop_start` | Direct mapping |
| `agent_end` | `loop_end` | Direct mapping |
| `turn_start` | *(none)* | New; can be added or omitted |
| `turn_end` | `turn_end` | Direct mapping |
| `message_start` | `response_start` | Direct mapping |
| `message_update` | `response_chunk` | Direct mapping |
| `message_end` | `response_end` | Direct mapping |
| `tool_execution_start` | `tool_call_start` | Direct mapping |
| `tool_execution_update` | *(none)* | New; tool progress, can be added or omitted |
| `tool_execution_end` | `tool_call_end` | Direct mapping |

**Additional notes:**

- Each pipeline phase (THOUGHT, AGENTIC LOOP, REFLECT) creates its own event session/scope for traceability. This allows log consumers to correlate events to a specific phase of the tick.
- `thinking_start`/`thinking_end` are dropped. These were Claude SDK-specific events not present in pi-agent-core.
- `turn_start` is available as a new event type (mapped from pi-agent-core's `turn_start` event).
- The event bridge provides normalized events that consumers can persist using their own logging infrastructure.
- The consumer may emit its own pipeline events (e.g., `tick_input`, `tick_output`, `execute_*`) independently of the event bridge. These are application-level events that the consumer logs during its own pipeline phases, not pi-agent-core events.

### Error Recovery

Pi-ai surfaces errors as plain `Error` objects with string messages. Cortex implements a regex-based error classifier that maps error strings to actionable categories (`authentication`, `rate_limit`, `context_overflow`, `server_error`, `network`, `cancelled`, `unknown`). Classified errors are emitted via the `onError` event for the consumer to route (logging, UI notifications, backoff).

Cortex also provides **automatic retry** for transient errors (`rate_limit`, `server_error`, `network`) inside `prompt()`. Uses `agent.continue()` from pi-agent-core with exponential backoff (default: 5 retries, 2s base delay). Retry events (`onRetry`, `onRetriesExhausted`) let consumers show UI feedback. Provider SDKs have inconsistent retry coverage; Cortex provides uniform behavior.

See **`error-recovery.md`** for the full design: classification patterns per category, error event flow, auth failure detection, automatic retry mechanism, consumer-specific rate limit handling, and integration with the 5-phase pipeline.

### Token Tracking

Pi-agent-core has no pre-request token counting. Pi-ai reports `Usage` (inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, per-category costs) on every response. `model.contextWindow` provides the limit.

Cortex tracks tokens through two complementary mechanisms:

- **Post-hoc tracking**: Running `currentContextTokenCount` from per-turn `AssistantMessage.usage`. Updated after every LLM call.
- **Heuristic estimation**: A built-in `estimateCurrentContextTokens()` API uses `estimateTokens(text)` internally to estimate context size before the first LLM call and between calls. This is critical for compaction and consumer UIs: if the heuristic estimate of the current message array is approaching `model.contextWindow`, Cortex can trigger compaction proactively and consumers can show current context pressure without waiting for the next post-hoc usage report.

The heuristic is a duplicate of the same utility in `@animus-labs/shared` (4 lines), kept inline to avoid a dependency.

## Lifecycle

Pi-agent-core's `Agent` class has no `destroy()` or `dispose()` method. It provides `abort()` (cancels the running loop via AbortController), `waitForIdle()` (resolves when the loop finishes), and `reset()` (clears message history and queues). But there is no instance-level cleanup: event listeners are never auto-removed, and the Agent holds references to callbacks and message arrays indefinitely.

Cortex wraps this with explicit lifecycle management.

### `CortexAgent.destroy()`

Ordered cleanup of all resources. Called by the consumer when the agent is no longer needed (e.g., during application shutdown or pipeline teardown).

```typescript
async destroy(): Promise<void> {
  // 1. Abort any in-progress agentic loop
  this.agent.abort();
  await this.agent.waitForIdle();

  // 2. Cancel all background sub-agents
  for (const subAgent of this.activeSubAgents) {
    subAgent.abort();
    await subAgent.waitForIdle();
    this.emit('onSubAgentFailed', subAgent.taskId, 'Parent agent destroyed');
  }

  // 3. Checkpoint conversation history (best-effort)
  try {
    this.emit('onLoopComplete');  // gives consumer a chance to save
  } catch { /* ignore checkpoint failures during shutdown */ }

  // 4. Close all MCP client connections
  await this.mcpClientManager.closeAll();
  //    - Stdio subprocesses are killed
  //    - HTTP connections are closed
  //    - Bridge context registry entry is unregistered

  // 5. Clear skill buffer
  this.skillRegistry.clear();

  // 6. Unsubscribe from pi-agent-core events
  for (const unsub of this.eventUnsubscribers) {
    unsub();
  }

  // 7. Clear agent state
  this.agent.reset();

  // 8. Mark as destroyed
  this.destroyed = true;
  // All subsequent prompt() calls throw: "Agent has been destroyed"
}
```

### `CortexAgent.abort()`

Cancel the current agentic loop without destroying the agent. The agent remains usable for subsequent prompts.

```typescript
async abort(): Promise<void> {
  this.agent.abort();
  await this.agent.waitForIdle();
}
```

**Tool abort is cooperative.** Pi-agent-core passes the `AbortSignal` to each `tool.execute()` call, but if a tool doesn't check the signal, it runs to completion. For Bash commands, the process tree is killed independently via the process cleanup mechanism (see `bash.md`). For MCP tool calls, the MCP client can close the pending request.

### Consumer Shutdown Integration

The consumer calls `destroy()` during its shutdown sequence (e.g., stopping a pipeline, exiting the application):

```typescript
async function shutdown(): Promise<void> {
  pipeline.stop();
  pipeline.clear();                 // prevent new work during shutdown
  await cortexAgent?.destroy();     // ordered cleanup
  cortexAgent = null;
}
```

The consumer should prevent new work from starting before calling `destroy()` to avoid a race where new prompts arrive while shutdown is in progress.

### Process Signal Handling

On `SIGTERM`/`SIGINT`, the consumer's signal handler calls `destroy()`. The key concern is **orphaned MCP subprocesses**, especially on Windows where there are no process groups by default.

Mitigations:
- **Unix**: MCP stdio subprocesses are spawned with `detached: true` in their own process group. On destroy, `kill(-pid, SIGKILL)` kills the entire group.
- **Windows**: MCP stdio subprocesses are tracked by PID. On destroy, `taskkill /F /T /PID` kills each one. As a safety net, cortex registers a `process.on('exit')` handler that runs synchronous cleanup for any processes still alive.
- **All platforms**: Cortex stores spawned subprocess PIDs in a set. The `process.on('exit')` handler iterates and kills any remaining. This is a last-resort fallback for unclean exits (SIGKILL, crash).

### Lifecycle States

```
CREATED → ACTIVE → DESTROYED
                ↑
                └── abort() returns to ACTIVE (agent still usable)
```

- **CREATED**: After `await CortexAgent.create(config)`. Slots can be set, but no loops have run.
- **ACTIVE**: After the first `prompt()` call. The agent is running or idle between prompts.
- **DESTROYED**: After `destroy()`. All resources released. Any `prompt()` call throws.

There is no IDLE vs RUNNING sub-state. The consumer can check `agent.isRunning` (delegates to pi-agent-core's internal streaming state) if needed.

## References

- [pi-agent-core source](https://github.com/badlogic/pi-mono/tree/main/packages/agent)
- [pi-ai source](https://github.com/badlogic/pi-mono/tree/main/packages/ai)
- [pi.dev](https://pi.dev)
- Pi Agent Core context architecture diagram: `App.pen` (frame: "pi-agent-core Context Architecture")
