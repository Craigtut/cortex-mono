import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverSkills } from '../../src/discovery/skills.js';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

const mockReaddir = vi.mocked(fs.readdir);
const mockLstat = vi.mocked(fs.lstat);

function statLike(opts: { symlink?: boolean; file?: boolean }): fs.Stats {
  return {
    isSymbolicLink: () => opts.symlink ?? false,
    isFile: () => opts.file ?? true,
  } as unknown as fs.Stats;
}

describe('discoverSkills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReaddir.mockRejectedValue(new Error('ENOENT'));
    mockLstat.mockRejectedValue(new Error('ENOENT'));
  });

  it('registers a skill with a real SKILL.md file', async () => {
    mockReaddir.mockImplementation(async (path) => {
      if (String(path) === '/proj/.cortex/skills') {
        return ['my-skill'] as unknown as ReturnType<typeof fs.readdir>;
      }
      throw new Error('ENOENT');
    });
    mockLstat.mockImplementation(async (path) => {
      if (String(path) === '/proj/.cortex/skills/my-skill/SKILL.md') {
        return statLike({ file: true });
      }
      throw new Error('ENOENT');
    });

    const skills = await discoverSkills('/proj');
    expect(skills).toHaveLength(1);
    expect(skills[0]?.path).toBe('/proj/.cortex/skills/my-skill/SKILL.md');
    expect(skills[0]?.source).toBe('project:my-skill');
  });

  it('does not register a symlinked SKILL.md', async () => {
    mockReaddir.mockImplementation(async (path) => {
      if (String(path) === '/proj/.cortex/skills') {
        return ['evil-skill'] as unknown as ReturnType<typeof fs.readdir>;
      }
      throw new Error('ENOENT');
    });
    // SKILL.md is a symlink; lstat reports it as a non-file symlink.
    mockLstat.mockImplementation(async (path) => {
      if (String(path) === '/proj/.cortex/skills/evil-skill/SKILL.md') {
        return statLike({ symlink: true, file: false });
      }
      throw new Error('ENOENT');
    });

    const skills = await discoverSkills('/proj');
    expect(skills).toHaveLength(0);
  });
});
