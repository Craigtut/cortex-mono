import { describe, expect, it } from 'vitest';
import { ProviderSetupFlow } from '../../src/providers/setup.js';

function newFlow(): ProviderSetupFlow {
  return new ProviderSetupFlow(
    false,
    ['anthropic'],
    [{ id: 'openai', envVar: 'OPENAI_API_KEY' }],
    [],
  );
}

describe('ProviderSetupFlow custom tier', () => {
  it('assigns the custom provider and reaches model selection', () => {
    const flow = newFlow();
    expect(flow.getCurrentStep().type).toBe('tier-selection');

    expect(flow.advance('custom').type).toBe('custom-entry');
    expect(flow.advance('').type).toBe('custom-validation');

    const modelStep = flow.advance('valid');
    expect(modelStep.type).toBe('model-selection');
    // The custom tier skips provider-selection, so the provider must be pinned.
    expect(modelStep.provider).toBe('custom');
  });

  it('threads base URL and API key into the completed result', () => {
    const flow = newFlow();
    flow.advance('custom');
    flow.advance('');
    flow.advance('valid'); // -> model-selection

    flow.setCustomConnection('http://localhost:1234/v1', 'sk-test');
    expect(flow.advance('my-model').type).toBe('complete');

    expect(flow.getResult()).toEqual({
      provider: 'custom',
      method: 'custom',
      model: 'my-model',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'sk-test',
    });
  });

  it('omits the API key when the endpoint is keyless', () => {
    const flow = newFlow();
    flow.advance('custom');
    flow.advance('');
    flow.advance('valid');

    flow.setCustomConnection('http://localhost:1234/v1');
    flow.advance('local-model');

    const result = flow.getResult();
    expect(result?.baseUrl).toBe('http://localhost:1234/v1');
    expect(result?.apiKey).toBeUndefined();
  });
});

describe('ProviderSetupFlow api_key tier (regression)', () => {
  it('produces an api_key result without custom connection fields', () => {
    const flow = newFlow();
    flow.advance('api_key');
    flow.advance('openai'); // provider-selection -> api-key-entry
    flow.advance('sk-live'); // api-key-entry -> api-key-validation
    flow.advance('valid'); // -> model-selection
    flow.advance('gpt-4.1'); // -> complete

    expect(flow.getResult()).toEqual({
      provider: 'openai',
      method: 'api_key',
      model: 'gpt-4.1',
    });
  });
});
