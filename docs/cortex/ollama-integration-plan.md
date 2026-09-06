# Ollama integration plan

Status: implemented with native transport opt-in. Reviewed 2026-09-06.

See [the consumer guide](ollama.md) for configuration and the sequential
benchmark. Native remains opt-in until the target-hardware comparison passes.
The sections below record the design; the consumer guide describes current
behavior.

Build a dedicated Ollama provider in Cortex, with native `/api/chat` inference
as the target transport. Keep pi-agent-core and pi-ai's message/event contract.
Fix model metadata and runtime context accounting before switching transport.

The target workload is one large local model competing for limited VRAM.
This plan does not add models, change background-work behavior, or increase
inference concurrency. Native HTTP is not inherently faster than OpenAI
compatibility. The benefits are explicit runtime controls, faithful protocol
mapping, and enough telemetry to verify performance.

## What pi-ai provides

The installed `@earendil-works/pi-ai` is 0.85.1. Its README documents Ollama as
a custom provider using `openai-completions` and `/v1`. There is no built-in
native Ollama adapter in the installed package or the upstream tree inspected
at `9767ba275f3e9a5ee0f5c5342249b629ab1b2282`.

Pi-ai supports registering custom API implementations. A synthetic probe
confirmed both `streamSimple()` and `complete()` dispatch to a registered API
without a fork. Its newer `createProvider()` surface also composes providers
from an API implementation. Cortex currently uses `/compat`; isolate that
registration bridge so the planned `createModels()` migration can replace it.

Sources: [pi-ai provider documentation](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/README.md),
[installed compatibility implementation](../../node_modules/@earendil-works/pi-ai/dist/compat.js).

## Baseline behavior and confirmed gaps

Before implementation, the path was Cortex Code model resolution, `createCustomModel()`,
`AgentLoop`, pi-agent-core, pi-ai's OpenAI completions adapter, and Ollama.

| Area | Baseline behavior | Required change |
| --- | --- | --- |
| Provider identity | Ollama is wrapped as `custom`. | Preserve `ollama` identity and connection-specific configuration. |
| Model metadata | Clones GPT-4.1, inheriting `reasoning: false`, image support, output limits, and pricing. | Construct an explicit descriptor using discovered capabilities and local configuration. Local inference has zero API price. |
| Runtime context | Reads trained context length from `/api/show`. | Distinguish trained maximum, running allocation, and the consumer's context budget. |
| Small context | Effective budget has a 16,384-token floor, even above an actual smaller model limit. | Never raise a known hard limit. Report when mandatory instructions cannot fit. |
| Cache policy | Unknown/custom provider means `isCacheCold()` always returns true. | Model automatic prefix reuse independently of paid cache-retention controls. |
| Thinking | Inherited non-reasoning metadata suppresses effort fields. | Discover support, map supported settings, and preserve thinking on tool continuations. |
| Resolution | Similar Ollama construction exists in startup, setup, model switching, utility selection, and completion mode. | Route every entry point through the same provider resolution owner. |

Relevant code: [custom model creation](../../packages/cortex/src/provider-manager.ts),
[Ollama discovery](../../packages/cortex-code/src/providers/ollama.ts),
[context and dispatch](../../packages/cortex/src/agent-loop.ts),
[cache gating](../../packages/cortex/src/compaction/index.ts),
[tool-result trimming](../../packages/cortex/src/compaction/microcompaction.ts).

Request-capture probes with pi-ai 0.85.1 established:

- Current custom-model settings produce identical requests for thinking `off`
  and `high`, with no effort field.
- Explicit reasoning metadata and an `off: 'none'` map restore `none`/`high`
  serialization over the existing OpenAI route.
- Explicitly disabling long-retention compatibility suppresses OpenAI cache
  fields even when a caller requests long retention.
- A synthetic response reporting 80 cached prompt tokens maps to `cacheRead: 80`.

These are adapter checks, not measurements of real Ollama inference.

## Ownership and data flow

Put reusable Ollama integration under `packages/cortex/src/providers/ollama/`.
Provider-specific behavior is framework infrastructure and must not depend on
Cortex Code. Keep separate responsibilities within that directory:

- Discovery and validated schemas: endpoint normalization, version, model list,
  capabilities, trained maximum, configured parameters, running allocation.
- Runtime profile: the selected endpoint/model's allocation and request options.
- Transport: native request encoding, streaming, cancellation, response decoding,
  replay, and usage metrics.

`ProviderManager` exposes resolution and returns a branded `CortexModel` with
the provider binding. It should not accumulate the HTTP implementation itself.
`AgentLoop` owns context composition and calls the provider through narrow
interfaces. The compaction module owns the general prefix-preservation policy.
Cortex Code owns setup, persisted preferences, and status presentation.

