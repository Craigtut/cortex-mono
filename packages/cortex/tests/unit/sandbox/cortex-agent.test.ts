import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBuiltinModel as getModel } from '@earendil-works/pi-ai/providers/all';
import { CortexAgent } from '../../../src/cortex-agent.js';
import { wrapModel } from '../../../src/model-wrapper.js';
import type { SandboxPolicy, SandboxProvider, SandboxStatus } from '../../../src/sandbox/types.js';

const captured = vi.hoisted(() => [] as Array<{ beforeToolCall?: (ctx: unknown) => Promise<unknown> }>);
vi.mock('@earendil-works/pi-agent-core', async (original) => {
  const real = await original<typeof import('@earendil-works/pi-agent-core')>();
  return { ...real, Agent: class extends real.Agent {
    constructor(options: ConstructorParameters<typeof real.Agent>[0]) {
      super(options);
      captured.push(options as unknown as (typeof captured)[number]);
    }
  } };
});
let cwd: string;
const agents: CortexAgent[] = [];
const status: SandboxStatus = { backend: 'seatbelt', filesystem: 'enforced', network: 'enforced', degradations: [] };
function provider() {
  return {
    initialize: vi.fn(async (_policy: SandboxPolicy) => status),
    wrapSpawn: vi.fn(async (spec) => ({ file: spec.shell, args: [...spec.shellArgs, spec.command], env: spec.env })),
    wrapExec: vi.fn(async (spec) => ({ file: spec.file, args: spec.args, env: spec.env })),
    status: () => status,
    dispose: vi.fn(async () => {}),
  } satisfies SandboxProvider;
}
beforeEach(() => { captured.length = 0; cwd = mkdtempSync(join(tmpdir(), 'cortex-facade-sandbox-')); });
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.destroy()));
  rmSync(cwd, { recursive: true, force: true });
});
function config() {
  return { model: wrapModel(getModel('anthropic', 'claude-sonnet-4-6'), 'anthropic', 'claude-sonnet-4-6'), workingDirectory: cwd, getApiKey: async () => 'unused' };
}

describe('CortexAgent managed sandbox API', () => {
  it.each(['passthrough', 'duplex'] as const)('owns one sandbox across %s loops and blocks writes without a resolver', async (mode) => {
    const backend = provider();
    const agent = await CortexAgent.create({ ...config(), mode, sandbox: { provider: backend } });
    agents.push(agent);
    expect(backend.initialize).toHaveBeenCalledOnce();
    expect(captured).toHaveLength(mode === 'duplex' ? 2 : 1);
    for (const loop of captured) {
      expect(await loop.beforeToolCall!({ toolCall: { name: 'Write' }, args: { file_path: join(cwd, '../outside') } }))
        .toMatchObject({ block: true, reason: expect.stringContaining('outside the writable roots') });
      expect(await loop.beforeToolCall!({ toolCall: { name: 'Write' }, args: { file_path: join(cwd, 'inside') } }))
        .toBeUndefined();
    }
    const temp = agent.getSandboxState()!.policy!.filesystem.sessionTmpDir!;
    await agent.setSandboxRung('restricted');
    expect(agent.getSandboxState()!.rung).toBe('restricted');
    await agent.destroy();
    await agent.destroy();
    expect(backend.dispose).toHaveBeenCalledOnce();
    expect(existsSync(temp)).toBe(false);
  });

  it('requires restarting connected stdio servers before a policy change', async () => {
    const agent = await CortexAgent.create({ ...config(), mode: 'passthrough', sandbox: { provider: provider() } });
    agents.push(agent);
    vi.spyOn(agent.getMcpClientManager(), 'getConnectionStates').mockReturnValue([{
      serverName: 'local', connected: true, reconnectAttempts: 0, toolNames: [],
      config: { transport: 'stdio', command: 'server', hasEnv: false },
    }]);
    await expect(agent.setSandboxRung('restricted')).rejects.toThrow('Disconnect stdio MCP');
    expect(agent.getSandboxState()!.rung).toBe('workspace');
  });

  it('preserves borrowed-provider ownership', async () => {
    const backend = provider();
    const agent = await CortexAgent.create({ ...config(), mode: 'passthrough', sandbox: backend });
    agents.push(agent);
    expect(agent.getSandboxState()).toBeUndefined();
    await agent.destroy();
    expect(backend.initialize).not.toHaveBeenCalled();
    expect(backend.dispose).not.toHaveBeenCalled();
  });

  it('lets consumers opt out without a managed controller', async () => {
    const agent = await CortexAgent.create({ ...config(), mode: 'passthrough', sandbox: false });
    agents.push(agent);
    expect(agent.getSandboxState()).toBeUndefined();
    await expect(agent.setSandboxRung('workspace')).rejects.toThrow('No Cortex-managed sandbox');
  });
});
