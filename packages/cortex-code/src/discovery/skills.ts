import { readdir, lstat } from 'node:fs/promises';
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
      // Reject a symlinked skill directory too: a symlinked dir with a real
      // SKILL.md inside would otherwise still register (and its relative loads
      // could escape the skills root). isDirectory() is only true for a real
      // directory, so this also rejects Windows junctions/reparse points.
      const dirStat = await lstat(skillDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;

      // lstat (not stat) so a symlinked SKILL.md is not followed. isFile() is
      // only true for a real regular file, so it rejects both POSIX symlinks and
      // Windows junctions/reparse points, which never report as a plain file.
      const s = await lstat(skillMdPath);
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
