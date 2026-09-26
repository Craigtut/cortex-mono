/**
 * The talker's D17 guards (decisions.md D17): the tool-result guard over
 * control-tool receipts and the stop-reason audit that repairs a truncated
 * turn. Both keep an exchange from ending silently, enforced in the loop's
 * result path rather than by prompt.
 */

import type {
  LoopDeliveryApi,
  LoopEventApi,
  LoopRunApi,
  LoopToolApi,
  ToolResultInterceptorInfo,
  ToolResultInterceptorResult,
} from '../agent-loop.js';

/** What the guards reach on the talker. */
type GuardedTalker = LoopRunApi & LoopDeliveryApi & LoopEventApi & LoopToolApi;
import type { CortexLogger } from '../types.js';
import { payloadOf } from '../event-bridge.js';
import type { CortexEvent } from '../event-bridge.js';
import { spokenText } from '../working-tags.js';
import { errorMessageOf } from '../error-classifier.js';
import { collectCauseTags } from './cause-tags.js';
import { isControlToolName } from './control-tools.js';
import { SPEAK_NOW_APPENDIX, TALKER_TRUNCATION_REPAIR_MESSAGE } from './prompts.js';

/** Append the D17 speak-now appendix to a control-tool receipt. */
function appendSpeakNudge(content: unknown): unknown {
  const nudge = `\n\n${SPEAK_NOW_APPENDIX}`;
  if (typeof content === 'string') return content + nudge;
  if (Array.isArray(content)) return [...content, { type: 'text', text: nudge }];
  return content;
}

export class TalkerGuards {
  private readonly logger: CortexLogger;
  private talker: GuardedTalker | null = null;
  /** One truncation repair per streak (D17 stop-reason audit). */
  private repairPending = false;

  constructor(logger: CortexLogger) {
    this.logger = logger;
  }

  /**
   * Install both guards on the talker. The audit listens on turn_end, so
   * handlers registered on the talker's turn_end before this run first.
   */
  attach(talker: GuardedTalker): void {
    this.talker = talker;
    talker.setToolResultInterceptor((info) => this.guardToolResult(info));
    talker.getEventBridge().on('turn_end', (event) => {
      if (event.childTaskId) return;
      this.auditTurnEnd(event);
    });
  }

  /** A restore starts a fresh streak. */
  resetForRestore(): void {
    this.repairPending = false;
  }

  /**
   * D17 terminate guards over control-tool results. Bare receipts (the
   * working-tags reminder is suppressed: a dispatch receipt must not carry
   * permanent per-exchange reminder tokens), and terminate suppression
   * when the assistant message spoke nothing, so a preamble-less tool call
   * cannot end the exchange silently: the forced follow-up turn speaks.
   */
  private guardToolResult(
    info: ToolResultInterceptorInfo,
  ): ToolResultInterceptorResult | undefined {
    if (!isControlToolName(info.toolName)) return undefined;
    if (info.isError) {
      // A pi-level error result already omits terminate, buying the one
      // recovery turn (bounded by the talker's hard maxTurns).
      return undefined;
    }
    const spoken = spokenText(info.assistantMessage);
    if (spoken.length === 0) {
      // Open question (review N3): a model that keeps answering the nudge
      // with another silent tool call oscillates here until the talker's
      // hard maxTurns aborts the exchange. Whether to cap the forced
      // follow-ups separately (and say what instead: give up silently, or
      // synthesize a spoken fallback) is a policy call deferred until real
      // usage shows how often fast-tier models actually oscillate.
      return {
        terminate: false,
        suppressWorkingTagsReminder: true,
        content: appendSpeakNudge(info.result.content),
      };
    }
    return { suppressWorkingTagsReminder: true };
  }

  /**
   * Stop-reason audit (D17): a maxTokens ('length') stop with no tool call
   * in the truncated message can leave a spoken acknowledgment with
   * nothing dispatched and no error anywhere. Run one repair turn; a
   * truncated repair does not repair again until a clean turn resets the
   * streak.
   */
  private auditTurnEnd(event: CortexEvent): void {
    const message = payloadOf(event, 'turn_end')?.message;
    const truncated = message?.stopReason === 'length';
    const content = message?.content;
    const hasToolCall = Array.isArray(content) &&
      content.some((block) => (block as { type?: string } | null)?.type === 'toolCall');
    if (truncated && !hasToolCall) {
      if (!this.repairPending && this.talker) {
        this.repairPending = true;
        try {
          // The audit runs during the still-live run (turn_end fires while
          // the gate is held), so the run's cause tags are readable here
          // and ride the repair delivery as its causeTag. Without this the
          // repair turn carries an empty chain, and a user's "yes, go
          // ahead" into a turn that truncates would get consent refused by
          // D16 for a reason unrelated to consent. The FULL set travels
          // (as an array in the single causeTag slot; collectCauseTags
          // flattens it), never a collapsed seq, so mixed-kind causes stay
          // distinguishable in the repair run.
          const causeTags = collectCauseTags(this.talker.activeRunCauseTags);
          this.talker.deliver(TALKER_TRUNCATION_REPAIR_MESSAGE, {
            wake: true,
            ...(causeTags.length > 0 ? { causeTag: causeTags } : {}),
          });
        } catch (err) {
          this.logger.warn('truncation repair delivery failed', {
            error: errorMessageOf(err),
          });
        }
      }
      return;
    }
    this.repairPending = false;
  }
}
