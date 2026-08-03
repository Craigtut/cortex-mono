/**
 * The pending-ask registry: a facade-queryable collection of permission asks
 * currently blocked on a resolver decision, each carrying a per-ask nonce, a
 * voiced flag, and a mandatory verbatim renderedRequest (tool name plus the
 * actual command/path, truncated but never summarized; review-findings F14).
 * Child asks are mirrored into the parent loop's registry so one query
 * surfaces the whole subtree.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type {
  AgentLoopConfig,
  ToolPermissionRequestContext,
  CortexToolPermissionResult,
} from '../../src/types.js';
import { wrapModel } from '../../src/model-wrapper.js';

type BeforeToolCallHook = (
  ctx: { toolCall: { name: string }; args: unknown },
  signal?: AbortSignal,
) => Promise<{ block: boolean; reason?: string } | undefined>;

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

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

/**
 * Build a real AgentLoop plus the pi beforeToolCall hook wired to it, the
 * way createManagedAgent does in production (the hook registers asks on the
 * loop through cacheBreakpointState).
 */
function buildLoopWithHook(
  resolvePermission: NonNullable<AgentLoopConfig['resolvePermission']>,
  configOverrides?: Partial<AgentLoopConfig>,
): { loop: AgentLoop; hook: BeforeToolCallHook } {
  const cortexConfig: AgentLoopConfig = {
    model: makeModel({
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      contextWindow: 200_000,
    } as PiModel),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test prompt',
    slots: [],
    resolvePermission,
    ...configOverrides,
  };
  const Ctor = AgentLoop as unknown as TestAgentLoopConstructor;
  const loop = new Ctor(createMockPiAgent(), cortexConfig, [], {
    enableSubAgentTool: false,
    enableLoadSkillTool: false,
  });
  const statics = AgentLoop as unknown as {
    buildPiAgentConfig: (params: {
      cortexConfig: AgentLoopConfig;
      cacheBreakpointState: { agentLoop: AgentLoop | null };
    }) => Record<string, unknown>;
  };
  const agentConfig = statics.buildPiAgentConfig({
    cortexConfig,
    cacheBreakpointState: { agentLoop: loop },
  });
  return { loop, hook: agentConfig['beforeToolCall'] as BeforeToolCallHook };
}

