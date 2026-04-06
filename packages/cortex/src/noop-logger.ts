import type { CortexLogger } from './types.js';

/** Silent logger used when no consumer logger is provided. */
export const NOOP_LOGGER: CortexLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
