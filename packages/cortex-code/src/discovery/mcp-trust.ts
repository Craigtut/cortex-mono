/**
 * MCP trust-on-first-use: tracks which project-local MCP configurations
 * the user has approved. When a project's .cortex/mcp.json is new or has
 * changed since last approval, the caller is notified so it can prompt
 * the user before spawning those servers.
 *
 * Global configs (~/.cortex/mcp.json) are always trusted since the user
 * owns them directly.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const TRUST_STORE_PATH = join(homedir(), '.cortex', 'trusted-mcp.json');

interface TrustStore {
  /** Map of project path to the SHA-256 hash of its .cortex/mcp.json content. */
  projects: Record<string, string>;
}

async function loadTrustStore(): Promise<TrustStore> {
  try {
    const raw = await readFile(TRUST_STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['projects'] === 'object'
    ) {
      return parsed as TrustStore;
    }
  } catch {
    // File doesn't exist or is corrupt
  }
  return { projects: {} };
}

async function saveTrustStore(store: TrustStore): Promise<void> {
  await mkdir(dirname(TRUST_STORE_PATH), { recursive: true });
  await writeFile(TRUST_STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface McpTrustResult {
  /** Whether the project MCP config is trusted (matches stored hash or doesn't exist). */
  trusted: boolean;
  /** The raw content of the project's mcp.json, if it exists. */
  configContent: string | null;
}

/**
 * Check whether a project's .cortex/mcp.json is trusted.
 * Returns trusted=true if:
 *   - The project has no .cortex/mcp.json
 *   - The file's hash matches the last approved hash
 */
export async function checkProjectMcpTrust(cwd: string): Promise<McpTrustResult> {
  const projectConfigPath = join(cwd, '.cortex', 'mcp.json');

  let content: string;
  try {
    content = await readFile(projectConfigPath, 'utf-8');
  } catch {
    // No project MCP config: nothing to trust-check
    return { trusted: true, configContent: null };
  }

  const store = await loadTrustStore();
  const currentHash = hashContent(content);
  const storedHash = store.projects[cwd];

  if (storedHash === currentHash) {
    return { trusted: true, configContent: content };
  }

  return { trusted: false, configContent: content };
}

/**
 * Record that the user has approved the current project MCP config.
 */
export async function trustProjectMcpConfig(cwd: string): Promise<void> {
  const projectConfigPath = join(cwd, '.cortex', 'mcp.json');

  let content: string;
  try {
    content = await readFile(projectConfigPath, 'utf-8');
  } catch {
    return;
  }

  const store = await loadTrustStore();
  store.projects[cwd] = hashContent(content);
  await saveTrustStore(store);
}
