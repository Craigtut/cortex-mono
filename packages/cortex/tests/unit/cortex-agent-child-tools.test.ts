import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CortexAgent } from '../../src/cortex-agent.js';
import type { PiAgent, PiModel } from '../../src/cortex-agent.js';
import type { CortexAgentConfig } from '../../src/types.js';
import { wrapModel } from '../../src/model-wrapper.js';
import { createBashTool } from '../../src/tools/bash/index.js';
import { createReadTool } from '../../src/tools/read.js';
import { createWriteTool } from '../../src/tools/write.js';
import { CwdTracker } from '../../src/tools/shared/cwd-tracker.js';
import { ReadRegistry } from '../../src/tools/shared/read-registry.js';

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
  options?: {
    enableSubAgentTool?: boolean;
    enableLoadSkillTool?: boolean;
  },
) => CortexAgent;

function makeModel(raw: PiModel) {
  return wrapModel(raw, raw.provider, raw.name, raw.contextWindow);
}

function createMockPiAgent(): PiAgent {
  return {
    state: {
      messages: [],
      systemPrompt: '',
      tools: [],
    },
    subscribe() {
      return () => {};
    },
    async prompt() {
      return { content: 'ok' };
    },
    abort() {},
    async waitForIdle() {},
    reset() {
      this.state.messages = [];
    },
    steer() {},
  };
}

function createTestCortexAgent(
  agent: PiAgent,
  config: CortexAgentConfig,
  tools?: RegisteredTool[],
  options?: {
    enableSubAgentTool?: boolean;
    enableLoadSkillTool?: boolean;
  },
): CortexAgent {
  const CortexAgentCtor = CortexAgent as unknown as TestCortexAgentConstructor;
  return new CortexAgentCtor(agent, config, tools, options);
}

function createConfig(workingDirectory: string): CortexAgentConfig {
  return {
    model: makeModel({
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      contextWindow: 200_000,
    } as PiModel),
    workingDirectory,
    initialBasePrompt: 'Test prompt',
    slots: [],
  };
}

describe('CortexAgent child tool hardening', () => {
  it('clones runtime-aware built-ins for child agents instead of reusing parent state', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-child-tools-'));
    const filePath = path.join(tmpDir, 'existing.txt');
    const subdir = path.join(tmpDir, 'subdir');
    fs.mkdirSync(subdir);
    fs.writeFileSync(filePath, 'parent readable\n');

    try {
      const parentTools: RegisteredTool[] = [
        createBashTool({ cwdTracker: new CwdTracker(tmpDir) }) as RegisteredTool,
        createReadTool({ readRegistry: new ReadRegistry() }) as RegisteredTool,
        createWriteTool({ readRegistry: new ReadRegistry() }) as RegisteredTool,
      ];

      const parent = createTestCortexAgent(
        createMockPiAgent(),
        createConfig(tmpDir),
        parentTools,
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      );

      const childTools = (parent as any).buildChildToolSet() as RegisteredTool[];
      const child = createTestCortexAgent(
        createMockPiAgent(),
        createConfig(tmpDir),
        childTools,
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      );

      const parentBash = (parent as any).registeredTools.find((tool: RegisteredTool) => tool.name === 'Bash') as RegisteredTool;
      const childBash = (child as any).registeredTools.find((tool: RegisteredTool) => tool.name === 'Bash') as RegisteredTool;
      const parentRead = (parent as any).registeredTools.find((tool: RegisteredTool) => tool.name === 'Read') as RegisteredTool;
      const childWrite = (child as any).registeredTools.find((tool: RegisteredTool) => tool.name === 'Write') as RegisteredTool;

      await parentBash.execute({ command: `cd ${JSON.stringify(subdir)} && pwd` });
      const childPwd = await childBash.execute({ command: 'pwd' }) as { details: { finalCwd: string } };

      expect(fs.realpathSync(childPwd.details.finalCwd)).toBe(fs.realpathSync(tmpDir));

      await parentRead.execute({ file_path: filePath });
      const childWriteResult = await childWrite.execute({
        file_path: filePath,
        content: 'child write attempt\n',
      }) as { content: Array<{ type: string; text: string }> };

      expect(childWriteResult.content[0]!.text).toContain('You must Read this file before overwriting it.');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('includes live MCP tools in the child tool inventory while excluding SubAgent and load_skill', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-child-mcp-'));

    try {
      const parent = createTestCortexAgent(
        createMockPiAgent(),
        createConfig(tmpDir),
        [],
      );

      const mcpTool: RegisteredTool = {
        name: 'domain__search',
        description: 'Search MCP tool',
        parameters: {},
        execute: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} })),
      };

      vi.spyOn(parent.getMcpClientManager(), 'getTools').mockReturnValue([mcpTool]);

      const childTools = (parent as any).buildChildToolSet() as RegisteredTool[];

      expect(childTools.map(tool => tool.name)).toContain('domain__search');
      expect(childTools.map(tool => tool.name)).not.toContain('SubAgent');
      expect(childTools.map(tool => tool.name)).not.toContain('load_skill');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
