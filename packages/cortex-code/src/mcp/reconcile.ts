/**
 * MCP server reconciliation: bring the agent's live set of connected MCP
 * servers into agreement with the desired set discovered from
 * `~/.cortex/mcp.json` and `{cwd}/.cortex/mcp.json`.
 *
 * Two callers use this:
 *
 * - The MCP config watcher (file change observed → reconcile after next turn).
 * - The `/mcp-reload` slash command (manual trigger).
 *
 * Reconciliation is **idempotent** and safe to run on an idle agent. It MUST
 * NOT run while the agentic loop is mid-prompt: pi-agent-core snapshots the
 * tool set at `prompt()` entry, and removing a tool mid-turn risks the model
 * choosing a tool that has just been disconnected. Callers gate on
 * `session.isRunning` and queue until `onLoopComplete`.
 */

import type { CortexAgent } from '@animus-labs/cortex';
import { discoverMcpServers, type DiscoveredMcpServer } from '../discovery/mcp.js';
import { checkProjectMcpTrust, trustProjectMcpConfig } from '../discovery/mcp-trust.js';

/** Outcome of a single reconciliation pass. Returned for telemetry and UX. */
export interface McpReconcileResult {
  added: string[];
  removed: string[];
  updated: string[];
  unchanged: string[];
  skippedDueToUntrustedProject: string[];
  errors: Array<{ serverName: string; phase: 'connect' | 'disconnect' | 'reconnect'; error: string }>;
}

/** Strategy callback for resolving trust on a project-scoped server set. */
export type ProjectTrustResolver = (
  cwd: string,
  servers: DiscoveredMcpServer[],
) => Promise<'trust' | 'skip'>;

/** Options accepted by [`reconcileMcpServers`]. */
export interface ReconcileOptions {
  /**
   * Resolves trust for an as-yet-untrusted project MCP config. Defaults to
   * `'skip'` so reconciliation never blocks waiting on a user. Watchers may
   * pass a resolver that shows an overlay (see `session.ts`).
   */
  resolveProjectTrust?: ProjectTrustResolver;
  /** Optional logger; defaults to a no-op. */
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Bring the agent's connected MCP servers into agreement with the discovered
 * set. Returns a summary of changes.
 */
export async function reconcileMcpServers(
  agent: CortexAgent,
  cwd: string,
  options: ReconcileOptions = {},
): Promise<McpReconcileResult> {
  const log = options.log ?? (() => {});
  const desired = await discoverMcpServers(cwd);
  return applyReconcile(agent, cwd, desired, options.resolveProjectTrust, log);
}

/**
 * Pure-logic core, exposed for tests that want to inject a fixed desired set
 * rather than reading config files.
 */
export async function applyReconcile(
  agent: CortexAgent,
  cwd: string,
  desired: DiscoveredMcpServer[],
  resolveProjectTrust: ProjectTrustResolver | undefined,
  log: (message: string, data?: Record<string, unknown>) => void,
): Promise<McpReconcileResult> {
  const result: McpReconcileResult = {
    added: [],
    removed: [],
    updated: [],
    unchanged: [],
    skippedDueToUntrustedProject: [],
    errors: [],
  };

  // Trust gate: if any newly-discovered project server is untrusted, defer to
  // the resolver. Servers that are merely currently connected (already
  // trusted in a prior pass) continue without re-prompting.
  const projectDesired = desired.filter((d) => d.source === 'project');
  if (projectDesired.length > 0) {
    const trust = await checkProjectMcpTrust(cwd);
    if (!trust.trusted) {
      const decision = (await resolveProjectTrust?.(cwd, projectDesired)) ?? 'skip';
      if (decision === 'trust') {
        await trustProjectMcpConfig(cwd);
      } else {
        for (const server of projectDesired) {
          result.skippedDueToUntrustedProject.push(server.name);
        }
        // Drop project servers from the desired set for this pass.
        desired = desired.filter((d) => d.source !== 'project');
      }
    }
  }

  // Index currently-connected server names and the desired set. The live states
  // carry a redacted config (secret env/headers withheld), so we only read the
  // names from them; change detection below asks the agent to compare the full
  // stored config (secrets included) via `mcpConfigMatches`, which keeps the
  // secrets inside the MCP client manager.
  const currentNames = new Set<string>();
  for (const state of agent.getMcpServerStates()) {
    currentNames.add(state.serverName);
  }
  const desiredByName = new Map(desired.map((d) => [d.name, d]));

  // 1) Remove servers no longer in the desired set. Project servers that we
  //    just chose to *skip* (declined re-trust) are NOT removed here: a
  //    declined re-trust is "leave it alone", not "disconnect what's
  //    currently working." Otherwise a user who approves on startup, then
  //    dismisses a watcher-driven re-trust prompt, would unexpectedly lose
  //    their connected project servers.
  for (const name of currentNames) {
    if (!desiredByName.has(name)) {
      if (result.skippedDueToUntrustedProject.includes(name)) {
        result.unchanged.push(name);
        continue;
      }
      try {
        await agent.disconnectMcpServer(name);
        result.removed.push(name);
        log('mcp.reconcile.removed', { server: name });
      } catch (err) {
        result.errors.push({
          serverName: name,
          phase: 'disconnect',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 2) Add or update servers in the desired set.
  for (const [name, discovered] of desiredByName) {
    if (!currentNames.has(name)) {
      try {
        await agent.connectMcpServer(name, discovered.config);
        result.added.push(name);
        log('mcp.reconcile.added', { server: name });
      } catch (err) {
        result.errors.push({
          serverName: name,
          phase: 'connect',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    // Full-config comparison inside the manager: detects any change to a
    // secret value, args, cwd, url, timeout, or added/removed/renamed
    // env/header keys. Both the file watcher and `/mcp-reload` reach this path.
    if (!agent.mcpConfigMatches(name, discovered.config)) {
      try {
        await agent.disconnectMcpServer(name);
        await agent.connectMcpServer(name, discovered.config);
        result.updated.push(name);
        log('mcp.reconcile.updated', { server: name });
      } catch (err) {
        result.errors.push({
          serverName: name,
          phase: 'reconnect',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    result.unchanged.push(name);
  }

  return result;
}
