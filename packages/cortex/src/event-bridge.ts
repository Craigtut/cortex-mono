/**
 * Event bridge: maps pi-agent-core events to normalized consumer events.
 *
 * Pi-agent-core emits 10 events across 4 scopes (agent, turn, message, tool).
 * The event bridge normalizes these into a consumer-facing event stream for
 * logging, monitoring, and lifecycle hooks.
 *
 * Key mappings:
 *   agent_start  -> session_start
 *   agent_end    -> session_end (onLoopComplete fires here)
 *   turn_start   -> turn_start
 *   turn_end     -> turn_end + AgentTextOutput (parse working tags)
 *   message_start  -> response_start
 *   message_update -> response_chunk
 *   message_end    -> response_end
 *   tool_execution_start  -> tool_call_start
 *   tool_execution_update -> tool_call_update
 *   tool_execution_end    -> tool_call_end
 *
 * Child event forwarding:
 *   forwardFrom(childBridge, childTaskId) subscribes to a child agent's
 *   event bridge and re-emits events on this bridge with childTaskId set.
 *   Consumers use event.childTaskId to distinguish parent vs child events.
 *
 * Reference: cortex-architecture.md (Event Bridge section)
 */

import type {
  AgentTextOutput,
  CortexLogger,
  CortexUsage,
  ToolCallStartPayload,
  ToolCallUpdatePayload,
  ToolCallEndPayload,
  ToolContentDetails,
} from './types.js';
import { NOOP_LOGGER } from './noop-logger.js';
import { parseWorkingTags } from './working-tags.js';

// ---------------------------------------------------------------------------
// Normalized event types emitted to consumers
// ---------------------------------------------------------------------------

export type CortexEventType =
  | 'session_start'
  | 'session_end'
  | 'turn_start'
  | 'turn_end'
  | 'response_start'
  | 'response_chunk'
  | 'response_end'
  | 'tool_call_start'
  | 'tool_call_update'
  | 'tool_call_end';

/**
 * Normalized event data emitted by the event bridge.
 */
export interface CortexEvent {
  type: CortexEventType;
  /** The original pi-agent-core event data (opaque to the bridge). */
  data?: unknown;
  /** Parsed text output, present only for turn_end events. */
  textOutput?: AgentTextOutput;
  /**
   * Typed payload for tool events (tool_call_start, tool_call_update, tool_call_end).
   * Provides typed access to tool event data without casting `data`.
   */
  payload?: ToolCallStartPayload | ToolCallUpdatePayload | ToolCallEndPayload;
  /**
   * Extracted usage data from the LLM response, present on turn_end events.
   * Centralizes extraction from pi-ai's AssistantMessage.usage structure so
   * subscribers (BudgetGuard, CortexAgent, consumers) read typed data instead
   * of parsing the opaque `data` field themselves.
   */
  usage?: CortexUsage;
  /**
   * Present when this event originates from a child (sub-agent) event bridge.
   * The value is the sub-agent's task ID, allowing consumers to route events
   * to the correct UI component. Absent for parent agent events.
   */
  childTaskId?: string;
}

/**
 * Callback type for event listeners.
 */
export type CortexEventListener = (event: CortexEvent) => void;

// ---------------------------------------------------------------------------
// Pi-agent-core event types (minimal contract, no runtime dependency)
// ---------------------------------------------------------------------------

export type PiEventType =
  | 'agent_start'
  | 'agent_end'
  | 'turn_start'
  | 'turn_end'
  | 'message_start'
  | 'message_update'
  | 'message_end'
  | 'tool_execution_start'
  | 'tool_execution_update'
  | 'tool_execution_end';

export interface PiEvent {
  type: PiEventType;
  [key: string]: unknown;
}

/**
 * Minimal interface for pi-agent-core's Agent.subscribe().
 * Returns an unsubscribe function.
 */
