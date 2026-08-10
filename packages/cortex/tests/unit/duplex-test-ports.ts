/**
 * A complete {@link DuplexRouterPorts} for tests, where every port a test
 * did not ask for throws when called.
 *
 * Two problems this exists for, both found by auditing rather than by a
 * failing test.
 *
 * **The annotation was not a check.** `const ports: DuplexRouterPorts = {}`
 * in a test file enforces nothing, because no package tsconfig includes
 * `tests` (see `npm run typecheck:tests`). The broker harness had been
 * missing the required `spawnLookup` port through several router changes,
 * silent only because no test in that file happened to dispatch a lookup.
 * Building every harness from one function makes the next port addition a
 * single compile error here instead of a silent omission in each harness.
 *
 * **A stub that answers is a stub that can lie.** The defaults throw rather
 * than returning a plausible value, which is the generalization of a lesson
 * already paid for in these suites: `currentReasonerCauseTags` was once a
 * neutral `() => []`, and an empty cause set does not mean "no information",
 * it means "this delivery concludes no delegation", which is precisely the
 * never-retires bug the retirement logic exists to remove. Every test in
 * that file would have asserted the old behavior while the one test written
 * for the fix passed. A throwing default cannot do that: a test either
 * declares the port it exercises or finds out immediately.
 *
 * So the rule for a harness here is: override the ports your tests actually
 * drive, and leave the rest. If a throw fires, the test reached machinery it
 * never meant to, which is information rather than an inconvenience.
 */
import type { DuplexRouterPorts } from '../../src/duplex/router.js';

/** The required members of the port contract, optional ones excluded. */
type RequiredPort = {
  [K in keyof DuplexRouterPorts]-?: Record<string, never> extends Pick<DuplexRouterPorts, K>
    ? never
    : K;
}[keyof DuplexRouterPorts];

/**
 * Ports with no sensible default: called means the test went off-script.
 *
 * A **mapped type over the contract**, not a hand-written list, and the
 * distinction is the whole point. The first version of this file listed the
 * names literally behind a cast, and adding a required port to
 * `DuplexRouterPorts` produced exactly one error, in production wiring, and
 * none here: the factory would have handed every harness an object silently
 * missing the new port, failing at runtime as "undefined is not a function"
 * instead of at compile time. That is the same defect this file exists to
 * prevent, one level up, and it is the same shape as the config table that
 * accepted keys it then discarded. Keyed this way, a new required port is a
 * missing-property error right here, once.
 */
const UNSTUBBED_PORTS: { [K in RequiredPort]: true } = {
  deliverToTalker: true,
  talkerIdle: true,
  dispatchToReasoner: true,
  appendLog: true,
  currentTalkerCauseSeq: true,
  currentTalkerCauseTags: true,
  currentReasonerCauseTags: true,
  voiceAskToTalker: true,
  spawnLookup: true,
};

function unstubbed(name: string): () => never {
  return () => {
    throw new Error(
      `test router port "${name}" was called but this harness did not stub it. ` +
      'Pass it to makeTestRouterPorts() if the test means to exercise it; a ' +
      'default that answered would let this test pass on a fabricated value.',
    );
  };
}

/**
 * Build a full port set from the subset a harness cares about.
 *
 * Property descriptors are copied rather than spread, so an override
 * defined as a getter stays a getter. The router harness needs that: it
 * swaps `idleSignal` mid-test, and a spread would capture one value at
 * construction and quietly pin it.
 *
 * Optional ports (`markAskVoiced`, `idleSignal`, `logger`, the loop paths)
 * get no default at all. Production guards them with `?.`, so installing a
 * throwing stub would turn "not provided" into "provided and explodes",
 * which is a different contract from the one under test.
 */
export function makeTestRouterPorts(
  overrides: Partial<DuplexRouterPorts>,
): DuplexRouterPorts {
  const base: Record<string, unknown> = {};
  for (const name of Object.keys(UNSTUBBED_PORTS)) base[name] = unstubbed(name);
  Object.defineProperties(base, Object.getOwnPropertyDescriptors(overrides));
  // Through `unknown`, because a Record of thrown-together members does not
  // structurally overlap the contract and tsc is right to say so. What makes
  // this sound is UNSTUBBED_PORTS being keyed BY the contract: every
  // required member is installed before the overrides land on top, and a
  // new required port fails to compile above rather than slipping through
  // here. The cast asserts nothing the type system has not already checked.
  return base as unknown as DuplexRouterPorts;
}
