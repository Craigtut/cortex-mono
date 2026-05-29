import type { Command } from './index.js';

/**
 * `/mcp-reload`: force the session to re-read `~/.cortex/mcp.json` and
 * `{cwd}/.cortex/mcp.json` and reconcile connected MCP servers. The reload
 * runs between turns; if the agentic loop is currently active it is queued.
 */
export const mcpReloadCommand: Command = {
  name: 'mcp-reload',
  description: 'Reload MCP server config without restarting the session',
  handler: async (session) => {
    await session.triggerMcpReload();
  },
};
