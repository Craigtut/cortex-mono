/**
 * Shared test fixtures matching the REAL pi message shapes at runtime.
 *
 * Validated against node_modules/@earendil-works/pi-ai/dist/types.d.ts:
 *   - AssistantMessage.content blocks: TextContent | ThinkingContent | ToolCall
 *     where ToolCall = { type: 'toolCall', id, name, arguments }
 *   - Tool results are separate messages: ToolResultMessage =
 *     { role: 'toolResult', toolCallId, toolName, content, isError, timestamp }
 *   - pi-agent-core's agent loop pushes ONE toolResult message per tool call,
 *     so an assistant message with N parallel toolCall blocks is followed by
 *     N consecutive toolResult messages.
 */

import { expect } from 'vitest';
import type { AgentMessage } from '../../../src/context-manager.js';

export function makeUserMsg(content: string): AgentMessage {
  return { role: 'user', content, timestamp: 0 };
}

export function makeAssistantMsg(content: string): AgentMessage {
  return { role: 'assistant', content, timestamp: 0 };
}

export interface ToolCallSpec {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * Real assistant message carrying one or more 'toolCall' content blocks,
 * optionally preceded by a text block.
 */
export function makeToolCallMsg(calls: ToolCallSpec[], text?: string): AgentMessage {
  const content: Array<{ type: string; text?: string; [key: string]: unknown }> = [];
  if (text !== undefined) {
    content.push({ type: 'text', text });
  }
  for (const call of calls) {
    content.push({
      type: 'toolCall',
      id: call.id,
      name: call.name,
      arguments: call.arguments ?? {},
    });
  }
  return { role: 'assistant', content, timestamp: 0 };
}

/**
 * Real runtime tool result message (role 'toolResult', one per tool call).
 */
export function makeToolResultMsg(
  toolCallId: string,
  toolName: string,
  text: string,
): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 0,
  };
}

/**
 * Assert the structural invariant providers require:
 *   - every toolResult message references a toolCall that appears in an
 *     EARLIER assistant message in the same slice (an orphaned result is a
 *     hard provider 400), and
 *   - every toolCall block has a matching toolResult message later in the
 *     slice (an orphaned call gets a synthetic error result injected).
 */
export function assertNoOrphans(messages: AgentMessage[]): void {
  const seenCallIds = new Set<string>();
  const answeredCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'toolCall' && typeof part['id'] === 'string') {
          seenCallIds.add(part['id']);
        }
      }
    }
    if (msg.role === 'toolResult' && typeof msg.toolCallId === 'string') {
      expect(
        seenCallIds.has(msg.toolCallId),
        `orphaned tool result: ${msg.toolCallId} has no preceding toolCall`,
      ).toBe(true);
      answeredCallIds.add(msg.toolCallId);
    }
  }

  for (const id of seenCallIds) {
    expect(
      answeredCallIds.has(id),
      `orphaned tool call: ${id} has no toolResult`,
    ).toBe(true);
  }
}
