# Cortex Pre-Commit Hardening Plan

Purpose: capture the implementation order for the architecture issues found in the pre-commit audit so a fresh context can resume work immediately.

## Guiding Decisions

- Public model contract: use `CortexModel` as the public API boundary.
- Internal runtime contract: unwrap `CortexModel` exactly once at the Cortex boundary and use raw pi-ai models internally.
- Do not use sub-agents for this implementation pass. The work is cross-cutting and sequential, so a handoff doc is higher leverage than fragmented delegation.

## Validated Issues

These were re-checked against code, tests, and runtime behavior:

1. `ProviderManager.resolveModel()` returns `CortexModel`, but `CortexAgent` does not unwrap it consistently.
2. Child agents reuse parent tool instances, so mutable built-in tool state is shared across agents.
3. Bash background tasks are process-global and not scoped to an owning agent/session.
4. Child agents do not inherit live MCP tools correctly.
5. Compaction can rely on stale token accounting inside `transformContext`.
6. Permission docs and runtime API do not match.
7. `validateApiKey()` collapses invalid credentials and transient provider failures into the same result.

## Implementation Order

### 1. Enforce the Model Boundary

Goal: make `CortexModel` the public contract and remove model ambiguity.

Tasks:

- Update `CortexAgentConfig.model` to use `CortexModel`.
- Unwrap `CortexModel` inside `CortexAgent` creation and runtime model changes.
- Ensure `prompt()`, `directComplete()`, `structuredComplete()`, and `utilityComplete()` all use the unwrapped internal model.
- Align `setModel()` and utility model resolution with the same boundary.
- Update docs to stop implying dual support for both raw pi-ai models and `CortexModel`.

Files:

- `packages/cortex/src/types.ts`
- `packages/cortex/src/cortex-agent.ts`
- `packages/cortex/src/model-wrapper.ts`
- `packages/cortex/src/provider-manager.ts`
- `docs/cortex/provider-manager.md`
- `docs/cortex/cortex-architecture.md`
- `packages/cortex/README.md`

Acceptance:

- A `ProviderManager.resolveModel()` result works with `CortexAgent.create()`.
- `directComplete()` no longer fails with `api: undefined`.
- Tests cover the full `ProviderManager -> CortexAgent` path.

Suggested commit:

- `refactor(cortex): enforce CortexModel as the public model contract`

### 2. Introduce Per-Agent Tool Runtime State

Goal: stop sharing mutable built-in tool state across parent and child agents.

Tasks:

- Create a per-agent runtime container for:
  - cwd tracking
  - read tracking
  - web-fetch loop counters/cache ownership
  - background task ownership
- Build built-in tools from runtime state instead of long-lived shared closures.
- Make lifecycle resets explicit per agent.

Likely files:

- `packages/cortex/src/cortex-agent.ts`
- `packages/cortex/src/tools/bash/index.ts`
- `packages/cortex/src/tools/task-output.ts`
- `packages/cortex/src/tools/read.ts`
- `packages/cortex/src/tools/write.ts`
- `packages/cortex/src/tools/edit.ts`
- `packages/cortex/src/tools/web-fetch/index.ts`
- new runtime helper module under `packages/cortex/src/tools/` or `packages/cortex/src/`

Acceptance:

- Parent/child cwd changes are isolated.
- Parent/child read registries are isolated.
- WebFetch loop counters/cache behavior is owned by the correct agent runtime.

Suggested commit:

- `refactor(cortex): introduce per-agent tool runtime state`

### 3. Scope Bash Background Tasks to the Owning Agent

Goal: prevent one agent from polling or killing another agent's tasks.

Tasks:

- Move background task storage behind per-agent runtime ownership.
- Namespace task IDs or otherwise bind them to a runtime owner.
- Make `TaskOutput` resolve only tasks from its owning runtime.

Files:

- `packages/cortex/src/tools/bash/index.ts`
- `packages/cortex/src/tools/task-output.ts`

Acceptance:

- A task started by one agent is invisible to another agent.
- Tests verify `poll`, `send`, and `kill` ownership checks.

Suggested commit:

- `fix(cortex): scope background bash tasks to owning agent`

### 4. Fix Child-Agent Tool Inheritance

Goal: child agents should inherit the correct tool inventory without sharing parent mutable state.

Tasks:

- Ensure child agents receive fresh built-in tool instances.
- Decide how live MCP tools are inherited:
  - shared wrapper references only if stateless and safe
  - or rewrapped per child from existing MCP connections
- Keep `SubAgent` and `load_skill` excluded from child agents.

Files:

- `packages/cortex/src/cortex-agent.ts`
- `packages/cortex/src/mcp-client.ts`
- `docs/cortex/tools/sub-agent.md`
- `docs/cortex/mcp-integration.md`

Acceptance:

- Child agents can use allowed live MCP tools.
- Child agents do not mutate parent built-in tool runtime state.

Suggested commit:

- `fix(cortex): isolate child tool state and inherit live MCP tools`

### 5. Correct Compaction Token Accounting

Goal: compaction decisions must be based on safe current-turn estimates, not stale prior-turn counts.

Tasks:

- Audit `CompactionManager.applyInTransformContext()`.
- Use current transformed-context estimation as a first-class input.
- If keeping post-hoc token counts, treat them as a lower bound or compare via `max(...)`.
- Make slot/history accounting explicit and conservative.

Files:

- `packages/cortex/src/compaction/index.ts`
- `packages/cortex/src/cortex-agent.ts`

Acceptance:

- Large ephemeral context injections can trigger compaction correctly.
- Tests cover current-turn growth beyond the previous recorded session token count.

