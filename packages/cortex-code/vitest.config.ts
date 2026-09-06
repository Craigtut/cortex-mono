import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Which build of `@animus-labs/cortex` this suite runs against.
 *
 * cortex-code is the framework's only in-repo consumer, so this suite is the
 * only evidence that the framework is adoptable. It used to resolve the
 * package through `node_modules` to `packages/cortex/dist`, which is a build
 * artifact that nothing rebuilt: the suite was green for four commits against
 * a dist that still carried the pre-duplex `onTurnComplete` fan-out. Evidence
 * that can go stale without saying so is worse than no evidence, because it
 * fails toward confidence.
 *
 * - `source` (the default): the package resolves to `packages/cortex/src`, so
 *   a local run answers about the framework as it is now. Staleness is
 *   impossible rather than merely unlikely.
 * - `dist`: normal `node_modules` resolution, exactly what a real consumer
 *   gets. CI runs the suite this way too, after a build, because source mode
 *   cannot see a gap between `src` and what the package actually exports:
 *   a broken `exports` map or a `files` list missing `dist` is invisible to
 *   an alias and fatal to an installer.
 *
 * `tests/framework-target.test.ts` asserts the mode in force is the mode that
 * was asked for, by module identity rather than by trusting this file.
 */
const target = process.env['CORTEX_TEST_TARGET'] ?? 'source';

const cortexSource = fileURLToPath(new URL('../cortex/src/index.ts', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
    // Propagated into the workers so the guard test knows which mode was
    // requested. Its absence means this config was not applied at all.
    env: { CORTEX_TEST_TARGET: target },
  },
  resolve: {
    alias: target === 'source'
      // Resolve only the root export; preserve subpath resolution.
      ? [{ find: /^@animus-labs\/cortex$/, replacement: cortexSource }]
      : [],
  },
});
