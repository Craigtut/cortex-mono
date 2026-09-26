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
 * may remove. Error stubs are always trimmable.
 *
 * An aborted message keeps pi's PARTIAL content, which the user may already
 * have read, so it is trimmable only when it has no text to keep or carries
 * tool calls (trailing ones are unpaired, a hard provider error next
 * request).
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
 * continue() can resume: the last message is a user or tool-result past the
 * slot region (a failure with only slots present must surface instead).
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
 * transcript to its pre-delivery state when possible, so a re-attempt does
 * not append the same body again.
 *
 * - 'requeue': the delivery message is no longer in the transcript; the
 *   content must be re-queued to survive.
 * - 'durable': the run progressed past the delivery message; re-queueing
 *   would duplicate it.
 *
 * A tail ending in an assistant tool-call turn (unpaired, a hard provider
 * error next request) unwinds the whole delivery. User messages pi injected
 * inside that run come back as `injectedUserTexts` for exactly-once
 * re-delivery. The transcript cannot tell a drained steer from a drained
 * follow-up, so the caller parks them rather than guess a pi queue.
 */
export function unwindFailedDelivery(
  messages: AgentMessage[],
  preDeliveryCount: number,
): { outcome: 'requeue' | 'durable'; injectedUserTexts: string[]; trimmed: boolean } {
  const injectedUserTexts: string[] = [];
  // Only this run's stubs; an earlier turn's stub stays.
  const stubs = trailingFailureCount(messages, preDeliveryCount);
  let trimmed = stubs > 0;
  if (trimmed) messages.splice(messages.length - stubs, stubs);

  if (messages.length <= preDeliveryCount) {
    // Nothing beyond the pre-delivery transcript survived. `<` is a mid-run
    // compaction, which keeps the recent tail, so the delivery is durable.
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
 * - 'repark': no run answered them; landed wake messages are spliced out.
 * - 'durable': the run progressed past the batch; re-parking would
 *   duplicate it.
 * - 'rewritten': only part of the batch sits at the boundary. Left alone:
 *   duplicating content is worse than leaving it as context.
 *
 * Messages are identity-checked by role and content, so a mid-run history
 * rewrite never removes an unrelated message. The prompt input and flushed
 * silent deliveries stay.
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

  // Any survivor beyond the pushed batch, stubs aside, means progress.
  const end = messages.length - trailingFailureCount(messages, boundary);
  if (end > boundary + wakeBatch.length + trailingBatchCount + 1) {
    return { outcome: 'durable', trimmed: false };
  }
  messages.splice(boundary, landed);
  return { outcome: 'repark', trimmed: true };
}
