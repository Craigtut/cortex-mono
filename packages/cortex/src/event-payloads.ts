/**
 * Typed event payloads: what each normalized event type carries in
 * CortexEvent.payload, extracted once from pi's raw event by the bridge
 * that emits it, and read back narrowed by type through payloadOf(). The
 * one place a raw pi event is cast, so no subscriber casts `event.data`.
 */

import type { CortexEvent, CortexEventType, PiEvent } from './event-bridge.js';
import type {
  LoopEndPayload,
  TalkerDeltaPayload,
  ToolCallEndPayload,
  ToolCallStartPayload,
  ToolCallUpdatePayload,
  ToolContentDetails,
  LoopMessageView,
  TurnEndPayload,
  UtilityUsagePayload,
} from './types.js';

/** The payload each event type carries. */
export interface CortexEventPayloads {
  tool_call_start: ToolCallStartPayload;
  tool_call_update: ToolCallUpdatePayload;
  tool_call_end: ToolCallEndPayload;
  turn_end: TurnEndPayload;
  loop_end: LoopEndPayload;
  utility_usage: UtilityUsagePayload;
  talker_delta: TalkerDeltaPayload;
}

/**
 * The event's payload when it is a `type` event, typed for that type, else
 * undefined.
 */
export function payloadOf<T extends keyof CortexEventPayloads>(
  event: CortexEvent,
  type: T,
): CortexEventPayloads[T] | undefined {
  if (event.type !== type) return undefined;
  return event.payload as CortexEventPayloads[T] | undefined;
}

/** The typed payload for a pi event mapped to `cortexType`, if it has one. */
export function extractPayload(
  cortexType: CortexEventType,
  piEvent: PiEvent,
): CortexEvent['payload'] {
  if (cortexType === 'turn_end') {
    const message = messageView(piEvent['message']);
    return (message ? { message } : {}) satisfies TurnEndPayload;
  }
  if (cortexType === 'loop_end') {
    const raw = piEvent['messages'];
    const messages = (Array.isArray(raw) ? raw : [])
      .map(messageView)
      .filter((message): message is LoopMessageView => message !== undefined);
    return { messages } satisfies LoopEndPayload;
  }
  return extractToolPayload(cortexType, piEvent);
}

function messageView(raw: unknown): LoopMessageView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const source = raw as Record<string, unknown>;
  const message: LoopMessageView = {};
  if (typeof source['role'] === 'string') message.role = source['role'];
  if ('content' in source) message.content = source['content'];
  if (typeof source['stopReason'] === 'string') message.stopReason = source['stopReason'];
  const errorMessage = source['errorMessage'];
  if (errorMessage != null) message.errorMessage = String(errorMessage);
  return message;
}

/** Typed payload for a pi tool event; undefined for any other event. */
function extractToolPayload(
  cortexType: CortexEventType,
  piEvent: PiEvent,
): ToolCallStartPayload | ToolCallUpdatePayload | ToolCallEndPayload | undefined {
  if (cortexType === 'tool_call_start') {
    return {
      toolCallId: String(piEvent['toolCallId'] ?? piEvent['id'] ?? ''),
      toolName: String(piEvent['toolName'] ?? piEvent['name'] ?? 'unknown'),
      args: (piEvent['args'] ?? piEvent['input'] ?? {}) as Record<string, unknown>,
    } satisfies ToolCallStartPayload;
  }

  if (cortexType === 'tool_call_update') {
    const partialResult = piEvent['partialResult'] as ToolContentDetails<unknown> | undefined;
    return {
      toolCallId: String(piEvent['toolCallId'] ?? piEvent['id'] ?? ''),
      toolName: String(piEvent['toolName'] ?? piEvent['name'] ?? 'unknown'),
      args: (piEvent['args'] ?? piEvent['input'] ?? {}) as Record<string, unknown>,
      partialResult: partialResult ?? { content: [], details: {} },
    } satisfies ToolCallUpdatePayload;
  }

  if (cortexType === 'tool_call_end') {
    const result = piEvent['result'] as ToolContentDetails<unknown> | undefined;
    const isError = Boolean(piEvent['isError']);
    const explicitError = piEvent['error'];
    const payload: ToolCallEndPayload = {
      toolCallId: String(piEvent['toolCallId'] ?? piEvent['id'] ?? ''),
      toolName: String(piEvent['toolName'] ?? piEvent['name'] ?? 'unknown'),
      result: result ?? { content: [], details: {} },
      durationMs: Number(piEvent['durationMs'] ?? piEvent['duration'] ?? 0),
      isError,
    };
    if (isError) {
      // Extract error text from multiple possible sources:
      // 1. Explicit error string field
      // 2. Error object with message
      // 3. Result content text (pi-agent-core puts error details here)
      // 4. Fallback
      let errorText: string | undefined;
      if (typeof explicitError === 'string') {
        errorText = explicitError;
      } else if (explicitError instanceof Error) {
        errorText = explicitError.message;
      } else if (typeof explicitError === 'object' && explicitError !== null && 'message' in (explicitError as Record<string, unknown>)) {
        errorText = String((explicitError as Record<string, unknown>)['message']);
      }

      // If no explicit error, extract from result content
      if (!errorText && result?.content) {
        const textParts = result.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map(c => c.text);
        if (textParts.length > 0) {
          errorText = textParts.join('\n');
        }
      }

      payload.error = errorText ?? 'unknown error';
    }
    return payload;
  }

  return undefined;
}
