#!/usr/bin/env node
/**
 * Typecheck the test suites, which the normal `typecheck` does not.
 *
 * Every package tsconfig carries `exclude: [..., "tests"]`, so `tsc` has
 * never seen a test file in this repo. The cost is not hypothetical: a
 * harness can write `const ports: DuplexRouterPorts = { ... }`, omit a
 * required member, and the annotation enforces nothing. That is the exact
 * claim a reader leans on when deciding a test means something, and it was
 * unchecked. One real instance (a missing `spawnLookup` port) sat in the
 * broker harness through several port additions, silent because no test in
 * that file happened to call it.
 *
 * This is a REPORT, not a gate. It is expected to be red. It is deliberately
 * not part of `npm run typecheck` (the pre-commit hook runs that) and not a
 * CI step, because a red check nobody can go green on trains people to
 * ignore the ones that can.
 *
 * Use it as a ratchet: run it, compare against the baseline printed below,
 * and drive the number down. Fixing a harness to match the interface it
 * claims to implement is the highest-value kind of fix in here; a cast to
 * reach a private is the lowest.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['cortex', 'cortex-code', 'cortex-sandbox', 'brand'];

/**
 * Errors per package when this script landed. A run that beats these is
 * progress; a run that exceeds one is worth a look. Not asserted, because
 * the point is visibility rather than a gate.
 *
 * A snapshot taken on a branch several agents were writing at once, so
 * treat small movements as noise and large ones as signal.
 */
const BASELINE = { cortex: 449, 'cortex-code': 25, 'cortex-sandbox': 1, brand: 0 };

/** Count `error TSxxxx` lines, and prove the run actually compiled tests. */
function check(pkg) {
  const project = join(ROOT, 'packages', pkg, 'tsconfig.tests.json');
  if (!existsSync(project)) return { pkg, skipped: 'no tsconfig.tests.json' };

  let output = '';
  try {
    output = execFileSync('npx', ['tsc', '--noEmit', '-p', project], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }

  // The instrument check. A misconfigured project compiles nothing and
  // reports a confident zero, which is how the original audit of this very
  // gap first came back clean. Never trust the count without it.
  let seen = 0;
  try {
    const listed = execFileSync(
      'npx', ['tsc', '--noEmit', '-p', project, '--listFiles'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    seen = listed.split('\n').filter((line) => /[/\\]tests[/\\]/.test(line)).length;
  } catch (err) {
    const listed = `${err.stdout ?? ''}`;
    seen = listed.split('\n').filter((line) => /[/\\]tests[/\\]/.test(line)).length;
  }

  const errors = output.split('\n').filter((line) => /error TS\d+/.test(line));
  // Only this package's own tests are counted. Errors elsewhere are noise
  // from how this config has to be built: `composite: false` makes tsc
  // compile referenced packages from source instead of from their emitted
  // .d.ts, so cortex-code's run reports errors inside cortex/src that the
  // real `npm run typecheck` does not have. Counting those would invent
  // findings and would make the number move when a neighbour is mid-edit.
  const own = `packages/${pkg}/tests/`;
  const inTests = errors.filter((line) => line.includes(own)).length;
  const elsewhere = errors.length - inTests;
  return { pkg, elsewhere, inTests, seen };
}

const results = PACKAGES.map(check);
let totalInTests = 0;
let instrumentFailed = false;

console.log('\nTypecheck of test suites (report only, not a gate)\n');
for (const r of results) {
  if (r.skipped) {
    console.log(`  ${r.pkg.padEnd(16)} skipped: ${r.skipped}`);
    continue;
  }
  totalInTests += r.inTests;
  const base = BASELINE[r.pkg];
  const delta = base === undefined ? '' : r.inTests === base
    ? '  (baseline)'
    : `  (baseline ${base}, ${r.inTests > base ? '+' : ''}${r.inTests - base})`;
  console.log(
    `  ${r.pkg.padEnd(16)} ${String(r.inTests).padStart(5)} errors in tests` +
    `   [${r.seen} test files compiled]${delta}`,
  );
  if (r.seen === 0) {
    instrumentFailed = true;
    console.log(`  ${' '.repeat(16)} WARNING: compiled no test files, so this zero means nothing`);
  }
  if (r.elsewhere > 0) {
    console.log(
      `  ${' '.repeat(16)} (${r.elsewhere} errors outside this package's tests, not counted:` +
      ' referenced packages compile from source here)',
    );
  }
}

console.log(`\n  TOTAL ${totalInTests} type errors across test suites\n`);
console.log('  Not a gate. `npm run typecheck` still covers src only.');
console.log('  Highest-value fixes: harnesses that annotate a production');
console.log('  interface and do not satisfy it. Lowest: casts to reach privates.\n');

// Exit non-zero only when the instrument itself is broken. A count, however
// large, is the expected output; a count measured over nothing is not.
process.exit(instrumentFailed ? 1 : 0);
