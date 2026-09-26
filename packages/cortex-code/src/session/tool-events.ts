/**
 * Tool-call events: the transcript rows the user watches, and the records
 * the activity stream and durable transcript keep.
 */

import type {
  CortexAgent,
  CortexEvent,
  ToolCallEndPayload,
  ToolCallStartPayload,
  ToolCallUpdatePayload,
} from '@animus-labs/cortex';
import type { FileSessionActivityReporter } from '../activity/session-activity.js';
import type { FreezeDiagnostics } from '../diagnostics/freeze.js';
import { extractToolResultText, type TranscriptWriter } from '../persistence/transcript-writer.js';
import type { App } from '../tui/app.js';
import { buildToolDisplayArgs, summarizeToolStartArgs } from '../tui/tool-display-args.js';
import type { TranscriptManager } from '../tui/transcript.js';
import { log } from '../logger.js';
import type { LoopRouting } from './loop-routing.js';
import type { RetryStatusLine } from './retry-status.js';
import type { SubAgentActivity } from './sub-agent-activity.js';

export type EventBridge = ReturnType<CortexAgent['getEventBridge']>;

export type ToolRowApp = Pick<App, 'traceNextRender'> & {
  transcript: Pick<TranscriptManager, 'startToolCall' | 'updateToolCall' | 'failToolCall' | 'completeToolCall'>;
};

export interface ToolRowPorts {
  routing: Pick<LoopRouting, 'isTalkerEvent'>;
  retry: Pick<RetryStatusLine, 'noteProgress'>;
  subAgents: Pick<SubAgentActivity, 'toolStarted' | 'toolEnded'>;
  freezeDiagnostics: Pick<FreezeDiagnostics, 'isEnabled'>;
}

export interface ActivityRecordPorts {
  activity: Pick<
    FileSessionActivityReporter,
    'recordTurnStarted' | 'recordTurnEnded' | 'recordToolStarted' | 'recordToolEnded'
  >;
  transcriptWriter: Pick<TranscriptWriter, 'addToolCall' | 'addToolResult'>;
}

