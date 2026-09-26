/**
 * TEMPORARY contract for AgentLoop's test-compat block.
 *
 * Tests reach loop internals through casts, which the typecheck never
 * sees: a renamed private fails only at runtime, and a WRITE to a renamed
 * field silently creates a new property, so the test passes vacuously.
 * While state moves out of AgentLoop into its modules, the old names stay
 * as forwarding accessors; this file pins every one of them (and that the
 * written ones really write through). Deleted with the compat block once
 * the tests move onto the modules.
 */
import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { AgentLoopConfig } from '../../src/types.js';
import { wrapModel } from '../../src/model-wrapper.js';

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

function createLoop(): AgentLoop {
  const Ctor = AgentLoop as unknown as TestAgentLoopConstructor;
  const pi = {
    state: { messages: [], systemPrompt: '', tools: [] },
    subscribe() { return () => {}; },
    async prompt() { return { content: 'ok' }; },
    abort() {},
    async waitForIdle() {},
    reset() {},
    steer() {},
  } as unknown as PiAgent;
  const raw = { provider: 'anthropic', name: 'claude-sonnet-4-20250514', contextWindow: 200_000 } as PiModel;
  return new Ctor(pi, {
    model: wrapModel(raw, raw.provider, raw.name, raw.contextWindow),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test prompt',
    compaction: { strategy: 'classic' },
  });
}

/** How each compat name must be reachable on an instance. */
type Kind = 'getter' | 'accessor' | 'method';

const COMPAT: Record<string, Kind> = {
  trackedPids: 'getter',
  compactionManager: 'getter',
  subAgentManager: 'getter',
  _abortEpoch: 'accessor',
  _prePromptMessageCount: 'accessor',
  _isPrompting: 'getter',
  fireRetryScheduled: 'method',
  fireRetrySucceeded: 'method',
  fireRetryExhausted: 'method',
  pendingWakeDeliveries: 'getter',
  pendingBackgroundResults: 'getter',
  headlineProvider: 'getter',
  _cacheBreakpointIndices: 'accessor',
  deliverOrQueueBackgroundCompletion: 'method',
  schedulePendingResultDelivery: 'method',
  drainPendingBackgroundResults: 'method',
  requeueOrDeadLetter: 'method',
  batchRecoveredAfterRequeue: 'method',
  unwindFailedDelivery: 'method',
  registeredTools: 'getter',
  toolRuntime: 'getter',
  buildChildToolSet: 'method',
  buildBackgroundTaskState: 'method',
  registerPendingAsk: 'method',
  settlePendingAsk: 'method',
  wrapChildPermissionResolver: 'method',
  createChildAgent: 'method',
  spawnForegroundSubAgentInternal: 'method',
  spawnBackgroundSubAgentInternal: 'method',
};

function descriptorOf(name: string): PropertyDescriptor | undefined {
  return Object.getOwnPropertyDescriptor(AgentLoop.prototype, name);
}

describe('AgentLoop test-compat contract', () => {
  for (const [name, kind] of Object.entries(COMPAT)) {
    it(`keeps ${name} reachable as a ${kind}`, () => {
      const descriptor = descriptorOf(name);
      expect(descriptor, `${name} missing from AgentLoop.prototype`).toBeDefined();
      if (kind === 'method') {
        expect(typeof descriptor!.value).toBe('function');
      } else {
        expect(typeof descriptor!.get).toBe('function');
        if (kind === 'accessor') expect(typeof descriptor!.set).toBe('function');
        // Reading must not throw on a live instance.
        const loop = createLoop() as unknown as Record<string, unknown>;
        expect(() => loop[name]).not.toThrow();
      }
    });
  }

  it('registeredTools is the registry\'s live list', () => {
    const loop = createLoop();
    const internals = loop as unknown as { registeredTools: Array<{ name: string }> };
    const before = internals.registeredTools;
    loop.addConsumerTool({
      name: 'contract_probe',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    } as never);
    expect(internals.registeredTools).toBe(before);
    expect(before.some((tool) => tool.name === 'contract_probe')).toBe(true);
  });

  it('_abortEpoch writes through to the epoch parked deliveries are stamped with', async () => {
    const loop = createLoop();
    const internals = loop as unknown as {
      _abortEpoch: number;
      pendingWakeDeliveries: Array<{ abortEpoch?: number }>;
    };
    internals._abortEpoch = 7;
    expect(internals._abortEpoch).toBe(7);
    // Hold the gate so the delivery parks rather than prompting.
    let release!: () => void;
    void (loop as unknown as { parts: { gate: { enqueue(task: () => Promise<void>): Promise<void> } } })
      .parts.gate.enqueue(() => new Promise<void>((resolve) => { release = resolve; }));
    loop.deliver('parked');
    expect(internals.pendingWakeDeliveries[0]!.abortEpoch).toBe(7);
    internals.pendingWakeDeliveries.splice(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
  });

  it('_prePromptMessageCount writes through to the history boundary', () => {
    const loop = createLoop();
    (loop as unknown as { _prePromptMessageCount: number })._prePromptMessageCount = 5;
    expect(loop.prePromptMessageCount).toBe(5);
  });

  it('_cacheBreakpointIndices writes through to what onPayload reads', () => {
    const loop = createLoop();
    const internals = loop as unknown as {
      _cacheBreakpointIndices: unknown;
      piHookHost(): { cacheBreakpointIndices(): unknown };
    };
    const indices = { bp2: 1, bp3: 2 };
    internals._cacheBreakpointIndices = indices;
    expect(internals.piHookHost().cacheBreakpointIndices()).toBe(indices);
  });

  it('trackedPids reads the process tracker', () => {
    const loop = createLoop() as unknown as { trackedPids: ReadonlySet<number> };
    expect(loop.trackedPids).toBeInstanceOf(Set);
  });
});
