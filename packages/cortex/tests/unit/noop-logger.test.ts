import { describe, it, expect } from 'vitest';
import { NOOP_LOGGER } from '../../src/noop-logger.js';
import type { CortexLogger } from '../../src/types.js';

describe('NOOP_LOGGER', () => {
  it('does not throw when called', () => {
    expect(() => NOOP_LOGGER.debug('test')).not.toThrow();
    expect(() => NOOP_LOGGER.info('test', { key: 'value' })).not.toThrow();
    expect(() => NOOP_LOGGER.warn('test')).not.toThrow();
    expect(() => NOOP_LOGGER.error('test', { error: 'boom' })).not.toThrow();
  });

  it('is compatible with console', () => {
    // Type-level check: console satisfies CortexLogger
    const _logger: CortexLogger = console;
    expect(_logger).toBeDefined();
  });
});
