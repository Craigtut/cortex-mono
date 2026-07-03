import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverProjectContext } from '../../src/discovery/context.js';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

const mockReaddir = vi.mocked(fs.readdir);
const mockReadFile = vi.mocked(fs.readFile);
const mockLstat = vi.mocked(fs.lstat);

/** Build a minimal fs.Stats-like object for lstat mocks. */
function statLike(opts: { symlink?: boolean; file?: boolean; size?: number }): fs.Stats {
  return {
    isSymbolicLink: () => opts.symlink ?? false,
    isFile: () => opts.file ?? true,
    size: opts.size ?? 100,
  } as unknown as fs.Stats;
}

describe('discoverProjectContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no files found
    mockReaddir.mockRejectedValue(new Error('ENOENT'));
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    // Default: a small regular file, so the happy paths read normally.
    mockLstat.mockResolvedValue(statLike({ file: true, size: 100 }));
  });

  it('returns empty string when no context files found', async () => {
    const result = await discoverProjectContext('/test/project/sub');
    expect(result).toBe('');
  });

  it('finds agents.md case-insensitively', async () => {
    mockReaddir.mockImplementation(async (path) => {
      if (String(path) === '/test/project') {
        return ['AGENTS.md', 'src', 'package.json'] as unknown as ReturnType<typeof fs.readdir>;
      }
      throw new Error('ENOENT');
    });
    mockReadFile.mockImplementation(async (path) => {
      if (String(path) === '/test/project/AGENTS.md') {
        return '# Project Rules\nUse TypeScript.';
      }
      throw new Error('ENOENT');
    });

    const result = await discoverProjectContext('/test/project');
    expect(result).toContain('# Project Rules');
    expect(result).toContain('<project-context>');
    expect(result).toContain('/test/project/AGENTS.md');
  });

  it('prefers agents.md over claude.md', async () => {
    mockReaddir.mockImplementation(async (path) => {
      if (String(path) === '/test/project') {
        return ['agents.md', 'CLAUDE.md'] as unknown as ReturnType<typeof fs.readdir>;
      }
      throw new Error('ENOENT');
    });
    mockReadFile.mockImplementation(async (path) => {
      if (String(path) === '/test/project/agents.md') return 'agents content';
      if (String(path) === '/test/project/CLAUDE.md') return 'claude content';
      throw new Error('ENOENT');
    });

    const result = await discoverProjectContext('/test/project');
    expect(result).toContain('agents content');
    expect(result).not.toContain('claude content');
  });

  it('falls back to claude.md when no agents.md', async () => {
    mockReaddir.mockImplementation(async (path) => {
      if (String(path) === '/test/project') {
        return ['Claude.md', 'src'] as unknown as ReturnType<typeof fs.readdir>;
      }
      throw new Error('ENOENT');
    });
    mockReadFile.mockImplementation(async (path) => {
      if (String(path) === '/test/project/Claude.md') return 'claude content';
      throw new Error('ENOENT');
    });

    const result = await discoverProjectContext('/test/project');
    expect(result).toContain('claude content');
  });

  it('concatenates root-first, closest-last', async () => {
    mockReaddir.mockImplementation(async (path) => {
      const p = String(path);
      if (p === '/test') return ['agents.md'] as unknown as ReturnType<typeof fs.readdir>;
      if (p === '/test/project') return ['agents.md'] as unknown as ReturnType<typeof fs.readdir>;
      throw new Error('ENOENT');
    });
    mockReadFile.mockImplementation(async (path) => {
      const p = String(path);
      if (p === '/test/agents.md') return 'ROOT CONTENT';
      if (p === '/test/project/agents.md') return 'PROJECT CONTENT';
      throw new Error('ENOENT');
    });

    const result = await discoverProjectContext('/test/project');
    const rootIdx = result.indexOf('ROOT CONTENT');
    const projectIdx = result.indexOf('PROJECT CONTENT');
    expect(rootIdx).toBeLessThan(projectIdx);
  });

  it('does not follow a symlinked context file', async () => {
    mockReaddir.mockImplementation(async (path) => {
      if (String(path) === '/test/project') {
        return ['AGENTS.md'] as unknown as ReturnType<typeof fs.readdir>;
      }
      throw new Error('ENOENT');
    });
    // AGENTS.md is a symlink (e.g. -> ~/.ssh/id_rsa).
    mockLstat.mockResolvedValue(statLike({ symlink: true, file: false, size: 100 }));
    mockReadFile.mockResolvedValue('SECRET KEY MATERIAL');

    const result = await discoverProjectContext('/test/project');
    expect(result).toBe('');
    // The symlink target must never be read.
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('skips a context file that exceeds the size cap', async () => {
    mockReaddir.mockImplementation(async (path) => {
      if (String(path) === '/test/project') {
        return ['AGENTS.md'] as unknown as ReturnType<typeof fs.readdir>;
      }
      throw new Error('ENOENT');
    });
    // Oversized regular file (1 MB, above the 256 KB cap).
    mockLstat.mockResolvedValue(statLike({ file: true, size: 1024 * 1024 }));
    mockReadFile.mockResolvedValue('huge content');

    const result = await discoverProjectContext('/test/project');
    expect(result).toBe('');
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});
