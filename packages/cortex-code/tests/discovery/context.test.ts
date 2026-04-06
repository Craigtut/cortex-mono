import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverProjectContext } from '../../src/discovery/context.js';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

const mockReaddir = vi.mocked(fs.readdir);
const mockReadFile = vi.mocked(fs.readFile);

describe('discoverProjectContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no files found
    mockReaddir.mockRejectedValue(new Error('ENOENT'));
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
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
});