describe('pending-ask registry', () => {
  it('lists an ask while its resolver is pending and settles it on answer', async () => {
    let answer!: (value: boolean) => void;
    const resolver = vi.fn(
      () => new Promise<boolean>((resolve) => { answer = resolve; }),
    );
    const { loop, hook } = buildLoopWithHook(resolver, { loopPath: 'reasoner' });

    const pending = hook({ toolCall: { name: 'Bash' }, args: { command: 'rm -rf build' } });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const asks = loop.getPendingAsks();
    expect(asks).toHaveLength(1);
    const ask = asks[0]!;
    expect(ask.askId).toMatch(/^ask-/);
    expect(ask.loopPath).toBe('reasoner');
    expect(ask.toolName).toBe('Bash');
    expect(ask.renderedRequest).toBe('Bash: rm -rf build');
    expect(ask.voiced).toBe(false);
    expect(typeof ask.requestedAt).toBe('number');

    answer(true);
    await pending;
    expect(loop.getPendingAsks()).toHaveLength(0);
  });

  it('delivers the same askId and renderedRequest to the resolver context', async () => {
    const contexts: Array<ToolPermissionRequestContext | undefined> = [];
    let observedAskId: string | undefined;
    const { loop, hook } = buildLoopWithHook(async (_tool, _args, context) => {
      contexts.push(context);
      observedAskId = context?.askId;
      // While pending here, the registry entry must match the context.
      const [ask] = loop.getPendingAsks();
      expect(ask?.askId).toBe(context?.askId);
      expect(ask?.renderedRequest).toBe(context?.renderedRequest);
      return true;
    });

    await hook({ toolCall: { name: 'Write' }, args: { file_path: '/tmp/out.txt' } });

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.renderedRequest).toBe('Write: /tmp/out.txt');
    expect(observedAskId).toMatch(/^ask-/);
  });

  it('truncates a long rendered request without summarizing it', async () => {
    const longCommand = `echo ${'x'.repeat(700)}`;
    let rendered: string | undefined;
    const { hook } = buildLoopWithHook(async (_tool, _args, context) => {
      rendered = context?.renderedRequest;
      return true;
    });

    await hook({ toolCall: { name: 'Bash' }, args: { command: longCommand } });

    expect(rendered).toBeDefined();
    expect(rendered!.endsWith(' [truncated]')).toBe(true);
    // Verbatim prefix: exactly the leading characters of the real request.
    const body = rendered!.slice(0, -' [truncated]'.length);
    expect(`Bash: ${longCommand}`.startsWith(body)).toBe(true);
    expect(body.length).toBe(500);
  });

  it('settles the ask when the run aborts while it is pending', async () => {
    const resolver = vi.fn(() => new Promise<boolean>(() => {}));
    const { loop, hook } = buildLoopWithHook(resolver);
    const controller = new AbortController();

    const pending = hook(
      { toolCall: { name: 'Bash' }, args: { command: 'git push' } },
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(loop.getPendingAsks()).toHaveLength(1);

    controller.abort();
    await pending;

    expect(loop.getPendingAsks()).toHaveLength(0);
  });

  it('markAskVoiced flips the voiced flag on a pending ask and rejects unknown ids', async () => {
    let answer!: (value: boolean) => void;
    const resolver = vi.fn(
      () => new Promise<boolean>((resolve) => { answer = resolve; }),
    );
    const { loop, hook } = buildLoopWithHook(resolver);

    const pending = hook({ toolCall: { name: 'Bash' }, args: { command: 'ls' } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [ask] = loop.getPendingAsks();

    expect(loop.markAskVoiced(ask!.askId)).toBe(true);
    expect(loop.getPendingAsks()[0]?.voiced).toBe(true);
    expect(loop.markAskVoiced('ask-unknown')).toBe(false);

    answer(true);
    await pending;
    // Settled asks cannot be voiced.
    expect(loop.markAskVoiced(ask!.askId)).toBe(false);
  });

  it('mints a fresh nonce per ask, even for identical tool calls', async () => {
    const seen: string[] = [];
    const { hook } = buildLoopWithHook(async (_tool, _args, context) => {
      seen.push(context!.askId!);
      return true;
    });

    await hook({ toolCall: { name: 'Bash' }, args: { command: 'ls' } });
    await hook({ toolCall: { name: 'Bash' }, args: { command: 'ls' } });

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('settles a mirrored child ask when the child run aborts, even if the resolver never answers', async () => {
    const { loop } = buildLoopWithHook(async () => true, { loopPath: 'main' });
    // The consumer's prompt never settles: the user never answers a prompt
    // that was dismissed by the abort.
    const parentResolver = vi.fn(() => new Promise<boolean>(() => {}));
    const wrap = (loop as unknown as {
      wrapChildPermissionResolver: (
        resolver: NonNullable<AgentLoopConfig['resolvePermission']>,
        childTaskId: string,
      ) => NonNullable<AgentLoopConfig['resolvePermission']>;
    }).wrapChildPermissionResolver(parentResolver, 'task-abort');
    const controller = new AbortController();

    // The wrapper registers the mirror synchronously (before its first
    // await), and the abort listener settles it synchronously too, so no
    // waiting is involved in this test.
    void wrap('Bash', { command: 'npm test' }, {
      askId: 'ask-child-abort',
      loopPath: 'main/task-abort',
      renderedRequest: 'Bash: npm test',
      signal: controller.signal,
    });
    expect(loop.getPendingAsks()).toHaveLength(1);

    // The child run aborts: Cortex proceeds with a block without waiting on
    // the resolver, so the registry entry must settle here, not in the
    // wrapper's finally (which waits on the unsettled resolver forever).
    controller.abort();

    expect(loop.getPendingAsks()).toHaveLength(0);
  });

  it('mirrors a child ask into the parent registry while it is pending', async () => {
    const { loop } = buildLoopWithHook(async () => true, { loopPath: 'main' });
    let answer!: (value: CortexToolPermissionResult | boolean) => void;
    const parentResolver = vi.fn(
      () => new Promise<boolean | CortexToolPermissionResult>((resolve) => { answer = resolve; }),
    );
    const wrap = (loop as unknown as {
      wrapChildPermissionResolver: (
        resolver: NonNullable<AgentLoopConfig['resolvePermission']>,
        childTaskId: string,
      ) => NonNullable<AgentLoopConfig['resolvePermission']>;
    }).wrapChildPermissionResolver(parentResolver, 'task-9');

    const pending = wrap('Bash', { command: 'npm test' }, {
      askId: 'ask-child-1',
      loopPath: 'main/task-9',
      renderedRequest: 'Bash: npm test',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const asks = loop.getPendingAsks();
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      askId: 'ask-child-1',
      loopPath: 'main/task-9',
      toolName: 'Bash',
      renderedRequest: 'Bash: npm test',
      voiced: false,
    });

    answer(true);
    await pending;
    expect(loop.getPendingAsks()).toHaveLength(0);
  });
});
