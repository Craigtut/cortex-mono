/**
 * Guards the evidence, not the code.
 *
 * This suite is the only in-repo proof that the Cortex framework is adoptable
 * by a real consumer. It resolved `@animus-labs/cortex` through
 * `packages/cortex/dist`, a build artifact nothing rebuilt, and was green for
 * four commits against a dist that still had the pre-duplex `onTurnComplete`
 * fan-out. `vitest.config.ts` fixes that by aliasing the package to source,
 * and this file exists so that fix cannot quietly stop working: a deleted
 * alias, a moved entry point, or a run that never loaded the config all fail
 * here rather than passing against whatever happens to be on disk.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// The bare specifier, however the runner chose to resolve it...
import { CortexAgent } from '@animus-labs/cortex';
// ...and the framework source, by a path that admits no ambiguity. Module
// identity between the two is the only honest test of which one is loaded;
// asserting on the config would just be the config agreeing with itself.
import { CortexAgent as CortexAgentFromSource } from '../../cortex/src/index.js';

const cortexRoot = fileURLToPath(new URL('../../cortex/', import.meta.url));
const distEntry = path.join(cortexRoot, 'dist', 'index.js');
const srcDir = path.join(cortexRoot, 'src');

/** Newest mtime under a directory tree, in ms. */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const mtime = entry.isDirectory()
      ? newestMtime(full)
      : entry.name.endsWith('.ts')
        ? fs.statSync(full).mtimeMs
        : 0;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

const target = process.env['CORTEX_TEST_TARGET'];

describe('the framework build this suite is testing', () => {
  it('was told which build to use', () => {
    // Absent means vitest.config.ts never loaded, which means no alias, which
    // means every other test in this package just ran against dist without
    // saying so. Run the suite as `npm run test:run -w packages/cortex-code`,
    // or through the root workspace config, so the package config applies.
    expect(
      target,
      'CORTEX_TEST_TARGET is unset: packages/cortex-code/vitest.config.ts did not load, '
        + 'so @animus-labs/cortex resolved to dist and this run may be testing a stale build',
    ).toBeDefined();
    expect(target).toMatch(/^(source|dist)$/);
  });

  it('resolves the bare specifier to the build that was asked for', () => {
    if (target === 'source') {
      expect(
        CortexAgent,
        'the @animus-labs/cortex alias is not in force: the suite is resolving dist',
      ).toBe(CortexAgentFromSource);
    } else {
      expect(
        CortexAgent,
        'CORTEX_TEST_TARGET=dist but the specifier still resolved to source',
      ).not.toBe(CortexAgentFromSource);
    }
  });

  it('has a dist that is not stale', () => {
    const distExists = fs.existsSync(distEntry);

    if (target === 'dist') {
      // The whole point of this mode is exercising the artifact, so a missing
      // or stale one is a hard failure rather than a caveat.
      expect(distExists, `${distEntry} is missing; build @animus-labs/cortex first`).toBe(true);
      expect(
        fs.statSync(distEntry).mtimeMs,
        'packages/cortex/dist is older than packages/cortex/src; '
          + 'this run would certify a build that no longer exists',
      ).toBeGreaterThanOrEqual(newestMtime(srcDir));
      return;
    }

    // Source mode: dist is not in the runtime path, so staleness cannot make
    // these tests lie. It can still make the neighbouring gate lie, because
    // `npm run typecheck` resolves types from dist/index.d.ts. Say so; do not
    // fail, or every run made while iterating on framework source goes red for
    // a reason the tests do not depend on.
    if (!distExists || fs.statSync(distEntry).mtimeMs < newestMtime(srcDir)) {
      console.warn(
        '\n[cortex-code] packages/cortex/dist is '
          + (distExists ? 'older than packages/cortex/src' : 'missing')
          + '. These tests ran against source and are unaffected, but '
          + '`npm run typecheck` reads dist/index.d.ts and is answering about a '
          + 'different build. Run `npm run build -w packages/cortex`.\n',
      );
    }
    expect(target).toBe('source');
  });
});
