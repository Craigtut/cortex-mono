# Sub-Agents: Tiers, Steering, Quick Lookups, Lifecycle

> **STATUS: IMPLEMENTED AND DEFAULT.** Built across phases 0 through 2b-ii on the `duplex-restructure` branch and validated in Phase 3. Duplex is the default mode (D14); `mode: 'passthrough'` is the opt-out. See migration-plan.md for the honest boundary of what the test suite can see, and consumer-guide.md for what changes on upgrade.

## Tier Rules

```
tier 1  talker            spawns nothing
tier 2  reasoner          spawns sub-agents (foreground or background)
tier 2* facade            spawns restricted quick-lookup sub-agents on the talker's behalf
tier 3  sub-agents        spawn nothing (hard cap)
```

The depth cap is enforced by configuration the facade controls: the current hardcoded `enableSubAgentTool: false` for children (`agent-loop.ts:4965-4968`) becomes a tier-driven setting (true for the reasoner, false for tier 3).

## Parent-to-Child Steering (Launch Requirement)

The reasoner must be able to redirect a running sub-agent without killing it. Cancel-and-respawn was rejected (decisions.md D12).

What exists: every child is a full AgentLoop with a steering queue; pi drains steering at turn boundaries. What is missing, per the coordination audit:

- Addressability: `TrackedSubAgent.agent` is typed `unknown` (`types.ts:1300`) and snapshots omit the handle; no steer-by-taskId surface exists anywhere.
- A delivery primitive that works regardless of loop state: `steer()` silently no-ops on an idle agent (`agent-loop.ts:1261`) and `prompt()` throws on a busy one (`agent-loop.ts:814-825`).

Build:

1. `deliver(message)` on AgentLoop (P0): prompt-if-idle, steer-if-running, queue via pi's currently unexposed `followUpQueue` otherwise.
2. Typed child handles and `steerSubAgent(taskId, message)` on the sub-agent manager (P1).
3. A reasoner-facing `SteerSubAgent` tool (P2). Tool calls are acceptable here: the reasoner is not latency-critical, and a tool result confirming queued delivery is useful signal.
4. Steer events become log lifecycle entries so the talker's headlines reflect the redirect.

Full chain: user speaks -> talker calls `steer_task({taskAlias: "scan", message: "focus on Europe"})` -> facade delivers to the reasoner -> reasoner calls `SteerSubAgent(taskId, ...)` -> child's queue drains at its next turn boundary.

Steers always route through the reasoner. An earlier draft allowed the facade to deliver straight to a named child, saving one hop; that is removed (decisions.md D20) because a steer message becomes a real user-role message in a tool-carrying child, and the fast-path put injected content one step from that child with no loop exercising judgment in between. Task references in control tools use short aliases surfaced in headlines, not the underlying UUIDs.

## Quick Lookups

Problem: while the reasoner is mid-turn, small factual questions ("what does resolveModel actually do?") cannot wait for its turn boundary, and the talker has no tools by design.

Solution (decisions.md D13): the facade spawns an ephemeral sub-agent with a read-only toolset (Read, Grep, Glob; no Write/Edit/Bash-write, no spawning), a fast model, a short wall-clock timeout, and a small concurrency cap separate from the reasoner's. The talker triggers it with its `quick_lookup` control tool and covers the wait conversationally; the result wakes the talker (`interrupt`).

Read restriction is enforced in-tool, not by prompt. `createGrepTool` is sandbox-threaded today but `createReadTool` and `createGlobTool` are not (no sandbox parameter exists on either), so an unrestricted lookup agent could read any file the process can, including paths the sandbox denies to Grep. Lookup results become real talker messages and get spoken, which makes an unrestricted read a direct exfiltration path. Lookup spawns therefore carry a path allowlist rooted at `workingDirectory`, inherit the sandbox, and are permission-gated through the broker like any other loop.

Lookups start with no conversation context, so they answer standalone factual questions only. The talker's role prompt routes context-dependent questions ("what did that test failure say") to the reasoner instead.

