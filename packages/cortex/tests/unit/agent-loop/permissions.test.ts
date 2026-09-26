import { describe, it, expect, vi } from 'vitest';
import {
  ABORTED_PERMISSION_REASON,
  createBeforeToolCall,
  mirrorChildPermissionResolver,
  PendingAskRegistry,
} from '../../../src/agent-loop/permissions.js';
import type { AgentLoopConfig } from '../../../src/types.js';

const baseConfig = { workingDirectory: '/tmp/w', loopPath: 'reasoner' } as unknown as AgentLoopConfig;

function hostWith(asks: PendingAskRegistry, exempt: string[] = []) {
  return () => ({ asks, isToolPermissionExempt: (name: string) => exempt.includes(name) });
}

describe('PendingAskRegistry', () => {
  it('lists copies, marks voiced, and wakes settlement waiters', async () => {
    const asks = new PendingAskRegistry();
    await asks.waitForSettlement(); // nothing pending: immediate
    asks.register({ askId: 'a', loopPath: 'main', toolName: 'Bash', renderedRequest: 'Bash: ls', requestedAt: 1, voiced: false });
    const listed = asks.list();
    listed[0]!.voiced = true;
    expect(asks.list()[0]!.voiced).toBe(false);
    expect(asks.markVoiced('a')).toBe(true);
    expect(asks.markVoiced('missing')).toBe(false);
    const settled = asks.waitForSettlement();
    asks.settle('a');
    await settled;
    expect(asks.list()).toEqual([]);
  });
});

describe('createBeforeToolCall', () => {
  it('is absent without a resolver or sandbox check', () => {
    expect(createBeforeToolCall(baseConfig, () => null)).toBeUndefined();
  });

  it('registers the ask while the resolver is pending and settles it on answer', async () => {
    let answer!: (allow: boolean) => void;
    const resolver = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const asks = new PendingAskRegistry();
    const gate = createBeforeToolCall({ ...baseConfig, resolvePermission: resolver }, hostWith(asks))!;
    const pending = gate({ toolCall: { name: 'Bash' }, args: { command: 'rm -rf build' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asks.list()).toMatchObject([{ loopPath: 'reasoner', toolName: 'Bash', renderedRequest: 'Bash: rm -rf build' }]);
    answer(false);
    expect(await pending).toEqual({ block: true, reason: 'Tool "Bash" is blocked or disabled.' });
    expect(asks.list()).toEqual([]);
  });

  it('skips the resolver for exempt tools and blocks an already-aborted run', async () => {
    const resolver = vi.fn(async () => true);
    const gate = createBeforeToolCall(
      { ...baseConfig, resolvePermission: resolver },
      hostWith(new PendingAskRegistry(), ['Deliver']),
    )!;
    expect(await gate({ toolCall: { name: 'Deliver' }, args: {} })).toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    expect(await gate({ toolCall: { name: 'Bash' }, args: {} }, controller.signal))
      .toEqual({ block: true, reason: ABORTED_PERMISSION_REASON });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('blocks with the aborted reason when the run aborts mid-ask', async () => {
    const asks = new PendingAskRegistry();
    const gate = createBeforeToolCall(
      { ...baseConfig, resolvePermission: () => new Promise<boolean>(() => {}) },
      hostWith(asks),
    )!;
    const controller = new AbortController();
    const pending = gate({ toolCall: { name: 'Write' }, args: { file_path: '/x' } }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect(await pending).toEqual({ block: true, reason: ABORTED_PERMISSION_REASON });
    expect(asks.list()).toEqual([]);
  });
});

describe('mirrorChildPermissionResolver', () => {
  it('mirrors the child ask and marks the tracked entry until it settles', async () => {
    const asks = new PendingAskRegistry();
    const entry = { pendingPermission: null as unknown };
    let answer!: (allow: boolean) => void;
    const mirrored = mirrorChildPermissionResolver(
      () => new Promise<boolean>((resolve) => { answer = resolve; }),
      {
        asks,
        subAgents: { get: () => entry as never },
        childTaskId: 't1',
        childLoopPath: 'main/t1',
      },
    );
    const pending = mirrored('Bash', { command: 'ls' }, { askId: 'ask-1', loopPath: 'main/t1', renderedRequest: 'Bash: ls' });
    expect(entry.pendingPermission).toEqual({ toolName: 'Bash', args: { command: 'ls' } });
    expect(asks.list().map((ask) => ask.askId)).toEqual(['ask-1']);
    answer(true);
    expect(await pending).toBe(true);
    expect(entry.pendingPermission).toBeNull();
    expect(asks.list()).toEqual([]);
  });
});
