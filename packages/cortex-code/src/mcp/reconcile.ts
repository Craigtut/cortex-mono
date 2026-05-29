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

import type { CortexAgent, McpStdioConfig, McpTransportConfig } from '@animus-labs/cortex';
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

  // Index current and desired by server name.
  const current = new Map<string, McpTransportConfig>();
  for (const state of agent.getMcpServerStates()) {
    current.set(state.serverName, state.config);
  }
  const desiredByName = new Map(desired.map((d) => [d.name, d]));

  // 1) Remove servers no longer in the desired set. Project servers that we
  //    just chose to *skip* (declined re-trust) are NOT removed here: a
  //    declined re-trust is "leave it alone", not "disconnect what's
  //    currently working." Otherwise a user who approves on startup, then
  //    dismisses a watcher-driven re-trust prompt, would unexpectedly lose
  //    their connected project servers.
  for (const [name] of current) {
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
    const currentConfig = current.get(name);
    if (currentConfig === undefined) {
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
    if (!configsEqual(currentConfig, discovered.config)) {
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

/**
 * Stable structural equality for two MCP transport configs. Used to detect
 * whether a server entry has been modified in the file (requiring a
 * disconnect+reconnect) vs unchanged (no-op).
 */
export function configsEqual(a: McpTransportConfig, b: McpTransportConfig): boolean {
  if (a.transport !== b.transport) return false;
  if (a.transport === 'stdio' && b.transport === 'stdio') {
    return stdioEqual(a, b);
  }
  if (a.transport === 'http' && b.transport === 'http') {
    return httpEqual(a, b);
  }
  return false;
}

function stdioEqual(a: McpStdioConfig, b: McpStdioConfig): boolean {
  if (a.command !== b.command) return false;
  if (a.cwd !== b.cwd) return false;
  if (a.toolTimeoutMs !== b.toolTimeoutMs) return false;
  if (!arrayEqual(a.args ?? [], b.args ?? [])) return false;
  return recordEqual(a.env ?? {}, b.env ?? {});
}

function httpEqual(a: Extract<McpTransportConfig, { transport: 'http' }>, b: Extract<McpTransportConfig, { transport: 'http' }>): boolean {
  if (a.url !== b.url) return false;
  if (a.toolTimeoutMs !== b.toolTimeoutMs) return false;
  return recordEqual(a.headers ?? {}, b.headers ?? {});
}

function arrayEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function recordEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
