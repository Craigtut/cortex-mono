/**
 * Run a single hook handler as a subprocess.
 *
 * Protocol:
 *
 * - Spawn the handler with the configured command + args.
 * - Write the [`HookEnvelope`] as one JSON line to its stdin and close stdin.
 * - Wait up to `timeoutMs` for the handler to exit.
 * - Parse the first line of stdout as a [`HookResponse`].
 *
 * Errors (spawn failure, timeout, non-zero exit, bad JSON) are surfaced via
 * the returned `HookRunResult` so callers can decide whether to log,
 * abandon, or fall through. The handler's stderr is captured for diagnostics.
 */

import { spawn } from 'node:child_process';
import type { HookEnvelope, HookHandler, HookResponse } from './types.js';

const DEFAULT_TIMEOUT_MS = 5000;

export interface HookRunResult {
  handler: HookHandler;
  /** Parsed handler response, or `undefined` on any failure. */
  response?: HookResponse;
  /** Reason no response is available; `undefined` on success. */
  error?: 'spawn_failed' | 'timeout' | 'exit_nonzero' | 'invalid_json' | 'no_output';
  /** Handler stderr, possibly truncated for log noise. */
  stderr?: string;
  /** Handler exit code or signal, when known. */
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

/**
 * Inject a custom spawn for tests. The shape mirrors
 * `node:child_process.spawn`'s "command, args, options" arity.
 */
export type SpawnFn = (command: string, args: string[], options: import('node:child_process').SpawnOptions) => import('node:child_process').ChildProcess;

export interface RunHookOptions {
  /** Override the spawn implementation for tests. */
  spawnImpl?: SpawnFn;
  /** Cap on stderr length captured into the result, in bytes. Default 16 KB. */
  stderrCapBytes?: number;
}

/**
 * Execute one hook handler. Resolves to a [`HookRunResult`] in all cases:
 * exceptions are caught and converted.
 */
export async function runHookHandler(
  handler: HookHandler,
  envelope: HookEnvelope,
  options: RunHookOptions = {},
): Promise<HookRunResult> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = handler.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stderrCap = options.stderrCapBytes ?? 16 * 1024;

  const child = (() => {
    try {
      return spawnImpl(handler.command, handler.args ?? [], {
        cwd: handler.cwd,
        env: handler.env ? { ...process.env, ...handler.env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      void err;
      return null;
    }
  })();

  if (!child) {
    return { handler, error: 'spawn_failed' };
  }

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf-8');
  child.stderr?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < stderrCap) {
      stderr += chunk;
    }
  });

  const exitPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ exitCode: code, signal });
    });
    child.once('error', () => {
      resolve({ exitCode: null, signal: null });
    });
  });

  let timedOut = false;
  let killTimer: NodeJS.Timeout | null = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    // Escalate to SIGKILL after a 2s grace period in case the handler
    // ignores or traps SIGTERM. Otherwise a misbehaving handler could
    // deadlock the agent turn forever.
    killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 2000);
  }, timeoutMs);

  try {
    if (child.stdin) {
      const payload = `${JSON.stringify(envelope)}\n`;
      child.stdin.end(payload);
    }
  } catch (err) {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    void err;
    return { handler, error: 'spawn_failed', stderr };
  }

  const { exitCode, signal } = await exitPromise;
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);

  const result: HookRunResult = { handler };
  if (exitCode !== null) result.exitCode = exitCode;
  if (signal !== null) result.signal = signal;
  if (stderr.length > 0) result.stderr = stderr;
  if (timedOut) {
    result.error = 'timeout';
    return result;
  }
  if (exitCode !== 0) {
    result.error = 'exit_nonzero';
    return result;
  }
  const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstLine) {
    result.error = 'no_output';
    return result;
  }
  try {
    const parsed = JSON.parse(firstLine) as HookResponse;
    result.response = sanitizeResponse(parsed);
    return result;
  } catch {
    result.error = 'invalid_json';
    return result;
  }
}

/**
 * Run every handler for an event in parallel and concatenate
 * `additionalContext` values in the same order. Order: project handlers
 * appear after global ones because [`loadHookHandlers`] already merged them
 * that way. Failures from individual handlers do not affect the overall
 * return; consumers inspect the `results` array for diagnostics.
 */
export async function runHookHandlers(
  handlers: HookHandler[],
  envelope: HookEnvelope,
  options: RunHookOptions = {},
): Promise<{
  additionalContext: string;
  results: HookRunResult[];
}> {
  const results = await Promise.all(handlers.map((h) => runHookHandler(h, envelope, options)));
  const additionalContextParts: string[] = [];
  for (const result of results) {
    const ctx = result.response?.additionalContext;
    if (typeof ctx === 'string' && ctx.length > 0) {
      additionalContextParts.push(ctx);
    }
  }
  return {
    additionalContext: additionalContextParts.join('\n\n'),
    results,
  };
}

function sanitizeResponse(value: HookResponse): HookResponse {
  const out: HookResponse = {};
  if (typeof value.additionalContext === 'string' && value.additionalContext.length > 0) {
    out.additionalContext = value.additionalContext;
  }
  return out;
}