All primary, utility, direct, structured, and child calls using the same selected
endpoint/model must share the same runtime allocation profile. Request-specific
output limits and thinking settings remain separate from allocation settings.
The profile contains no conversation or cache contents. Avoid an unrelated
global scheduler or a general provider-framework rewrite.

## Runtime context contract

Maintain three separate values:

1. Trained maximum: model metadata, suitable for display and upper-bound checks.
2. Runtime allocation: the context Ollama actually provides to this model.
3. Consumer budget: a limit on Cortex's context usage, no greater than allocation.

`/api/ps` reports the loaded model's context length. `/api/show` supplies model
details and configured parameters; neither trained metadata nor a configured
parameter alone proves what is currently allocated.
[Running models](https://docs.ollama.com/api/ps),
[model details](https://docs.ollama.com/api-reference/show-model-details).

Resolution should work as follows:

- If the selected model is loaded, adopt its measured allocation by default.
- If it is unloaded, prepare only that selected model with server defaults,
  then inspect its allocation. Do not load models just to populate a picker.
- An explicit Ollama allocation preference can request a different `num_ctx`.
  Configure it once, verify the resulting allocation, then reuse it.
- If a server cannot report allocation, distinguish an explicitly configured
  limit from an unknown value. Do not silently claim the trained maximum is
  available. Give an actionable configuration error when safe sizing is unknown.
- Refresh after model selection, a detected reload/restart, or an overflow.
  A cached allocation is evidence, not a reservation against other clients.

For tight VRAM, do not automatically allocate the trained maximum or grow
`num_ctx` with conversation length. Do not reduce `num_ctx` for short utility
requests. Ollama compares runner options when deciding whether to reload;
changing allocation can invalidate an otherwise reusable runner.
[Scheduler implementation](https://github.com/ollama/ollama/blob/83ed7d9965b1ee07e0f0b29fd46e47c31f0fcab8/server/sched.go).

The native request can carry `options.num_ctx` and `options.num_predict`.
The former follows the runtime profile; the latter is a per-request output cap.
Use the actual runtime limit for pi-ai output clamping, Cortex compaction,
failsafe logic, and utility-model accounting. Reserve room for generation and
template overhead. A client token estimate is not exact server tokenization.

Fix the 16K floor across every relevant path, including sub-agent budget
calculation. If mandatory context exceeds the hard limit, fail clearly rather
than inventing capacity or enlarging the server allocation.

For supported server versions, use native `truncate: false` so overflow is
visible to Cortex. Evaluate `shift: false` separately and keep it stable across
calls; generation-time context shifting is distinct from input truncation.
These controls need version/backend contract tests. Unknown fields accepted
without error are not proof of support. On overflow, use bounded compaction
recovery or return a clear error, not an unchanged retry loop.
[Native request fields](https://github.com/ollama/ollama/blob/83ed7d9965b1ee07e0f0b29fd46e47c31f0fcab8/api/types.go).

## Thinking and model capabilities

Use `/api/show` capabilities to detect thinking, tools, and vision. Capability
presence alone does not identify every valid effort setting. Maintain a small,
tested mapping for recognized families, allow explicit model overrides, and
show only settings that can actually be enforced.

Binary thinking models need true/false mapping. GPT-OSS uses low/medium/high
and cannot fully disable thinking. Do not advertise `off` for GPT-OSS, or
pretend low/high differ on a model exposing only a binary switch. For unknown
thinking families, preserve the server default until a mapping is established.
Keep the user's intent distinct from the effective setting and report clamping.
[Ollama thinking semantics](https://docs.ollama.com/capabilities/thinking).

Preserve assistant thinking, text, tool calls, and tool results across a tool
continuation. Do not turn thinking into user-facing text. Test session restore
and migration from old `custom` model identities as well as fresh conversations.

## Prefix caching and compaction

Automatic prefix caching needs no Anthropic breakpoint markers. Ollama matches
prompt tokens against available cached state; the reusable length can depend
on backend and model architecture. Keeping weights loaded is helpful but does
not guarantee that a particular conversation's prefix remains available.
[Prefix cache implementation](https://github.com/ollama/ollama/blob/83ed7d9965b1ee07e0f0b29fd46e47c31f0fcab8/x/mlxrunner/prefix_cache.go).

Replace the inference that "no explicit retention support means a cold cache"
with a model-level cache capability, independent of the billing/TTL registry.
Distinguish explicit-breakpoint caching, automatic-prefix caching, and no known
reuse. Keep actual cache state unknown unless supported by evidence.

For automatic-prefix models, preserve stable history when there is enough
context headroom. The existing 25% trim floor should not by itself authorize
repeated rewrites of an active prefix. Necessary pressure-based compaction,
oversized-result insertion caps, and hard-limit recovery must still operate.
Do not solve this by setting an infinite fake cache TTL and disabling trimming.

When a rewrite is necessary, favor a coherent compaction boundary over repeated
small changes to old tool results. Keep tool definitions and their order stable.
Do not change ephemeral-context semantics in this first implementation, but
measure where the serialized prefix first diverges across turns and tool calls.
Report divergence locations and lengths without logging prompt contents.

## Native transport requirements

The target API identity should be dedicated to Ollama and registered once.
Use pi-ai's event stream and message types, so the agent loop, tool execution,
permissions, and budgets remain unchanged. Keep registration separate from the
encoder/decoder so the newer pi-ai provider collection can reuse it later.

Required behavior before switching the default:

- Parse NDJSON across arbitrary network and UTF-8 chunk boundaries, with
  bounded buffering, abort propagation, HTTP errors, in-stream errors, and
  premature EOF handling.
- Map thinking/text deltas, complete tool arguments, finish reasons, and usage.
  Preserve tool-call IDs where supplied; otherwise generate IDs once and retain
  them across replay. Never dispatch an incomplete tool call.
- Round-trip multiple calls to the same tool, tool errors, images where
  supported, and interrupted/restored conversations.
- Keep model-default sampling unless the consumer explicitly overrides it.
  Do not accidentally copy OpenAI adapter defaults into native options.
- Apply the same allocation and residency policy to every completion path.
  Keep-alive configuration is separate from prefix-cache policy. Do not
  unconditionally unload a shared Ollama model when a Cortex session closes.

Ollama documents native streaming tool calls and carrying assistant messages
into the next request. Use those semantics directly, rather than adopting an
unverified third-party adapter as a dependency.
[Tool calling](https://docs.ollama.com/capabilities/tool-calling).

### Structured output is a migration gate

Cortex currently implements `structuredComplete()` by forcing a virtual tool.
Native `/api/chat` exposes JSON-schema `format`, but does not expose the same
forced-tool-choice contract. A transport that simply ignores that request
would silently weaken Cortex's API.

Add a narrow provider capability for schema-constrained completion and route
`structuredComplete()` through it when supported. Keep schema validation,
usage, cancellation, and error behavior owned by the existing completion path.
Use native `format` for Ollama. Preserve the forced-tool implementation for
other providers. Unsupported forced-tool requests outside this contract must
fail explicitly rather than be silently treated as automatic tool selection.
[Native chat schema output](https://docs.ollama.com/api/chat).

## Diagnostics and validation

Show actual allocation alongside trained maximum and the client budget. Record
time to first streamed output, time to first answer text, load time, prompt
evaluation time, generated tokens, generation time, and cache-read tokens when
available. Distinguish an absent cached-token metric from a reported zero.
Native timings and cached counts vary by server version; preserve that fact in
diagnostics instead of fabricating a hit rate.

Unit and adapter contract coverage must include runtime allocations below 16K,
unloaded discovery, unavailable endpoints, stale allocation, model switching,
every model-resolution entry point, reasoning maps, schema output, stream
fragmentation, and cache-aware trimming under both headroom and pressure.

Run a sequential integration benchmark against one resident large model:

1. Compare OpenAI and native transports with equivalent rendered input,
   effective sampling, thinking, output caps, and allocation. Normalize defaults
   before attributing a timing difference to transport.
2. Measure a warm runner with a new prefix, repeated prefix, appended user turn,
   and several tool continuations. Separately record true model-load latency
   when a load happens naturally; do not unload just to run routine validation.
3. Exercise history beyond the existing trim floor and a necessary compaction.
   Verify preserved history under headroom and successful bounded recovery.
4. Interleave the existing utility calls. Verify they use the same allocation
   and do not cause a context-option-driven reload.
5. Compare only a few user-selected context allocations sequentially, recording
   VRAM/offload and latency. Do not search by repeatedly provoking OOMs.

No second model or additional parallel slot is needed. Server settings such as
`OLLAMA_NUM_PARALLEL`, Flash Attention, and KV quantization remain operator
choices. Match the existing single-model setup; do not automatically change
global settings. Quantized KV is a separate memory/quality experiment.
[Ollama server settings](https://docs.ollama.com/faq).

## Delivery sequence

1. Add the dedicated provider descriptor and shared discovery/resolution path.
   Correct capabilities, local pricing, thinking maps, and runtime context
   accounting while retaining the current transport. Cover the 16K floor bug.
2. Add general automatic-prefix cache policy and pressure-aware trimming tests.
   Establish a sequential baseline on the target server.
3. Implement the native adapter and schema-completion capability. Verify all
   primary, utility, structured, child, and restore paths through the same
   runtime profile. Version-gate newer native behavior.
4. Compare equivalent requests on real hardware. Make native the Ollama default
   only after functional parity and no material performance regression. Keep
   an explicit OpenAI-compatible fallback for older servers or proxies, with
   its control limitations visible. Never switch protocols silently on failure.

Production integration and automated contract tests are implemented. No global
Ollama server settings were changed. The target-hardware comparison remains
pending; synthetic protocol tests do not establish real throughput or VRAM use.
