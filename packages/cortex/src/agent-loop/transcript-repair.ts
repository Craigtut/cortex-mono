/**
 * Transcript repair after a failed run. pi appends a synthetic assistant
 * failure stub when a run fails, and pushes a run's leading messages at run
 * start, before any model call; these functions decide what of that to
 * remove so the transcript can be resumed (continue() rejects a trailing
 * assistant turn) or the undelivered content re-delivered exactly once.
 *
 * Pure over the live message array (mutated in place); callers tell the
 * compaction manager when the tail was trimmed.
 */

import type { AgentMessage } from '../context-manager.js';
import { messageHasText, messageHasToolCalls, userMessageText } from '../pi-message.js';

type RawMessage = Record<string, unknown>;

function raw(message: AgentMessage | undefined): RawMessage {
  return message as unknown as RawMessage;
}

/**
 * Whether a transcript message is a synthetic failure stub that trimming
 * may remove. Error stubs (stopReason 'error' or errorMessage set) are
 * always trimmable: pi appends them with empty content, and continue()
 * rejects a trailing assistant turn.
 *
 * An aborted message (stopReason 'aborted') is different: pi returns the
 * accumulated PARTIAL content with that stopReason, and a consumer UI has
 * already shown any streamed text to the user. Trimming it would make the
 * model forget an answer the user read. So an aborted message is only
 * trimmable when it has no text to keep, or when it carries tool calls
 * (trailing ones are unpaired by construction, and an unpaired tool call
 * in history is a hard provider error on the next request).
 */
export function isTrimmableFailureMessage(msg: RawMessage): boolean {
  if (msg['role'] !== 'assistant') return false;
  const isAborted = msg['stopReason'] === 'aborted';
  if (msg['stopReason'] === 'error' || (msg['errorMessage'] != null && !isAborted)) {
    return true;
  }
  if (!isAborted) return false;
  return !messageHasText(msg) || messageHasToolCalls(msg);
}

/** Trailing failure stubs at or above index `floor`. */
export function trailingFailureCount(messages: readonly AgentMessage[], floor = 0): number {
  let end = messages.length;
  while (end > floor && isTrimmableFailureMessage(raw(messages[end - 1]))) {
    end -= 1;
  }
  return messages.length - end;
}

/**
 * Whether trimming trailing failure stubs would leave a transcript that
 * continue() can resume: the last message is a user or tool-result, and a
 * real conversation message sits past the slot region (a failure with
 * only slots present has nothing to resume, so it must surface instead).
 * Guards the rare failure that lands after an assistant tool-call turn but
 * before its tool results.
 */
export function isResumableAfterTrim(messages: readonly AgentMessage[], slotCount: number): boolean {
  const lastIndex = messages.length - trailingFailureCount(messages) - 1;
  if (lastIndex < slotCount) return false;
  return raw(messages[lastIndex])['role'] !== 'assistant';
}

/** Remove trailing failure stubs. Returns whether anything was removed. */
export function trimTrailingFailures(messages: AgentMessage[]): boolean {
  const trimCount = trailingFailureCount(messages);
  if (trimCount === 0) return false;
  messages.splice(messages.length - trimCount, trimCount);
  return true;
}

/**
 * After a failed delivery run (a sweep or a background drain), restore the
 * transcript to its pre-delivery state when possible: remove the run's
 * failure stubs and the delivery's user message, so a re-attempt does not
 * append the same body again.
 *
 * - 'requeue': the delivery message is no longer in the transcript (unwound
 *   here, or it never landed); the content must be re-queued to survive.
 * - 'durable': the run progressed past the delivery message (a model
 *   response, tool results, or a steer landed after it); its content stays
 *   in history, and re-queueing would duplicate it.
 *
 * When the run failed after an assistant tool-call turn but before its tool
 * results, the surviving tail carries an unpaired tool call (a hard
 * provider error on the very next request), so the whole delivery is
 * unwound. User messages pi injected inside that run (a public steer()
 * drained at a turn boundary, or a follow-up drained at a would-stop
 * point) are in the removed range; their text comes back as
 * `injectedUserTexts` so the caller can re-deliver it exactly once. The
 * transcript cannot tell a drained steer from a drained follow-up, so
 * re-injecting through either pi queue would guess the wrong semantics for
 * the other; the caller parks them for a clean run start instead.
 */
