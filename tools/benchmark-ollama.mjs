#!/usr/bin/env node
// Build Cortex first. This probes one selected model sequentially and never unloads it.
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ProviderManager, unwrapModel } from '../packages/cortex/dist/index.js';
import { complete } from '@earendil-works/pi-ai/compat';

const { values } = parseArgs({ options: {
  model: { type: 'string' }, host: { type: 'string' },
  transport: { type: 'string', default: 'native' },
  repeats: { type: 'string', default: '3' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Usage: node tools/benchmark-ollama.mjs --model <installed-model> [--host <url>] [--transport native|openai] [--repeats 3]');
  console.log('Runs new-prefix, repeat-prefix, and appended-turn requests sequentially. Uses the existing allocation; never unloads models.');
  process.exit(0);
}
if (!values.model || !['native', 'openai'].includes(values.transport)) throw new Error('Provide --model and a native|openai transport');
const repeats = Number(values.repeats);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('--repeats must be between 1 and 20');
let metrics;
const model = await new ProviderManager().createOllamaModel({
  modelId: values.model, baseUrl: values.host, transport: values.transport,
  onMetrics: value => { metrics = value; },
});
const raw = unwrapModel(model);
console.log(JSON.stringify({ model: model.modelId, transport: values.transport, contextWindow: model.contextWindow,
  trainedContextWindow: model.capabilities?.trainedContextWindow }));

const lines = Math.min(250, Math.floor(model.contextWindow / 100));
const prefix = `Synthetic benchmark ${randomUUID()}.\n` + Array.from({ length: lines }, (_, i) =>
  `Reference item ${i}: a stable example for measuring repeated prompt processing.\n`).join('');
const context = { systemPrompt: 'Answer with the word OK. Do not call tools.', messages: [
  { role: 'user', content: prefix + '\nAcknowledge this reference.', timestamp: Date.now() },
] };
async function run(phase, input) {
  metrics = undefined;
  const result = await complete(raw, input, {
    maxTokens: 32, temperature: 0,
    onPayload: payload => {
      // Match sampling across native options and the compatibility endpoint.
      if (values.transport === 'native') payload.options.top_p = 1;
      else payload.top_p = 1;
    },
  });
  if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error(result.errorMessage);
  console.log(JSON.stringify({ phase, ...metrics, stopReason: result.stopReason,
    ...(metrics?.generationMs > 0 ? { outputTokensPerSecond: metrics.outputTokens * 1000 / metrics.generationMs } : {}),
  }));
  return result;
}
const answer = await run('new-prefix', context);
for (let i = 0; i < repeats; i++) await run(`repeat-prefix-${i + 1}`, context);
await run('appended-turn', { ...context, messages: [...context.messages, answer,
  { role: 'user', content: 'Acknowledge again.', timestamp: Date.now() },
] });
