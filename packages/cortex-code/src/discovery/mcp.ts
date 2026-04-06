import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { McpStdioConfig } from '@animus-labs/cortex';

interface McpConfigFile {
  servers?: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  }>;
}

export interface DiscoveredMcpServer {
  name: string;
  config: McpStdioConfig;
}

/**
 * Discover MCP server configurations from project-local and global config files.
 * Project configs override global configs for servers with the same name.
 */
export async function discoverMcpServers(cwd: string): Promise<DiscoveredMcpServer[]> {
  const globalPath = join(homedir(), '.cortex', 'mcp.json');
  const projectPath = join(cwd, '.cortex', 'mcp.json');

  const [globalConfig, projectConfig] = await Promise.all([
    loadMcpConfig(globalPath),
    loadMcpConfig(projectPath),
  ]);

  // Merge: project overrides global for same-name servers
  const merged = new Map<string, DiscoveredMcpServer>();

  for (const server of globalConfig) {
    merged.set(server.name, server);
  }
  for (const server of projectConfig) {
    merged.set(server.name, server);
  }

  return [...merged.values()];
}

async function loadMcpConfig(path: string): Promise<DiscoveredMcpServer[]> {
  try {
    const content = await readFile(path, 'utf-8');
    const config = JSON.parse(content) as McpConfigFile;
    const servers: DiscoveredMcpServer[] = [];

    for (const [name, entry] of Object.entries(config.servers ?? {})) {
      if (!entry.command) continue;
      const config: McpStdioConfig = {
        transport: 'stdio',
        command: entry.command,
      };
      if (entry.args) config.args = entry.args;
      if (entry.env) config.env = entry.env;
      if (entry.cwd) config.cwd = entry.cwd;
      servers.push({ name, config });
    }

    return servers;
  } catch {
    return [];
  }
}
