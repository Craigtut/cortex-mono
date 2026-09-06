import { Check } from 'typebox/value';
import type { TSchema } from 'typebox';
import type { CortexModel } from './model-wrapper.js';
import { unwrapModel } from './model-wrapper.js';
import { forcedToolChoiceFor } from './tool-choice.js';

/** Provider capability controls encoding; callers keep usage and cancellation ownership. */
export function structuredCompletionRequest(model: CortexModel, schema: unknown, tool: unknown) {
  return model.capabilities?.structuredOutput === 'json-schema'
    ? { context: {}, options: { jsonSchema: schema } }
    : { context: { tools: [tool] }, options: { toolChoice: forcedToolChoiceFor(unwrapModel(model)) } };
}

export function parseSchemaCompletion(result: unknown, schema: unknown): Record<string, unknown> {
  const message = result as { stopReason?: string; content?: Array<{ type: string; text?: string }> };
  if (message.stopReason === 'length') throw new Error('Structured completion reached its output limit');
  const text = message.content?.filter(b => b.type === 'text').map(b => b.text ?? '').join('') ?? '';
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Check(schema as TSchema, value)) {
    throw new Error('Structured completion does not match the requested JSON schema');
  }
  return value as Record<string, unknown>;
}
