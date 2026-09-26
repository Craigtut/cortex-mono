/**
 * The conversation-delta buffer (decisions.md D18).
 *
 * Both sides of the conversation are buffered facade-side and flushed as a
 * context-only block INSIDE the next dispatch message, so a directive can
 * never reach the reasoner without the conversation it points at (a
 * directive parked behind a busy reasoner is delivered by a sweep run,
 * which never flushes the loop's silent queue; carrying the block in the
 * dispatch message makes the pairing exact in every loop state). Deltas
 * alone never start a reasoner turn.
 */

import { buildConversationBlock, DELTA_OVERFLOW_MARKER } from './prompts.js';
import type { ConversationDelta } from './prompts.js';

const DELTA_SPEAKERS: ReadonlySet<string> = new Set<ConversationDelta['speaker']>([
  'user', 'assistant', 'consumer', 'lookup',
]);

/** The persisted part of the buffer (DuplexRouterState). */
export interface ConversationDeltasState {
  /** Conversation the reasoner has not seen yet, flushed with the next dispatch. */
  conversationDeltas: ConversationDelta[];
  /** Whether that buffer already dropped lines (the next flush says so). */
  conversationDeltasOverflowed: boolean;
}

export class ConversationDeltas {
  private readonly maxChars: number;
  private buffer: ConversationDelta[] = [];
  private chars = 0;
  private overflowed = false;

  constructor(maxChars: number) {
    this.maxChars = maxChars;
  }

  /** Number of buffered deltas awaiting a dispatch flush. */
  get size(): number {
    return this.buffer.length;
  }

  /** Buffer one delta, dropping the oldest past the char bound. */
  push(delta: ConversationDelta): void {
    this.buffer.push(delta);
    this.chars += delta.text.length;
    while (this.chars > this.maxChars && this.buffer.length > 1) {
      const removed = this.buffer.shift()!;
      this.chars -= removed.text.length;
      this.overflowed = true;
    }
  }

  /** Take everything buffered as one conversation block, or null when empty. */
  consumeBlock(): string | null {
    if (this.buffer.length === 0) return null;
    const deltas = this.buffer.splice(0);
    this.chars = 0;
    if (this.overflowed) {
      deltas.unshift({ speaker: 'consumer', text: DELTA_OVERFLOW_MARKER });
      this.overflowed = false;
    }
    return buildConversationBlock(deltas);
  }

  /** Drop everything buffered; returns how many deltas went. */
  drop(): number {
    const dropped = this.buffer.length;
    this.buffer = [];
    this.chars = 0;
    this.overflowed = false;
    return dropped;
  }

  exportState(): ConversationDeltasState {
    return {
      conversationDeltas: this.buffer.map((delta) => ({ ...delta })),
      conversationDeltasOverflowed: this.overflowed,
    };
  }

  /** Re-apply persisted deltas, skipping anything malformed. */
  restoreState(state: Partial<ConversationDeltasState>): void {
    const deltas = Array.isArray(state.conversationDeltas) ? state.conversationDeltas : [];
    for (const delta of deltas) {
      if (typeof delta?.text === 'string' && DELTA_SPEAKERS.has(delta.speaker)) {
        this.push({ speaker: delta.speaker, text: delta.text });
      }
    }
    if (state.conversationDeltasOverflowed === true) this.overflowed = true;
  }
}
