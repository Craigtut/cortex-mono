/**
 * The `pre_turn` lifecycle hook: outside processes inject context the agent
 * should see before a turn (e.g. inter-agent message notifications).
 */

import { log } from '../logger.js';
import { runHookHandlers } from './runner.js';
import type { HookHandler, PreTurnEnvelope } from './types.js';

/**
 * Invoke every registered `pre_turn` hook handler in parallel and prepend
 * their concatenated `additionalContext` (if any) to the user's prompt.
 * Returns the (possibly augmented) prompt text the agent should see.
 *
 * Hooks are external subprocesses; per-handler failures are logged and the
 * other handlers still run. If no handlers are configured or none return
 * context, the original prompt is returned unchanged.
 */
export async function applyPreTurnHooks(
  handlers: HookHandler[],
  session: { sessionId: string; cwd: string },
  userText: string,
): Promise<string> {
  if (handlers.length === 0) return userText;
  const envelope: PreTurnEnvelope = {
    event: 'pre_turn',
    sessionId: session.sessionId,
    cwd: session.cwd,
    timestamp: new Date().toISOString(),
    version: 1,
    userPrompt: userText,
  };
  const { additionalContext, results } = await runHookHandlers(handlers, envelope);
  for (const result of results) {
    if (result.error) {
      log.warn('pre_turn hook failed', {
        handler: result.handler.name,
        error: result.error,
        exitCode: result.exitCode,
        signal: result.signal,
      });
    }
  }
  if (additionalContext.length === 0) return userText;
  return `<pre-turn-context>\n${additionalContext}\n</pre-turn-context>\n\n${userText}`;
}
