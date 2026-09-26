/**
 * Backend concurrency (decisions.md D21): every provider pi-ai catalogs is
 * hosted and parallel, local runtime ids are not, and a base URL on this
 * machine or a private network is `unknown` whatever the provider id.
 */
import { describe, it, expect } from 'vitest';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import {
  backendConcurrency,
  isLocalEndpoint,
  LOCAL_RUNTIME_PROVIDER_IDS,
  modelBackend,
} from '../../src/model-backend.js';
import { wrapModel } from '../../src/model-wrapper.js';
import { PROVIDER_REGISTRY } from '../../src/provider-registry.js';

describe('backendConcurrency', () => {
  // Enumerated at test time, so a pi-ai bump that adds a provider is
  // classified by the rule rather than silently losing duplex.
  const catalog = builtinProviders();

  it('reads a non-trivial catalog, including the providers a hand-picked list missed', () => {
    const ids = catalog.map((provider) => provider.id);
    expect(ids.length).toBeGreaterThan(30);
    expect(ids).toEqual(expect.arrayContaining([
      'anthropic', 'ant-ling', 'radius', 'zai-coding-cn', 'qwen-token-plan-individual',
    ]));
  });

  it.each(catalog.map((provider) => [provider.id, provider.baseUrl] as const))(
    'classifies catalog provider %s as parallel at its own base URL',
    (id, baseUrl) => {
      // A catalog provider that ships a local base URL is a local runtime:
      // add it to LOCAL_RUNTIME_PROVIDER_IDS rather than loosening this.
      expect(LOCAL_RUNTIME_PROVIDER_IDS.has(id)).toBe(false);
      expect(backendConcurrency(modelBackend(id, baseUrl))).toBe('parallel');
    },
  );

  it('classifies every model pi-ai catalogs as parallel through wrapModel', async () => {
    const { getBuiltinModels, getBuiltinProviders } = await import('@earendil-works/pi-ai/providers/all');
    for (const provider of getBuiltinProviders()) {
      for (const model of getBuiltinModels(provider)) {
        expect(wrapModel(model, provider, model.id).capabilities?.concurrency, `${provider}/${model.id}`)
          .toBe('parallel');
      }
    }
  });

  it('classifies every provider Cortex registers as parallel', () => {
    for (const provider of PROVIDER_REGISTRY) {
      expect(backendConcurrency(modelBackend(provider.id, undefined)), provider.id).toBe('parallel');
    }
  });

  it('never judges a local runtime id hosted', () => {
    for (const id of LOCAL_RUNTIME_PROVIDER_IDS) {
      expect(backendConcurrency(modelBackend(id, 'https://gpu.example.com/v1'))).toBe('unknown');
    }
  });

  it('is unknown for a provider id pi-ai does not know', () => {
    expect(backendConcurrency(modelBackend('self-hosted-vllm', 'https://vllm.example.com'))).toBe('unknown');
  });

  it('is unknown for a catalog id aimed at a local server', () => {
    expect(backendConcurrency(modelBackend('anthropic', 'https://api.anthropic.com'))).toBe('parallel');
    expect(backendConcurrency(modelBackend('anthropic', 'http://localhost:4000'))).toBe('unknown');
    expect(backendConcurrency(modelBackend('openai', 'http://192.168.1.20:8000/v1'))).toBe('unknown');
    expect(backendConcurrency(modelBackend('openrouter', 'http://proxy.local:8080'))).toBe('unknown');
  });
});

describe('isLocalEndpoint', () => {
  it.each([
    'http://localhost:11434',
    'http://LOCALHOST/v1',
    'http://127.0.0.1:8000',
    'http://127.8.9.1',
    'http://0.0.0.0:8080',
    'http://10.0.0.5',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://192.168.1.1',
    'http://169.254.10.10',
    'http://100.101.102.103',
    'http://[::1]:11434',
    'http://[fd12:3456::1]',
    'http://[fe80::1]',
    'http://[::ffff:127.0.0.1]:8000',
    'http://studio.local:1234',
    'http://api.localhost',
    'http://llm.internal',
    'http://box.lan',
    'http://gpu.home.arpa',
    'http://gpu-box:8000',
  ])('treats %s as local', (endpoint) => {
    expect(isLocalEndpoint(modelBackend('x', endpoint).endpoint)).toBe(true);
  });

  it.each([
    'https://api.anthropic.com',
    'https://api.openai.com/v1',
    'http://172.32.0.1',
    'http://172.15.0.1',
    'http://8.8.8.8',
    'http://100.128.0.1',
    'http://[2001:db8::1]',
    'https://{location}-aiplatform.googleapis.com',
    '',
  ])('treats %s as not local', (endpoint) => {
    expect(isLocalEndpoint(modelBackend('x', endpoint).endpoint)).toBe(false);
  });
});
