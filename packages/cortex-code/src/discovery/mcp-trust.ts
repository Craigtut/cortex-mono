/**
 * MCP trust-on-first-use: tracks which project-local MCP configurations the
 * user has approved. When a project's `.cortex/mcp.json` is new or has changed
 * since last approval, the caller is notified so it can prompt the user before
 * spawning those servers.
 *
 * This is a thin adapter over the shared project-trust store (see
 * `project-trust.ts`), which also gates project hooks and skills. Global
 * configs (`~/.cortex/mcp.json`) are user-authored and always trusted.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkProjectTrust, recordProjectTrust } from './project-trust.js';

export interface McpTrustResult {
  /** Whether the project MCP config is trusted (matches stored hash or doesn't exist). */
  trusted: boolean;
  /** The raw content of the project's mcp.json, if it exists. */
  configContent: string | null;
}

/** Read a project's `.cortex/mcp.json`, or null if it does not exist. */
async function readProjectMcpConfig(cwd: string): Promise<string | null> {
  try {
    return await readFile(join(cwd, '.cortex', 'mcp.json'), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Check whether a project's `.cortex/mcp.json` is trusted.
 * Returns trusted=true if the project has no config, or the file's hash matches
 * the last approved hash. The raw content is returned so the caller can display
 * it and thread the SAME bytes into `trustProjectMcpConfig` (no re-read TOCTOU).
 */
export async function checkProjectMcpTrust(cwd: string): Promise<McpTrustResult> {
  const configContent = await readProjectMcpConfig(cwd);
  const trusted = await checkProjectTrust(cwd, 'mcp', configContent);
  return { trusted, configContent };
}

/**
 * Record that the user has approved a project MCP config. The caller passes the
 * content it displayed (from `checkProjectMcpTrust`); if omitted, the file is
 * read as a fallback. Passing the displayed content closes the window where a
 * file swapped between prompt and approval could be trusted.
 */
export async function trustProjectMcpConfig(cwd: string, content?: string | null): Promise<void> {
  const resolved = content ?? (await readProjectMcpConfig(cwd));
  if (resolved === null) return;
  await recordProjectTrust(cwd, 'mcp', resolved);
}
