import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  AgentLoop,
  McpConnectionState,
  McpRedactedTransportConfig,
  McpTransportConfig,
} from '@animus-labs/cortex';
import { applyReconcile } from '../../src/mcp/reconcile.js';
import type { DiscoveredMcpServer } from '../../src/discovery/mcp.js';

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

/** Mirror the manager's redaction so the fake state matches production shape. */
function redact(config: McpTransportConfig): McpRedactedTransportConfig {
  if (config.transport === 'stdio') {
    const { env, ...rest } = config;
    return { ...rest, hasEnv: env !== undefined && Object.keys(env).length > 0 };
  }
  const { headers, ...rest } = config;
  return { ...rest, hasHeaders: headers !== undefined && Object.keys(headers).length > 0 };
}

function recordEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => a[k] === b[k]);
}

/**
 * Mirror of the McpClientManager's internal full-config comparison (including
 * secret env/headers). The real comparison lives in the manager and is
 * unit-tested in packages/cortex/tests/unit/mcp-client.test.ts; here it backs
 * the fake agent's `mcpConfigMatches` so reconcile's decisions can be exercised
 * against full configs, exactly as production does.
 */
function fullConfigsEqual(a: McpTransportConfig, b: McpTransportConfig): boolean {
  if (a.transport !== b.transport) return false;
  if (a.transport === 'stdio' && b.transport === 'stdio') {
    if (a.command !== b.command) return false;
    if (a.cwd !== b.cwd) return false;
    if (a.toolTimeoutMs !== b.toolTimeoutMs) return false;
    const argsA = a.args ?? [];
    const argsB = b.args ?? [];
    if (argsA.length !== argsB.length || !argsA.every((v, i) => v === argsB[i])) return false;
    return recordEqual(a.env ?? {}, b.env ?? {});
  }
  if (a.transport === 'http' && b.transport === 'http') {
    if (a.url !== b.url) return false;
    if (a.toolTimeoutMs !== b.toolTimeoutMs) return false;
    return recordEqual(a.headers ?? {}, b.headers ?? {});
  }
  return false;
}

function fakeAgent(initial: Array<{ name: string; config: McpTransportConfig }> = []): {
  agent: AgentLoop;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  const state = new Map<string, McpTransportConfig>();
  for (const entry of initial) {
    state.set(entry.name, entry.config);
  }
  const connect = vi.fn(async (name: string, config: McpTransportConfig) => {
    state.set(name, config);
  });
  const disconnect = vi.fn(async (name: string) => {
    state.delete(name);
  });
  const agent = {
    connectMcpServer: connect,
    disconnectMcpServer: disconnect,
    // Redacted, exactly like production: reconcile only reads server names here.
    getMcpServerStates: (): McpConnectionState[] =>
      [...state.entries()].map(([name, config]) => ({
        serverName: name,
        config: redact(config),
        connected: true,
        reconnectAttempts: 0,
        toolNames: [],
      })),
    // Full-config comparison against the (secret-bearing) stored config, which
    // never leaves the manager in production. This is what restores change
    // detection for secret value/key edits.
    mcpConfigMatches: (serverName: string, desired: McpTransportConfig): boolean => {
      const stored = state.get(serverName);
      if (!stored) return false;
      return fullConfigsEqual(stored, desired);
    },
  } as unknown as AgentLoop;
  return { agent, connect, disconnect };
}

function stdioServer(
  name: string,
  source: 'global' | 'project',
  overrides: Partial<Extract<McpTransportConfig, { transport: 'stdio' }>> = {},
): DiscoveredMcpServer {
  return {
    name,
    source,
    config: { transport: 'stdio', command: 'node', args: ['s.js'], ...overrides },
  };
}

