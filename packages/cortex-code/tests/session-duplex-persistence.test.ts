/**
 * What a duplex session actually writes to disk, and what comes back.
 *
 * The v1 autosave built its artifact from `getConversationHistory()` plus
 * `getObservationalMemoryState()`, both of which read the REASONER. Under
 * duplex the reasoner holds the work transcript and the user's dialogue lives
 * on the talker, so every save written after the pin drops would silently
 * omit the conversation. Nothing errors, and no later migration recovers
 * something that was never written, which is why this has to land before
 * anyone flips the mode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

import type { CortexAgentStateV2 } from '@animus-labs/cortex';
import {
  createDuplexSession,
  destroyHarnessAgents,
  waitUntil,
  type DuplexSession,
} from './helpers/duplex-harness.js';
import { saveSession, type SessionMeta } from '../src/persistence/sessions.js';

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-duplex-ws-'));
});

afterEach(async () => {
  await destroyHarnessAgents();
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

function sessionDir(sessionId: string): string {
  return path.join(currentHome(), '.cortex', 'sessions', sessionId);
}

/** Every text fragment in a persisted history, flattened for substring checks. */
function historyText(history: unknown[]): string {
  return JSON.stringify(history);
}

/**
 * Run one exchange and wait until the session has persisted it. Keyed on the
 * save CALL rather than on a filename, so the wait means the same thing
 * before and after the migration and a failure lands on the assertion that
 * describes the symptom.
 */
async function persistOneExchange(ctx: DuplexSession, text: string): Promise<void> {
  const save = vi.spyOn(ctx.internals.saver, 'save');
  await ctx.internals.handleInput(text);
  await waitUntil(() => save.mock.calls.length > 0, 3000, 'the session persisted');
  await ctx.internals.saver.flush();
}

describe('duplex: the saved artifact carries the conversation', () => {
  it('restores the talker\'s dialogue on resume, not just the reasoner\'s work log', async () => {
    const first = await createDuplexSession(cwd);
    first.harness.talkerPi.defaultText = 'Sure, starting on the payments module.';
    await persistOneExchange(first, 'refactor the payments module');
    const sessionId = first.internals.sessionId;

    const second = await createDuplexSession(cwd, { resumeSessionId: sessionId });
    await second.session.resume(sessionId);

    const restored = await second.harness.agent.getState();
    expect(historyText(restored.talkerHistory)).toContain('refactor the payments module');
    expect(historyText(restored.talkerHistory)).toContain('Sure, starting on the payments module.');
    expect(historyText(restored.reasonerHistory)).toEqual(
      historyText((await first.harness.agent.getState()).reasonerHistory),
    );
  });

  it('writes the composite artifact, log and both histories included', async () => {
    const ctx = await createDuplexSession(cwd);
    ctx.harness.talkerPi.defaultText = 'Sure, starting on the payments module.';
    await persistOneExchange(ctx, 'refactor the payments module');

    const state = JSON.parse(
      fs.readFileSync(path.join(sessionDir(ctx.internals.sessionId), 'state.json'), 'utf-8'),
    ) as CortexAgentStateV2;

    expect(state.version).toBe(2);
    expect(historyText(state.talkerHistory)).toContain('Sure, starting on the payments module.');
    expect(state.log.length).toBeGreaterThan(0);
  });

  it('saves once per settled exchange, not once per loop and once per turn', async () => {
    const ctx = await createDuplexSession(cwd);
    const save = vi.spyOn(ctx.internals.saver, 'save');

    ctx.harness.reasonerPi.hold = true;
    ctx.harness.agent.deliver('Refactor the payments module', { target: 'work' });
    await waitUntil(() => ctx.harness.reasonerPi.running, 2000, 'reasoner run started');
    await ctx.internals.handleInput('how is it going?');
    ctx.harness.reasonerPi.releaseRun();
    await waitUntil(() => !ctx.internals.isRunning, 2000, 'session settles');
    await waitUntil(() => save.mock.calls.length > 0, 3000, 'a save landed');
    await ctx.internals.saver.flush();

    // The old wiring drove autosave from onLoopComplete (once per resident
    // loop) and from turn_end (once per LLM turn), so a single exchange wrote
    // the session out three times.
    expect(save.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('still resumes a session saved in the pre-composite layout', async () => {
    const sessionId = 'legacy-v1-session';
    const meta: SessionMeta = {
      id: sessionId,
      mode: 'test',
      provider: 'test',
      model: 'test',
      cwd,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      contextTokenCount: 1234,
    };
    await saveSession(
      sessionId,
      [
        { role: 'user', content: 'an older question' },
        { role: 'assistant', content: 'an older answer' },
      ],
      meta,
    );

    const { session, harness } = await createDuplexSession(cwd, { resumeSessionId: sessionId });
    await session.resume(sessionId);

    // v1 shapes restore into the reasoner; the facade upgrades them.
    const state = await harness.agent.getState();
    expect(historyText(state.reasonerHistory)).toContain('an older question');
  });
});
