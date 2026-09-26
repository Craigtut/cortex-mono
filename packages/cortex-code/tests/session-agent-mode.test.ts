/**
 * Choosing which agent this CLI runs.
 *
 * cortex-code defaults to passthrough and the framework defaults to duplex, so
 * the mode is a decision this session makes rather than one it inherits. What
 * matters here is that the decision is reachable: a `--duplex` flag and an
 * `agentMode` config key, the flag winning, and the resolved mode actually
 * reaching the facade that gets assembled.
 *
 * Every case is driven from the real argv parser through the real Session into
 * a real CortexAgent. Asserting on a config object a test built itself would
 * say nothing about whether the flag reaches it, which is the half that can
 * break.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function currentHome(): string {
  const g = globalThis as { __sessionAgentModeHome?: string };
  if (!g.__sessionAgentModeHome) {
    g.__sessionAgentModeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-mode-home-'));
  }
  return g.__sessionAgentModeHome;
}
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => currentHome() };
});

import { CortexAgent, wrapModel } from '@animus-labs/cortex';
import type { CortexModel } from '@animus-labs/cortex';
import type { Session } from '../src/session.js';
import { parseArgs } from '../src/cli-args.js';
import { statusCommand } from '../src/commands/status.js';
import { StatusBar, type StatusBarState } from '../src/tui/status.js';
import { createFakeApp, type FakeApp } from './helpers/fake-app.js';
import {
  createDuplexSession,
  destroyHarnessAgents,
  makeSession,
  testModel,
  type SessionInternals,
} from './helpers/duplex-harness.js';

const VERSION = '0.0.0-test';

let cwd: string;
const liveAgents: CortexAgent[] = [];

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-mode-ws-'));
});

afterEach(async () => {
  await destroyHarnessAgents();
  while (liveAgents.length > 0) {
    await liveAgents.pop()!.destroy().catch(() => {});
  }
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

/** The `duplex` field of a real command line, parsed by the shipped parser. */
function flagFrom(...argv: string[]): boolean | undefined {
  return parseArgs(['node', 'cortex', ...argv], VERSION).duplex;
}

/** A provider Cortex cannot enumerate, so no fast tier resolves for the talker. */
function unenumerableModel(): CortexModel {
  return wrapModel({ provider: 'ollama', name: 'qwen3:32b' } as never, 'ollama', 'qwen3:32b');
}

/**
 * A real facade built from the session's own config, unmocked. Used for the
 * passthrough cases, where a single loop assembles without a provider.
 */
async function agentFromSession(internals: SessionInternals): Promise<CortexAgent> {
  const agent = await CortexAgent.create({ ...internals.buildAgentConfig(), model: testModel() });
  liveAgents.push(agent);
  return agent;
}

/** The footer the session's own pushed state renders to, through the real bar. */
function renderFooter(app: FakeApp, width = 160): string {
  const bar = new StatusBar();
  bar.setState(app.statusState as Partial<StatusBarState>);
  return bar.render(width).join('');
}

/** The body of the last notification the command wrote. */
function lastNotification(app: FakeApp): string {
  const calls = app.transcript['addNotification']!.mock.calls;
  return String(calls[calls.length - 1]?.[1] ?? '');
}

/** A passthrough session with its footer in the state start() opens with. */
async function openPassthroughSession(overrides: Record<string, unknown> = {}): Promise<{
  session: Session;
  internals: SessionInternals;
  app: FakeApp;
  agent: CortexAgent;
}> {
  const { session, internals } = makeSession(cwd, overrides);
  const agent = await agentFromSession(internals);
  const app = createFakeApp();
  internals.agent = agent;
  internals.app = app;
  internals.status.pushInitialFooter('', 'medium');
  return { session, internals, app, agent };
}

