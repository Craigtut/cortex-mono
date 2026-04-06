import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, parse as parsePath } from 'node:path';
import { homedir } from 'node:os';

/**
 * Discover project context files by walking from CWD upward to the filesystem root.
 *
 * At each directory, checks for case-insensitive matches against:
 * 1. agents.md (preferred)
 * 2. claude.md (fallback if no agents.md)
 *
 * Also checks ~/.cortex/agents.md (global, lowest priority).
 *
 * Returns all found files concatenated root-first, closest-last,
 * wrapped in <project-context> tags with source path headers.
 */
export async function discoverProjectContext(cwd: string): Promise<string> {
  const foundFiles: Array<{ path: string; content: string }> = [];

  // Walk from CWD up to root
  const directories = getAncestorDirectories(cwd);

  for (const dir of directories) {
    const match = await findContextFile(dir);
    if (match) {
      foundFiles.push(match);
    }
  }

  // Reverse so root-first, closest-last
  foundFiles.reverse();

  // Check global context file (lowest priority, prepend)
  const globalPath = join(homedir(), '.cortex', 'agents.md');
  const globalContent = await readFileSafe(globalPath);
  if (globalContent !== null) {
    foundFiles.unshift({ path: globalPath, content: globalContent });
  }

  if (foundFiles.length === 0) return '';

  const sections = foundFiles.map(
    f => `## ${f.path}\n${f.content}`
  );

  return `<project-context>\n${sections.join('\n\n')}\n</project-context>`;
}

function getAncestorDirectories(startDir: string): string[] {
  const dirs: string[] = [];
  let current = startDir;

  while (true) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) break; // Reached root
    current = parent;
  }

  return dirs;
}

async function findContextFile(dir: string): Promise<{ path: string; content: string } | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  // Check for agents.md first (case-insensitive)
  const agentsMatch = entries.find(e => e.toLowerCase() === 'agents.md');
  if (agentsMatch) {
    const fullPath = join(dir, agentsMatch);
    const content = await readFileSafe(fullPath);
    if (content !== null) {
      return { path: fullPath, content };
    }
  }

  // Fallback: claude.md (case-insensitive)
  const claudeMatch = entries.find(e => e.toLowerCase() === 'claude.md');
  if (claudeMatch) {
    const fullPath = join(dir, claudeMatch);
    const content = await readFileSafe(fullPath);
    if (content !== null) {
      return { path: fullPath, content };
    }
  }

  return null;
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}
