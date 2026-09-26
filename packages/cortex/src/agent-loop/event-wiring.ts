/**
 * The loop's own subscriptions on its EventBridge: diagnostics, usage
 * accounting, context-size tracking for compaction, and the onLoopComplete
 * / onTurnComplete fan-out.
 *
 * Registered before the budget guard wires itself, so these listeners see
 * each event first (listener order is registration order).
 */

import type { AgentMessage } from '../context-manager.js';
import type { CompactionManager } from '../compaction/index.js';
import type { EventBridge } from '../event-bridge.js';
import { turnInputTokens, turnText } from '../pi-message.js';
import type { PromptWatchdogDiagnostics } from '../prompt-diagnostics.js';
import type {
  AgentTextOutput,
  CortexLogger,
  LoopOriginContext,
  UtilityUsagePayload,
} from '../types.js';
import { parseWorkingTags } from '../working-tags.js';
import type { HandlerList } from './handler-list.js';
import type { UsageLedger } from './usage-ledger.js';

export interface LoopEventDeps {
  logger: CortexLogger;
  diagnostics: Pick<PromptWatchdogDiagnostics, 'recordEvent'>;
  ledger: UsageLedger;
  /** pi's live state: the transcript plus the error of the run that just ended. */
  agentState(): { messages: AgentMessage[]; errorMessage?: unknown };
  slotCount(): number;
  /** Resolved per event: the manager is built after the wiring. */
  compaction(): CompactionManager;
  effectiveContextWindow(): number;
  /** Budget figures for the loop_end log line. */
  budgetSummary(): { turns: number; totalCost: number };
  /** A logical turn ended: per-loop state that lives for one turn resets. */
  onLoopEnd(): void;
  loopComplete: HandlerList<[LoopOriginContext]>;
  turnComplete: HandlerList<[AgentTextOutput, LoopOriginContext]>;
  origin: LoopOriginContext;
}

/** Subscribe the loop's internal listeners; returns their unsubscribe. */
export function wireLoopEvents(bridge: EventBridge, deps: LoopEventDeps): () => void {
  const { logger, ledger } = deps;
  const unsubscribers: Array<() => void> = [];

  unsubscribers.push(
    bridge.onAll((event) => {
      deps.diagnostics.recordEvent(event);
    }),
  );

  // Accumulate direct/utility completion spend into session usage. One
  // listener covers this loop's own completions and forwarded child
  // completions (childTaskId set), mirroring how child turn_end usage rolls
  // into the parent totals.
  unsubscribers.push(
    bridge.on('utility_usage', (event) => {
      const usage = event.usage;
      if (!usage) return;
      const category =
        (event.payload as UtilityUsagePayload | undefined)?.category ?? 'utility';

      ledger.recordUtility(category, usage);

      logger.debug('utility usage', {
        category,
        cost: usage.cost.total,
        input: usage.input,
        output: usage.output,
        childTaskId: event.childTaskId,
        sessionTotalCost: ledger.totalCost,
      });
    }),
  );

  // Map loop_end -> onLoopComplete
  unsubscribers.push(
    bridge.on('loop_end', () => {
      // pi-agent-core emits agent_end for EVERY run that ends, including a run
      // that failed (it stores the failure in state.errorMessage). Background
      // retry means one logical turn can span several such runs, and
      // onLoopComplete must fire once per logical turn: firing it on a failed
      // attempt would let a consumer mark the turn idle while a retry is
      // still pending (and route its next message to prompt(), which throws,
      // instead of steer()). A turn that fails for good still surfaces via
      // onError plus the prompt() rejection; a retried turn fires
      // onLoopComplete on the run that finally succeeds (errorMessage is
      // cleared at the start of each run).
      if (deps.agentState().errorMessage) {
        logger.info('loop_end suppressed (run ended in error; retry may follow)');
        return;
      }
      const budget = deps.budgetSummary();
      logger.info('loop_end', {
        turns: budget.turns,
        totalCost: budget.totalCost,
        currentContextTokens: deps.compaction().currentContextTokenCount,
      });
      deps.onLoopEnd();
      deps.loopComplete.emit(deps.origin);
    }),
  );

  // Map turn_end -> context size, usage, and onTurnComplete
  unsubscribers.push(
    bridge.on('turn_end', (event) => {
      const isChildEvent = Boolean(event.childTaskId);

      // Stamp any new messages that lack a timestamp. Messages are added
      // by pi-agent-core during the agentic loop (user prompts, assistant
      // responses, tool results). Cortex stamps them here at the turn
      // boundary so they carry temporal metadata for observational memory.
      if (!isChildEvent) {
        const now = Date.now();
        const messages = deps.agentState().messages;
        for (let i = deps.slotCount(); i < messages.length; i++) {
          const msg = messages[i];
          if (msg && msg.timestamp == null) {
            msg.timestamp = now;
          }
        }
      }

      // Context size and observation buffering track this loop's own turns
      // only (child tokens don't fill this context window). The bridge's
      // typed usage is preferred; raw event data is the fallback when the
      // provider reported partial usage the bridge could not type.
      const usage = event.usage;
      if (!isChildEvent) {
        const inputTokens = usage
          ? usage.input + usage.cacheRead + usage.cacheWrite
          : turnInputTokens(event.data);
        const compaction = deps.compaction();
        if (inputTokens > 0) {
          compaction.updateCurrentContextTokenCount(inputTokens);
        }
        if ((usage || inputTokens > 0) && compaction.strategy === 'observational') {
          compaction.onTurnEnd(
            inputTokens,
            deps.effectiveContextWindow(),
            deps.agentState().messages,
            deps.slotCount(),
          );
        }
      }

      // Session usage accumulates parent and forwarded child turns alike.
      if (usage) {
        ledger.recordTurn(usage);
        logger.debug('turn_end usage', {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cost: usage.cost.total,
          sessionTotalCost: ledger.totalCost,
          childTaskId: event.childTaskId,
        });
      } else if (!isChildEvent) {
        ledger.recordUnmeteredTurn();
      }

      // Only dispatch onTurnComplete for parent events. Child turn_end
      // events are forwarded by EventBridge.forwardFrom() but must not
      // surface in the parent's TUI; doing so leaks raw subagent text
      // (including XML tags and metadata) into the main chat thread. With
      // working tags disabled the bridge does not parse, so the raw text is
      // parsed here.
      if (!isChildEvent) {
        const text = event.textOutput ? null : turnText(event.data);
        const output = event.textOutput ?? (text ? parseWorkingTags(text) : null);
        if (output) deps.turnComplete.emit(output, deps.origin);
      }
    }),
  );

  return () => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  };
}