export interface PiEventSource {
  subscribe(handler: (event: PiEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Event type mapping
// ---------------------------------------------------------------------------

const PI_TO_CORTEX_MAP: Partial<Record<PiEventType, CortexEventType>> = {
  agent_start: 'session_start',
  agent_end: 'session_end',
  turn_start: 'turn_start',
  turn_end: 'turn_end',
  message_start: 'response_start',
  message_update: 'response_chunk',
  message_end: 'response_end',
  tool_execution_start: 'tool_call_start',
  tool_execution_update: 'tool_call_update',
  tool_execution_end: 'tool_call_end',
};

// ---------------------------------------------------------------------------
// EventBridge
// ---------------------------------------------------------------------------

export class EventBridge {
  private readonly listeners = new Map<CortexEventType, Set<CortexEventListener>>();
  private readonly allListeners = new Set<CortexEventListener>();
  private unsubscribeFromPi: (() => void) | null = null;
  private workingTagsEnabled: boolean;
  private readonly logger: CortexLogger;

  /**
   * Create an EventBridge.
   *
   * @param workingTagsEnabled - Whether to parse working tags on turn_end
   * @param logger - Optional logger for diagnostics (defaults to silent no-op)
   */
  constructor(workingTagsEnabled = true, logger?: CortexLogger) {
    this.workingTagsEnabled = workingTagsEnabled;
    this.logger = logger ?? NOOP_LOGGER;
  }

  /**
   * Wire the bridge to a pi-agent-core Agent's event stream.
   * Stores the unsubscribe function for cleanup.
   *
   * @param source - The pi-agent-core Agent (or any PiEventSource)
   */
  wire(source: PiEventSource): void {
    // Clean up previous wiring if any
    this.unwire();

    this.unsubscribeFromPi = source.subscribe((piEvent: PiEvent) => {
      this.handlePiEvent(piEvent);
    });
  }

  /**
   * Disconnect from the pi-agent-core event stream.
   */
  unwire(): void {
    if (this.unsubscribeFromPi) {
      this.unsubscribeFromPi();
      this.unsubscribeFromPi = null;
    }
  }

  /**
   * Register a listener for a specific event type.
   *
   * @param type - The event type to listen for
   * @param listener - The callback function
   * @returns An unsubscribe function
   */
  on(type: CortexEventType, listener: CortexEventListener): () => void {
    let typeListeners = this.listeners.get(type);
    if (!typeListeners) {
      typeListeners = new Set();
      this.listeners.set(type, typeListeners);
    }
    typeListeners.add(listener);

    return () => {
      typeListeners!.delete(listener);
    };
  }

  /**
   * Register a listener for all event types.
   *
   * @param listener - The callback function
   * @returns An unsubscribe function
   */
  onAll(listener: CortexEventListener): () => void {
    this.allListeners.add(listener);
    return () => {
      this.allListeners.delete(listener);
    };
  }

  /**
   * Forward all events from a child agent's event bridge onto this bridge.
   *
   * Each forwarded event gets `childTaskId` set so consumers can distinguish
   * parent events from child events. Returns an unsubscribe function that
   * stops forwarding (call when the child agent completes or is destroyed).
   *
   * @param childBridge - The child agent's EventBridge
   * @param childTaskId - The sub-agent task ID to tag forwarded events with
   * @returns An unsubscribe function
   */
  forwardFrom(childBridge: EventBridge, childTaskId: string): () => void {
    return childBridge.onAll((event) => {
      this.emit({
        ...event,
        childTaskId,
      });
    });
  }

  /**
   * Update whether working tags parsing is enabled.
   */
  setWorkingTagsEnabled(enabled: boolean): void {
    this.workingTagsEnabled = enabled;
  }

  /**
   * Clean up all listeners and disconnect from the pi-agent-core event stream.
   */
  destroy(): void {
    this.unwire();
    this.listeners.clear();
    this.allListeners.clear();
  }

  /**
   * Handle a pi-agent-core event by mapping and emitting to consumers.
   */
  private handlePiEvent(piEvent: PiEvent): void {
    const cortexType = PI_TO_CORTEX_MAP[piEvent.type];
    if (!cortexType) {
      return;
    }

    const cortexEvent: CortexEvent = {
      type: cortexType,
      data: piEvent,
    };

    // Populate typed payload for tool events
    const payload = this.extractToolPayload(cortexType, piEvent);
    if (payload) {
      cortexEvent.payload = payload;
    }

    // For turn_end, extract typed usage and parse working tags
    if (cortexType === 'turn_end') {
      const usage = this.extractUsage(piEvent);
      if (usage) {
        cortexEvent.usage = usage;
      }

      if (this.workingTagsEnabled) {
        const text = this.extractTurnText(piEvent);
        if (text) {
          cortexEvent.textOutput = parseWorkingTags(text);
        }
      }
    }

    this.emit(cortexEvent);
  }

  /**
   * Extract a typed payload from a pi-agent-core tool event.
   * Returns undefined for non-tool events.
   */
  private extractToolPayload(
    cortexType: CortexEventType,
    piEvent: PiEvent,
  ): CortexEvent['payload'] {
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
      const error = piEvent['error'] as string | undefined;
      const payload: ToolCallEndPayload = {
        toolCallId: String(piEvent['toolCallId'] ?? piEvent['id'] ?? ''),
        toolName: String(piEvent['toolName'] ?? piEvent['name'] ?? 'unknown'),
        result: result ?? { content: [], details: {} },
        durationMs: Number(piEvent['durationMs'] ?? piEvent['duration'] ?? 0),
        isError,
      };
      if (isError) {
        payload.error = error ?? 'unknown error';
      }
      return payload;
    }

    return undefined;
  }

  /**
   * Extract the text content from a turn_end event.
   * Pi-agent-core's turn_end event carries the assistant message for that turn.
   */
  private extractTurnText(piEvent: PiEvent): string | null {
    // The turn_end event from pi-agent-core carries the assistant message.
    // The structure varies, so we try multiple access patterns.

    // Pattern 1: Direct text property
    if (typeof piEvent['text'] === 'string') {
      return piEvent['text'];
    }

    // Pattern 2: message.content as string
    const message = piEvent['message'] as Record<string, unknown> | undefined;
    if (message && typeof message['content'] === 'string') {
      return message['content'];
    }

    // Pattern 3: message.content as array with text parts
    if (message && Array.isArray(message['content'])) {
      const textParts = (message['content'] as Array<{ type: string; text?: string }>)
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text!);
      if (textParts.length > 0) {
        return textParts.join('');
      }
    }

    // Pattern 4: result.content
    const result = piEvent['result'] as Record<string, unknown> | undefined;
    if (result && typeof result['content'] === 'string') {
      return result['content'];
    }

    // Pattern 5: content on the content parts of the result
    if (result && Array.isArray(result['content'])) {
      const textParts = (result['content'] as Array<{ type: string; text?: string }>)
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text!);
      if (textParts.length > 0) {
        return textParts.join('');
      }
    }

    return null;
  }

