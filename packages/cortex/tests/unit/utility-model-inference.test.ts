import { describe, expect, it } from 'vitest';
import { inferUtilityModelId } from '../../src/utility-model-inference.js';

function model(id: string, input = 1, output = 1): Record<string, unknown> {
  return {
    id,
    name: id,
    input: ['text'],
    cost: { input, output, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
  };
}

describe('utility-model-inference', () => {
  it('prefers the newest utility-sized version over older cheaper versions', () => {
    expect(inferUtilityModelId([
      model('gpt-5.1-codex-mini', 0.25, 2),
      model('gpt-5.4-mini', 0.75, 4.5),
      model('gpt-5.5', 5, 30),
    ])).toBe('gpt-5.4-mini');
  });

  it('infers recency from release dates', () => {
    expect(inferUtilityModelId([
      model('claude-3-5-haiku-20241022', 0.8, 4),
      model('claude-haiku-4-5-20251001', 1, 5),
      model('claude-sonnet-4-6', 3, 15),
    ])).toBe('claude-haiku-4-5-20251001');
  });

  it('infers recency from short yymm suffixes', () => {
    expect(inferUtilityModelId([
      model('mistral-small-2501', 0.1, 0.3),
      model('mistral-small-2506', 0.06, 0.18),
      model('mistral-large-2512', 2, 6),
    ])).toBe('mistral-small-2506');
  });

  it('infers recency from month-year preview suffixes', () => {
    expect(inferUtilityModelId([
      model('gemini-2.5-flash-lite-preview-06-2025', 0.1, 0.4),
      model('gemini-2.5-flash-lite-preview-09-2025', 0.1, 0.4),
    ])).toBe('gemini-2.5-flash-lite-preview-09-2025');
  });

  it('filters special-purpose models', () => {
    expect(inferUtilityModelId([
      model('grok-vision-beta', 0.1, 0.1),
      model('grok-code-fast-1', 0.2, 1.5),
    ])).toBe('grok-code-fast-1');
  });

  it('falls back to cheapest capable model when no utility-sized hint exists', () => {
    expect(inferUtilityModelId([
      model('provider-model-1', 2, 8),
      model('provider-model-2', 1, 2),
    ])).toBe('provider-model-2');
  });
});