Shared-context guarantee: lookup results are appended to the log and routed to the reasoner as a delta at its next turn. The reasoner sees everything the talker learned. Lookups carry no decision authority and mutate nothing, so no session context ever forks; the single-reasoner invariant (decisions.md D3) holds.

## Lifecycle Fixes Required for This Design

From the coordination audit, in build order:

**P0 (bugs regardless of duplex):**

- Background-result durability: `drainPendingBackgroundResults` splices the queue before delivering (`agent-loop.ts:4790`); a delivery failure permanently drops completed work. Re-queue on failure, with a capped attempt count and a dead-letter path so a deterministic failure cannot loop forever.
- Real cancellation: `abort()` does not touch sub-agents (only `destroy()` cascades via `cancelAll`), and a surviving child's completion path replaces the aborted controller and delivers anyway (`agent-loop.ts:917-922`), so today's "cancel" neither stops the work nor suppresses its result. Add `cancel(taskId)` to the sub-agent manager (abort, untrack, discard the pending completion) and have the drain drop cancelled items.
- Escape interpolated values in `buildBackgroundTaskState`: task instructions and stdout tails reach the headline block verbatim.
- Spawn-path leaks: `track()` failure after child creation leaks a live agent in both foreground and background paths (`agent-loop.ts:4587-4599`, `4689-4696`); public `spawnBackgroundSubAgent` (`agent-loop.ts:4301`) has no cap pre-check.
- Event forwarding for background children: currently disabled (`agent-loop.ts:4698-4700`), which leaves them invisible (no live activity, no usage accounting) and makes the `Current:` headline surface dead code. Enable it; the headline system depends on it. Two side effects to handle: the background path has no unsubscribe site today, so one must be added to the completion continuation or listeners leak per task; and `_sessionUsage` will start accumulating background-child usage, so any consumer that also sums `SubAgentResult.usage` needs auditing for double-count.
- Abort-raced permission asks (see communication.md).

**P1 (long-lived reasoner support):**

- Persistent tool runtime: `toolRuntime.resetForLoop()` runs at every prompt start (`agent-loop.ts:936`), wiping Read-before-Edit state, cwd, and undo history. A reasoner woken repeatedly by deliveries must keep that state across prompts (opt-in `persistentRuntime` flag on AgentLoop).
- Lifetime budgets: `budgetGuard.reset()` per prompt (`agent-loop.ts:940`) makes `maxCost` meaningless for a loop prompted many times per session. Add a lifetime budget mode plus a facade-level aggregate guard covering talker + reasoner + all sub-agents (today parent guards skip child events entirely, `budget-guard.ts:87-89`).
- Loop identity on events and callbacks: `childTaskId` is single-level and overwritten on re-forwarding; it becomes a loop path (e.g. `reasoner/task-7`). All consumer callbacks gain origin context.
- Timeouts: the `timed_out` sub-agent status exists in types (`types.ts:1281`) but nothing produces it. Wall-clock caps per spawn, with profile defaults. This is a launch blocker, not a nicety: without it a saturated sub-agent fleet has no upper bound on spend.
- Per-spawn model override: `createChildAgent` hardcodes the parent's primary model (`agent-loop.ts:4909`), but quick lookups need a fast model and the architecture already claims per-spawn model selection. Add model, compaction, and thinking-level overrides to the child-config path.
- Separate caps: one concurrency cap currently conflates everything (`sub-agent-manager.ts:41`); quick lookups get their own small pool so a busy task fleet cannot starve them, and vice versa.

## MCP and Shared Services

Children currently execute MCP tools over the parent's connections via captured closures (`agent-loop.ts:5101`, `mcp-client.ts:624-663`), and `McpClientManager` callbacks are single-slot fields, so naive sharing between resident loops breaks silently while not sharing forks one stdio subprocess per server per loop. The facade owns an MCP multiplexer (P2): one connection per server, listener arrays instead of single-slot callbacks, tools projected into the reasoner (and sub-agents) only. The talker never sees MCP tools.

Skills follow the same pattern at the facade: one registration API, fanned out to per-loop registries (the registry's single `onChange` slot makes instance sharing unsafe).
