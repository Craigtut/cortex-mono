import { describe, it, expect, vi } from 'vitest';
import {
  TitleManager,
  sanitizeTitle,
  type TitleCompletionContext,
} from '../../src/terminal/title-manager.js';

/** Flush the microtask + timer queue so fire-and-forget regeneration settles. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Control characters constructed at runtime so the source stays pure ASCII.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const NUL = String.fromCharCode(0x00);
const SOH = String.fromCharCode(0x01);
/** Matches any C0/C1/DEL control character. */
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('sanitizeTitle', () => {
  it('strips ESC, BEL, and all control characters (OSC injection guard)', () => {
    const result = sanitizeTitle(`Refactor${ESC}]0;pwned${BEL} auth layer`);
    expect(CONTROL_RE.test(result)).toBe(false);
    // Control bytes become spaces and collapse; surrounding text survives.
    expect(result).toContain('Refactor');
    expect(result).toContain('auth');
  });

  it('strips embedded control bytes and produces clean output', () => {
    const result = sanitizeTitle(`a${NUL}b${SOH}c`);
    expect(result).toBe('a b c');
    expect(CONTROL_RE.test(result)).toBe(false);
  });

  it('collapses newlines and whitespace', () => {
    expect(sanitizeTitle('Add\n\n  billing   webhooks')).toBe('Add billing webhooks');
  });

  it('strips wrapping quotes and backticks', () => {
    expect(sanitizeTitle('"Refactor auth"')).toBe('Refactor auth');
    expect(sanitizeTitle('`Debug websocket`')).toBe('Debug websocket');
  });

  it('drops a trailing period', () => {
    expect(sanitizeTitle('Refactor auth.')).toBe('Refactor auth');
  });

  it('clamps to the max length with an ellipsis', () => {
    const long = 'word '.repeat(40);
    const result = sanitizeTitle(long);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result.endsWith('…')).toBe(true);
  });

  it('returns empty for empty or all-control input', () => {
    expect(sanitizeTitle('')).toBe('');
    expect(sanitizeTitle(' ')).toBe('');
    expect(sanitizeTitle(`${NUL}${SOH}`)).toBe('');
  });
});

describe('TitleManager dynamic mode', () => {
  it('generates a title immediately on the first prompt', async () => {
    const setTitle = vi.fn();
    const complete = vi.fn(async () => 'Refactor auth');
    const mgr = new TitleManager({ mode: 'dynamic', cwd: '/home/u/proj', setTitle, complete });

    mgr.recordUserPrompt('please refactor the auth middleware');
    await flush();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(setTitle).toHaveBeenCalledWith('Refactor auth');
    expect(mgr.getCurrentTitle()).toBe('Refactor auth');
  });

  it('regenerates only every Nth completed turn (cadence)', async () => {
    const setTitle = vi.fn();
    const complete = vi.fn(async () => 'Some Title');
    const mgr = new TitleManager({
      mode: 'dynamic',
      cwd: '/home/u/proj',
      setTitle,
      complete,
      cadence: 5,
    });

    mgr.recordUserPrompt('first task');
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);

    // Four completed turns: still no new generation.
    for (let i = 0; i < 4; i++) mgr.onUserTurnComplete();
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);

    // Fifth turn crosses the cadence threshold.
    mgr.onUserTurnComplete();
    await flush();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('is single-flight and replays once when triggered mid-generation', async () => {
    const setTitle = vi.fn();
    const first = deferred<string>();
    const second = deferred<string>();
    const complete = vi
      .fn<(ctx: TitleCompletionContext) => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const mgr = new TitleManager({
      mode: 'dynamic',
      cwd: '/home/u/proj',
      setTitle,
      complete,
      cadence: 1,
    });

    // First generation is now in flight (unresolved).
    mgr.recordUserPrompt('start');
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);

    // Several triggers while in flight collapse into a single pending replay.
    mgr.onUserTurnComplete();
    mgr.onUserTurnComplete();
    mgr.onUserTurnComplete();
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);

    // Resolving the first run kicks off exactly one replay.
    first.resolve('Title One');
    await flush();
    expect(complete).toHaveBeenCalledTimes(2);

    second.resolve('Title Two');
    await flush();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(mgr.getCurrentTitle()).toBe('Title Two');
  });

  it('feeds the first prompt, recent prompts, and current title back to the model', async () => {
    const setTitle = vi.fn();
    const complete = vi
      .fn<(ctx: TitleCompletionContext) => Promise<string>>()
      .mockResolvedValueOnce('Login flow')
      .mockResolvedValueOnce('Password reset');
    const mgr = new TitleManager({
      mode: 'dynamic',
      cwd: '/home/u/proj',
      setTitle,
      complete,
      cadence: 1,
    });

    mgr.recordUserPrompt('build login flow');
    await flush();
    mgr.recordUserPrompt('add password reset');
    mgr.onUserTurnComplete();
    await flush();

    expect(complete).toHaveBeenCalledTimes(2);
    const secondCall = complete.mock.calls[1]![0];
    const content = secondCall.messages[0]!.content;
    expect(content).toContain('First request: build login flow');
    expect(content).toContain('add password reset');
    expect(content).toContain('Current tab title: "Login flow"');
  });

  it('does not change the title when generation fails', async () => {
    const setTitle = vi.fn();
    const onError = vi.fn();
    const complete = vi.fn(async () => {
      throw new Error('offline');
    });
    const mgr = new TitleManager({
      mode: 'dynamic',
      cwd: '/home/u/proj',
      setTitle,
      complete,
      onError,
    });

    mgr.recordUserPrompt('do something');
    await flush();

    expect(setTitle).not.toHaveBeenCalled();
    expect(mgr.getCurrentTitle()).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('sanitizes model output before applying it', async () => {
    const setTitle = vi.fn();
    const complete = vi.fn(async () => `"Fix ${BEL}parser${ESC} bug"`);
    const mgr = new TitleManager({ mode: 'dynamic', cwd: '/home/u/proj', setTitle, complete });

    mgr.recordUserPrompt('fix the parser');
    await flush();

    const applied = setTitle.mock.calls[0]![0] as string;
    expect(CONTROL_RE.test(applied)).toBe(false);
    expect(applied.startsWith('"')).toBe(false);
  });
});

