/**
 * Which resident loop an event or callback came from, and what that means for
 * the transcript.
 *
 * Under duplex the facade's merged bridge carries both the talker and the
 * reasoner, and its fan-out callbacks fire for both. The user talks to one
 * loop (the conversation loop) while the other does the work, so each
 * rendering decision has to ask which loop it is looking at. In passthrough
 * there is one loop and every answer is the trivial one.
 */

import type { CortexAgentConfig, CortexEvent, LoopOriginContext } from '@animus-labs/cortex';

export class LoopRouting {
  /**
   * @param agentMode The facade mode this session runs, resolved once: the
   *   loops are assembled from it, so routing must never read another value.
   */
  constructor(private readonly agentMode: NonNullable<CortexAgentConfig['mode']>) {}

  /** The duplex talker's loop path, or null in passthrough, which has none. */
  private get talkerLoopPath(): string | null {
    return this.agentMode === 'duplex' ? 'talker' : null;
  }

  /**
   * The loop whose streamed text is the user-visible reply: the reasoner in
   * passthrough, the talker in duplex. Passthrough hands back the reasoner's
   * own bridge verbatim, so its events carry no `loopPath` at all; the duplex
   * merged bridge stamps every event with one.
   */
  private get conversationLoopPath(): string {
    return this.talkerLoopPath ?? 'reasoner';
  }

  /** True when an event came from the loop the user is actually talking to. */
  isConversationEvent(event: CortexEvent): boolean {
    return event.loopPath === undefined || event.loopPath === this.conversationLoopPath;
  }

  /**
   * True when an event came from the talker.
   *
   * Used to keep the talker's tool calls out of the transcript. The talker's
   * toolset is fixed and is entirely control plumbing (`spawn_task`,
   * `steer_task`, `cancel_task`, `quick_lookup`, `answer_ask`): it has no
   * file, shell, MCP or sub-agent tools, by construction. A coding CLI's
   * transcript is a record of what was done to the workspace, and routing
   * chatter rendered beside Read/Edit/Bash is noise that reads like work.
   *
   * Filtered on the loop rather than on a list of tool names deliberately, so
   * a control tool added to the talker later is hidden by inheritance instead
   * of appearing in the transcript the day it ships. Sub-agent tool calls are
   * unaffected: they carry `childTaskId` and their own `reasoner/<taskId>`
   * path, and are handled by the child-event branches.
   */
  isTalkerEvent(event: CortexEvent): boolean {
    return this.talkerLoopPath !== null && event.loopPath === this.talkerLoopPath;
  }

  /**
   * Whether a fan-out callback came from the loop doing the user's work.
   *
   * Defined by excluding the talker rather than by naming the reasoner, so it
   * cannot be wrong about what the reasoner's loop path is called: passthrough
   * has no talker and every origin is work, and a sub-agent
   * (`reasoner/<taskId>`) is work too, which is what its compaction and
   * observation events should count as.
   */
  isWorkLoop(origin: LoopOriginContext): boolean {
    return origin.loopPath !== this.talkerLoopPath;
  }
}
