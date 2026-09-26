/**
 * The assistant bubble while a reply streams in, and the working-tag subtitle
 * on the spinner line.
 *
 * Only the conversation loop's parent-level stream belongs here; the caller
 * filters child agents and, under duplex, the work loop before feeding it.
 */

import { INTERNAL_TAG_NAMES } from '@animus-labs/cortex';
import type { App } from '../tui/app.js';
import type { TranscriptManager } from '../tui/transcript.js';

export type AssistantStreamApp = Pick<App, 'removeWorkingTagSubtitle' | 'enqueueWorkingTagText'> & {
  transcript: Pick<TranscriptManager, 'startAssistantMessage' | 'appendAssistantChunk' | 'finalizeAssistantMessage'>;
};

export class AssistantStream {
  private assistantStarted = false;
  private rawStreamText = '';
  private workingTagOpen = false;

  constructor(private readonly getApp: () => AssistantStreamApp | null) {}

  /** A new response is starting: forget the last one's stream state. */
  begin(): void {
    this.reset();
    this.getApp()?.removeWorkingTagSubtitle();
  }

  /** Append one streamed chunk, opening the bubble on the first. */
  chunk(data: Record<string, unknown> | undefined): void {
    const app = this.getApp();
    if (!app) return;
    if (!this.assistantStarted) {
      app.transcript.startAssistantMessage();
      this.assistantStarted = true;
    }
    const delta = this.extractTextDelta(data);
    if (delta) {
      this.rawStreamText += delta;
      this.updateWorkingTagDisplay(app);
      app.transcript.appendAssistantChunk(delta);
    }
  }

  /**
   * The turn completed with its final user-facing text (working tags
   * stripped): replace the streamed bubble with it.
   */
  finish(userFacing: string): void {
    this.getApp()?.transcript.finalizeAssistantMessage(userFacing);
    this.reset();
  }

  private reset(): void {
    this.assistantStarted = false;
    this.rawStreamText = '';
    this.workingTagOpen = false;
  }

  /** Extract text delta from a pi-agent-core message_update event. */
  private extractTextDelta(data: Record<string, unknown> | undefined): string | null {
    if (!data) return null;

    // Pi-agent-core message_update events carry the streaming delta inside assistantMessageEvent
    const assistantEvent = data['assistantMessageEvent'] as Record<string, unknown> | undefined;
    if (assistantEvent && assistantEvent['type'] === 'text_delta') {
      const delta = assistantEvent['delta'];
      if (typeof delta === 'string') return delta;
    }

    // Fallback patterns for other provider shapes
    if (typeof data['text'] === 'string') return data['text'];
    if (typeof data['delta'] === 'string') return data['delta'];
    if (typeof data['content'] === 'string') return data['content'];
    const delta = data['delta'] as Record<string, unknown> | undefined;
    if (delta && typeof delta['text'] === 'string') return delta['text'];
    return null;
  }

  /**
   * Detect working tag close transitions and enqueue completed messages
   * for display at reading pace on the spinner line.
   */
  private updateWorkingTagDisplay(app: AssistantStreamApp): void {
    const rawText = this.rawStreamText;
    // Scan every internal-tag alias (<working>, <thinking>, ...) so a model
    // that drifted to its trained scratchpad tag still feeds the spinner
    // subtitle instead of silently vanishing from it.
    let lastOpenIdx = -1;
    let openTagLen = 0;
    let lastCloseIdx = -1;
    for (const name of INTERNAL_TAG_NAMES) {
      const openTag = `<${name}>`;
      const openIdx = rawText.lastIndexOf(openTag);
      if (openIdx > lastOpenIdx) {
        lastOpenIdx = openIdx;
        openTagLen = openTag.length;
      }
      lastCloseIdx = Math.max(lastCloseIdx, rawText.lastIndexOf(`</${name}>`));
    }

    if (lastOpenIdx > lastCloseIdx) {
      // Inside an unclosed working tag (streaming)
      this.workingTagOpen = true;
    } else if (this.workingTagOpen && lastCloseIdx >= lastOpenIdx) {
      // Working tag just closed: extract content and enqueue for display
      const content = rawText.slice(lastOpenIdx + openTagLen, lastCloseIdx).trim();
      if (content) {
        app.enqueueWorkingTagText(content);
      }
      this.workingTagOpen = false;
    }
  }
}
