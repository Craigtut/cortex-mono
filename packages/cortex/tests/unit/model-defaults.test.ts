import { describe, expect, it } from 'vitest';
import {
  PRIMARY_MODEL_DEFAULTS,
  resolveDefaultModelId,
  selectDefaultModelId,
} from '../../src/model-defaults.js';

describe('selectDefaultModelId', () => {
  it('picks the newest version of the provider\'s family, skipping variants and snapshots', () => {
    const ids = [
      'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5',
      'claude-opus-4-1-20250805', 'claude-opus-5-5-fast', 'claude-opus-latest',
    ];
    expect(selectDefaultModelId('anthropic', ids)).toBe('claude-opus-5-5');
  });

  it('moves to a new release with no code change', () => {
    expect(selectDefaultModelId('anthropic', ['claude-opus-5-5', 'claude-opus-6'])).toBe('claude-opus-6');
    expect(selectDefaultModelId('xai', ['grok-4.7', 'grok-4.10'])).toBe('grok-4.10');
  });

  it('reads the version separators aggregators use', () => {
    expect(selectDefaultModelId('openrouter', [
      'anthropic/claude-opus-5', 'anthropic/claude-opus-5.5', 'anthropic/claude-opus-5.5:batch',
    ])).toBe('anthropic/claude-opus-5.5');
    expect(selectDefaultModelId('fireworks', [
      'accounts/fireworks/models/kimi-k2p6', 'accounts/fireworks/models/kimi-k2p7-code',
      'accounts/fireworks/models/kimi-k3',
    ])).toBe('accounts/fireworks/models/kimi-k3');
  });

  it('falls back through the family order, then to the first model', () => {
    // Groq's own family (gpt-oss) is gone: the fallback order applies.
    expect(selectDefaultModelId('groq', ['llama-3.3-70b', 'moonshotai/kimi-k3'])).toBe('moonshotai/kimi-k3');
    expect(selectDefaultModelId('some-aggregator', ['vendor/model-a', 'vendor/model-b'])).toBe('vendor/model-a');
    expect(selectDefaultModelId('anthropic', [])).toBeUndefined();
  });

  it('defaults Bedrock to the global inference profile', () => {
    expect(selectDefaultModelId('amazon-bedrock', [
      'anthropic.claude-opus-5-5', 'us.anthropic.claude-opus-5-5', 'global.anthropic.claude-opus-5-5',
    ])).toBe('global.anthropic.claude-opus-5-5');
  });
});

describe('against the installed pi-ai catalog', () => {
  it('defaults Anthropic to its newest Opus', () => {
    expect(PRIMARY_MODEL_DEFAULTS['anthropic']).toMatch(/^claude-opus-/);
  });

  it('has no default for a provider without a catalog', () => {
    expect(resolveDefaultModelId('ollama')).toBeUndefined();
    expect(PRIMARY_MODEL_DEFAULTS).not.toHaveProperty('ollama');
  });
});
