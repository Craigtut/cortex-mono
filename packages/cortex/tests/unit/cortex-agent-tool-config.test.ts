import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CortexAgent } from '../../src/cortex-agent.js';
import type { PiAgent, PiModel } from '../../src/cortex-agent.js';
import type { CortexAgentConfig } from '../../src/types.js';
import { wrapModel } from '../../src/model-wrapper.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TestCortexAgentConstructor = new (
  agent: PiAgent,
  config: CortexAgentConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => CortexAgent;

interface ExecutableTool {
  name: string;
  execute: (args: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

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

function createTestCortexAgent(
  workingDirectory: string,
  config?: Partial<CortexAgentConfig>,
): CortexAgent {
  const Ctor = CortexAgent as unknown as TestCortexAgentConstructor;
  return new Ctor(
    createMockPiAgent(),
    {
      model: makeModel({
        provider: 'anthropic',
        name: 'claude-sonnet-4-20250514',
        contextWindow: 200_000,
      } as PiModel),
      workingDirectory,
      initialBasePrompt: 'Test prompt',
      slots: [],
      ...config,
    },
    [],
    { enableSubAgentTool: false, enableLoadSkillTool: false },
  );
}

function getRegisteredTool(agent: CortexAgent, name: string): ExecutableTool {
  const tools = (agent as unknown as { registeredTools: ExecutableTool[] }).registeredTools;
  const tool = tools.find(t => t.name === name);
  expect(tool, `built-in tool ${name} should be registered`).toBeDefined();
  return tool!;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CortexAgent tool config threading', () => {
  let tmpDir: string | null = null;
  let agent: CortexAgent | null = null;

  afterEach(async () => {
    await agent?.destroy();
    agent = null;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  function makeTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-tool-config-'));
    return tmpDir;
  }

  it('threads webFetch.maxPerLoop to the WebFetch tool', async () => {
    agent = createTestCortexAgent(makeTmpDir(), { webFetch: { maxPerLoop: 0 } });
    const webFetch = getRegisteredTool(agent, 'WebFetch');

    // A zero budget rate-limits before any network I/O.
    const result = await webFetch.execute({
      url: 'https://example.com/',
      prompt: 'what is this page about',
    });

    expect(textOf(result)).toContain('rate limit reached (0 per loop)');
  });

  it('threads bash.autoYieldThreshold to the Bash tool', async () => {
    agent = createTestCortexAgent(makeTmpDir(), { bash: { autoYieldThreshold: 150 } });
    const bash = getRegisteredTool(agent, 'Bash');

    const result = await bash.execute({ command: 'sleep 1' });

    expect(textOf(result)).toContain('auto-yielded after 150ms');
  });

  it('threads bash.shellPath to the Bash tool', async () => {
    const dir = makeTmpDir();
    // A wrapper shell that marks its own invocation, then defers to /bin/sh.
    const shellPath = path.join(dir, 'marker-shell.sh');
    fs.writeFileSync(shellPath, '#!/bin/sh\necho MARKER_FROM_CUSTOM_SHELL\nexec /bin/sh "$@"\n');
    fs.chmodSync(shellPath, 0o755);

    agent = createTestCortexAgent(dir, { bash: { shellPath } });
    const bash = getRegisteredTool(agent, 'Bash');

    const result = await bash.execute({ command: 'echo hello' });

    const text = textOf(result);
    expect(text).toContain('MARKER_FROM_CUSTOM_SHELL');
    expect(text).toContain('hello');
  });

  it('keeps default behavior when neither bash nor webFetch config is set', async () => {
    agent = createTestCortexAgent(makeTmpDir());
    const bash = getRegisteredTool(agent, 'Bash');

    const result = await bash.execute({ command: 'echo fast' });

    const text = textOf(result);
    expect(text).toContain('fast');
    expect(text).not.toContain('auto-yielded');
  });

  it('inherits bash and webFetch tuning in the child agent config', async () => {
    agent = createTestCortexAgent(makeTmpDir(), {
      bash: { autoYieldThreshold: 250, shellPath: '/bin/sh' },
      webFetch: { maxPerLoop: 3 },
    });

    // Capture the config createChildAgent hands to the child factory.
    const statics = CortexAgent as unknown as {
      createManagedAgent: (params: { cortexConfig: CortexAgentConfig }) => Promise<unknown>;
    };
    const original = statics.createManagedAgent;
    let captured: CortexAgentConfig | null = null;
    statics.createManagedAgent = async (params) => {
      captured = params.cortexConfig;
      return { setCacheRetention: () => {} };
    };
    try {
      await (agent as unknown as {
        createChildAgent: (params: { taskId: string; instructions: string }) => Promise<unknown>;
      }).createChildAgent({ taskId: 't1', instructions: 'child work' });
    } finally {
      statics.createManagedAgent = original;
    }

    expect(captured).not.toBeNull();
    expect(captured!.bash).toEqual({ autoYieldThreshold: 250, shellPath: '/bin/sh' });
    expect(captured!.webFetch).toEqual({ maxPerLoop: 3 });
  });
});
