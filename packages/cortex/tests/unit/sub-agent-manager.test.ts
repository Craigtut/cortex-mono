import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SubAgentManager } from '../../src/sub-agent-manager.js';
import type { SubAgentResult, TrackedSubAgent } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTrackedEntry(overrides?: Partial<TrackedSubAgent>): TrackedSubAgent {
  let resolveCompletion!: (result: SubAgentResult) => void;
  const completion = new Promise<SubAgentResult>((resolve) => {
    resolveCompletion = resolve;
  });

  return {
    taskId: overrides?.taskId ?? 'task-1',
    agent: overrides?.agent ?? {},
    instructions: overrides?.instructions ?? 'Test instructions',
    background: overrides?.background ?? false,
    spawnedAt: overrides?.spawnedAt ?? Date.now(),
    completion: overrides?.completion ?? completion,
    resolve: overrides?.resolve ?? resolveCompletion,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubAgentManager', () => {
  let manager: SubAgentManager;

  beforeEach(() => {
    manager = new SubAgentManager({ maxConcurrent: 3 });
  });

  describe('canSpawn', () => {
    it('returns true when under the limit', () => {
      expect(manager.canSpawn()).toBe(true);
    });

    it('returns false when at the limit', () => {
      manager.track(createTrackedEntry({ taskId: 'a' }));
      manager.track(createTrackedEntry({ taskId: 'b' }));
      manager.track(createTrackedEntry({ taskId: 'c' }));
      expect(manager.canSpawn()).toBe(false);
    });

    it('returns true again after a sub-agent completes', () => {
      manager.track(createTrackedEntry({ taskId: 'a' }));
      manager.track(createTrackedEntry({ taskId: 'b' }));
      manager.track(createTrackedEntry({ taskId: 'c' }));
      expect(manager.canSpawn()).toBe(false);

      manager.complete('b', {
        output: 'done',
        status: 'completed',
        usage: { turns: 1, cost: 0.01, durationMs: 100 },
      });
      expect(manager.canSpawn()).toBe(true);
    });
  });

  describe('track', () => {
    it('adds a sub-agent entry and increments activeCount', () => {
      expect(manager.activeCount).toBe(0);
      const tracked = manager.track(createTrackedEntry());
      expect(tracked).toBe(true);
      expect(manager.activeCount).toBe(1);
    });

    it('returns false when the concurrency limit is reached', () => {
      manager.track(createTrackedEntry({ taskId: 'a' }));
      manager.track(createTrackedEntry({ taskId: 'b' }));
      manager.track(createTrackedEntry({ taskId: 'c' }));
      const result = manager.track(createTrackedEntry({ taskId: 'd' }));
      expect(result).toBe(false);
      expect(manager.activeCount).toBe(3);
    });
  });

  describe('complete', () => {
    it('removes the entry from tracking', () => {
      manager.track(createTrackedEntry({ taskId: 'task-1' }));
      expect(manager.activeCount).toBe(1);

      manager.complete('task-1', {
        output: 'result',
        status: 'completed',
        usage: { turns: 2, cost: 0.02, durationMs: 500 },
      });

      expect(manager.activeCount).toBe(0);
      expect(manager.get('task-1')).toBeUndefined();
    });

    it('resolves the completion promise', async () => {
      const entry = createTrackedEntry({ taskId: 'task-1' });
      manager.track(entry);

      const result: SubAgentResult = {
        output: 'test result',
        status: 'completed',
        usage: { turns: 3, cost: 0.05, durationMs: 1000 },
      };

      manager.complete('task-1', result);
      const completed = await entry.completion;
      expect(completed.output).toBe('test result');
      expect(completed.status).toBe('completed');
    });

    it('fires the onCompleted hook', () => {
      const onCompleted = vi.fn();
      manager.setHooks({ onCompleted });

      manager.track(createTrackedEntry({ taskId: 'task-1' }));
      manager.complete('task-1', {
        output: 'done',
        status: 'completed',
        usage: { turns: 1, cost: 0, durationMs: 50 },
      });

      expect(onCompleted).toHaveBeenCalledWith(
        'task-1',
        'done',
        'completed',
        { turns: 1, cost: 0, durationMs: 50 },
      );
    });
  });

  describe('fail', () => {
    it('removes the entry and resolves as failed', async () => {
      const entry = createTrackedEntry({ taskId: 'task-1' });
      manager.track(entry);

      manager.fail('task-1', 'something went wrong');

      expect(manager.activeCount).toBe(0);
      const result = await entry.completion;
      expect(result.status).toBe('failed');
      expect(result.output).toBe('');
    });

    it('fires the onFailed hook', () => {
      const onFailed = vi.fn();
      manager.setHooks({ onFailed });

      manager.track(createTrackedEntry({ taskId: 'task-1' }));
      manager.fail('task-1', 'oops');

      expect(onFailed).toHaveBeenCalledWith('task-1', 'oops');
    });
  });

  describe('lifecycle hooks', () => {
    it('fires onSpawned when track is called', () => {
      const onSpawned = vi.fn();
      manager.setHooks({ onSpawned });

      manager.track(createTrackedEntry({ taskId: 'task-1', instructions: 'do stuff' }));
      expect(onSpawned).toHaveBeenCalledWith('task-1', 'do stuff', false);
    });

    it('swallows errors in hooks', () => {
      manager.setHooks({
        onSpawned: () => { throw new Error('hook error'); },
      });

      // Should not throw
      expect(() => {
        manager.track(createTrackedEntry());
      }).not.toThrow();
    });
  });

  describe('getBackgroundCompletions', () => {
    it('returns only background sub-agents', () => {
      manager.track(createTrackedEntry({ taskId: 'fg', background: false }));
      manager.track(createTrackedEntry({ taskId: 'bg1', background: true }));
      manager.track(createTrackedEntry({ taskId: 'bg2', background: true }));

      const completions = manager.getBackgroundCompletions();
      expect(completions).toHaveLength(2);
      expect(completions.map(c => c.taskId)).toEqual(['bg1', 'bg2']);
    });
  });

  describe('cancel', () => {
    it('untracks the entry, calls abortFn, and resolves the completion as cancelled', async () => {
      const abortFn = vi.fn().mockResolvedValue(undefined);
      const childAgent = { fake: true };
      const entry = createTrackedEntry({ taskId: 'task-1', agent: childAgent });
      manager.track(entry);

      const cancelled = await manager.cancel('task-1', abortFn);

      expect(cancelled).toBe(true);
      expect(abortFn).toHaveBeenCalledWith(childAgent);
      expect(manager.get('task-1')).toBeUndefined();
      expect(manager.activeCount).toBe(0);

      const result = await entry.completion;
      expect(result.status).toBe('cancelled');
    });

    it('returns false for an unknown task ID', async () => {
      const abortFn = vi.fn();
      const cancelled = await manager.cancel('nope', abortFn);
      expect(cancelled).toBe(false);
      expect(abortFn).not.toHaveBeenCalled();
    });

    it('marks the task cancelled so late completions are discardable', async () => {
      manager.track(createTrackedEntry({ taskId: 'task-1' }));
      expect(manager.isCancelled('task-1')).toBe(false);

      await manager.cancel('task-1', vi.fn().mockResolvedValue(undefined));
      expect(manager.isCancelled('task-1')).toBe(true);
    });

    it('evicts the oldest cancelled task ID past the 200-entry cap', async () => {
      // The cancelled-ID set is bounded so a long-lived agent cannot leak
      // memory; eviction is oldest-first, so only the most recent 200
      // cancels remain discardable.
      const abortFn = vi.fn().mockResolvedValue(undefined);
      for (let i = 0; i <= 200; i++) {
        manager.track(createTrackedEntry({ taskId: `task-${i}` }));
        await manager.cancel(`task-${i}`, abortFn);
      }

      // 201 cancels: the very first ID was evicted, the rest remain.
      expect(manager.isCancelled('task-0')).toBe(false);
      expect(manager.isCancelled('task-1')).toBe(true);
      expect(manager.isCancelled('task-200')).toBe(true);
    });

    it('marks the task cancelled before running the async teardown', async () => {
      manager.track(createTrackedEntry({ taskId: 'task-1' }));

      let cancelledDuringTeardown: boolean | null = null;
      const abortFn = vi.fn().mockImplementation(async () => {
        cancelledDuringTeardown = manager.isCancelled('task-1');
      });

      await manager.cancel('task-1', abortFn);
      expect(cancelledDuringTeardown).toBe(true);
    });

    it('suppresses onCompleted for a completion arriving after the cancel', async () => {
      const onCompleted = vi.fn();
      manager.setHooks({ onCompleted });
      manager.track(createTrackedEntry({ taskId: 'task-1' }));

      await manager.cancel('task-1', vi.fn().mockResolvedValue(undefined));
      manager.complete('task-1', {
        output: 'late result',
        status: 'completed',
        usage: { turns: 1, cost: 0, durationMs: 100 },
      });

      expect(onCompleted).not.toHaveBeenCalled();
    });

    it('fires onFailed with Cancelled', async () => {
      const onFailed = vi.fn();
      manager.setHooks({ onFailed });
      manager.track(createTrackedEntry({ taskId: 'task-1' }));

      await manager.cancel('task-1', vi.fn().mockResolvedValue(undefined));
      expect(onFailed).toHaveBeenCalledWith('task-1', 'Cancelled');
    });

    it('still cancels when abortFn throws', async () => {
      const entry = createTrackedEntry({ taskId: 'task-1' });
      manager.track(entry);

      const cancelled = await manager.cancel('task-1', vi.fn().mockRejectedValue(new Error('boom')));

      expect(cancelled).toBe(true);
      expect(manager.isCancelled('task-1')).toBe(true);
      const result = await entry.completion;
      expect(result.status).toBe('cancelled');
    });
  });

  describe('steer', () => {
    it('queues the message into the child in-flight run and returns steered', () => {
      const steer = vi.fn();
      manager.track(createTrackedEntry({
        taskId: 'task-1',
        agent: { steer, isPrompting: true, isLoopActive: true } as never,
      }));

      const outcome = manager.steer('task-1', 'focus on Europe');

      expect(outcome).toBe('steered');
      expect(steer).toHaveBeenCalledWith('focus on Europe');
    });

    it('returns null for an unknown task ID', () => {
      expect(manager.steer('nope', 'message')).toBeNull();
    });

    it('returns null in the settle window instead of starting a doomed turn', () => {
      // The child's run has settled but complete() has not untracked it
      // yet: a redirect accepted here is never polled again and dies with
      // the child, while the caller is told it landed.
      const steer = vi.fn();
      manager.track(createTrackedEntry({
        taskId: 'task-1',
        agent: { steer, isPrompting: false, isLoopActive: false } as never,
      }));

      expect(manager.steer('task-1', 'message')).toBeNull();
      expect(steer).not.toHaveBeenCalled();
    });

    it('returns null in the end-of-cycle drain window (gate held, no run in flight)', () => {
      // After the child's run ended its gate stays held through the
      // end-of-cycle drain. Steering polls never happen again in that
      // window, so an accepted redirect would be silently dropped when the
      // parent's continuation destroys the child. A gate-depth check
      // (isLoopActive) passes here and accepts the doomed redirect; only
      // the run-in-flight check is honest.
      const steer = vi.fn();
      const deliver = vi.fn(() => ({ outcome: 'steered' as const }));
      manager.track(createTrackedEntry({
        taskId: 'task-1',
        agent: { steer, deliver, isPrompting: false, isLoopActive: true } as never,
      }));

      expect(manager.steer('task-1', 'message')).toBeNull();
      expect(steer).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
    });

    it('returns null when the child is already tearing down (steer throws)', () => {
      const steer = vi.fn(() => {
        throw new Error('Agent is being destroyed');
      });
      manager.track(createTrackedEntry({
        taskId: 'task-1',
        agent: { steer, isPrompting: true, isLoopActive: true } as never,
      }));

      expect(manager.steer('task-1', 'message')).toBeNull();
    });

    it('returns null after the task was cancelled', async () => {
      const steer = vi.fn();
      manager.track(createTrackedEntry({
        taskId: 'task-1',
        agent: { steer, isPrompting: true, isLoopActive: true } as never,
      }));
      await manager.cancel('task-1', vi.fn().mockResolvedValue(undefined));

      expect(manager.steer('task-1', 'message')).toBeNull();
      expect(steer).not.toHaveBeenCalled();
    });
  });

  describe('cancelAll', () => {
    it('marks every task cancelled', async () => {
      manager.track(createTrackedEntry({ taskId: 'a' }));
      manager.track(createTrackedEntry({ taskId: 'b' }));

      await manager.cancelAll(vi.fn().mockResolvedValue(undefined));

      expect(manager.isCancelled('a')).toBe(true);
      expect(manager.isCancelled('b')).toBe(true);
    });

    it('cancels all active sub-agents', async () => {
      const abortFn = vi.fn().mockResolvedValue(undefined);

      manager.track(createTrackedEntry({ taskId: 'a' }));
      manager.track(createTrackedEntry({ taskId: 'b' }));

      await manager.cancelAll(abortFn);

      expect(abortFn).toHaveBeenCalledTimes(2);
      expect(manager.activeCount).toBe(0);
    });

    it('resolves completion promises as cancelled', async () => {
      const entryA = createTrackedEntry({ taskId: 'a' });
      const entryB = createTrackedEntry({ taskId: 'b' });
      manager.track(entryA);
      manager.track(entryB);

      await manager.cancelAll(vi.fn().mockResolvedValue(undefined));

      const resultA = await entryA.completion;
      expect(resultA.status).toBe('cancelled');

      const resultB = await entryB.completion;
      expect(resultB.status).toBe('cancelled');
    });

    it('fires onFailed hooks for each cancelled agent', async () => {
      const onFailed = vi.fn();
      manager.setHooks({ onFailed });

      manager.track(createTrackedEntry({ taskId: 'a' }));
      manager.track(createTrackedEntry({ taskId: 'b' }));

      await manager.cancelAll(vi.fn().mockResolvedValue(undefined));

      expect(onFailed).toHaveBeenCalledTimes(2);
      expect(onFailed).toHaveBeenCalledWith('a', 'Parent agent destroyed');
      expect(onFailed).toHaveBeenCalledWith('b', 'Parent agent destroyed');
    });
  });

  describe('destroy', () => {
    it('clears all state', () => {
      manager.track(createTrackedEntry({ taskId: 'a' }));
      manager.track(createTrackedEntry({ taskId: 'b' }));

      manager.destroy();

      expect(manager.activeCount).toBe(0);
      expect(manager.getActiveTaskIds()).toHaveLength(0);
    });

    it('keeps cancelled task IDs so late completions stay discardable after destroy', async () => {
      // A cancelled child's completion continuation can settle after the
      // parent's teardown reaches destroy() (it awaits its own child
      // destroy). The cancelled-ID set must survive so that late result is
      // still recognized as a purposeful discard, not dead-lettered as
      // undelivered work. The set is capped at 200, so keeping it is not a
      // leak.
      manager.track(createTrackedEntry({ taskId: 'task-1' }));
      await manager.cancel('task-1', vi.fn().mockResolvedValue(undefined));

      manager.destroy();

      expect(manager.isCancelled('task-1')).toBe(true);
    });
  });

  describe('defaults', () => {
    it('defaults to maxConcurrent 4', () => {
      const defaultManager = new SubAgentManager();
      expect(defaultManager.limit).toBe(4);
    });
  });
});
