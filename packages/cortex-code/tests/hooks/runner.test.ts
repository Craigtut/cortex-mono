import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { runHookHandler, runHookHandlers, type SpawnFn } from '../../src/hooks/runner.js';
import type { HookEnvelope, HookHandler } from '../../src/hooks/types.js';

// ---------------------------------------------------------------------------
// Fake child process
// ---------------------------------------------------------------------------

class FakeReadable extends EventEmitter {
  private encoding: BufferEncoding | undefined;
  setEncoding(encoding: BufferEncoding): this {
    this.encoding = encoding;
    return this;
  }
  push(chunk: string): void {
    void this.encoding;
    this.emit('data', chunk);
  }
}

class FakeWritable {
  ended = false;
  writtenChunks: string[] = [];
  end(chunk?: string): void {
    if (chunk !== undefined) this.writtenChunks.push(chunk);
    this.ended = true;
  }
}

interface FakeChildOptions {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdoutChunks?: string[];
  stderrChunks?: string[];
  /** Delay before emitting exit, in ms. Default 5. */
  exitDelayMs?: number;
  /** Don't emit exit at all (simulates hang for timeout testing). */
  hang?: boolean;
}

class FakeChild extends EventEmitter {
  stdin = new FakeWritable();
  stdout = new FakeReadable();
  stderr = new FakeReadable();
  killed = false;
  constructor(private options: FakeChildOptions) {
    super();
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    void signal;
    this.emit('exit', null, 'SIGTERM');
    return true;
  }
  start(): void {
    for (const chunk of this.options.stdoutChunks ?? []) this.stdout.push(chunk);
    for (const chunk of this.options.stderrChunks ?? []) this.stderr.push(chunk);
    if (this.options.hang) return;
    setTimeout(() => {
      this.emit('exit', this.options.exitCode ?? 0, this.options.signal ?? null);
    }, this.options.exitDelayMs ?? 5);
  }
}

function fakeSpawn(opts: FakeChildOptions): SpawnFn {
  return (() => {
    const child = new FakeChild(opts);
    // start asynchronously so the caller can attach listeners first
    setImmediate(() => child.start());
    return child as unknown as import('node:child_process').ChildProcess;
  }) as SpawnFn;
}

function envelope(prompt = 'hi'): HookEnvelope {
  return {
    event: 'pre_turn',
    sessionId: 's',
    cwd: '/repo',
    timestamp: '2026-05-28T00:00:00Z',
    version: 1,
    userPrompt: prompt,
  };
}

const handler: HookHandler = {
  name: 'reverie',
  command: 'reverie-hook',
  source: 'global',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runHookHandler', () => {
  it('returns parsed response when the handler exits cleanly', async () => {
    const spawn = fakeSpawn({
      exitCode: 0,
      stdoutChunks: [`${JSON.stringify({ additionalContext: 'You have 1 unread message.' })}\n`],
    });
    const result = await runHookHandler(handler, envelope(), { spawnImpl: spawn });
    expect(result.error).toBeUndefined();
    expect(result.response).toEqual({ additionalContext: 'You have 1 unread message.' });
  });

  it('flags exit_nonzero when the handler returns a nonzero code', async () => {
    const spawn = fakeSpawn({ exitCode: 2, stderrChunks: ['oh no\n'] });
    const result = await runHookHandler(handler, envelope(), { spawnImpl: spawn });
    expect(result.error).toBe('exit_nonzero');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('oh no');
  });

  it('flags invalid_json when stdout is not parseable', async () => {
    const spawn = fakeSpawn({ exitCode: 0, stdoutChunks: ['not-json\n'] });
    const result = await runHookHandler(handler, envelope(), { spawnImpl: spawn });
    expect(result.error).toBe('invalid_json');
  });

  it('flags no_output when stdout is empty', async () => {
    const spawn = fakeSpawn({ exitCode: 0, stdoutChunks: [] });
    const result = await runHookHandler(handler, envelope(), { spawnImpl: spawn });
    expect(result.error).toBe('no_output');
  });

  it('kills the child and flags timeout when it hangs past timeoutMs', async () => {
    const spawn = fakeSpawn({ hang: true });
    const result = await runHookHandler(
      { ...handler, timeoutMs: 25 },
      envelope(),
      { spawnImpl: spawn },
    );
    expect(result.error).toBe('timeout');
  });

  it('writes the envelope as one JSON line to handler stdin', async () => {
    let captured: FakeChild | undefined;
    const spawnImpl: SpawnFn = ((): import('node:child_process').ChildProcess => {
      const child = new FakeChild({
        exitCode: 0,
        stdoutChunks: [`${JSON.stringify({ additionalContext: 'ok' })}\n`],
      });
      captured = child;
      setImmediate(() => child.start());
      return child as unknown as import('node:child_process').ChildProcess;
    }) as SpawnFn;
    await runHookHandler(handler, envelope('hello'), { spawnImpl });
    expect(captured?.stdin.ended).toBe(true);
    const written = captured?.stdin.writtenChunks.join('') ?? '';
    expect(written.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(written.trim());
    expect(parsed.event).toBe('pre_turn');
    expect(parsed.userPrompt).toBe('hello');
  });
});

describe('runHookHandlers', () => {
  it('concatenates additionalContext across handlers in order', async () => {
    const spawnGood = (text: string): SpawnFn =>
      fakeSpawn({ exitCode: 0, stdoutChunks: [`${JSON.stringify({ additionalContext: text })}\n`] });
    // Sequence two handlers; the runner shares one spawnImpl, so use a counter.
    let call = 0;
    const spawnImpl: SpawnFn = ((cmd: string, args: string[], opts: import('node:child_process').SpawnOptions) => {
      call += 1;
      void cmd;
      void args;
      void opts;
      const text = call === 1 ? 'First note.' : 'Second note.';
      return spawnGood(text)(cmd, args, opts);
    }) as SpawnFn;

    const handlers: HookHandler[] = [
      { ...handler, name: 'a' },
      { ...handler, name: 'b' },
    ];
    const { additionalContext, results } = await runHookHandlers(handlers, envelope(), { spawnImpl });
    expect(results).toHaveLength(2);
    expect(additionalContext).toBe('First note.\n\nSecond note.');
  });

  it('skips handlers that error but still returns context from the successful ones', async () => {
    let call = 0;
    const spawnImpl: SpawnFn = ((cmd: string, args: string[], opts: import('node:child_process').SpawnOptions) => {
      call += 1;
      void cmd;
      void args;
      void opts;
      const child = new FakeChild(
        call === 1
          ? { exitCode: 1, stderrChunks: ['boom'] }
          : { exitCode: 0, stdoutChunks: [`${JSON.stringify({ additionalContext: 'ok' })}\n`] },
      );
      setImmediate(() => child.start());
      return child as unknown as import('node:child_process').ChildProcess;
    }) as SpawnFn;
    const handlers: HookHandler[] = [
      { ...handler, name: 'broken' },
      { ...handler, name: 'good' },
    ];
    const { additionalContext, results } = await runHookHandlers(handlers, envelope(), { spawnImpl });
    expect(additionalContext).toBe('ok');
    expect(results.find((r) => r.handler.name === 'broken')?.error).toBe('exit_nonzero');
  });
});
