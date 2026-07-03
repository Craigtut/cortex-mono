import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverSkills } from '../../src/discovery/skills.js';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

const mockReaddir = vi.mocked(fs.readdir);
const mockLstat = vi.mocked(fs.lstat);

function statLike(opts: { symlink?: boolean; file?: boolean; dir?: boolean }): fs.Stats {
  return {
    isSymbolicLink: () => opts.symlink ?? false,
    isFile: () => opts.file ?? false,
    isDirectory: () => opts.dir ?? false,
  } as unknown as fs.Stats;
}

const SKILLS_DIR = '/proj/.cortex/skills';

describe('discoverSkills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReaddir.mockRejectedValue(new Error('ENOENT'));
    mockLstat.mockRejectedValue(new Error('ENOENT'));
  });

  it('registers a skill with a real directory and a real SKILL.md file', async () => {
    mockReaddir.mockImplementation(async (path) => {
      if (String(path) === SKILLS_DIR) {
        return ['my-skill'] as unknown as ReturnType<typeof fs.readdir>;
      }
      throw new Error('ENOENT');
    });
    mockLstat.mockImplementation(async (path) => {
      if (String(path) === `${SKILLS_DIR}/my-skill`) return statLike({ dir: true });
      if (String(path) === `${SKILLS_DIR}/my-skill/SKILL.md`) return statLike({ file: true });
      throw new Error('ENOENT');
    });

    const skills = await discoverSkills('/proj');
    expect(skills).toHaveLength(1);
    expect(skills[0]?.path).toBe(`${SKILLS_DIR}/my-skill/SKILL.md`);
    expect(skills[0]?.source).toBe('project:my-skill');
  });

  it('does not register a symlinked SKILL.md', async () => {
    mockReaddir.mockImplementation(async (path) => {
      if (String(path) === SKILLS_DIR) {
        return ['evil-skill'] as unknown as ReturnType<typeof fs.readdir>;
      }
      throw new Error('ENOENT');
    });
    mockLstat.mockImplementation(async (path) => {
      if (String(path) === `${SKILLS_DIR}/evil-skill`) return statLike({ dir: true });
      // SKILL.md itself is a symlink.
      if (String(path) === `${SKILLS_DIR}/evil-skill/SKILL.md`) return statLike({ symlink: true });
      throw new Error('ENOENT');
    });

    const skills = await discoverSkills('/proj');
    expect(skills).toHaveLength(0);
  });

  it('does not register a symlinked skill directory even with a real SKILL.md inside', async () => {
    mockReaddir.mockImplementation(async (path) => {
      if (String(path) === SKILLS_DIR) {
        return ['linked-skill'] as unknown as ReturnType<typeof fs.readdir>;
      }
      throw new Error('ENOENT');
    });
    mockLstat.mockImplementation(async (path) => {
      // The directory entry is a symlink (e.g. -> /some/other/place).
      if (String(path) === `${SKILLS_DIR}/linked-skill`) return statLike({ symlink: true });
      // A real SKILL.md exists behind the link, but must never be reached.
      if (String(path) === `${SKILLS_DIR}/linked-skill/SKILL.md`) return statLike({ file: true });
      throw new Error('ENOENT');
    });

    const skills = await discoverSkills('/proj');
    expect(skills).toHaveLength(0);
  });
});
