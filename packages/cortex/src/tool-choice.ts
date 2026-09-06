/**
 * Per-API-family spelling of "you must call a tool".
 *
 * There is no portable value. Anthropic and Google spell it "any"; the OpenAI
 * families spell it "required" and reject "any" outright. pi-ai 0.80 hid this
 * by discarding `toolChoice` on the OpenAI adapters entirely, so Cortex sent
 * "any" everywhere and only Anthropic ever saw it. 0.84 forwards the option,
 * which turns that latent mismatch into a rejected request on every OpenAI
 * structured completion.
 *
 * Keyed off `model.api` rather than the provider id, because the API family is
 * what decides the wire format: an Anthropic model served through Bedrock or
 * Copilot still speaks anthropic-messages.
 */

/** API families that spell a forced tool call as "required". */
const REQUIRED_STYLE_APIS: ReadonlySet<string> = new Set([
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'azure-openai-responses',
]);

/**
 * The value to send so the model is obliged to call a tool.
 *
 * Unknown families fall back to "any", matching the pre-0.84 behaviour for
 * everything that is not demonstrably OpenAI-shaped.
 */
export function forcedToolChoiceFor(model: unknown): 'any' | 'required' {
  const api = (model as { api?: unknown } | null | undefined)?.api;
  if (typeof api === 'string' && REQUIRED_STYLE_APIS.has(api)) return 'required';
  return 'any';
}
