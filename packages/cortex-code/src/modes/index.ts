import { BUILD_MODE } from './build.js';
import type { Mode } from './types.js';

export type { Mode } from './types.js';
export { BUILD_MODE } from './build.js';

/**
 * Every mode the agent can run as. This is the single source of truth for how
 * many modes exist.
 *
 * The footer hides the mode badge while only one mode is registered (there is
 * nothing to choose, so naming it is just noise). Add a second mode here and the
 * active-mode badge appears automatically.
 */
export const AVAILABLE_MODES: Mode[] = [BUILD_MODE];
