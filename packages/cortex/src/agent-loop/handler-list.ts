/**
 * A list of consumer-registered handlers with isolated fan-out: a handler
 * that throws is logged and the rest still run, so one faulty consumer
 * callback can never break the loop path that fired the event.
 */

import { errorMessageOf } from '../error-classifier.js';
import type { CortexLogger } from '../types.js';

export class HandlerList<A extends unknown[]> {
  private handlers: Array<(...args: A) => void> = [];

  /**
   * @param label - Names the registration API in the failure log line
   *   ("<label> handler threw").
   * @param describe - Extra identifying fields for that log line, read off
   *   the first handler argument.
   */
  constructor(
    private readonly label: string,
    private readonly logger: CortexLogger,
    private readonly describe?: (first: NoInfer<A>[0]) => Record<string, unknown>,
  ) {}

  add(handler: (...args: A) => void): void {
    this.handlers.push(handler);
  }

  emit(...args: A): void {
    for (const handler of this.handlers) {
      try {
        handler(...args);
      } catch (err) {
        this.logger.error(`${this.label} handler threw`, {
          ...(this.describe?.(args[0]) ?? {}),
          error: errorMessageOf(err),
        });
      }
    }
  }

  clear(): void {
    this.handlers = [];
  }

  get size(): number {
    return this.handlers.length;
  }
}
