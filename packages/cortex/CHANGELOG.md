# Changelog

All notable changes to `@animus-labs/cortex` are documented here.

## Unreleased

- Upgrade pi-agent-core and pi-ai from `0.84.1` to `0.85.1`. Existing Cortex integrations need no API migration; see `docs/cortex/pi-upgrade-0.85.1.md` for the upstream compatibility review.
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