function httpServer(
  name: string,
  source: 'global' | 'project',
  overrides: Partial<Extract<McpTransportConfig, { transport: 'http' }>> = {},
): DiscoveredMcpServer {
  return {
    name,
    source,
    config: { transport: 'http', url: 'http://svc/mcp', ...overrides },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyReconcile', () => {
  let log: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    log = vi.fn();
  });

  it('connects newly added servers and reports them', async () => {
    const { agent, connect, disconnect } = fakeAgent();
    const desired = [stdioServer('reverie_bridge', 'global')];
    const result = await applyReconcile(agent, '/repo', desired, undefined, log);
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith('reverie_bridge', desired[0].config);
    expect(disconnect).not.toHaveBeenCalled();
    expect(result.added).toEqual(['reverie_bridge']);
    expect(result.removed).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.unchanged).toEqual([]);
  });

  it('disconnects servers that have been removed from config', async () => {
    const { agent, connect, disconnect } = fakeAgent([
      { name: 'weather', config: { transport: 'stdio', command: 'node', args: ['w.js'] } },
    ]);
    const result = await applyReconcile(agent, '/repo', [], undefined, log);
    expect(disconnect).toHaveBeenCalledWith('weather');
    expect(connect).not.toHaveBeenCalled();
    expect(result.removed).toEqual(['weather']);
  });

  it('reports unchanged servers as unchanged, with no agent mutations', async () => {
    const { agent, connect, disconnect } = fakeAgent([
      {
        name: 'reverie_bridge',
        config: { transport: 'stdio', command: '/bin/r', args: [], toolTimeoutMs: 600_000 },
      },
    ]);
    const desired = [
      stdioServer('reverie_bridge', 'global', { command: '/bin/r', args: [], toolTimeoutMs: 600_000 }),
    ];
    const result = await applyReconcile(agent, '/repo', desired, undefined, log);
    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(result.unchanged).toEqual(['reverie_bridge']);
  });

  it('disconnect-then-connects a server whose config changed', async () => {
    const { agent, connect, disconnect } = fakeAgent([
      { name: 'svc', config: { transport: 'stdio', command: '/bin/old', args: [] } },
    ]);
    const desired = [stdioServer('svc', 'global', { command: '/bin/new', args: [] })];
    const result = await applyReconcile(agent, '/repo', desired, undefined, log);
    expect(disconnect).toHaveBeenCalledWith('svc');
    expect(connect).toHaveBeenCalledWith('svc', desired[0].config);
    expect(result.updated).toEqual(['svc']);
  });

  // ---------------------------------------------------------------------------
  // Secret change detection. reconcile compares against the manager's FULL
  // stored config via agent.mcpConfigMatches, so env/header edits reconnect even
  // though getMcpServerStates is redacted. Both the file watcher and the manual
  // /mcp-reload command funnel through applyReconcile, so these cover both paths.
  // ---------------------------------------------------------------------------

  it('reconnects when only an env value changed (secret rotation)', async () => {
    const { agent, connect, disconnect } = fakeAgent([
      { name: 'svc', config: { transport: 'stdio', command: 'node', args: ['s.js'], env: { TOKEN: 'old' } } },
    ]);
    const desired = [stdioServer('svc', 'global', { env: { TOKEN: 'new' } })];
    const result = await applyReconcile(agent, '/repo', desired, undefined, log);
    expect(disconnect).toHaveBeenCalledWith('svc');
    expect(connect).toHaveBeenCalledWith('svc', desired[0].config);
    expect(result.updated).toEqual(['svc']);
  });

  it('reconnects when an env key is added', async () => {
    const { agent, connect, disconnect } = fakeAgent([
      { name: 'svc', config: { transport: 'stdio', command: 'node', args: ['s.js'], env: { A: '1' } } },
    ]);
    const desired = [stdioServer('svc', 'global', { env: { A: '1', B: '2' } })];
    const result = await applyReconcile(agent, '/repo', desired, undefined, log);
    expect(disconnect).toHaveBeenCalledWith('svc');
    expect(result.updated).toEqual(['svc']);
  });

  it('reconnects when an env key is removed', async () => {
    const { agent, disconnect } = fakeAgent([
      { name: 'svc', config: { transport: 'stdio', command: 'node', args: ['s.js'], env: { A: '1', B: '2' } } },
    ]);
    const desired = [stdioServer('svc', 'global', { env: { A: '1' } })];
    const result = await applyReconcile(agent, '/repo', desired, undefined, log);
    expect(disconnect).toHaveBeenCalledWith('svc');
    expect(result.updated).toEqual(['svc']);
  });

  it('reconnects when an env key is renamed', async () => {
    const { agent, disconnect } = fakeAgent([
      { name: 'svc', config: { transport: 'stdio', command: 'node', args: ['s.js'], env: { OLD: '1' } } },
    ]);
    const desired = [stdioServer('svc', 'global', { env: { NEW: '1' } })];
    const result = await applyReconcile(agent, '/repo', desired, undefined, log);
    expect(disconnect).toHaveBeenCalledWith('svc');
    expect(result.updated).toEqual(['svc']);
  });

  it('reconnects when an http header value changed', async () => {
    const { agent, disconnect } = fakeAgent([
      { name: 'api', config: { transport: 'http', url: 'http://svc/mcp', headers: { Authorization: 'Bearer old' } } },
    ]);
    const desired = [httpServer('api', 'global', { headers: { Authorization: 'Bearer new' } })];
    const result = await applyReconcile(agent, '/repo', desired, undefined, log);
    expect(disconnect).toHaveBeenCalledWith('api');
    expect(result.updated).toEqual(['api']);
  });

  it('leaves a server unchanged when the full config including env is identical', async () => {
    const { agent, connect, disconnect } = fakeAgent([
      { name: 'svc', config: { transport: 'stdio', command: 'node', args: ['s.js'], env: { A: '1' } } },
    ]);
    const desired = [stdioServer('svc', 'global', { env: { A: '1' } })];
    const result = await applyReconcile(agent, '/repo', desired, undefined, log);
    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(result.unchanged).toEqual(['svc']);
  });

  it('records a per-server error when connect fails but continues other work', async () => {
    const { agent, connect, disconnect } = fakeAgent();
    connect.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const desired = [stdioServer('a', 'global'), stdioServer('b', 'global')];
    const result = await applyReconcile(agent, '/repo', desired, undefined, log);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(disconnect).not.toHaveBeenCalled();
    expect(result.added).toEqual(['b']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ serverName: 'a', phase: 'connect' });
  });
});

