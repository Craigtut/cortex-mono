/**
 * The duplex session's consumer event stream: one merged bridge over every
 * loop, plus the sanitized talker-delta stream voice consumers speak from.
 */

import type { AgentLoop } from '../agent-loop.js';
import type { CortexLogger } from '../types.js';
import { EventBridge, extractResponseChunkText } from '../event-bridge.js';
import type { CortexEvent } from '../event-bridge.js';
import { WorkingTagStreamFilter } from '../working-tags.js';

export class MergedEvents {
  /** The merged stream the facade hands consumers (getEventBridge). */
  readonly bridge: EventBridge;

  /**
   * One merged event stream, every event labeled with its loop path in its
   * own loopPath field. Never forwardFrom: that would stamp childTaskId, and
   * main-loop events arriving as pseudo-children go dark against every
   * `if (event.childTaskId) return;` consumer filter.
   */
  constructor(talker: AgentLoop, reasoner: AgentLoop, logger: CortexLogger) {
    this.bridge = new EventBridge(false, logger);
    const talkerBridge = talker.getEventBridge();
    this.bridge.forwardLoopFrom(talkerBridge, talker.loopPath);
    this.bridge.forwardLoopFrom(reasoner.getEventBridge(), reasoner.loopPath);

    // The sanitized talker-delta stream (F6): voice consumers must never
    // route raw response_chunk to TTS, because working tags are stripped
    // only at turn_end and split across chunks at arbitrary positions. The
    // filter holds text from any '<' until the tag disambiguates, per
    // assistant message; stream end releases a trailing prefix that never
    // became a tag and drops unterminated working content. flush() is
    // unconditional, so a close tag that never arrives cannot wedge the
    // stream.
    const mergedBridge = this.bridge;
    const deltaFilter = new WorkingTagStreamFilter();
    talkerBridge.on('response_start', (event) => {
      if (event.childTaskId) return;
      deltaFilter.reset();
    });
    talkerBridge.on('response_chunk', (event) => {
      if (event.childTaskId) return;
      const delta = extractResponseChunkText(event.data);
      if (delta === null || delta.length === 0) return;
      const clean = deltaFilter.push(delta);
      if (clean.length > 0) mergedBridge.emitTalkerDelta(clean, talker.loopPath);
    });
    const flushDeltaFilter = (event: CortexEvent): void => {
      if (event.childTaskId) return;
      const tail = deltaFilter.flush();
      if (tail.length > 0) mergedBridge.emitTalkerDelta(tail, talker.loopPath);
    };
    // response_end is the per-message end; turn_end backstops it (flush is
    // idempotent: the held text clears on the first release).
    talkerBridge.on('response_end', flushDeltaFilter);
    talkerBridge.on('turn_end', flushDeltaFilter);
  }

  /**
   * Label a quick-lookup loop's events on the merged stream ('lookup/lk-1'),
   * which also feeds the aggregate budget guard, so lookup spend is bounded
   * like everything else. Returns the detach function.
   */
  forwardLookup(loop: AgentLoop): () => void {
    return this.bridge.forwardLoopFrom(loop.getEventBridge(), loop.loopPath);
  }

  destroy(): void {
    this.bridge.destroy();
  }
}