export function unwindFailedDelivery(
  messages: AgentMessage[],
  preDeliveryCount: number,
): { outcome: 'requeue' | 'durable'; injectedUserTexts: string[]; trimmed: boolean } {
  const injectedUserTexts: string[] = [];
  // Trim failure stubs appended during this run only; a stub predating
  // the delivery belongs to an earlier turn and stays.
  const stubs = trailingFailureCount(messages, preDeliveryCount);
  let trimmed = stubs > 0;
  if (trimmed) messages.splice(messages.length - stubs, stubs);

  if (messages.length <= preDeliveryCount) {
    // Nothing beyond the pre-delivery transcript survived (the failure
    // hit before pi pushed the message, or only stubs landed): nothing
    // to unwind, but the batch is not in history and must be re-queued.
    // (`<` covers a mid-run compaction shrinking history; the recent
    // tail survives compaction, so the delivery message is still there
    // and this branch is not taken in that case.)
    const outcome = messages.length === preDeliveryCount ? 'requeue' : 'durable';
    return { outcome, injectedUserTexts, trimmed };
  }
  if (messages.length === preDeliveryCount + 1 && raw(messages[messages.length - 1])['role'] === 'user') {
    messages.pop();
    return { outcome: 'requeue', injectedUserTexts, trimmed: true };
  }
  if (raw(messages[messages.length - 1])['role'] === 'assistant') {
    for (const message of messages.slice(preDeliveryCount + 1)) {
      const msg = raw(message);
      if (msg['role'] !== 'user') continue;
      const text = userMessageText(msg);
      if (text.trim().length > 0) injectedUserTexts.push(text);
    }
    messages.splice(preDeliveryCount, messages.length - preDeliveryCount);
    trimmed = true;
    return { outcome: 'requeue', injectedUserTexts, trimmed };
  }
  return { outcome: 'durable', injectedUserTexts, trimmed };
}

/**
 * After a terminal failure of a run whose leading batch carried spliced
 * wake deliveries, decide whether those deliveries still need a run.
 *
 * - 'repark': no run answered them. Either the failure hit before pi pushed
 *   the batch, or the run produced nothing beyond the batch (and failure
 *   stubs), in which case the wake messages are spliced back out here.
 * - 'durable': the run progressed past the batch; the content is history
 *   the next successful run sees, and re-parking would duplicate it.
 * - 'rewritten': only part of the batch sits at the boundary, so the
 *   transcript was rewritten under the run. Left untouched and not
 *   re-parked: duplicating content is worse than leaving it as context.
 *
 * Messages are identity-checked by role and content, so a mid-run history
 * rewrite can never cause an unrelated message to be removed. Only the
 * wake messages are removed; the prompt's own input and any flushed silent
 * deliveries keep ordinary failure semantics (they stay).
 *
 * @param boundary - Index where pi pushed the batch.
 * @param trailingBatchCount - Messages the batch carried after the wake
 *   portion (flushed silent deliveries); the prompt input follows those.
 */
export function unwindSplicedBatch(
  messages: AgentMessage[],
  wakeBatch: ReadonlyArray<{ content: string }>,
  boundary: number,
  trailingBatchCount: number,
): { outcome: 'repark' | 'durable' | 'rewritten'; trimmed: boolean } {
  let landed = 0;
  while (landed < wakeBatch.length) {
    const idx = boundary + landed;
    if (idx >= messages.length) break;
    const msg = raw(messages[idx]);
    if (msg['role'] !== 'user' || msg['content'] !== wakeBatch[landed]!.content) break;
    landed += 1;
  }

  if (landed === 0) return { outcome: 'repark', trimmed: false };
  if (landed < wakeBatch.length) return { outcome: 'rewritten', trimmed: false };

  // Progression test, ignoring trailing failure stubs: any survivor beyond
  // the pushed batch (wake, silent, and the prompt input) means the run
  // progressed past the content.
  const end = messages.length - trailingFailureCount(messages, boundary);
  if (end > boundary + wakeBatch.length + trailingBatchCount + 1) {
    return { outcome: 'durable', trimmed: false };
  }
  messages.splice(boundary, landed);
  return { outcome: 'repark', trimmed: true };
}