describe('the agent mode is selectable', () => {
  it('runs a single reasoner loop by default', async () => {
    const { internals, agent } = await openPassthroughSession({ duplex: flagFrom() });

    expect(internals.buildAgentConfig().mode).toBe('passthrough');

    // The public tell for "no talker was built". The reasoner's own usage is
    // asserted alongside it so the null below is a real absence rather than a
    // state object that never populated.
    const state = await agent.getState();
    expect(state.usage.perLoop.reasoner).not.toBeNull();
    expect(state.usage.perLoop.talker).toBeNull();
    expect(state.talkerHistory).toEqual([]);
  });

  it('runs duplex when --duplex is passed', async () => {
    // createDuplexSession assembles through the session's resolved mode and
    // throws if create() did not build both resident loops, so a flag that
    // never reached the config fails here rather than passing quietly.
    const ctx = await createDuplexSession(cwd, { duplex: flagFrom('--duplex') });

    expect(ctx.internals.buildAgentConfig().mode).toBe('duplex');
    const state = await ctx.harness.agent.getState();
    expect(state.usage.perLoop.talker).not.toBeNull();
  });

  it('runs duplex from the agentMode config key with no flag', async () => {
    const ctx = await createDuplexSession(cwd, {
      duplex: flagFrom(),
      config: { agentMode: 'duplex' },
    });

    expect(ctx.internals.buildAgentConfig().mode).toBe('duplex');
    const state = await ctx.harness.agent.getState();
    expect(state.usage.perLoop.talker).not.toBeNull();
  });

  it('lets --no-duplex win over a config key that asked for duplex', async () => {
    const { internals, agent } = await openPassthroughSession({
      duplex: flagFrom('--no-duplex'),
      config: { agentMode: 'duplex' },
    });

    expect(internals.buildAgentConfig().mode).toBe('passthrough');
    const state = await agent.getState();
    expect(state.usage.perLoop.reasoner).not.toBeNull();
    expect(state.usage.perLoop.talker).toBeNull();
  });

  it('falls back to the default for a config value it does not recognize', async () => {
    const { internals } = await openPassthroughSession({
      duplex: flagFrom(),
      config: { agentMode: 'duplexx' },
    });

    expect(internals.buildAgentConfig().mode).toBe('passthrough');
  });
});

describe('the session says which agent it is running', () => {
  it('badges duplex in the footer', async () => {
    const ctx = await createDuplexSession(cwd, { duplex: flagFrom('--duplex') });

    expect(renderFooter(ctx.app)).toContain('duplex');
  });

  it('leaves the default unbadged', async () => {
    const { app } = await openPassthroughSession({ duplex: flagFrom() });

    // Positive precondition for the absence, twice over: the footer really
    // rendered, and this exact state would carry the badge had the mode been
    // duplex. Without both, the assertion also passes against an empty string
    // or a bar that never renders the badge at all.
    const footer = renderFooter(app);
    expect(footer).toContain('test/test');
    const wouldBadge = new StatusBar();
    wouldBadge.setState({ ...(app.statusState as Partial<StatusBarState>), agentMode: 'duplex' });
    expect(wouldBadge.render(160).join('')).toContain('duplex');

    expect(footer).not.toContain('duplex');
  });

  it('names the mode in /status, in both directions', async () => {
    const passthrough = await openPassthroughSession({ duplex: flagFrom() });
    await statusCommand.handler(passthrough.session, []);
    expect(lastNotification(passthrough.app)).toContain('Agent: passthrough');

    const duplex = await createDuplexSession(cwd, { duplex: flagFrom('--duplex') });
    await statusCommand.handler(duplex.session, []);
    expect(lastNotification(duplex.app)).toContain('Agent: duplex');
  });
});

describe('opting in on a provider with no fast tier', () => {
  it('reports the talker fallback and marks the footer', async () => {
    // The degenerate case: duplex assembles, but talker and reasoner are the
    // same model, so it delivers none of the responsiveness it was chosen for.
    const ctx = await createDuplexSession(
      cwd,
      { duplex: flagFrom('--duplex') },
      { model: unenumerableModel() },
    );

    expect(ctx.internals.buildAgentConfig().mode).toBe('duplex');
    const note = ctx.internals.agent!.getResolutionReport()
      .find((n) => n.code === 'talker-model-fallback');
    expect(note?.severity).toBe('degraded');

    // Still badged as duplex (it is), and marked as not the duplex that was
    // asked for. /status carries the reason.
    const footer = renderFooter(ctx.app);
    expect(footer).toContain('duplex');
    expect(footer).toContain('†');

    await statusCommand.handler(ctx.session, []);
    expect(lastNotification(ctx.app)).toContain(note!.remedy);
  });
});
