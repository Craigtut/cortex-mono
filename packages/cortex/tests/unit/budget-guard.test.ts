import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BudgetGuard } from '../../src/budget-guard.js';
import { EventBridge } from '../../src/event-bridge.js';
import type { PiEvent, PiEventSource } from '../../src/event-bridge.js';

/**
 * Create a mock pi-agent-core event source.
 */
function createMockSource(): PiEventSource & { emit: (event: PiEvent) => void } {
  let handler: ((event: PiEvent) => void) | null = null;

  return {
    subscribe(h: (event: PiEvent) => void): () => void {
      handler = h;
      return () => {
        handler = null;
      };
    },
    emit(event: PiEvent): void {
      if (handler) {
        handler(event);
      }
    },
  };
}

/**
 * Build a pi-ai-shaped turn_end event with usage and cost data.
 * Mimics the real AssistantMessage.usage structure from pi-ai.
 */
function turnEndWithCost(total: number): PiEvent {
  return {
    type: 'turn_end',
    message: {
      usage: {
        input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
      },
    },
  };
}

describe('BudgetGuard', () => {
  let bridge: EventBridge;
  let source: ReturnType<typeof createMockSource>;
  let abortFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bridge = new EventBridge(false); // working tags off for simpler testing
    source = createMockSource();
    bridge.wire(source);
    abortFn = vi.fn();
  });

  // -----------------------------------------------------------------------
  // Turn counting
  // -----------------------------------------------------------------------

  describe('turn counting', () => {
    it('increments turn count on each turn_end', () => {
      const guard = new BudgetGuard({ maxTurns: Infinity }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      source.emit({ type: 'turn_end' });
      source.emit({ type: 'turn_end' });

      expect(guard.getTurnCount()).toBe(3);
    });

    it('aborts when maxTurns is exceeded', () => {
      const guard = new BudgetGuard({ maxTurns: 3 }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      expect(abortFn).not.toHaveBeenCalled();

      source.emit({ type: 'turn_end' });
      expect(abortFn).not.toHaveBeenCalled();

      source.emit({ type: 'turn_end' });
      expect(abortFn).toHaveBeenCalledTimes(1);
    });

    it('does not abort when maxTurns is Infinity', () => {
      const guard = new BudgetGuard({ maxTurns: Infinity }, abortFn);
      guard.wire(bridge);

      for (let i = 0; i < 100; i++) {
        source.emit({ type: 'turn_end' });
      }

      expect(abortFn).not.toHaveBeenCalled();
      expect(guard.getTurnCount()).toBe(100);
    });

    it('does not call abort multiple times after breach', () => {
      const guard = new BudgetGuard({ maxTurns: 2 }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      source.emit({ type: 'turn_end' }); // Breach
      source.emit({ type: 'turn_end' }); // Should not abort again

      expect(abortFn).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Cost tracking
  // -----------------------------------------------------------------------

  describe('cost tracking', () => {
    it('accumulates cost from turn_end events (pi-ai AssistantMessage structure)', () => {
      const guard = new BudgetGuard({ maxCost: Infinity }, abortFn);
      guard.wire(bridge);

      source.emit({
        type: 'turn_end',
        message: { usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.01, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.05 } } },
      });
      source.emit({
        type: 'turn_end',
        message: { usage: { input: 80, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } } },
      });

      expect(guard.getTotalCost()).toBeCloseTo(0.08);
    });

    it('aborts when maxCost is exceeded', () => {
      const guard = new BudgetGuard({ maxCost: 0.10 }, abortFn);
      guard.wire(bridge);

      source.emit({
        type: 'turn_end',
        message: { usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.01, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.06 } } },
      });
      expect(abortFn).not.toHaveBeenCalled();

      source.emit({
        type: 'turn_end',
        message: { usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.01, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.05 } } },
      });
      expect(abortFn).toHaveBeenCalledTimes(1);
    });

    it('does not abort when maxCost is Infinity', () => {
      const guard = new BudgetGuard({ maxCost: Infinity }, abortFn);
      guard.wire(bridge);

      for (let i = 0; i < 100; i++) {
        source.emit({
          type: 'turn_end',
          message: { usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.2, output: 0.8, cacheRead: 0, cacheWrite: 0, total: 1.0 } } },
        });
      }

      expect(abortFn).not.toHaveBeenCalled();
    });

    it('extracts cost from result.usage.cost.total', () => {
      const guard = new BudgetGuard({ maxCost: Infinity }, abortFn);
      guard.wire(bridge);

      source.emit({
        type: 'turn_end',
        result: { usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.02, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.07 } } },
      });

      expect(guard.getTotalCost()).toBeCloseTo(0.07);
    });

    it('extracts cost from direct usage on event', () => {
      const guard = new BudgetGuard({ maxCost: Infinity }, abortFn);
      guard.wire(bridge);

      source.emit({
        type: 'turn_end',
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.01, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.04 } },
      });

      expect(guard.getTotalCost()).toBeCloseTo(0.04);
    });

    it('handles turn_end with no usage data (zero cost)', () => {
      const guard = new BudgetGuard({ maxCost: Infinity }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });

      expect(guard.getTotalCost()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Reset on loop_start
  // -----------------------------------------------------------------------

  describe('reset on loop_start', () => {
    it('resets counters on loop_start', () => {
      const guard = new BudgetGuard({ maxTurns: Infinity, maxCost: Infinity }, abortFn);
      guard.wire(bridge);

      source.emit(turnEndWithCost(0.05));
      source.emit(turnEndWithCost(0.05));

      expect(guard.getTurnCount()).toBe(2);
      expect(guard.getTotalCost()).toBeCloseTo(0.10);

      // Reset via agent_start -> loop_start
      source.emit({ type: 'agent_start' });

      expect(guard.getTurnCount()).toBe(0);
      expect(guard.getTotalCost()).toBe(0);
      expect(guard.isBreached()).toBe(false);
    });

    it('allows new turns after reset', () => {
      const guard = new BudgetGuard({ maxTurns: 2 }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      source.emit({ type: 'turn_end' }); // Breach
      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(guard.isBreached()).toBe(true);

      // Reset via agent_start -> loop_start
      source.emit({ type: 'agent_start' });
      expect(guard.isBreached()).toBe(false);

      // Should be able to run 2 more turns
      source.emit({ type: 'turn_end' });
      expect(abortFn).toHaveBeenCalledTimes(1); // Still just the 1 from before
    });
  });

  // -----------------------------------------------------------------------
  // Defaults
  // -----------------------------------------------------------------------

  describe('defaults', () => {
    it('defaults to Infinity for both limits', () => {
      const guard = new BudgetGuard({}, abortFn);
      guard.wire(bridge);

      for (let i = 0; i < 50; i++) {
        source.emit(turnEndWithCost(10.0));
      }

      expect(abortFn).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Combined limits
  // -----------------------------------------------------------------------

  describe('combined limits', () => {
    it('aborts on whichever limit is hit first (turns)', () => {
      const guard = new BudgetGuard({ maxTurns: 3, maxCost: 100.0 }, abortFn);
      guard.wire(bridge);

      source.emit(turnEndWithCost(0.01));
      source.emit(turnEndWithCost(0.01));
      source.emit(turnEndWithCost(0.01));

      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(guard.getTotalCost()).toBeCloseTo(0.03); // Well under cost limit
    });

    it('aborts on whichever limit is hit first (cost)', () => {
      const guard = new BudgetGuard({ maxTurns: 100, maxCost: 0.05 }, abortFn);
      guard.wire(bridge);

      source.emit(turnEndWithCost(0.03));
      source.emit(turnEndWithCost(0.03));

      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(guard.getTurnCount()).toBe(2); // Well under turn limit
    });
  });

  // -----------------------------------------------------------------------
  // Breach state
  // -----------------------------------------------------------------------

  describe('breach state', () => {
    it('reports not breached initially', () => {
      const guard = new BudgetGuard({ maxTurns: 5 }, abortFn);
      expect(guard.isBreached()).toBe(false);
    });

    it('reports breached after turn limit', () => {
      const guard = new BudgetGuard({ maxTurns: 1 }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      expect(guard.isBreached()).toBe(true);
    });

    it('reports breached after cost limit', () => {
      const guard = new BudgetGuard({ maxCost: 0.01 }, abortFn);
      guard.wire(bridge);

      source.emit(turnEndWithCost(0.02));
      expect(guard.isBreached()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  describe('cleanup', () => {
    it('unwire stops tracking events', () => {
      const guard = new BudgetGuard({ maxTurns: 5 }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      expect(guard.getTurnCount()).toBe(1);

      guard.unwire();

      source.emit({ type: 'turn_end' });
      expect(guard.getTurnCount()).toBe(1); // No longer tracking
    });

    it('destroy stops tracking events', () => {
      const guard = new BudgetGuard({ maxTurns: 5 }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      guard.destroy();

      source.emit({ type: 'turn_end' });
      expect(guard.getTurnCount()).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Logger integration
  // -----------------------------------------------------------------------

  describe('logger', () => {
    it('logs warn on turn limit breach', () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const guard = new BudgetGuard({ maxTurns: 2 }, abortFn, logger);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      expect(logger.warn).not.toHaveBeenCalled();

      source.emit({ type: 'turn_end' });
      expect(logger.warn).toHaveBeenCalledWith(
        '[BudgetGuard] turn limit breached',
        expect.objectContaining({ turnCount: 2, maxTurns: 2 }),
      );
    });

    it('logs warn on cost limit breach', () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const guard = new BudgetGuard({ maxCost: 0.05 }, abortFn, logger);
      guard.wire(bridge);

      source.emit(turnEndWithCost(0.06));
      expect(logger.warn).toHaveBeenCalledWith(
        '[BudgetGuard] cost limit breached',
        expect.objectContaining({ totalCost: 0.06, maxCost: 0.05 }),
      );
    });

    it('works without logger (default NOOP)', () => {
      const guard = new BudgetGuard({ maxTurns: 1 }, abortFn);
      guard.wire(bridge);

      // Should not throw
      expect(() => source.emit({ type: 'turn_end' })).not.toThrow();
      expect(guard.isBreached()).toBe(true);
    });
  });
});
