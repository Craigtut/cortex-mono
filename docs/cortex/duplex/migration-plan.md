# Migration Plan

> **STATUS: DESIGN, NOT IMPLEMENTED**

Four phases. Each phase lands on main in small conventional commits, keeps the test suite green, and is independently valuable. File:line references are as of 2026-08 and will drift; they identify the sites, not eternal truths.

## Phase 0: Standalone Fixes

Bugs and gaps worth shipping regardless of duplex. Each item is small, testable, and committable independently.

1. **Background-result durability.** `drainPendingBackgroundResults` splices the pending queue before delivering (`cortex-agent.ts:4790`); a throw in the delivery loop drops completed work permanently. Re-queue unsent results on failure.
2. **Spawn-path leaks.** Destroy the just-created child when `track()` fails in both foreground (`cortex-agent.ts:4587-4599`) and background (`4689-4696`) paths; add a cap pre-check to public `spawnBackgroundSubAgent` (`4301`).
3. **`deliver()` primitive.** New method on the loop: prompt-if-idle, steer-if-running, queue otherwise via pi's `followUpQueue` (exists in pi, unexposed by Cortex). Also surface `followUp()`, steering/follow-up queue modes, and queue clears. Closes the steer-silently-drops (`1261`) / prompt-throws (`814-825`) gap.
4. **Abort-raced permission asks.** pi awaits `beforeToolCall` before checking the abort signal (`pi-agent-core/dist/agent-loop.js:372-383`), so a pending ask hangs abort/destroy into the 8s force-kill path. Race the consumer resolver against the loop's abort signal in Cortex's wrapper; return a block on abort. No pi change.
5. **Abort-stub trim.** Trim-and-continue machinery exists but only fires on retry (`retry-policy.ts:86` returns false on abort), so a user abort leaves the aborted assistant stub in history, later rewritten to `(no output)`. Trim it on abort.
6. **Dead config.** Thread or delete `webFetch.maxPerLoop`, `bash.autoYieldThreshold`, `bash.shellPath` (declared in `types.ts:230-241`, never wired by the agent path).
7. **Background child event forwarding.** Enable `forwardFrom` for background children (currently skipped, `cortex-agent.ts:4698-4700`). Fixes dead live-activity surfaces (`4498-4501`), background usage undercounting, and is a prerequisite for headlines.

## Phase 1: Rename and Loop Hardening

The breaking-change phase. Wants clean CI before starting; lands as a small number of focused commits.

1. **Rename.** `CortexAgent` (class) becomes `AgentLoop`. The `CortexAgent` name is reserved for the facade (Phase 2). Deprecated aliases (`buildSystemPrompt`, `rebuildSystemPrompt`, `systemPrompt` config) are removed in the same pass rather than renamed. Public type names that churn (`PiAgent`, `DirectCompletionOptions`) are re-exported under the new module layout.
2. **Loop identity.** Origin context (`loopPath`) threaded through: `resolvePermission` (gains `{askId, loopPath}`), `onError`, `onTurnComplete`, `persistResult` metadata, logger prefixes, and events. `childTaskId` becomes the path form (single-level today, overwritten on re-forwarding).
3. **Long-lived mode.** Opt-in `persistentRuntime` (skip `toolRuntime.resetForLoop()` per prompt, `cortex-agent.ts:936`); lifetime budget mode (no per-prompt `budgetGuard.reset()`, `940`) plus the plumbing for a facade-level aggregate guard (parent guards currently skip child events, `budget-guard.ts:87-89`; background children forward nothing until P0.7).
4. **Steer addressability.** Typed child handles (replace `agent: unknown`, `types.ts:1300`); `steerSubAgent(taskId, message)` on the sub-agent manager, built on `deliver()`.
5. **Timeouts and caps.** Wall-clock timeout per spawn producing the existing-but-unused `timed_out` status (`types.ts:1281`); separate concurrency pools for reasoner-spawned sub-agents and facade quick lookups (today one cap conflates all spawning, `sub-agent-manager.ts:41`).
6. **Ask registry.** Facade-queryable pending-ask collection with ask IDs (today: one anonymous nullable slot per tracked child).

## Phase 2: The Facade

The new `CortexAgent`. Built against the hardened primitive; passthrough mode first, duplex assembled behind it.

1. Facade class: talker + persistent reasoner, mode routing, config routing table (facade-api.md), per-loop session IDs, staggered compaction thresholds.
2. The session log: entry types, append/subscribe, versioned composite persistence (v2 format; idempotent usage restore; restore-while-running guard; v1 upgrade path).
3. Router and wake policy: `interrupt` / `when_idle` / `silent`, consumer idle signal, `when_idle` degradation delay, delivery via `deliver()`.
4. Directive parser on the talker's delta stream: `<task>`, `<steer>`, `<cancel>`, `<answer>`, `<lookup>`; dispatch on tag close; directives stripped from user-facing text per working-tags conventions.
5. Headlines: generalize `buildBackgroundTaskState` (`cortex-agent.ts:4474-4538`) into the facade-fed, token-capped status block, injected outside BP3 for the talker.
6. Permission broker end-to-end (communication.md), including timeouts and passthrough bypass.
7. `SteerSubAgent` tool for the reasoner; facade fast-path for user steers that obviously target a named task.
8. Quick lookups: `<lookup>` directive, read-only ephemeral spawns, results wake the talker and route to the reasoner via the log.
9. MCP multiplexer and skill registration fan-out (single-slot callback fields become listener arrays; one stdio subprocess per server total).
10. Talker role prompt: presence, grounding rules (never state facts absent from headlines/deliveries, never invent outcomes of unfinished work), directive usage, honest staleness phrasing.
11. Reasoner prompt nudges: background long commands, delegate long parallelizable work, deliver milestones with appropriate wake classes.

## Phase 3: Validation and Default Flip

1. Scenario integration tests, each run in both modes:
   - coding session with mid-work questions and a quick lookup
   - deep research with a mid-flight redirect (parent-to-child steer)
   - iterative design against the persistent reasoner
   - permission brokering through conversation (including timeout and abort paths)
   - passthrough parity: byte-identical behavior versus a pre-facade baseline
2. Facade-level aggregate budget guard active across all loops.
3. Latency measurement harness: talker TTFT, directive dispatch latency, delivery-to-voiced latency.
4. Docs sync (this folder moves from DESIGN to IMPLEMENTED status; consumer-guide.md updated).
5. Duplex ships as the default with `mode: 'passthrough'` as the opt-out (decisions.md D14).

## Out of Scope for Launch

- Resumable/persistent sub-agent state (tasks re-derive from the log).
- Parent-to-child steering below tier 2 (sub-agents cannot spawn, so there is no tier 4 to steer).
- Cross-loop shared MCP tool state beyond connection multiplexing.
- Upstream pi-agent-core changes of any kind. The abort-check-before-`beforeToolCall` nicety may be proposed upstream later; Cortex does not depend on it.
