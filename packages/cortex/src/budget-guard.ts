/**
 * Budget guard: enforces turn count and cost limits during the agentic loop.
 *
 * Monitors turn_end events for turn counting and cost accumulation.
 * On breach, calls the provided abort function to stop the loop.
 * Defaults to Infinity for both limits (no enforcement unless configured).
 *
 * Counters reset on agent_start (beginning of each agentic loop).
 *
 * Reference: cortex-architecture.md (Budget Guards section)
 */

import type { BudgetGuardConfig, CortexLogger } from './types.js';
import { NOOP_LOGGER } from './noop-logger.js';
import type { EventBridge } from './event-bridge.js';

// ---------------------------------------------------------------------------
// BudgetGuard
// ---------------------------------------------------------------------------

export class BudgetGuard {
  private readonly maxTurns: number;
  private readonly maxCost: number;
  private readonly abortFn: () => void;
  private readonly logger: CortexLogger;

  private turnCount = 0;
  private totalCost = 0;
  private breached = false;

  private unsubscribers: Array<() => void> = [];

  /**
   * Create a BudgetGuard.
   *
   * @param config - Budget limits (maxTurns, maxCost). Both default to Infinity.
   * @param abortFn - Function to call when a limit is breached (typically agent.abort())
   * @param logger - Optional logger for diagnostics (defaults to silent no-op)
   */
  constructor(config: Partial<BudgetGuardConfig>, abortFn: () => void, logger?: CortexLogger) {
    this.maxTurns = config.maxTurns ?? Infinity;
    this.maxCost = config.maxCost ?? Infinity;
    this.abortFn = abortFn;
    this.logger = logger ?? NOOP_LOGGER;
  }

  /**
   * Wire the guard to an event bridge.
   * Subscribes to turn_end (for turn counting and cost) and loop_start (for reset).
   *
   * @param bridge - The EventBridge to subscribe to
   */
  wire(bridge: EventBridge): void {
    // Clean up any previous wiring
    this.unwire();

    // Reset counters on agent_start (beginning of a new agentic loop)
    this.unsubscribers.push(
      bridge.on('loop_start', () => {
        this.reset();
      }),
    );

    // Track turns and cost on turn_end
    this.unsubscribers.push(
      bridge.on('turn_end', (event) => {
        this.turnCount++;

        // Read cost from typed usage (extracted by EventBridge)
        const cost = event.usage?.cost?.total ?? 0;
        if (cost > 0) {
          this.totalCost += cost;
        }

        // Check limits
        this.checkLimits();
      }),
    );
  }

  /**
   * Disconnect from the event bridge.
   */
  unwire(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  /**
   * Get the current turn count.
   */
  getTurnCount(): number {
    return this.turnCount;
  }

  /**
   * Get the accumulated cost.
   */
  getTotalCost(): number {
    return this.totalCost;
  }

  /**
   * Get the maximum turn limit.
   */
  getMaxTurns(): number {
    return this.maxTurns;
  }

  /**
   * Get the maximum cost limit.
   */
  getMaxCost(): number {
    return this.maxCost;
  }

  /**
   * Whether any limit has been breached.
   */
  isBreached(): boolean {
    return this.breached;
  }

  /**
   * Reset counters. Called automatically on loop_start.
   */
  reset(): void {
    this.turnCount = 0;
    this.totalCost = 0;
    this.breached = false;
  }

  /**
   * Clean up all subscriptions.
   */
  destroy(): void {
    this.unwire();
  }

  /**
   * Check if any limits have been exceeded and abort if so.
   */
  private checkLimits(): void {
    if (this.breached) {
      return; // Already breached, don't abort multiple times
    }

    if (this.turnCount >= this.maxTurns) {
      this.breached = true;
      this.logger.warn('[BudgetGuard] turn limit breached', {
        turnCount: this.turnCount,
        maxTurns: this.maxTurns,
      });
      this.abortFn();
      return;
    }

    if (this.totalCost >= this.maxCost) {
      this.breached = true;
      this.logger.warn('[BudgetGuard] cost limit breached', {
        totalCost: this.totalCost,
        maxCost: this.maxCost,
      });
      this.abortFn();
    }
  }

}
