/**
 * Drives the REAL trust gates a Session runs at startup (registerSkills /
 * loadHooks) so a wiring bug (wrong filter, forgetting to record trust,
 * loading declined content) is caught. Only the UI prompt
 * (promptProjectContentTrust) and the agent/app collaborators are stubbed; the
 * trust store and discovery run for real against a temp project + fake home.
 * The agent and app are injected on the Session, which the gates read through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillRegistry } from '@animus-labs/cortex';

// A single lazily-created fake home for the whole file. It must resolve even
// when transitive imports (e.g. logger) call homedir() at module-load time,
// before any beforeEach runs, so it lives on globalThis with no TDZ. Per-test
// isolation comes from a fresh `cwd` each test (trust is keyed by project path,
// not by home), and the fake home has no ~/.cortex/skills so no global skills
// leak in.
function currentHome(): string {
  const g = globalThis as { __sessionTrustHome?: string };
  if (!g.__sessionTrustHome) {
    g.__sessionTrustHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-trust-home-'));
  }
  return g.__sessionTrustHome;
}
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => currentHome() };
});

import { Session } from '../src/session.js';
import { checkProjectTrust } from '../src/discovery/project-trust.js';

let cwd: string;

const HOOKS_JSON = JSON.stringify({
  hooks: { pre_turn: [{ name: 'inject', command: 'echo', args: ['hi'] }] },
});

function writeSkill(name: string, body: string): void {
  const dir = path.join(cwd, '.cortex', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + '/SKILL.md', `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`);
}

function writeHooks(): void {
  fs.mkdirSync(path.join(cwd, '.cortex'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.cortex', 'hooks.json'), HOOKS_JSON);
}

/**
 * Build a Session with just enough injected state to run the trust gates.
 * Collaborators the constructor only stores are stubbed; `agent` exposes the
 * facade's addSkill() over a real SkillRegistry (the session registers through
 * the facade, not past it, so the fan-out set stays the facade's business) and
 * `app` exposes the transcript/notification surface the gates touch.
 */
function makeSession(): { session: Session; registry: SkillRegistry } {
  const registry = new SkillRegistry();
  const session = new Session({
    config: {} as never,
    mode: { name: 'test', systemPrompt: '', contextSlots: [] } as never,
    model: {} as never,
    provider: 'test',
    modelId: 'test',
    providerManager: {} as never,
    credentialStore: {} as never,
    cwd,
    yoloMode: false,
    initialEffort: 'medium',
    resumeSessionId: undefined,
  });
  (session as unknown as { agent: unknown }).agent = {
    addSkill: (config: Parameters<SkillRegistry['addSkill']>[0]) => registry.addSkill(config),
    getSkillRegistry: () => registry,
  };
  (session as unknown as { app: unknown }).app = {
    transcript: { addNotification: vi.fn() },
    refreshCommands: vi.fn(),
  };
  return { session, registry };
}

interface TrustGatesInternals {
  promptProjectContentTrust: () => Promise<'trust' | 'skip'>;
  registerSkills: () => Promise<void>;
  loadHooks: () => Promise<Record<string, Array<{ source: string }>>>;
}

/** The session's trust gates, where the prompt and the gated loaders live. */
function gatesOf(session: Session): TrustGatesInternals {
  return (session as unknown as { trust: TrustGatesInternals }).trust;
}

/** Force the trust overlay decision without a TUI. */
function stubPrompt(session: Session, decision: 'trust' | 'skip'): void {
  vi.spyOn(gatesOf(session), 'promptProjectContentTrust').mockResolvedValue(decision);
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-trust-proj-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('trust gate: project skills', () => {
  it('does not register an untrusted project skill when the user declines', async () => {
    writeSkill('evil', '!`echo pwned`');
    const { session, registry } = makeSession();
    stubPrompt(session, 'skip');

    await gatesOf(session).registerSkills();

    expect(registry.getEntry('evil')).toBeNull();
    expect(registry.getAvailableSkillsSummary()).not.toContain('evil');
  });

  it('registers and records trust when the user approves', async () => {
    writeSkill('helper', '!`echo ok`');
    const { session, registry } = makeSession();
    stubPrompt(session, 'trust');

    await gatesOf(session).registerSkills();

    expect(registry.getEntry('helper')).not.toBeNull();
    // Trust was persisted, so a second run needs no prompt.
    const { session: session2, registry: registry2 } = makeSession();
    const spy = vi.spyOn(gatesOf(session2), 'promptProjectContentTrust');
    await gatesOf(session2).registerSkills();
    expect(spy).not.toHaveBeenCalled();
    expect(registry2.getEntry('helper')).not.toBeNull();
  });
});

describe('trust gate: project hooks', () => {
  it('loads NO project hooks when the user declines', async () => {
    writeHooks();
    const { session } = makeSession();
    stubPrompt(session, 'skip');

    const handlers = await gatesOf(session).loadHooks();

    expect(handlers['pre_turn']).toHaveLength(0);
  });

  it('loads project hooks and records trust when the user approves', async () => {
    writeHooks();
    const { session } = makeSession();
    stubPrompt(session, 'trust');

    const handlers = await gatesOf(session).loadHooks();

    expect(handlers['pre_turn']).toHaveLength(1);
    expect(handlers['pre_turn']?.[0]?.source).toBe('project');
    expect(await checkProjectTrust(cwd, 'hooks', HOOKS_JSON)).toBe(true);
  });
});
