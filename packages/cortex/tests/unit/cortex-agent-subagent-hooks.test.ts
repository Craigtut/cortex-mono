import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CortexAgent } from '../../src/cortex-agent.js';
import type { PiAgent, PiModel } from '../../src/cortex-agent.js';
import type { CortexAgentConfig, TrackedSubAgent, SubAgentResult } from '../../src/types.js';
import { wrapModel } from '../../src/model-wrapper.js';

type RegisteredTool = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (...args: any[]) => Promise<unknown>;
};

type TestCortexAgentConstructor = new (
  agent: PiAgent,
  config: CortexAgentConfig,
  tools?: RegisteredTool[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => CortexAgent;

function makeModel(raw: PiModel) {
  return wrapModel(raw, raw.provider, raw.name, raw.contextWindow);
}

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

function createTestCortexAgent(config: CortexAgentConfig): CortexAgent {
  const Ctor = CortexAgent as unknown as TestCortexAgentConstructor;
  return new Ctor(createMockPiAgent(), config, [], {
    enableSubAgentTool: false,
    enableLoadSkillTool: false,
  });
}

function createConfig(workingDirectory: string, extra?: Partial<CortexAgentConfig>): CortexAgentConfig {
  return {
    model: makeModel({
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      contextWindow: 200_000,
    } as PiModel),
    workingDirectory,
    initialBasePrompt: 'Test prompt',
    slots: [],
    ...extra,
  };
}

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-subagent-hooks-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('CortexAgent sessionId (prompt_cache_key plumbing)', () => {
  it('initializes from config and supports get/set/clear', () => {
    withTmpDir((dir) => {
      const agent = createTestCortexAgent(createConfig(dir, { sessionId: 'mind-session' }));
      expect(agent.getSessionId()).toBe('mind-session');

      agent.setSessionId('mind-session-2');
      expect(agent.getSessionId()).toBe('mind-session-2');

      agent.setSessionId(null);
      expect(agent.getSessionId()).toBeNull();
    });
  });

  it('defaults to null when no sessionId is configured', () => {
    withTmpDir((dir) => {
      const agent = createTestCortexAgent(createConfig(dir));
      expect(agent.getSessionId()).toBeNull();
    });
  });
});

describe('CortexAgent.getActiveSubAgents', () => {
  it('returns an empty array when no sub-agents are running', () => {
    withTmpDir((dir) => {
      const agent = createTestCortexAgent(createConfig(dir));
      expect(agent.getActiveSubAgents()).toEqual([]);
    });
  });

  it('maps tracked sub-agents to snapshots including live cost and activity', () => {
    withTmpDir((dir) => {
      const agent = createTestCortexAgent(createConfig(dir));
      const manager = (agent as unknown as { subAgentManager: { track(e: TrackedSubAgent): boolean } }).subAgentManager;

      const fakeChild = {
        getBudgetGuard: () => ({ getTotalCost: () => 0.42, getTurnCount: () => 3 }),
      };
      const spawnedAt = Date.now();
      const entry: TrackedSubAgent = {
        taskId: 't1',
        agent: fakeChild,
        instructions: 'investigate the failing build',
        background: true,
        spawnedAt,
        completion: Promise.resolve({} as SubAgentResult),
        resolve: () => {},
        toolCount: 2,
        lastToolName: 'Bash',
        lastToolSummary: 'npm test',
        lastToolStartedAt: spawnedAt,
        pendingPermission: null,
      };
      expect(manager.track(entry)).toBe(true);

      const snapshots = agent.getActiveSubAgents();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        taskId: 't1',
        instructions: 'investigate the failing build',
        background: true,
        status: 'running',
        toolCount: 2,
        lastToolName: 'Bash',
        lastToolSummary: 'npm test',
        liveCostUsd: 0.42,
        turnsUsed: 3,
      });
    });
  });

  it('reports waiting-for-permission status when a sub-agent is blocked on approval', () => {
    withTmpDir((dir) => {
      const agent = createTestCortexAgent(createConfig(dir));
      const manager = (agent as unknown as { subAgentManager: { track(e: TrackedSubAgent): boolean } }).subAgentManager;

      const entry: TrackedSubAgent = {
        taskId: 't2',
        agent: { getBudgetGuard: () => ({ getTotalCost: () => 0, getTurnCount: () => 0 }) },
        instructions: 'do something requiring approval',
        background: false,
        spawnedAt: Date.now(),
        completion: Promise.resolve({} as SubAgentResult),
        resolve: () => {},
        toolCount: 0,
        lastToolName: null,
        lastToolSummary: null,
        lastToolStartedAt: null,
        pendingPermission: { toolName: 'Bash', args: {} },
      };
      manager.track(entry);

      const [snapshot] = agent.getActiveSubAgents();
      expect(snapshot?.status).toBe('waiting-for-permission');
    });
  });
});
