# Pi 0.85.1 compatibility review

Reviewed on 2026-09-06 against npm's `latest` tags and the published packages.
Upgraded Cortex's `pi-agent-core` and `pi-ai`, plus Cortex Code's `pi-ai` and
`pi-tui`, from `^0.84.1` to `^0.85.1`. The lockfile resolves all four to `0.85.1`,
released on 2026-09-05. No production TypeScript changes are required.

## Breaking changes and local impact

| Upstream change | Cortex impact |
| --- | --- |
| Agent 0.84.4: `prepareNextTurn` and `prepareNextTurnWithContext` now run only when another assistant turn will start, after stop and queued-message checks. | Neither hook is used. Cortex's completion handling already uses `agent_end`. Real-agent tests cover plain completion, tool continuation, and tool termination. |
| Agent: withdrawn manual-drive harness APIs removed; published `./session/testing` export moved to `./harness/session/testing`. | Cortex uses `Agent`, not `AgentHarness` or Pi session storage/testing APIs. No migration. |
| AI 0.84.3: `GoogleThinkingLevel` renamed to `GoogleApiThinkingLevel`. | Cortex does not import the renamed type. Its provider-neutral thinking-level boundary remains compatible. |
| AI 0.85.0: Cloudflare `createGatewayBindingFetch()` replaced by `createAiBindingFetch()`, with explicit model gateway URL configuration. | Cortex does not use the helper, which was introduced after our previous version. No migration. |
| TUI 0.85.0: removed coding-agent environment defaults and changed debug logging. | Cortex Code's default hidden hardware cursor and disabled clear-on-shrink still match upstream defaults. `PI_HARDWARE_CURSOR` and `PI_CLEAR_ON_SHRINK` no longer affect it. `PI_DEBUG_REDRAW` became `PI_TUI_DEBUG_REDRAW`; redraw logging requires an explicit log directory, and default crash dumps go to the OS temp directory. |

The existing `/compat`, `/providers/all`, and root imports remain available.
Moving completion calls from `/compat` to `createModels()` remains a separate
migration, not a prerequisite for this update.

## Behavior changes inherited from pi-ai

- Provider catalogs gain GPT-6 Astra and other model updates. Built-in xAI
  models now use the Responses API; Grok Build 0.1 has been removed. Consumers
  that pin removed catalog IDs must choose a supported ID or configure a
  custom model.
- Supported Anthropic transports preserve per-turn effort, recover signed
  thinking mismatches, and support server-side refusal fallback. Usage pricing
  follows the returned fallback model.
- OpenAI tool namespaces and reasoning metadata survive streaming and replay.
  Strict tool schemas convert optional fields to required nullable fields on
  the wire and normalize omitted optional arguments back for execution.
- Long-cache requests for GPT-5.6+ Responses models now use
  `prompt_cache_options.ttl: "30m"`. Cortex continues forwarding its existing
  cache-retention setting to the adapter.

Node requirements remain compatible with Cortex's Node 24 minimum. Transitive
updates include the Anthropic and OpenAI SDKs, removal of the Mistral SDK, and
the agent package's new Chord dependency with its own esbuild platform packages.
Those platform entries account for most of the lockfile growth.

## Validation

- Workspace typechecking and production builds.
- Full Vitest workspace suite: 3,646 passed, 12 skipped.
- Cortex Code tests against the built Cortex package (`CORTEX_TEST_TARGET=dist`):
  575 passed.
- Built CLI `--help` smoke check.
- `pi-upstream-contract.test.ts` uses the installed Agent, provider catalog,
  and event stream with synthetic model responses. It checks one completion
  per prompt, tool continuation and termination, and preservation of thinking
  effort, end-turn diagnostics, and tool namespaces through JSON restore and
  the next request's context transformation.

The separate Cortex test-source typecheck reports 451 diagnostics outside the
new contract test, which has no type errors. This test-only check is not the
workspace typecheck gate (see `tools/typecheck-tests.mjs`).

Live provider requests, OAuth login, and remote Windows/SteamOS execution were
not exercised. The local checks ran on macOS with Node 25.2.1.

## Sources

- [Agent changelog](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/CHANGELOG.md)
- [AI changelog](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/CHANGELOG.md)
- [TUI changelog](https://github.com/earendil-works/pi/blob/v0.85.1/packages/tui/CHANGELOG.md)
- [Agent package exports and dependencies](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/package.json)
- [Release 0.85.1](https://github.com/earendil-works/pi/releases/tag/v0.85.1)
