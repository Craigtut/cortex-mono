import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => { throw new Error('ENOENT'); }),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import * as fs from 'node:fs';

const mockMkdir = vi.mocked(fs.mkdirSync);
const mockAppend = vi.mocked(fs.appendFileSync);

describe('logger restrictive permissions', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset the module's one-time init guard so ensureLogDir runs again.
    vi.resetModules();
  });

  it('creates the log directory owner-only and appends with a restrictive mode', async () => {
    const { log } = await import('../src/logger.js');
    log.info('hello');

    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining('logs'),
      expect.objectContaining({ recursive: true, mode: 0o700 }),
    );
    expect(mockAppend).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ mode: 0o600 }),
    );
  });
});