Suggested commit:

- `fix(cortex): correct compaction token accounting`

### 6. Resolve the Permission Contract Mismatch

Goal: match the runtime API to the documented capability, or narrow the docs.

Preferred direction:

- Replace boolean `resolvePermission()` with a structured gate result such as:
  - `allow`
  - `block`
  - `ask`

Fallback direction:

- If approval flows are not part of the first shippable slice, keep boolean allow/block and cut docs back to match.

Files:

- `packages/cortex/src/types.ts`
- `packages/cortex/src/cortex-agent.ts`
- docs for MCP and architecture

Acceptance:

- The public API and docs describe the same permission behavior.

Suggested commit:

- `refactor(cortex): align permission API with approval semantics`

or

- `docs(cortex): narrow permission contract to allow-block semantics`

### 7. Improve ProviderManager Validation Semantics

Goal: avoid treating transient failures as invalid credentials.

Tasks:

- Rework `validateApiKey()` to distinguish:
  - invalid credentials
  - network/server/transient provider failures
  - model/provider resolution failures
- Decide whether to return a richer result type or throw classified errors.

Files:

- `packages/cortex/src/provider-manager.ts`
- relevant tests/docs

Acceptance:

- The consumer can distinguish bad credentials from retryable provider failures.

Suggested commit:

- `fix(cortex): improve api key validation error handling`

## Test Plan

Run after each step:

- `npm run typecheck`
- `npm run test:run`

Add or extend tests for:

- `ProviderManager.resolveModel()` -> `CortexAgent.create()` -> `directComplete()`
- parent/child cwd isolation
- parent/child read-registry isolation
- background task ownership isolation
- child inheritance of live MCP tools
- compaction trigger behavior under large ephemeral injections
- permission contract behavior
- provider validation failure classification

## Recommended Fresh-Context Starting Point

Start with Step 1 and do not mix it with the runtime-state refactor. The model boundary change is foundational and should land first.

Open first:

- `packages/cortex/src/cortex-agent.ts`
- `packages/cortex/src/types.ts`
- `packages/cortex/src/model-wrapper.ts`
- `packages/cortex/src/provider-manager.ts`
- `packages/cortex/tests/unit/cortex-agent.test.ts`
- `packages/cortex/tests/unit/provider-manager.test.ts`

## Follow-Up: Cortex Code Requirements

These items were identified during the Cortex Code architecture audit. They are Cortex-level enhancements needed before Cortex Code ships.

### 8. Automatic Retry for Transient Errors

Goal: Cortex provides uniform retry behavior for `rate_limit`, `server_error`, and `network` errors inside `prompt()`. Provider-level retry coverage is inconsistent (Anthropic SDK: 2 retries, Google Gemini: 3, Groq/xAI/Cerebras: none).

Tasks:

- Add `RetryConfig` to `CortexAgentConfig` (maxRetries, baseDelayMs, maxDelayMs)
- Wrap `prompt()` with retry loop that uses `agent.continue()` from pi-agent-core for retries after transient errors
- Add `onRetry` and `onRetriesExhausted` event handlers to `CortexAgent`
- Classify errors via existing `classifyError()` and retry only when `severity === 'retry'`
- Default: 5 retries, 2s base delay, exponential backoff capped at 32s

Files:

- `packages/cortex/src/cortex-agent.ts` (retry loop in prompt(), new events)
- `packages/cortex/src/types.ts` (RetryConfig, retry event types)
- `packages/cortex/tests/unit/cortex-agent.test.ts` (retry behavior tests)
- `docs/cortex/error-recovery.md` (already updated with the design)

Acceptance:

- `prompt()` automatically retries on rate_limit/server_error/network errors
- Consumer receives `onRetry` events with attempt count and delay
- Non-retryable errors (auth, cancelled) throw immediately
- Retries use `agent.continue()` to resume from where the error occurred

Suggested commit:

- `feat(cortex): add automatic retry with exponential backoff for transient errors`

### 9. Pass isAutoApprove to Bash Safety Layer 7

Goal: When the consumer is in auto-approve mode (e.g., Cortex Code's YOLO mode), the Bash tool's Layer 7 safety classifier should engage its fail-safe behavior (block without classifier).

Currently, `bash/index.ts` calls `runSafetyChecks()` without passing `isAutoApprove`, so Layer 7 always returns `{ allowed: true }`. This means YOLO mode bypasses both the permission prompt AND the auto-mode classifier, which is too permissive.

Tasks:

- Add `isAutoApprove?: boolean` to `BashToolConfig`
- Pass `config.isAutoApprove` through to `runSafetyChecks()` in `bash/index.ts:277-284`
- Consumer sets `isAutoApprove: true` when YOLO mode is active

Files:

- `packages/cortex/src/tools/bash/index.ts` (pass isAutoApprove to runSafetyChecks)
- `packages/cortex/src/tools/bash/index.ts` (BashToolConfig interface)
- `packages/cortex/tests/unit/tools/bash-safety.test.ts` (verify Layer 7 engages)

Acceptance:

- Layer 7 blocks commands when `isAutoApprove=true` and no utility classifier is available
- Layer 7 still passes through when `isAutoApprove=false` (normal permission flow)
- Existing tests pass; new test verifies Layer 7 fail-safe behavior

Suggested commit:

- `fix(cortex): wire isAutoApprove to bash safety Layer 7 for YOLO mode hardening`

## Notes

- Current `typecheck` and `test:run` pass. These issues are contract/integration issues, not basic unit-test failures.
- The architecture is directionally good. The immediate goal is to tighten the package boundary and remove hidden shared state before the first real commit.
