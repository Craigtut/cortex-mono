import { readdir, lstat, readFile } from 'node:fs/promises';
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

/** True for skills discovered under `{cwd}/.cortex/skills` (source `project:*`). */
export function isProjectSkill(skill: SkillConfig): boolean {
  return skill.source.startsWith('project:');
}

/**
 * Build a stable trust signature over a set of project skills: every SKILL.md
 * path and its full content, sorted by path. The signature changes if any
 * project skill is added, removed, or edited, so an edited skill re-prompts for
 * trust before it can run shell on load. Returns null when there are no project
 * skills (nothing to gate).
 */
export async function computeProjectSkillsSignature(
  skills: SkillConfig[],
): Promise<string | null> {
  const projectSkills = skills.filter(isProjectSkill);
  if (projectSkills.length === 0) return null;

  const parts: string[] = [];
  for (const skill of [...projectSkills].sort((a, b) => a.path.localeCompare(b.path))) {
    let content: string;
    try {
      content = await readFile(skill.path, 'utf-8');
    } catch {
      content = '<unreadable>';
    }
    parts.push(`${skill.source}\n${skill.path}\n${content}`);
  }
  return parts.join('\u0000');
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