/** Render the parent's tool calls as transcript rows; child calls update their sub-agent row. */
export function wireToolRows(bridge: EventBridge, app: ToolRowApp, ports: ToolRowPorts): void {
  // Tool call lifecycle (uses typed payloads from EventBridge)
  bridge.on('tool_call_start', (event: CortexEvent) => {
    // Child agent tool events update the parent sub-agent row instead of
    // creating separate transcript rows.
    if (event.childTaskId) {
      ports.subAgents.toolStarted(event);
      return;
    }
    // The talker's control tools are routing plumbing, not work. See
    // isTalkerEvent().
    if (ports.routing.isTalkerEvent(event)) return;

    // A tool starting means the agent is making progress again.
    ports.retry.noteProgress();

    const p = event.payload as ToolCallStartPayload | undefined;
    const toolName = p?.toolName ?? String((event.data as Record<string, unknown> | undefined)?.['toolName'] ?? 'unknown');

    // SubAgent tool calls are displayed via the onSubAgentSpawned lifecycle hook
    if (toolName === 'SubAgent') return;

    const toolCallId = p?.toolCallId ?? String((event.data as Record<string, unknown> | undefined)?.['toolCallId'] ?? Math.random());
    const args = p?.args ?? ((event.data as Record<string, unknown> | undefined)?.['args'] as Record<string, unknown> ?? {});
    const displayArgs = buildToolDisplayArgs(toolName, args);
    const summary = summarizeToolStartArgs(toolName, toolCallId, args);
    const traceToolStarts = ports.freezeDiagnostics.isEnabled;

    if (traceToolStarts) {
      log.debug('[TUI] tool_call_start received', summary);
      app.traceNextRender(`tool-start:${toolName}:${toolCallId}`);
    }

    try {
      app.transcript.startToolCall(toolCallId, toolName, displayArgs);
      if (traceToolStarts) {
        log.debug('[TUI] tool_call_start queued', {
          ...summary,
          displayArgKeys: Object.keys(displayArgs),
        });
      }
    } catch (error) {
      log.error('[TUI] tool_call_start failed', {
        ...summary,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  });

  // Streaming tool updates (bash output, etc.)
  bridge.on('tool_call_update', (event: CortexEvent) => {
    if (event.childTaskId) return;
    if (ports.routing.isTalkerEvent(event)) return;

    const p = event.payload as ToolCallUpdatePayload | undefined;
    const toolCallId = p?.toolCallId ?? String((event.data as Record<string, unknown> | undefined)?.['toolCallId'] ?? '');
    const partialResult = p?.partialResult ?? (event.data as Record<string, unknown> | undefined)?.['partialResult'];

    if (partialResult) {
      app.transcript.updateToolCall(toolCallId, partialResult);
    }
  });

  bridge.on('tool_call_end', (event: CortexEvent) => {
    // Child agent tool events update the parent sub-agent row instead of
    // creating separate transcript rows.
    if (event.childTaskId) {
      ports.subAgents.toolEnded(event);
      return;
    }
    if (ports.routing.isTalkerEvent(event)) return;

    const p = event.payload as ToolCallEndPayload | undefined;
    const toolName = p?.toolName ?? String((event.data as Record<string, unknown> | undefined)?.['toolName'] ?? 'unknown');

    // SubAgent tool_call_end is handled via onSubAgentCompleted/onSubAgentFailed
    if (toolName === 'SubAgent') return;

    const toolCallId = p?.toolCallId ?? String((event.data as Record<string, unknown> | undefined)?.['toolCallId'] ?? '');
    const durationMs = p?.durationMs ?? Number((event.data as Record<string, unknown> | undefined)?.['durationMs'] ?? 0);

    if (p?.isError && p.error) {
      app.transcript.failToolCall(toolCallId, p.error, durationMs);
    } else {
      const result = p?.result ?? (event.data as Record<string, unknown> | undefined)?.['result'];
      const details = (result as Record<string, unknown> | undefined)?.['details'];
      app.transcript.completeToolCall(toolCallId, result, details, durationMs);
    }
  });
}

/**
 * Record turn boundaries and every tool call, children included, in the
 * activity stream and the durable transcript. Unfiltered by loop: both are
 * complete records, not views.
 */
export function wireActivityRecords(bridge: EventBridge, ports: ActivityRecordPorts): void {
  bridge.on('turn_start', () => {
    ports.activity.recordTurnStarted();
  });

  bridge.on('turn_end', () => {
    ports.activity.recordTurnEnded();
  });

  bridge.on('tool_call_start', (event: CortexEvent) => {
    const p = event.payload as ToolCallStartPayload | undefined;
    const data = event.data as Record<string, unknown> | undefined;
    const toolName = p?.toolName ?? String(data?.['toolName'] ?? 'unknown');
    const toolCallId = p?.toolCallId ?? String(data?.['toolCallId'] ?? data?.['id'] ?? Math.random());
    const args = p?.args ?? (data?.['args'] as Record<string, unknown> | undefined) ?? {};
    ports.activity.recordToolStarted({
      toolCallId,
      toolName,
      args,
      ...(event.childTaskId ? { childTaskId: event.childTaskId } : {}),
    });
    ports.transcriptWriter.addToolCall(toolCallId, toolName, args);
  });

  bridge.on('tool_call_end', (event: CortexEvent) => {
    const p = event.payload as ToolCallEndPayload | undefined;
    const data = event.data as Record<string, unknown> | undefined;
    const toolName = p?.toolName ?? String(data?.['toolName'] ?? 'unknown');
    const toolCallId = p?.toolCallId ?? String(data?.['toolCallId'] ?? data?.['id'] ?? '');
    const isError = p?.isError ?? Boolean(data?.['isError']);
    ports.activity.recordToolEnded({
      toolCallId,
      toolName,
      durationMs: p?.durationMs ?? Number(data?.['durationMs'] ?? data?.['duration'] ?? 0),
      isError,
      ...(p?.error ? { error: p.error } : {}),
      ...(event.childTaskId ? { childTaskId: event.childTaskId } : {}),
    });
    const output = isError && p?.error
      ? p.error
      : extractToolResultText(p?.result ?? data?.['result']);
    ports.transcriptWriter.addToolResult(toolCallId, isError, output);
  });
}
