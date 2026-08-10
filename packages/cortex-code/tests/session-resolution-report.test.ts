/**
 * Surfacing what the session actually resolved to.
 *
 * Cortex can assemble a configuration that quietly differs from the one it
 * was handed: duplex on a provider whose models cannot be enumerated runs the
 * talker on the primary model, which looks entirely healthy and delivers none
 * of the latency the mode exists for. The framework reports that through
 * `getResolutionReport()`; this suite is about whether a user ever finds out.
 *
 * Both halves are driven end to end. The report comes from a real assembled
 * agent rather than hand-written notes, and the footer string comes from a
 * real StatusBar fed the state the SESSION pushed: a renderer test that built
 * its own input would prove the marker renders while saying nothing about
 * whether the session ever sets it, which is the half that can break.
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
import type { CortexModel } from '@animus-labs/cortex';
import { StatusBar, type StatusBarState } from '../src/tui/status.js';
import { statusCommand } from '../src/commands/status.js';
import {
  createDuplexSession,
  destroyHarnessAgents,
  type DuplexSession,
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

/** A provider Cortex cannot enumerate, so no fast tier resolves for the talker. */
function unenumerableModel(): CortexModel {
  return wrapModel({ provider: 'ollama', name: 'qwen3:32b' } as never, 'ollama', 'qwen3:32b');
}

function fastModel(): CortexModel {
  return wrapModel(
    { provider: 'anthropic', name: 'claude-haiku-4-5-20251001' } as never,
    'anthropic',
    'claude-haiku-4-5-20251001',
  );
}

/** The footer the session's own pushed state renders to, through the real bar. */
function renderFooter(ctx: DuplexSession, width = 160): string {
  const bar = new StatusBar();
  bar.setState(ctx.app.statusState as Partial<StatusBarState>);
  return bar.render(width).join('');
}

/** The body of the last notification the command wrote. */
function lastNotification(ctx: DuplexSession): string {
  const calls = ctx.app.transcript['addNotification']!.mock.calls;
  return String(calls[calls.length - 1]?.[1] ?? '');
}

describe('the footer marks a degraded resolution', () => {
  it('marks the model when the talker fell back to the primary model', async () => {
    const ctx = await createDuplexSession(cwd, {}, { model: unenumerableModel() });

    // Precondition: the session really did resolve into the degraded state,
    // so the assertion below is about surfacing rather than about a note that
    // was never produced.
    const notes = ctx.internals.agent!.getResolutionReport();
    expect(notes.map((n) => n.code)).toContain('talker-model-fallback');
    expect(notes.find((n) => n.code === 'talker-model-fallback')?.severity).toBe('degraded');

    expect(renderFooter(ctx)).toContain('†');
  });

  it('does not mark the model for an info-only note', async () => {
    // A default duplex session with no cost cap: one note, and it is info.
    const ctx = await createDuplexSession(cwd, {}, { talker: { model: fastModel() } });

    const notes = ctx.internals.agent!.getResolutionReport();
    expect(notes.map((n) => n.code)).toEqual(['duplex-cost-cap-unset']);
    expect(notes[0]!.severity).toBe('info');

    // Marking info would light the footer on every default duplex session,
    // at which point the marker stops carrying information.
    expect(renderFooter(ctx)).not.toContain('†');
  });

  it('leaves a cleanly resolved session unmarked', async () => {
    const ctx = await createDuplexSession(cwd, {}, {
      talker: { model: fastModel() },
      duplex: { maxTotalCost: 5 },
    });

    expect(ctx.internals.agent!.getResolutionReport()).toEqual([]);

    // Positive precondition for the absence, twice over: the footer really
    // rendered the segment the marker attaches to, and this exact state
    // would have carried a marker had the flag been set. Without both, the
    // assertion also passes against an empty string or a renderer that never
    // emits the mark at all.
    const footer = renderFooter(ctx);
    expect(footer).toContain('test/test');
    const wouldMark = new StatusBar();
    wouldMark.setState({
      ...(ctx.app.statusState as Partial<StatusBarState>),
      resolutionDegraded: true,
    });
    expect(wouldMark.render(160).join('')).toContain('†');

    expect(footer).not.toContain('†');
  });
});

describe('/status answers what the marker only hints at', () => {
  it('reports each note with its detail and remedy', async () => {
    const ctx = await createDuplexSession(cwd, {}, { model: unenumerableModel() });
    const note = ctx.internals.agent!.getResolutionReport()
      .find((n) => n.code === 'talker-model-fallback');
    expect(note).toBeDefined();

    await statusCommand.handler(ctx.session, []);

    const body = lastNotification(ctx);
    expect(body).toContain(note!.summary);
    expect(body).toContain(note!.detail);
    expect(body).toContain(note!.remedy);
  });

  it('shows info notes the footer deliberately withholds', async () => {
    const ctx = await createDuplexSession(cwd, {}, { talker: { model: fastModel() } });

    await statusCommand.handler(ctx.session, []);

    // The footer stays clean for these (asserted above); /status is where
    // they are meant to be findable.
    expect(renderFooter(ctx)).not.toContain('†');
    expect(lastNotification(ctx)).toContain('Set duplex.maxTotalCost.');
  });

  it('says so when nothing resolved differently', async () => {
    const ctx = await createDuplexSession(cwd, {}, {
      talker: { model: fastModel() },
      duplex: { maxTotalCost: 5 },
    });

    await statusCommand.handler(ctx.session, []);

    expect(lastNotification(ctx)).toContain('Everything resolved as configured.');
  });
});

describe('a note that appears after assembly still reaches the footer', () => {
  it('marks the footer when the egress resolver turns out to be unwired', async () => {
    // sandbox + resolveNetworkAccess configured, and nothing ever collects
    // the resolver: shell egress asks will fail closed. The framework cannot
    // know that at assembly (a consumer wires it on the line after create()
    // returns), so it records the note at the first prompt instead.
    const ctx = await createDuplexSession(cwd, {}, {
      talker: { model: fastModel() },
      duplex: { maxTotalCost: 5 },
      sandbox: { status: () => ({ mode: 'none' }) } as never,
      resolveNetworkAccess: async () => ({ decision: 'allow' as const }),
    });

    // Clean at startup, which is the precondition that makes the change below
    // mean something: a report that already carried the note would prove
    // nothing about when it was read.
    expect(ctx.internals.agent!.getResolutionReport()).toEqual([]);
    expect(renderFooter(ctx)).not.toContain('†');

    await ctx.internals.handleInput('do something');

    expect(ctx.internals.agent!.getResolutionReport().map((n) => n.code))
      .toContain('network-resolver-unwired');
    // Reads the report live. A flag captured once at startup would still be
    // false here, and this is the only note cortex-code can currently reach.
    expect(renderFooter(ctx)).toContain('†');
  });
});
