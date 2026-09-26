/**
 * A model or provider switch in a duplex session reaches the talker, not
 * only the reasoner: the presence loop (and the quick lookups built from its
 * model) must not stay on the provider the user just switched away from.
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

import { wrapModel } from '@animus-labs/cortex';
import { createDuplexSession, destroyHarnessAgents } from './helpers/duplex-harness.js';

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-duplex-ws-'));
});

afterEach(async () => {
  await destroyHarnessAgents();
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('duplex: switching provider moves the talker too', () => {
  it('re-mirrors the talker onto the new provider', async () => {
    const credentialStore = {
      setDefaults: vi.fn(async () => {}),
      getDefaultUtilityModel: vi.fn(async () => null),
      getProvider: vi.fn(async () => ({})),
    };
    const { session, harness } = await createDuplexSession(cwd, { credentialStore });
    // Precondition: the talker starts on the session's original provider.
    expect(harness.talkerLoop.getModel().provider).toBe('anthropic');

    const gpt = wrapModel({ provider: 'openai', name: 'gpt-4o' } as never, 'openai', 'gpt-4o');
    vi.spyOn(session as unknown as { resolveProviderModel: () => Promise<unknown> }, 'resolveProviderModel')
      .mockResolvedValue(gpt);

    await session.switchProvider('openai', 'gpt-4o');

    expect(harness.reasonerLoop.getModel().modelId).toBe('gpt-4o');
    expect(harness.talkerLoop.getModel().provider).toBe('openai');
  });
});
