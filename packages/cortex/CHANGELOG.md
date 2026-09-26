# Changelog

All notable changes to `@animus-labs/cortex` are documented here.

## Unreleased

- Breaking: an omitted `CortexAgent` `mode` now resolves from backend concurrency. It is duplex when both the talker's and the reasoner's models are served concurrently (every hosted provider) and passthrough otherwise, with a `mode-resolved-passthrough` resolution note saying why. Native Ollama and custom endpoints now default to passthrough. An explicit `mode` always wins; `mode: 'duplex'` on a backend not known to be concurrent adds a `duplex-not-concurrent` note, which `setModel()` also re-evaluates.
- Add `capabilities.concurrency` (`'parallel' | 'serial' | 'unknown'`, type `ModelConcurrency`) to every `CortexModel`: `parallel` for hosted providers in Cortex's registry, `serial` for `createOllamaModel()`, `unknown` for custom endpoints and unrecognized providers.
- Add `parallelRequests` to the Ollama model config, for servers that run requests in parallel (`OLLAMA_NUM_PARALLEL` above 1, with the talker and reasoner models fitting in memory together).

## 0.6.0

- Add native local Ollama support through `ProviderManager.createOllamaModel()`, including runtime context allocation, thinking, structured output, and inference metrics. Requires Ollama `0.15.0` or newer.
- Honor small context budgets without the former 16K floor, share budget calculations across compaction strategies, and preserve Ollama prompt prefixes until context pressure requires trimming.
- Breaking: rename the former single-loop `CortexAgent` to `AgentLoop` and its configuration to `AgentLoopConfig`. `CortexAgent` now owns a composite agent with duplex talker/reasoner behavior by default; use `AgentLoop` for the prior primitive or `mode: 'passthrough'` for a single-loop facade.
- Breaking: remove the deprecated `systemPrompt` config, `buildSystemPrompt()`, and `rebuildSystemPrompt()` aliases. Use `initialBasePrompt` and the current prompt APIs. Facade persistence now uses composite `getState()`/`restore()` state; consult `docs/cortex/cortex-agent.md` before migrating.
- Add duplex routing, session logs, loop-origin metadata, permission coordination, and conversation/work settlement APIs.
- Build opt-in sandboxing into Cortex: `sandbox: true` provides managed setup, workspace defaults, shared network policy, in-process file protections, and automatic cleanup. Platform backends ship in this package, with an isolated runtime process per root agent on macOS/Linux. Strict enforcement is the default; `requireEnforcement: false` explicitly permits degraded operation.
- Upgrade pi-agent-core and pi-ai from the published `0.80.3` baseline to `0.85.1`; migrate OAuth to per-provider authentication and derive effort choices from model metadata.
- Fix credential scrubbing, internal-tool permission exemptions, prompt tool descriptions, and working-tag aliases and stream filtering.
- Add structured contexts (`slots`/`history`/`ephemeral`/`prompt`) to `directComplete()`, `structuredComplete()`, and `utilityComplete()`, applying the agentic loop's cache breakpoint strategy to direct calls.
- Add per-call `sessionId` override to direct completion options for cache affinity across distinct pipelines.
- Forward the agent's `cacheRetention` and `sessionId` on `utilityComplete()` calls (previously dropped).
- Fix BP3 cache breakpoint drift when conversation history contains consecutive tool results.
- Fix BP2 cache breakpoint loss when the last context slot is empty.
- Keep churning background task state outside the cached prefix by injecting it after ephemeral content and skill instructions.

## 0.5.0

- Upgrade pi packages to `0.80.3` and migrate away from relocated `pi-ai` exports.
- Add background retry with backoff and surface error cause chains.
- Fire `onLoopComplete` once per logical turn across background retries.
- Surface auth failures from direct completions through `onError`.
- Broaden auth error classification for OAuth expiry and refresh failures.
- Support aborting direct completions through `AbortSignal`.
- Wake the agent loop when a backgrounded Bash command completes.
