import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runComplete } from '../src/complete.js';
import { CredentialStore } from '../src/config/credentials.js';
import * as config from '../src/config/config.js';
import { ollamaServer } from '../../cortex/tests/helpers/ollama.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('standalone native Ollama completion', () => {
  it('uses native schema output with the same runtime preferences as sessions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cortex-ollama-schema-'));
    try {
      const path = join(dir, 'schema.json');
      await writeFile(path, JSON.stringify({ type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] }));
      const server = ollamaServer();
      server.replies.push([{ message: { content: '{"answer":42}' }, done: true }]);
      vi.stubGlobal('fetch', server.fetch);
      vi.spyOn(config, 'loadConfig').mockResolvedValue({ contextWindowLimit: 8192, ollama: { transport: 'native', keepAlive: '30m' } });
      vi.spyOn(CredentialStore.prototype, 'getDefaults').mockResolvedValue({ provider: 'ollama', model: 'test' });
      vi.spyOn(CredentialStore.prototype, 'getProvider').mockResolvedValue(null);
      vi.spyOn(CredentialStore.prototype, 'getDefaultUtilityModel').mockResolvedValue(null);
      const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      await runComplete(['--schema', path, 'Answer'], { version: 'test' });
      expect(write).toHaveBeenCalledWith('{"answer":42}\n');
      expect(server.requests.at(-1)?.body).toMatchObject({ format: { type: 'object' }, keep_alive: '30m', options: { num_ctx: 8192 } });
      expect(server.requests.at(-1)?.body).not.toHaveProperty('tools');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
