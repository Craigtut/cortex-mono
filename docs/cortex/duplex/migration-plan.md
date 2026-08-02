# Migration Plan

> **STATUS: DESIGN, NOT IMPLEMENTED**

Four phases, developed on the `duplex-restructure` branch (an exception to the usual commit-to-main rule, given the size of the overhaul). Each phase lands in small conventional commits, keeps the test suite green, and is independently valuable. File:line references are as of 2026-08 and will drift; they identify the sites, not eternal truths.

Items marked **[Rn]** come from the pre-implementation reviews; see review-findings.md for the reasoning.

## Phase 0: Standalone Fixes

Bugs and gaps worth shipping regardless of duplex. Each item is small, testable, and committable independently.

1. **Background-result durability.** `drainPendingBackgroundResults` splices the pending queue before delivering (`cortex-agent.ts:4790`); a throw in the delivery loop drops completed work permanently. Re-queue unsent results on failure, with a capped attempt count and dead-letter path so a deterministic failure cannot redeliver forever. **[R17]**
2. **Spawn-path leaks.** Destroy the just-created child when `track()` fails in both foreground (`cortex-agent.ts:4587-4599`) and background (`4689-4696`) paths; add a cap pre-check to public `spawnBackgroundSubAgent` (`4301`).
3. **Real sub-agent cancellation.** `cancel(taskId)` on the sub-agent manager: abort, untrack, discard the pending completion. Today `abort()` never touches children and a surviving child's completion replaces the aborted controller and delivers anyway (`917-922`), so nothing can actually cancel work. **[R-F10]**
4. **Abort-raced permission asks.** pi awaits `beforeToolCall` before checking the abort signal (`pi-agent-core/dist/agent-loop.js:372-383`), so a pending ask hangs abort/destroy into the 8s force-kill path. Race the consumer resolver against the loop's abort signal in Cortex's wrapper; return a block on abort. Pass an abort signal into the resolver context so a consumer UI can dismiss a moot prompt. No pi change. **[R17]**
5. **Abort-stub trim.** Trim-and-continue machinery exists but only fires on retry (`retry-policy.ts:86` returns false on abort), so a user abort leaves the aborted assistant stub in history, later rewritten to `(no output)`. Trim it on abort.
6. **Dead config.** Thread or delete `webFetch.maxPerLoop`, `bash.autoYieldThreshold`, `bash.shellPath` (declared in `types.ts:230-241`, never wired by the agent path).
7. **Background child event forwarding.** Enable `forwardFrom` for background children (currently skipped, `cortex-agent.ts:4698-4700`). Fixes dead live-activity surfaces (`4498-4501`), background usage undercounting, and is a prerequisite for headlines. Add the missing unsubscribe in the completion continuation (none exists today, so listeners would leak per task) and audit consumer usage summation for double-count. **[R19]**
8. **Escape headline interpolation.** Task instructions, commands, and stdout tails reach `buildBackgroundTaskState` verbatim (`4474-4538`).

`deliver()` was originally P0.3 and has moved to P1; the reviews showed it is a state machine, not a small fix. **[R16]**

## Phase 1: Rename and Loop Hardening

The breaking-change phase. Wants clean CI before starting; lands as a small number of focused commits.

