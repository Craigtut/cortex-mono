# Using Ollama

Cortex has a dedicated local Ollama provider. It discovers model capabilities
and the actual loaded context allocation instead of copying a cloud model's
metadata. Ollama Cloud models are outside this integration's scope.

## Cortex Code configuration

Existing Ollama credentials continue to work, including entries saved as
`method: "custom"`. The provider name remains `ollama`. Host normalization
accepts `OLLAMA_HOST`, host/port addresses, and stored URLs ending in `/v1`.

Cortex uses Ollama's `/api/chat` API. There is one Ollama integration and no
transport setting. Ollama 0.15.0 or newer is required for explicit input
truncation and context shifting controls. Older servers receive an upgrade
error before inference.

Optional settings in `.cortex/config.json`:

```json
{
  "ollama": { "keepAlive": "30m" }
}
```

Resolution adopts the selected model's loaded context unless an allocation or
cap is configured. If unloaded, Cortex prepares that model before reading its
allocation. Model pickers only discover metadata and do not load models.

An explicit `ollama.contextWindow` requests a server allocation. Choose a value
that fits your VRAM. Cortex Code also passes its top-level `contextWindowLimit` as an allocation cap. For example:

```json
{
  "contextWindowLimit": 8192,
  "ollama": { "keepAlive": "30m" }
}
```

This reduces a larger allocation to 8192 and sends the resolved `num_ctx` on
every request. A cap never increases a smaller loaded allocation. If the model
is unloaded, it loads with the cap immediately. An explicit
`ollama.contextWindow` can request a larger allocation, subject to the cap.
The limit applies when the model is resolved. Restart Cortex Code after
editing configuration.

Cortex never raises the effective context above a known runtime limit,
including allocations below 16K. Explicit positive budgets are honored
without a 16K floor.

The optional `ollama.maxOutputTokens` controls the default output cap, separately
from allocation. Calls keep `num_ctx` fixed across main, utility, and
structured requests. A smaller output cap does not shrink the allocation.
Generation reserves estimated room for prompt formatting; server overflow
remains an error rather than silently dropping input history.

A zero `keepAlive` is rejected because Ollama treats empty preparation calls
with that value as an unload command. Negative values keep the model resident
indefinitely.

Cortex pins `shift: false`. The first Cortex request can reload a runner
previously using different options. Subsequent calls reuse the same options.
Cortex does not unload models on exit or change global concurrency, Flash
Attention, GPU placement, or KV quantization settings.

`/status` shows allocation, trained maximum, and Cortex budget. Ollama
inference diagnostics include load time, prompt evaluation time, generation time,
first output/text latency, and cached-token counts when reported by the server.
These are written to the normal Cortex Code diagnostic log without prompt text.
An absent cache metric is not treated as a measured cache miss.

## Framework API

```typescript
import { CortexAgent, ProviderManager } from '@animus-labs/cortex';

const providers = new ProviderManager();
const model = await providers.createOllamaModel({
  modelId: 'qwen3:32b',
  // Omit contextWindow and contextWindowLimit to adopt the loaded allocation.
  contextWindowLimit: 8192,
  keepAlive: '30m',
  onMetrics: metrics => console.log(metrics),
});

const agent = await CortexAgent.create({
  mode: 'passthrough',
  model,
  workingDirectory: process.cwd(),
  initialBasePrompt: 'Help with this project.',
});
try {
  await agent.prompt('Describe the project.');
} finally {
  await agent.destroy();
}
```

The framework provider owns allocation. Its `contextWindow` requests an exact
size; its `contextWindowLimit` caps the chosen size. Use that provider option
when a framework consumer wants to save VRAM. `AgentLoop.contextWindowLimit`
remains a compaction budget, so separate loops sharing one model cannot
continually resize its cache when their budgets differ.

The provider accepts `baseUrl`, `apiKey`, a resolution abort signal, and an
injectable fetch implementation. Resolution errors are explicit: unknown
allocation, unsupported server version, and invalid context requests do not
silently select a different model or allocation.

Before inference, Cortex checks whether the running allocation still matches.
If another client changed it, reselect the model to resolve the new limit. If
the model expired, Cortex prepares only that model with its pinned
allocation. This check cannot reserve the shared server against simultaneous
changes by another client.

### Concurrency and facade mode

Ollama serves one request per model by default (`OLLAMA_NUM_PARALLEL=1`) and
runs two different models at once only if both fit in memory. Its API exposes
neither, so an Ollama model's `capabilities.concurrency` is `'serial'`. A
`CortexAgent` created with `mode` omitted runs passthrough, with a
`mode-resolved-passthrough` resolution note, when its talker would run on the
same Ollama server as its reasoner: the reasoner's model itself (Ollama has no
auto-resolved fast tier), a `utilityModel` on that server, or a pinned
`talker.model` on it. Two different models on one serial server count too,
because whether both fit in memory is exactly what Cortex cannot see. A talker
on another backend (a second Ollama host, or a hosted provider) runs duplex,
since nothing queues. If your server does run requests in parallel, declare
it on both models and the omitted mode resolves to duplex:

```typescript
const model = await providers.createOllamaModel({
  modelId: 'qwen3:32b',
  parallelRequests: true, // OLLAMA_NUM_PARALLEL > 1, talker and reasoner fit together
});
```

An explicit `mode: 'duplex'` runs duplex either way and records a
`duplex-not-concurrent` note when the talker and reasoner share a `'serial'`
server. See
[cortex-agent.md](cortex-agent.md#mode-resolution).

## Thinking and structured output

Capabilities come from `/api/show`. Known Qwen3 and DeepSeek thinking families
use a binary switch, exposed as `off` and `low` (enabled) in Cortex's effort
vocabulary, using `think: false` or `true`. GPT-OSS exposes `low`, `medium`, and
`high`; it cannot disable thinking. Other families preserve the server default until configured.
`ollama.thinking` can override the mapping with `binary`, `levels`, or `default`.
Select a mapping supported by the model; Cortex cannot infer arbitrary custom
template behavior from a model name alone.

Assistant thinking stays separate from text and survives tool
continuations and session restore. `structuredComplete()` uses Ollama's
JSON-schema format and validates the result against the schema. Arbitrary
forced-tool selection is unsupported and returns an error.

## Caching

Ollama automatically reuses matching prompt prefixes. No Anthropic breakpoints
are sent. Cortex advertises automatic prefix reuse on the model and preserves
history under context headroom, independently of `cacheRetention`. At 70%
utilization, pressure-based tool trimming can run; normal compaction and hard
overflow handling remain active. Model residency does not guarantee that a
specific prefix survives other requests or backend eviction.

## Sequential benchmark

After building Cortex, run against one already-installed model:

```bash
npm run build -w packages/cortex
node tools/benchmark-ollama.mjs --model qwen3:32b
```

Use `--host` for another server and `--repeats` to change the repeat count.
The script sends synthetic prompts sequentially, reports JSON metrics, and
never unloads the model. Its new prefix is a cache probe, not a guarantee that
every server cache is empty. Thinking uses the model's server default;
temperature and top-p are fixed. Repeat with representative coding tasks to
measure throughput on the target hardware.

The implementation is covered by synthetic server, pi-ai adapter, real
AgentLoop, CLI, and regression tests. Automated tests do not establish real
GPU throughput or cache reuse; those need measurement on the target server.
