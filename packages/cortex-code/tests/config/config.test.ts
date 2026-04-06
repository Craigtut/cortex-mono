import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

const mockReadFile = vi.mocked(fs.readFile);

describe('loadConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty config when no files exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const config = await loadConfig('/test/project');
    expect(config).toEqual({});
  });

  it('loads global config', async () => {
    mockReadFile.mockImplementation(async (path) => {
      if (String(path).includes('.cortex/config.json')) {
        return JSON.stringify({ defaultModel: 'claude-sonnet-4-6' });
      }
      throw new Error('ENOENT');
    });

    const config = await loadConfig('/test/project');
    expect(config.defaultModel).toBe('claude-sonnet-4-6');
  });

  it('project config overrides global config', async () => {
    mockReadFile.mockImplementation(async (path) => {
      const p = String(path);
      if (p.includes('/test/project/.cortex/config.json')) {
        return JSON.stringify({ defaultModel: 'gpt-4' });
      }
      if (p.includes('.cortex/config.json')) {
        return JSON.stringify({ defaultModel: 'claude-sonnet-4-6', maxCost: 10 });
      }
      throw new Error('ENOENT');
    });

    const config = await loadConfig('/test/project');
    expect(config.defaultModel).toBe('gpt-4');
    expect(config.maxCost).toBe(10);
  });
});
