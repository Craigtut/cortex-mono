import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiModel } from '../../src/agent-loop.js';
import type { AgentLoopConfig, CortexToolPermissionResult } from '../../src/types.js';
import { wrapModel } from '../../src/model-wrapper.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BeforeToolCallHook = (
  ctx: { toolCall: { name: string }; args: unknown },
  signal?: AbortSignal,
) => Promise<{ block: boolean; reason?: string } | undefined>;

function makeModel(raw: PiModel) {
  return wrapModel(raw, raw.provider, raw.name, raw.contextWindow);
}

/**
 * Build the pi-agent-core config Cortex hands to the loop and extract the
 * beforeToolCall permission hook, exactly as pi would call it.
 */
function buildBeforeToolCallHook(
  resolvePermission: AgentLoopConfig['resolvePermission'],
  configOverrides?: Partial<AgentLoopConfig>,
): BeforeToolCallHook {
  const cortexConfig: AgentLoopConfig = {
    model: makeModel({
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      contextWindow: 200_000,
    } as PiModel),
    workingDirectory: '/tmp/test-workspace',
    ...(resolvePermission ? { resolvePermission } : {}),
    ...configOverrides,
  };
  const statics = AgentLoop as unknown as {
    buildPiAgentConfig: (params: {
      cortexConfig: AgentLoopConfig;
      cacheBreakpointState: { agentLoop: AgentLoop | null };
    }) => Record<string, unknown>;
  };
  const agentConfig = statics.buildPiAgentConfig({
    cortexConfig,
    cacheBreakpointState: { agentLoop: null },
  });
  return agentConfig['beforeToolCall'] as BeforeToolCallHook;
}

const bashCtx = { toolCall: { name: 'Bash' }, args: { command: 'rm -rf build' } };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('permission resolver abort race (beforeToolCall wrapper)', () => {
  it('returns a block when the run aborts while the ask is pending', async () => {
    // A resolver that never answers: the consumer is "showing a prompt".
    const resolver = vi.fn(() => new Promise<boolean>(() => {}));
    const hook = buildBeforeToolCallHook(resolver);
    const controller = new AbortController();

    const pending = hook(bashCtx, controller.signal);
    controller.abort();

    const result = await pending;
    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toMatch(/aborted/i);
  });

  it('passes the abort signal to the resolver so a consumer UI can dismiss its prompt', async () => {
    const seenContexts: unknown[] = [];
    const resolver = vi.fn(async (_tool: string, _args: unknown, context?: { signal?: AbortSignal }) => {
      seenContexts.push(context);
      return true;
    });
    const hook = buildBeforeToolCallHook(resolver);
    const controller = new AbortController();

    await hook(bashCtx, controller.signal);

    expect(seenContexts).toHaveLength(1);
    expect((seenContexts[0] as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });

  it('blocks immediately without consulting the resolver when already aborted', async () => {
    const resolver = vi.fn(async () => true);
    const hook = buildBeforeToolCallHook(resolver);
    const controller = new AbortController();
    controller.abort();

    const result = await hook(bashCtx, controller.signal);

    expect(result).toMatchObject({ block: true });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('honors an allow that resolves before any abort', async () => {
    const resolver = vi.fn(async () => true);
    const hook = buildBeforeToolCallHook(resolver);
    const controller = new AbortController();

    const result = await hook(bashCtx, controller.signal);
    expect(result).toBeUndefined();
  });

  it('honors a block decision that resolves before any abort', async () => {
    const resolver = vi.fn(async (): Promise<CortexToolPermissionResult> => ({
      decision: 'block',
      reason: 'not allowed',
    }));
    const hook = buildBeforeToolCallHook(resolver);
    const controller = new AbortController();

    const result = await hook(bashCtx, controller.signal);
    expect(result).toMatchObject({ block: true, reason: 'not allowed' });
  });

  it('propagates a resolver rejection unchanged', async () => {
    const resolver = vi.fn(async () => {
      throw new Error('resolver exploded');
    });
    const hook = buildBeforeToolCallHook(resolver);
    const controller = new AbortController();

    await expect(hook(bashCtx, controller.signal)).rejects.toThrow('resolver exploded');
  });

  it('resolves normally when pi passes no signal', async () => {
    const resolver = vi.fn(async () => true);
    const hook = buildBeforeToolCallHook(resolver);

    const result = await hook(bashCtx, undefined);
    expect(result).toBeUndefined();
  });

  it('ignores a late resolver answer after the abort settled the race', async () => {
    let resolveLate!: (v: boolean) => void;
    const resolver = vi.fn(() => new Promise<boolean>((resolve) => { resolveLate = resolve; }));
    const hook = buildBeforeToolCallHook(resolver);
    const controller = new AbortController();

    const pending = hook(bashCtx, controller.signal);
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ block: true });

    // The consumer answering afterwards changes nothing and throws nothing.
    resolveLate(true);
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('permission ask identity (askId and loopPath)', () => {
  type SeenContext = { signal?: AbortSignal; askId?: string; loopPath?: string };

  it('passes a per-ask nonce and the default loop path to the resolver', async () => {
    const seenContexts: SeenContext[] = [];
    const resolver = vi.fn(async (_tool: string, _args: unknown, context?: SeenContext) => {
      if (context) seenContexts.push(context);
      return true;
    });
    const hook = buildBeforeToolCallHook(resolver);

    await hook(bashCtx, new AbortController().signal);

    expect(seenContexts).toHaveLength(1);
    expect(seenContexts[0]!.askId).toMatch(/^ask-/);
    expect(seenContexts[0]!.loopPath).toBe('main');
  });

  it('passes the configured loopPath to the resolver', async () => {
    const seenContexts: SeenContext[] = [];
    const resolver = vi.fn(async (_tool: string, _args: unknown, context?: SeenContext) => {
      if (context) seenContexts.push(context);
      return true;
    });
    const hook = buildBeforeToolCallHook(resolver, { loopPath: 'reasoner' });

    await hook(bashCtx, new AbortController().signal);

    expect(seenContexts[0]!.loopPath).toBe('reasoner');
  });

  it('never reuses an askId across asks, even for identical calls', async () => {
    const askIds: string[] = [];
    const resolver = vi.fn(async (_tool: string, _args: unknown, context?: SeenContext) => {
      if (context?.askId) askIds.push(context.askId);
      return true;
    });
    const hook = buildBeforeToolCallHook(resolver);

    await hook(bashCtx, new AbortController().signal);
    await hook(bashCtx, new AbortController().signal);

    expect(askIds).toHaveLength(2);
    expect(askIds[0]).not.toBe(askIds[1]);
  });

  it('carries identity even when pi passes no signal', async () => {
    const seenContexts: SeenContext[] = [];
    const resolver = vi.fn(async (_tool: string, _args: unknown, context?: SeenContext) => {
      if (context) seenContexts.push(context);
      return true;
    });
    const hook = buildBeforeToolCallHook(resolver);

    await hook(bashCtx, undefined);

    expect(seenContexts[0]!.askId).toMatch(/^ask-/);
    expect(seenContexts[0]!.loopPath).toBe('main');
    expect(seenContexts[0]!.signal).toBeUndefined();
  });
});