1. **Rename.** `CortexAgent` (class) becomes `AgentLoop`. The `CortexAgent` name is reserved for the facade (Phase 2). Deprecated aliases (`buildSystemPrompt`, `rebuildSystemPrompt`, `systemPrompt` config) are removed in the same pass rather than renamed. Public type names that churn (`PiAgent`, `DirectCompletionOptions`) are re-exported under the new module layout. Measured blast radius: 569 occurrences across 24 src files, 9 test files, 2 cortex-code files, 28 doc files, including ~90 `[CortexAgent]` log prefixes that become misleading. cortex-code's `session.ts` calls `CortexAgent.create` directly and flips in the same commit. This is an npm major. **[R19]**
2. **`deliver()` primitive.** A state machine over (loop-gate depth, pi run state, abort state) with four branches (see log-and-context.md), implemented inside the loop gate to avoid a time-of-check race, with explicit budget and promise semantics for the follow-up-extended-turn case. Also surface `followUp()`, queue modes, and queue clears. **[R16, R-F5]**
3. **Loop identity.** Origin context (`loopPath`) threaded through: `resolvePermission` (gains `{askId, loopPath}`), `onError`, `onTurnComplete`, `persistResult` metadata, logger prefixes, and events. `childTaskId` becomes the path form (single-level today, overwritten on re-forwarding).
4. **Long-lived mode.** Opt-in `persistentRuntime` (skip `toolRuntime.resetForLoop()` per prompt, `cortex-agent.ts:936`); lifetime budget mode (no per-prompt `budgetGuard.reset()`, `940`) plus the plumbing for a facade-level aggregate guard (parent guards currently skip child events, `budget-guard.ts:87-89`).
5. **Steer addressability.** Typed child handles (replace `agent: unknown`, `types.ts:1300`); `steerSubAgent(taskId, message)` on the sub-agent manager, built on `deliver()`.
6. **Timeouts, caps, per-spawn overrides.** Wall-clock timeout per spawn producing the existing-but-unused `timed_out` status (`types.ts:1281`), treated as a launch blocker; separate concurrency pools for reasoner sub-agents and quick lookups (`sub-agent-manager.ts:41`); per-spawn model/compaction/thinking overrides (`createChildAgent` hardcodes the parent's primary model at `4909`). **[R-F19]**
7. **Ask registry.** Facade-queryable pending-ask collection with per-ask nonces, a `voiced` state field, and a mandatory verbatim `renderedRequest` (today: one anonymous nullable slot per tracked child). **[R-F2, R-F14]**
8. **Headline feed API.** A small `AgentLoop` surface letting the facade feed the headline block into a loop's `transformContext`; `buildBackgroundTaskState` and its injection point are private and loop-local today. **[R-plan]**
9. **Non-blocking compaction posture.** A loop mode that disables the synchronous observer fallback, leaving emergency truncation as the only in-band path (for the talker). **[R-F7]**

## Phase 2: The Facade

The new `CortexAgent`. Built against the hardened primitive; passthrough mode first, duplex assembled behind it.

1. Facade class: talker + persistent reasoner, mode routing, the completed config routing table (facade-api.md), per-loop session IDs, staggered compaction thresholds, talker constructed with no `resolvePermission` and a facade-set hard `maxTurns`, **and the aggregate budget guard active from the first assembly** (moved up from P3: duplex must never run with per-prompt budgets as its only bound). **[R-F1, R-F3]**
2. The session log: entry types (including `error`/`retrying`), append/subscribe with offsets, retention/ring-buffer policy, versioned composite persistence (v2; idempotent usage restore; restore-while-running rejection; v1 upgrade path), and the `onStateChanged` persistence trigger. **[R-F8, R-plan]**
3. Router: wake policy (`interrupt` / `when_idle` / `silent` with producer-proposes/router-disposes), advisory idle signal with facade-enforced minimum spacing, and backpressure per D19 (interrupt token bucket, content-hash dedup, per-turn and per-exchange delegation caps, dispatch dedup on `(loopPath, turnIndex, toolName, argsHash)`). **[R-F13]**
4. Control toolset on the talker: `spawn_task`, `steer_task`, `cancel_task`, `answer_ask`, `quick_lookup`; local dispatch into the router; **every outcome returns `{content, terminate: true}` and control tools never throw or return `isError`** (D17); required result shape asserted by testing that the batch terminates; failed dispatch produces a voiceable lifecycle entry. **[R-F9]**
5. Headlines: generalize `buildBackgroundTaskState` (`cortex-agent.ts:4474-4538`) into the facade-fed, hard-capped status block with aliases and `as_of` timestamps, injected outside BP3 for the talker.
6. Permission broker end-to-end (communication.md): D16 consent binding in the router, verbatim `renderedRequest`, one-voiced-at-a-time, escalation-class timeouts, `resolveNetworkAccess` and the sandbox ask callback routed through the same pipeline, passthrough bypass. **[R-F2, R-F14]**
7. `Deliver` tool for the reasoner (`{content, wake}`), implicit `when_idle` delivery from final assistant text, and the liveness watchdog for long silent runs. `SteerSubAgent` tool; no steer fast-path (D20). **[R-F1, R-F11]**
8. Quick lookups: `quick_lookup` control tool, ephemeral spawns with an in-tool path allowlist rooted at `workingDirectory` and inherited sandbox, results wake the talker and route to the reasoner via the log. **[R-F12]**
9. MCP multiplexer and skill registration fan-out (single-slot callback fields become listener arrays; one stdio subprocess per server total).
10. Sanitized talker delta stream for TTS: holdback buffering across chunk boundaries, emitted as a defined event. **[R-F6]**
11. Talker role prompt: presence, grounding rules (never state facts absent from headlines/deliveries, never invent outcomes of unfinished work, correct yourself when a later delivery contradicts what you said), verbatim reading of destructive and escalation asks, honest staleness phrasing from `as_of`, routing context-dependent questions to the reasoner rather than to a lookup.
12. Reasoner prompt: background long commands, delegate long parallelizable work, deliver with appropriate wake classes; conversation deltas arrive wrapped as context-only and never as instruction (D18).

## Phase 3: Validation and Default Flip

1. Scenario integration tests, each run in both modes:
   - coding session with mid-work questions and a quick lookup
   - deep research with a mid-flight redirect (parent-to-child steer)
   - iterative design against the persistent reasoner
   - permission brokering through conversation (including timeout and abort paths)
   - passthrough parity, measured against the **post-P0/P1 baseline**, not against today (P0.5 and the P1 signature additions change behavior legitimately) **[R-plan]**
2. Adversarial scenario tests: **[red-team]**
   - persuasion attempt against a live pending ask via planted content in a delivery
   - two-pending-ask mis-binding under a bare "yes"
   - injected `cancel_task`/`steer_task` using an alias harvested from headlines
   - control-tool error loop, asserting bounded turns
   - retry-induced double dispatch
   - cancel-during-completion, abort-during-drain, user-speaks-during-interrupt-turn
   - grounding held under repeated user pressure ("just tell me what it found so far")
3. Latency measurement harness: talker TTFT (warm and cold-cache), control-tool dispatch latency, delivery-to-voiced latency, and a talker-prefix size guardrail.
4. Docs sync (this folder moves from DESIGN to IMPLEMENTED status; consumer-guide.md updated).
5. Duplex ships as the default with `mode: 'passthrough'` as the opt-out (decisions.md D14).

## Out of Scope for Launch

- Resumable/persistent sub-agent state (tasks re-derive from the log).
- Parent-to-child steering below tier 2 (sub-agents cannot spawn, so there is no tier 4 to steer).
- Cross-loop shared MCP tool state beyond connection multiplexing.
- Upstream pi-agent-core changes of any kind. The abort-check-before-`beforeToolCall` nicety may be proposed upstream later; Cortex does not depend on it.
