/**
 * The liveness watchdog and the silence clock it reads: a working reasoner
 * must be distinguishable from a hung one, and a run waiting on the user
 * from one that is merely slow.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { LivenessWatchdog } from '../../src/duplex/watchdog.js';
import type { WatchdogPorts } from '../../src/duplex/watchdog.js';
import { ReasonerOutcomeReporter } from '../../src/duplex/reasoner-outcomes.js';
import type { AgentLoop } from '../../src/agent-loop.js';
import type { WakeClass } from '../../src/session-log.js';

const watchdogs: LivenessWatchdog[] = [];

afterEach(() => {
  for (const watchdog of watchdogs.splice(0)) watchdog.destroy();
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createWatchdog(overrides?: Partial<WatchdogPorts>): {
  reports: string[];
  state: {
    clock: number;
    startedAt: number | null;
    lastOutputAt: number;
    asks: Array<{ toolName: string; requestedAt: number }>;
  };
} {
  const reports: string[] = [];
  const state = {
    clock: 1_000_000,
    startedAt: null as number | null,
    lastOutputAt: 0,
    asks: [] as Array<{ toolName: string; requestedAt: number }>,
  };
  const watchdog = new LivenessWatchdog(
    {
      runStartedAt: () => state.startedAt,
      lastOutputAt: () => state.lastOutputAt,
      activeAliases: () => ['task-1'],
      pendingAsks: () => state.asks,
      reportProgress: (text) => reports.push(text),
      ...overrides,
    },
    { intervalMs: 200, now: () => state.clock },
  );
  watchdogs.push(watchdog);
  return { reports, state };
}

describe('LivenessWatchdog', () => {
  it('reports a long-silent attempt as still running, naming the work', async () => {
    const { reports, state } = createWatchdog();
    state.startedAt = state.clock;
    state.lastOutputAt = state.clock;
    state.clock += 250; // silence exceeds the interval on the injected clock
    await waitUntil(() => reports.length === 1);
    expect(reports[0]).toMatch(/Background work \(task-1\) is still running/);
  });

  it('says a run blocked on a permission ask is waiting on the user', async () => {
    const { reports, state } = createWatchdog();
    state.startedAt = state.clock;
    state.lastOutputAt = state.clock;
    state.asks = [{ toolName: 'Bash', requestedAt: state.clock }];
    state.clock += 250;
    await waitUntil(() => reports.length === 1);
    expect(reports[0]).toMatch(/waiting for the user's permission answer \(Bash\)/);
    expect(reports[0]).not.toMatch(/no update/);
  });

  it('stays quiet between attempts and while the reasoner is recently productive', async () => {
    const { reports, state } = createWatchdog();
    // No attempt live (idle, or a retry backoff).
    state.clock += 1_000;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(reports).toHaveLength(0);

    // Live, but it spoke 150ms ago on a 200ms interval.
    state.startedAt = state.clock - 300;
    state.lastOutputAt = state.clock - 150;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(reports).toHaveLength(0);
  });
});

describe('ReasonerOutcomeReporter silence clock and outcome', () => {
  function createReporter(): {
    reporter: ReasonerOutcomeReporter;
    intake: Array<{ content: string; wake: WakeClass | undefined; meta: unknown }>;
    clock: { t: number };
    run: { id: number | null };
    retired: { count: number };
  } {
    const intake: Array<{ content: string; wake: WakeClass | undefined; meta: unknown }> = [];
    const clock = { t: 5_000 };
    const run: { id: number | null } = { id: 1 };
    const retired = { count: 0 };
    const reporter = new ReasonerOutcomeReporter({
      reasoner: {} as AgentLoop,
      runId: () => run.id,
      router: {
        deliverFromReasoner: (content, wake, meta) => {
          intake.push({ content, wake, meta });
          return { delivered: true, ...(wake !== undefined ? { wake } : {}) };
        },
        retireRunDelegations: () => { retired.count += 1; },
      },
      headlines: { noteRetry: () => {}, clearRetry: () => {} },
      aggregateBreached: () => false,
      destroyed: () => false,
      now: () => clock.t,
    });
    return { reporter, intake, clock, run, retired };
  }

  function endedWith(text: string) {
    return {
      type: 'loop_end',
      timestamp: 0,
      payload: { messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] }] },
    } as never;
  }

  it('stamps the silence clock on every producer, progress notes included', () => {
    const { reporter, clock } = createReporter();
    reporter.noteAttemptStart();
    expect(reporter.lastOutputAt()).toBe(5_000);
    clock.t = 6_000;
    reporter.reportProgress('still going');
    expect(reporter.lastOutputAt()).toBe(6_000);
    clock.t = 7_000;
    reporter.deliverFromReasoner('halfway', 'silent');
    expect(reporter.lastOutputAt()).toBe(7_000);
    clock.t = 8_000;
    reporter.notify('restored', 'silent', { synthetic: true });
    expect(reporter.lastOutputAt()).toBe(8_000);
  });

  it('a concluding Deliver suppresses the implicit final text; progress never does', () => {
    const progress = createReporter();
    progress.reporter.noteAttemptStart();
    progress.reporter.deliverFromReasoner('halfway', 'silent');
    progress.reporter.reportProgress('still going');
    progress.reporter.noteAttemptEnd(endedWith('All done.'));
    expect(progress.intake.map((item) => item.content)).toEqual(['halfway', 'still going', 'All done.']);

    const concluded = createReporter();
    concluded.reporter.noteAttemptStart();
    concluded.reporter.deliverFromReasoner('The result.', 'when_idle');
    concluded.reporter.noteAttemptEnd(endedWith('All done.'));
    expect(concluded.intake.map((item) => item.content)).toEqual(['The result.']);

    // The next run's outcome is open again.
    concluded.run.id = 2;
    concluded.reporter.noteAttemptStart();
    concluded.reporter.noteAttemptEnd(endedWith('Second result.'));
    expect(concluded.intake.at(-1)!.content).toBe('Second result.');
  });

  it('retires the stopped run delegations whoever stopped it, announcing only an unrequested stop', () => {
    // A user abort: acknowledged when asked for, so nothing is delivered,
    // but the work the run served is no longer in progress.
    const { reporter, intake, retired } = createReporter();
    reporter.expectAbort('user');
    reporter.noteAttemptStart();
    reporter.noteAttemptEnd({
      type: 'loop_end',
      payload: { messages: [{ role: 'assistant', stopReason: 'aborted', content: [] }] },
    } as never);
    expect(retired.count).toBe(1);
    expect(intake).toHaveLength(0);
  });

  it('keys the outcome by run: a retry attempt of a delivered run adds no implicit result', () => {
    // Attempt 1 delivers the result explicitly and then fails; the retry
    // ladder resumes the SAME run, and its closing text must not reach the
    // user as a second answer.
    const { reporter, intake, run } = createReporter();
    run.id = 7;
    reporter.noteAttemptStart();
    reporter.deliverFromReasoner('The result.', 'when_idle');
    reporter.noteAttemptStart();
    reporter.noteAttemptEnd(endedWith('Wrapping up: the result.'));
    expect(intake.map((item) => item.content)).toEqual(['The result.']);

    // Precondition for the negative above: a run that delivered nothing
    // does surface its closing text.
    run.id = 8;
    reporter.noteAttemptStart();
    reporter.noteAttemptEnd(endedWith('Fresh answer.'));
    expect(intake.at(-1)!.content).toBe('Fresh answer.');
  });
});
