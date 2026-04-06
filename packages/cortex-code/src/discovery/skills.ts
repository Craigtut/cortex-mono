import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SkillConfig } from '@animus-labs/cortex';

/**
 * Discover skill directories from project-local and global paths.
 * Returns SkillConfig[] suitable for CortexAgent.getSkillRegistry().addSkill().
 */
export async function discoverSkills(cwd: string): Promise<SkillConfig[]> {
  const skills: SkillConfig[] = [];

  const searchPaths = [
    { base: join(cwd, '.cortex', 'skills'), source: 'project' },
    { base: join(homedir(), '.cortex', 'skills'), source: 'global' },
  ];

  for (const { base, source } of searchPaths) {
    const found = await scanSkillDirectory(base, source);
    skills.push(...found);
  }

  return skills;
}

async function scanSkillDirectory(dir: string, source: string): Promise<SkillConfig[]> {
  const skills: SkillConfig[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return skills;
  }

  for (const entry of entries) {
    const skillDir = join(dir, entry);
    const skillMdPath = join(skillDir, 'SKILL.md');

    try {
      const s = await stat(skillMdPath);
      if (s.isFile()) {
        skills.push({
          path: skillMdPath,
          source: `${source}:${entry}`,
        });
      }
    } catch {
      // No SKILL.md in this directory, skip
    }
  }

  return skills;
}
