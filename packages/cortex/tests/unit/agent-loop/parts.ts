/**
 * The modules inside a live AgentLoop, for tests that drive one of them
 * directly (a background completion arriving, an abort epoch advancing,
 * a history boundary moving under compaction).
 *
 * This is the one cast into the loop's internals; everything past it is
 * the modules' own typed API, so a rename there is a type error here
 * rather than a test that silently writes to a property nothing reads.
 */
import type { AgentLoop } from '../../../src/agent-loop.js';
import type { LoopParts } from '../../../src/agent-loop/assembly.js';

export function partsOf(loop: AgentLoop): LoopParts {
  return (loop as unknown as { parts: LoopParts }).parts;
}