describe('TitleManager static and off modes', () => {
  it('static mode sets the cwd basename once and never calls the model', async () => {
    const setTitle = vi.fn();
    const complete = vi.fn(async () => 'unused');
    const mgr = new TitleManager({ mode: 'static', cwd: '/home/u/my-project', setTitle, complete });

    mgr.start();
    mgr.recordUserPrompt('do work');
    mgr.onUserTurnComplete();
    await flush();

    expect(setTitle).toHaveBeenCalledTimes(1);
    expect(setTitle).toHaveBeenCalledWith('my-project');
    expect(complete).not.toHaveBeenCalled();
  });

  it('off mode never touches the title or the model', async () => {
    const setTitle = vi.fn();
    const complete = vi.fn(async () => 'unused');
    const mgr = new TitleManager({ mode: 'off', cwd: '/home/u/my-project', setTitle, complete });

    mgr.start();
    mgr.recordUserPrompt('do work');
    mgr.onUserTurnComplete();
    mgr.dispose();
    await flush();

    expect(setTitle).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('TitleManager.reset', () => {
  it('resets the tab to the cwd basename and treats the next prompt as new', async () => {
    const setTitle = vi.fn();
    const complete = vi
      .fn<(ctx: TitleCompletionContext) => Promise<string>>()
      .mockResolvedValueOnce('Refactor auth')
      .mockResolvedValueOnce('Add billing');
    const mgr = new TitleManager({ mode: 'dynamic', cwd: '/home/u/my-project', setTitle, complete });

    mgr.recordUserPrompt('refactor auth');
    await flush();
    expect(mgr.getCurrentTitle()).toBe('Refactor auth');

    mgr.reset();
    expect(setTitle).toHaveBeenLastCalledWith('my-project');
    expect(mgr.getCurrentTitle()).toBeNull();

    // Next prompt is a fresh first message: regenerates immediately, with no
    // stale hysteresis anchor in the model input.
    mgr.recordUserPrompt('add billing webhooks');
    await flush();
    expect(complete).toHaveBeenCalledTimes(2);
    const secondCall = complete.mock.calls[1]![0];
    expect(secondCall.messages[0]!.content).not.toContain('Current tab title');
    expect(mgr.getCurrentTitle()).toBe('Add billing');
  });

  it('neutralizes an in-flight generation so it cannot apply a stale title', async () => {
    const setTitle = vi.fn();
    const pending = deferred<string>();
    const complete = vi
      .fn<(ctx: TitleCompletionContext) => Promise<string>>()
      .mockReturnValueOnce(pending.promise);
    const mgr = new TitleManager({ mode: 'dynamic', cwd: '/home/u/my-project', setTitle, complete });

    mgr.recordUserPrompt('refactor auth');
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);

    // Reset while the first generation is still in flight.
    mgr.reset();
    pending.resolve('Refactor auth');
    await flush();

    // The stale result must not become the title; the last applied title is the
    // basename reset, not the resolved generation.
    expect(setTitle).toHaveBeenLastCalledWith('my-project');
    expect(mgr.getCurrentTitle()).toBeNull();
  });

  it('off mode reset never touches the title', () => {
    const setTitle = vi.fn();
    const complete = vi.fn(async () => 'unused');
    const mgr = new TitleManager({ mode: 'off', cwd: '/home/u/my-project', setTitle, complete });
    mgr.reset();
    expect(setTitle).not.toHaveBeenCalled();
  });
});

describe('TitleManager.dispose', () => {
  it('resets the title to the cwd basename and stops further work', async () => {
    const setTitle = vi.fn();
    const complete = vi.fn(async () => 'Refactor auth');
    const mgr = new TitleManager({ mode: 'dynamic', cwd: '/home/u/my-project', setTitle, complete });

    mgr.recordUserPrompt('refactor auth');
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);

    mgr.dispose();
    expect(setTitle).toHaveBeenLastCalledWith('my-project');

    // No further generations after disposal.
    mgr.recordUserPrompt('new work');
    mgr.onUserTurnComplete();
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