  /**
   * Extract typed CortexUsage from a turn_end event.
   *
   * Pi-ai's AssistantMessage carries usage at message.usage with a nested
   * cost object. This method navigates the opaque event data once so all
   * subscribers receive clean, typed usage without duplicating extraction.
   */
  private extractUsage(piEvent: PiEvent): CortexUsage | null {
    // Pattern 1: message.usage (pi-ai AssistantMessage, the primary path)
    const message = piEvent['message'] as Record<string, unknown> | undefined;
    if (message) {
      const usage = this.buildUsageFromObject(message['usage']);
      if (usage) {
        if (typeof message['model'] === 'string') {
          usage.model = message['model'];
        }
        return usage;
      }
    }

    // Pattern 2: Direct usage property on the event
    const directUsage = this.buildUsageFromObject(piEvent['usage']);
    if (directUsage) return directUsage;

    // Pattern 3: result.usage
    const result = piEvent['result'] as Record<string, unknown> | undefined;
    if (result) {
      const resultUsage = this.buildUsageFromObject(result['usage']);
      if (resultUsage) return resultUsage;
    }

    return null;
  }

  /**
   * Build a CortexUsage from a raw usage-shaped object.
   * Returns null if the object is not a valid usage structure.
   */
  private buildUsageFromObject(raw: unknown): CortexUsage | null {
    if (!raw || typeof raw !== 'object') return null;

    const u = raw as Record<string, unknown>;
    const input = typeof u['input'] === 'number' ? u['input'] : 0;
    const output = typeof u['output'] === 'number' ? u['output'] : 0;
    const cacheRead = typeof u['cacheRead'] === 'number' ? u['cacheRead'] : 0;
    const cacheWrite = typeof u['cacheWrite'] === 'number' ? u['cacheWrite'] : 0;
    const totalTokens = typeof u['totalTokens'] === 'number' ? u['totalTokens'] : input + output;

    // At least one non-zero field to consider this a valid usage object
    if (input === 0 && output === 0 && cacheRead === 0 && totalTokens === 0) return null;

    let cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const costObj = u['cost'];
    if (costObj && typeof costObj === 'object') {
      const c = costObj as Record<string, unknown>;
      cost = {
        input: typeof c['input'] === 'number' ? c['input'] : 0,
        output: typeof c['output'] === 'number' ? c['output'] : 0,
        cacheRead: typeof c['cacheRead'] === 'number' ? c['cacheRead'] : 0,
        cacheWrite: typeof c['cacheWrite'] === 'number' ? c['cacheWrite'] : 0,
        total: typeof c['total'] === 'number' ? c['total'] : 0,
      };
    }

    return { input, output, cacheRead, cacheWrite, totalTokens, cost };
  }

  /**
   * Emit a normalized event to all matching listeners.
   * Each listener is wrapped in try/catch so a throwing listener
   * does not prevent subsequent listeners from receiving the event.
   */
  private emit(event: CortexEvent): void {
    // Notify type-specific listeners
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        try {
          listener(event);
        } catch (err) {
          this.logger.error('[EventBridge] listener threw', {
            eventType: event.type,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Notify catch-all listeners
    for (const listener of this.allListeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error('[EventBridge] catch-all listener threw', {
          eventType: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
