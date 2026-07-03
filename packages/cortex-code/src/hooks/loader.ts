/**
 * Load hook configurations from `~/.cortex/hooks.json` and
 * `{cwd}/.cortex/hooks.json`. Project entries override global entries with
 * the same name (matching the MCP discovery convention).
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HookConfigFile, HookEvent, HookHandler } from './types.js';

const HOOK_EVENTS: readonly HookEvent[] = [
  'pre_turn',
  'post_turn',
  'pre_tool_use',
  'post_tool_use',
  'session_start',
  'session_end',
];

export interface LoadHookOptions {
  /**
   * Whether to include project-local (`{cwd}/.cortex/hooks.json`) handlers.
   * Defaults to true. Callers pass false to load ONLY global handlers when the
   * project's hooks are untrusted (declined at the trust prompt), so project
   * hooks never run.
   */
  includeProject?: boolean;
}

/**
 * Discover hook handlers grouped by event. Returned map is exhaustive: every
 * known event has an entry (possibly empty). Missing or malformed files are
 * treated as "no hooks".
 */
export async function loadHookHandlers(
  cwd: string,
  options: LoadHookOptions = {},
): Promise<Record<HookEvent, HookHandler[]>> {
  const includeProject = options.includeProject ?? true;
  const globalPath = join(homedir(), '.cortex', 'hooks.json');
  const projectPath = join(cwd, '.cortex', 'hooks.json');
  const [global, project] = await Promise.all([
    loadOne(globalPath, 'global'),
    includeProject ? loadOne(projectPath, 'project') : Promise.resolve(emptyMap()),
  ]);
  return merge(global, project);
}

/**
 * Read the raw `{cwd}/.cortex/hooks.json` content, or null if it does not
 * exist. Used as the trust signature for project hooks so the exact bytes that
 * back the loaded handlers are what the user approves.
 */
export async function readProjectHooksContent(cwd: string): Promise<string | null> {
  try {
    return await readFile(join(cwd, '.cortex', 'hooks.json'), 'utf-8');
  } catch {
    return null;
  }
}

/** True if any event bucket contains a handler sourced from the project. */
export function hasProjectHooks(handlers: Record<HookEvent, HookHandler[]>): boolean {
  return HOOK_EVENTS.some((event) => handlers[event].some((h) => h.source === 'project'));
}

async function loadOne(
  path: string,
  source: 'global' | 'project',
): Promise<Record<HookEvent, HookHandler[]>> {
  const empty = emptyMap();
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return empty;
  }
  let parsed: HookConfigFile;
  try {
    parsed = JSON.parse(raw) as HookConfigFile;
  } catch {
    return empty;
  }
  const result = emptyMap();
  if (parsed.hooks) {
    for (const event of HOOK_EVENTS) {
      const entries = parsed.hooks[event];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || typeof entry.command !== 'string' || entry.command.length === 0) continue;
        const handler: HookHandler = {
          name: entry.name && entry.name.length > 0 ? entry.name : entry.command,
          command: entry.command,
          source,
        };
        if (Array.isArray(entry.args)) handler.args = [...entry.args];
        if (typeof entry.cwd === 'string') handler.cwd = entry.cwd;
        if (typeof entry.timeoutMs === 'number') handler.timeoutMs = entry.timeoutMs;
        if (entry.env && typeof entry.env === 'object') handler.env = { ...entry.env };
        result[event].push(handler);
      }
    }
  }
  return result;
}

function merge(
  global: Record<HookEvent, HookHandler[]>,
  project: Record<HookEvent, HookHandler[]>,
): Record<HookEvent, HookHandler[]> {
  const out = emptyMap();
  for (const event of HOOK_EVENTS) {
    const byName = new Map<string, HookHandler>();
    for (const handler of global[event]) byName.set(handler.name, handler);
    for (const handler of project[event]) byName.set(handler.name, handler);
    out[event] = [...byName.values()];
  }
  return out;
}

function emptyMap(): Record<HookEvent, HookHandler[]> {
  return HOOK_EVENTS.reduce<Record<HookEvent, HookHandler[]>>((acc, event) => {
    acc[event] = [];
    return acc;
  }, {} as Record<HookEvent, HookHandler[]>);
}
