import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CortexAgent, McpConnectionState, McpTransportConfig } from '@animus-labs/cortex';
import { applyReconcile, configsEqual } from '../../src/mcp/reconcile.js';
import type { DiscoveredMcpServer } from '../../src/discovery/mcp.js';

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

function fakeAgent(initial: Array<{ name: string; config: McpTransportConfig }> = []): {
  agent: CortexAgent;
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
    getMcpServerStates: (): McpConnectionState[] =>
      [...state.entries()].map(([name, config]) => ({
        serverName: name,
        config,
        connected: true,
        reconnectAttempts: 0,
        toolNames: [],
      })),
  } as unknown as CortexAgent;
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

describe('configsEqual', () => {
  it('treats identical stdio configs as equal', () => {
    expect(
      configsEqual(
        { transport: 'stdio', command: 'node', args: ['a'], env: { K: '1' } },
        { transport: 'stdio', command: 'node', args: ['a'], env: { K: '1' } },
      ),
    ).toBe(true);
  });

  it('detects timeout changes', () => {
    expect(
      configsEqual(
        { transport: 'stdio', command: 'node', toolTimeoutMs: 60_000 },
        { transport: 'stdio', command: 'node', toolTimeoutMs: 600_000 },
      ),
    ).toBe(false);
  });

  it('detects env key/value changes', () => {
    expect(
      configsEqual(
        { transport: 'stdio', command: 'node', env: { A: '1' } },
        { transport: 'stdio', command: 'node', env: { A: '2' } },
      ),
    ).toBe(false);
    expect(
      configsEqual(
        { transport: 'stdio', command: 'node' },
        { transport: 'stdio', command: 'node', env: { A: '1' } },
      ),
    ).toBe(false);
  });

  it('treats different transports as not equal', () => {
    expect(
      configsEqual(
        { transport: 'stdio', command: 'node' },
        { transport: 'http', url: 'http://x' },
      ),
    ).toBe(false);
  });

  it('compares http urls and headers', () => {
    expect(
      configsEqual(
        { transport: 'http', url: 'http://x', headers: { A: '1' } },
        { transport: 'http', url: 'http://x', headers: { A: '1' } },
      ),
    ).toBe(true);
    expect(
      configsEqual(
        { transport: 'http', url: 'http://x' },
        { transport: 'http', url: 'http://y' },
      ),
    ).toBe(false);
  });
});
