/**
 * Shared MCP manager across loops (docs/cortex/duplex/sub-agents.md "MCP
 * and Shared Services"): AgentLoopConfig.mcpClientManager lets several
 * loops hold ONE manager (one connection and one stdio subprocess per
 * server total). The manager's callbacks are listener arrays, so
 * registration is additive: with the old single-slot fields the last loop
 * to wire itself silently disconnected every other observer.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { AgentLoopConfig } from '../../src/types.js';
import { McpClientManager } from '../../src/mcp-client.js';
import { wrapModel } from '../../src/model-wrapper.js';

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

function createMockPiAgent(): PiAgent {
  return {
    state: { messages: [], systemPrompt: '', tools: [] },
    subscribe() { return () => {}; },
    async prompt() { return { content: 'ok' }; },
    abort() {},
    async waitForIdle() {},
    reset() { this.state.messages = []; },
    steer() {},
  } as unknown as PiAgent;
}

function createLoop(config?: Partial<AgentLoopConfig>): AgentLoop {
  const Ctor = AgentLoop as unknown as TestAgentLoopConstructor;
  return new Ctor(
    createMockPiAgent(),
    {
      model: wrapModel(
        { provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel,
        'anthropic',
        'claude-sonnet-4-20250514',
      ),
      workingDirectory: '/tmp/test-workspace',
      initialBasePrompt: 'Test prompt',
      slots: [],
      ...config,
    },
    [],
    { enableSubAgentTool: false, enableLoadSkillTool: false },
  );
}

/** Reach the manager's private listener arrays and emitters for assertions. */
function managerInternals(manager: McpClientManager): {
  toolsChangedListeners: unknown[];
  subprocessSpawnedListeners: unknown[];
  toolCallProgressListeners: unknown[];
  emitToolsChanged: () => void;
} {
  return manager as unknown as {
    toolsChangedListeners: unknown[];
    subprocessSpawnedListeners: unknown[];
    toolCallProgressListeners: unknown[];
    emitToolsChanged: () => void;
  };
}

const liveLoops: AgentLoop[] = [];

afterEach(async () => {
  for (const loop of liveLoops.splice(0)) {
    await loop.destroy().catch(() => {});
  }
  vi.restoreAllMocks();
});

describe('McpClientManager listener arrays', () => {
  it('fires every registered toolsChanged listener; unsubscribe removes only its own', () => {
    const manager = new McpClientManager();
    const calls: string[] = [];
    const unsubA = manager.addToolsChangedListener(() => calls.push('a'));
    manager.addToolsChangedListener(() => calls.push('b'));

    managerInternals(manager).emitToolsChanged();
    expect(calls).toEqual(['a', 'b']);

    unsubA();
    unsubA(); // idempotent
    managerInternals(manager).emitToolsChanged();
    expect(calls).toEqual(['a', 'b', 'b']);
  });

  it('a throwing listener does not silence the others', () => {
    const manager = new McpClientManager();
    const calls: string[] = [];
    manager.addToolsChangedListener(() => {
      throw new Error('observer bug');
    });
    manager.addToolsChangedListener(() => calls.push('survivor'));
    managerInternals(manager).emitToolsChanged();
    expect(calls).toEqual(['survivor']);
  });
});

describe('AgentLoop with a shared MCP manager', () => {
  it('uses the external manager and both sharing loops observe tool changes', () => {
    const shared = new McpClientManager();
    const loopA = createLoop({ mcpClientManager: shared });
    const loopB = createLoop({ mcpClientManager: shared });
    liveLoops.push(loopA, loopB);

    expect(loopA.getMcpClientManager()).toBe(shared);
    expect(loopB.getMcpClientManager()).toBe(shared);

    // The defect the arrays close: with single-slot fields, loopB's wiring
    // would have displaced loopA's and its tool resync would go dark.
    const refreshA = vi.spyOn(loopA, 'refreshTools');
    const refreshB = vi.spyOn(loopB, 'refreshTools');
    managerInternals(shared).emitToolsChanged();
    expect(refreshA).toHaveBeenCalledTimes(1);
    expect(refreshB).toHaveBeenCalledTimes(1);
  });

  it('does not configure or close a manager it does not own', async () => {
    const shared = new McpClientManager();
    const ownerLogger = { debug() {}, info() {}, warn() {}, error() {} };
    shared.logger = ownerLogger;
    const closeSpy = vi.spyOn(shared, 'closeAll');

    const loop = createLoop({ mcpClientManager: shared });
    // Owner-level settings are untouched by a non-owning loop.
    expect(shared.logger).toBe(ownerLogger);

    const internals = managerInternals(shared);
    const registered = internals.toolsChangedListeners.length;
    expect(registered).toBeGreaterThan(0);

    await loop.destroy();
    // Detached its own listeners, closed nothing.
    expect(internals.toolsChangedListeners.length).toBe(0);
    expect(internals.subprocessSpawnedListeners.length).toBe(0);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('still closes a manager it owns on destroy', async () => {
    const loop = createLoop();
    const closeSpy = vi.spyOn(loop.getMcpClientManager(), 'closeAll');
    await loop.destroy();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('progress handlers keep per-loop replace semantics on a shared manager', () => {
    const shared = new McpClientManager();
    const loopA = createLoop({ mcpClientManager: shared });
    const loopB = createLoop({ mcpClientManager: shared });
    liveLoops.push(loopA, loopB);
    const internals = managerInternals(shared);

    loopA.setMcpToolCallProgressHandler(() => {});
    loopB.setMcpToolCallProgressHandler(() => {});
    expect(internals.toolCallProgressListeners.length).toBe(2);

    // Replacing loopA's handler keeps exactly one registration for it and
    // leaves loopB's alone; clearing removes only loopA's.
    loopA.setMcpToolCallProgressHandler(() => {});
    expect(internals.toolCallProgressListeners.length).toBe(2);
    loopA.setMcpToolCallProgressHandler(undefined);
    expect(internals.toolCallProgressListeners.length).toBe(1);
  });
});
