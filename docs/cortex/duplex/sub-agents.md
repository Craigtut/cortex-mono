# Sub-Agents: Tiers, Steering, Quick Lookups, Lifecycle

> **STATUS: DESIGN, NOT IMPLEMENTED**

## Tier Rules

```
tier 1  talker            spawns nothing
tier 2  reasoner          spawns sub-agents (foreground or background)
tier 2* facade            spawns restricted quick-lookup sub-agents on the talker's behalf
tier 3  sub-agents        spawn nothing (hard cap)
```

The depth cap is enforced by configuration the facade controls: the current hardcoded `enableSubAgentTool: false` for children (`cortex-agent.ts:4965-4968`) becomes a tier-driven setting (true for the reasoner, false for tier 3).

## Parent-to-Child Steering (Launch Requirement)

The reasoner must be able to redirect a running sub-agent without killing it. Cancel-and-respawn was rejected (decisions.md D12).

What exists: every child is a full AgentLoop with a steering queue; pi drains steering at turn boundaries. What is missing, per the coordination audit:

- Addressability: `TrackedSubAgent.agent` is typed `unknown` (`types.ts:1300`) and snapshots omit the handle; no steer-by-taskId surface exists anywhere.
- A delivery primitive that works regardless of loop state: `steer()` silently no-ops on an idle agent (`cortex-agent.ts:1261`) and `prompt()` throws on a busy one (`cortex-agent.ts:814-825`).

Build:

1. `deliver(message)` on AgentLoop (P0): prompt-if-idle, steer-if-running, queue via pi's currently unexposed `followUpQueue` otherwise.
2. Typed child handles and `steerSubAgent(taskId, message)` on the sub-agent manager (P1).
3. A reasoner-facing `SteerSubAgent` tool (P2). Tool calls are acceptable here: the reasoner is not latency-critical, and a tool result confirming queued delivery is useful signal.
4. Steer events become log lifecycle entries so the talker's headlines reflect the redirect.

Full chain: user speaks -> talker calls `steer_task({taskId: "task-7", message: "focus on Europe"})` -> facade delivers to the reasoner -> reasoner calls `SteerSubAgent("task-7", ...)` -> child's queue drains at its next turn boundary. When `taskId` names a running sub-agent directly, the facade may deliver the steer straight to that child and inform the reasoner via the log, saving one hop; the router owns that choice, not the consumer.

## Quick Lookups

Problem: while the reasoner is mid-turn, small factual questions ("what does resolveModel actually do?") cannot wait for its turn boundary, and the talker has no tools by design.

Solution (decisions.md D13): the facade spawns an ephemeral sub-agent with a read-only toolset (Read, Grep, Glob; no Write/Edit/Bash-write, no spawning), a fast model, a short wall-clock timeout, and a small concurrency cap separate from the reasoner's. The talker triggers it with its `quick_lookup` control tool and covers the wait conversationally; the result wakes the talker (`interrupt`).

Shared-context guarantee: lookup results are appended to the log and routed to the reasoner as a delta at its next turn. The reasoner sees everything the talker learned. Lookups carry no decision authority and mutate nothing, so no session context ever forks; the single-reasoner invariant (decisions.md D3) holds.

## Lifecycle Fixes Required for This Design

From the coordination audit, in build order:

**P0 (bugs regardless of duplex):**

- Background-result durability: `drainPendingBackgroundResults` splices the queue before delivering (`cortex-agent.ts:4790`); a delivery failure permanently drops completed work. Re-queue on failure.
- Spawn-path leaks: `track()` failure after child creation leaks a live agent in both foreground and background paths (`cortex-agent.ts:4587-4599`, `4689-4696`); public `spawnBackgroundSubAgent` (`cortex-agent.ts:4301`) has no cap pre-check.
- Event forwarding for background children: currently disabled (`cortex-agent.ts:4698-4700`), which leaves them invisible (no live activity, no usage accounting) and makes the `Current:` headline surface dead code. Enable it; the headline system depends on it.
- Abort-raced permission asks (see communication.md).

**P1 (long-lived reasoner support):**

- Persistent tool runtime: `toolRuntime.resetForLoop()` runs at every prompt start (`cortex-agent.ts:936`), wiping Read-before-Edit state, cwd, and undo history. A reasoner woken repeatedly by deliveries must keep that state across prompts (opt-in `persistentRuntime` flag on AgentLoop).
- Lifetime budgets: `budgetGuard.reset()` per prompt (`cortex-agent.ts:940`) makes `maxCost` meaningless for a loop prompted many times per session. Add a lifetime budget mode plus a facade-level aggregate guard covering talker + reasoner + all sub-agents (today parent guards skip child events entirely, `budget-guard.ts:87-89`).
- Loop identity on events and callbacks: `childTaskId` is single-level and overwritten on re-forwarding; it becomes a loop path (e.g. `reasoner/task-7`). All consumer callbacks gain origin context.
- Timeouts: the `timed_out` sub-agent status exists in types (`types.ts:1281`) but nothing produces it. Wall-clock caps per spawn, with profile defaults.
- Separate caps: one concurrency cap currently conflates everything (`sub-agent-manager.ts:41`); quick lookups get their own small pool so a busy task fleet cannot starve them, and vice versa.

## MCP and Shared Services

Children currently execute MCP tools over the parent's connections via captured closures (`cortex-agent.ts:5101`, `mcp-client.ts:624-663`), and `McpClientManager` callbacks are single-slot fields, so naive sharing between resident loops breaks silently while not sharing forks one stdio subprocess per server per loop. The facade owns an MCP multiplexer (P2): one connection per server, listener arrays instead of single-slot callbacks, tools projected into the reasoner (and sub-agents) only. The talker never sees MCP tools.

Skills follow the same pattern at the facade: one registration API, fanned out to per-loop registries (the registry's single `onChange` slot makes instance sharing unsafe).
