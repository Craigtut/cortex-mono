/**
 * Drives the REAL Session against a REAL duplex CortexAgent, over the one
 * question the passthrough pin hides: when is the agent DONE?
 *
 * `onLoopComplete` is registered on every resident loop and carries no
 * origin, so under duplex the talker's sub-second turn used to fire the whole
 * end-of-turn handler while the reasoner was minutes from finishing. The
 * spinner vanished, the session recorded itself as awaiting input, and the
 * `isRunning` gate at the top of Session.abort() went false, which is what
 * turns a cosmetic bug into a Ctrl+C that does nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A single lazily-created fake home for the whole file (see
// session-sandbox.test.ts for why this lives on globalThis). The persistence
// module resolves ~/.cortex/sessions at module load, so this must be in place
// before the first import of it.
function currentHome(): string {
  const g = globalThis as { __sessionDuplexHome?: string };
  if (!g.__sessionDuplexHome) {
    g.__sessionDuplexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-duplex-home-'));
  }
  return g.__sessionDuplexHome;
}
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => currentHome() };
});

import {
  createDuplexSession,
  createPassthroughSession,
  destroyHarnessAgents,
  startHeldReasonerWork,
  waitUntil,
} from './helpers/duplex-harness.js';

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-duplex-ws-'));
});

afterEach(async () => {
  await destroyHarnessAgents();
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('duplex: the TUI must not report idle while the reasoner works', () => {
  it('keeps the session busy after the talker finishes its turn', async () => {
    const { internals, app, harness } = await createDuplexSession(cwd);
    await startHeldReasonerWork(harness);

    // The user asks something; the talker answers in a sub-second turn while
    // the reasoner is still deep in the task.
    await internals.handleInput('how is it going?');

    expect(harness.reasonerPi.running).toBe(true);
    expect(internals.isRunning).toBe(true);
    expect(app.spinnerVisible).toBe(true);

    harness.reasonerPi.releaseRun();
    await waitUntil(() => !internals.isRunning, 2000, 'session settles');
    expect(app.spinnerVisible).toBe(false);
  });

  it('still aborts on Ctrl+C during reasoner work', async () => {
    const { session, internals, harness } = await createDuplexSession(cwd);
    await startHeldReasonerWork(harness);
    await internals.handleInput('how is it going?');

    const abort = vi.spyOn(harness.agent, 'abort');
    await session.abort();

    // The gate at the top of Session.abort() is `isRunning`; a session that
    // believes it is idle never reaches the agent at all, and Ctrl+C during a
    // multi-minute task becomes a no-op.
    expect(abort).toHaveBeenCalled();
    await waitUntil(() => !harness.reasonerPi.running, 2000, 'reasoner run unwound');
  });

  it('routes a keystroke during reasoner work to the talker, not into a steer', async () => {
    const { internals, harness } = await createDuplexSession(cwd);

    // A whole real exchange: the user asks for work, the talker dispatches it
    // through its control tool and speaks, and the reasoner settles into the
    // task. The session is now legitimately busy, which is the state that
    // makes this routing decision load-bearing.
    harness.reasonerPi.hold = true;
    harness.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'Refactor the payments module.' } }],
    }];
    await internals.handleInput('refactor the payments module');
    await waitUntil(() => harness.reasonerPi.running, 2000, 'reasoner run started');
    expect(internals.isRunning).toBe(true);

    // The user types again while the reasoner is still working. The talker is
    // free and is who they are talking to, so this is a fresh prompt. Keying
    // it on isRunning would steer it into a loop that is not listening.
    const steer = vi.spyOn(harness.agent, 'steer');
    const before = harness.talkerPi.promptCalls.length;
    await internals.handleInput('how is it going?');

    expect(steer).not.toHaveBeenCalled();
    expect(harness.talkerPi.promptCalls.length).toBeGreaterThan(before);

    harness.reasonerPi.releaseRun();
  });

  it('steers when the conversation itself is mid-turn', async () => {
    const { internals, harness } = await createDuplexSession(cwd);
    harness.talkerPi.hold = true;
    const first = internals.handleInput('start something');
    await waitUntil(() => harness.talkerPi.running, 2000, 'talker run started');

    const steer = vi.spyOn(harness.agent, 'steer');
    await internals.handleInput('actually, wait');
    expect(steer).toHaveBeenCalledWith('actually, wait');

    harness.talkerPi.releaseRun();
    await first;
  });
});

describe('passthrough: the mode cortex-code actually ships is unchanged', () => {
  it('shows the spinner for a turn and clears it when the turn ends', async () => {
    const { internals, app, reasonerPi } = await createPassthroughSession(cwd);

    reasonerPi.hold = true;
    const turn = internals.handleInput('list the files');
    await waitUntil(() => reasonerPi.running, 2000, 'reasoner run started');
    expect(internals.isRunning).toBe(true);
    expect(app.spinnerVisible).toBe(true);

    reasonerPi.releaseRun();
    await turn;
    await waitUntil(() => !internals.isRunning, 2000, 'session settles');
    expect(app.spinnerVisible).toBe(false);
    expect(app.calls).toContain('transcript.closeActiveToolGroups');
  });

  it('steers a second message typed into a running turn', async () => {
    const { internals, agent, reasonerPi } = await createPassthroughSession(cwd);
    reasonerPi.hold = true;
    const turn = internals.handleInput('list the files');
    await waitUntil(() => reasonerPi.running, 2000, 'reasoner run started');

    const steer = vi.spyOn(agent, 'steer');
    await internals.handleInput('actually, just the top level');
    expect(steer).toHaveBeenCalledWith('actually, just the top level');

    reasonerPi.releaseRun();
    await turn;
  });
});
