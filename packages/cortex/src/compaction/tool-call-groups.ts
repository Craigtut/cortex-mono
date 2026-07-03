/**
 * Structural grouping of tool call messages with their tool results.
 *
 * In real pi conversations, one assistant message may carry N parallel
 * 'toolCall' content blocks; pi-agent-core then appends N separate
 * role 'toolResult' messages (one per call, in order). Providers require
 * every tool call to have a matching result and every result to have a
 * preceding matching call, so the assistant message plus its consecutive
 * toolResult messages form ONE atomic unit for compaction purposes:
 *
 *   - Layer 2 (summarization) must never split the preserved-tail boundary
 *     inside a group.
 *   - Layer 3 (emergency truncation) must drop the whole group or none of it.
 *
 * Orphaning either side corrupts the conversation: an orphaned toolResult
 * (result without its call) is a hard provider 400; an orphaned toolCall
 * gets a synthetic "No result provided" error injected by pi-ai.
 */

import type { AgentMessage } from '../context-manager.js';
import { isToolCallMessage, isToolResultMessage } from './microcompaction.js';

/**
 * Collect the tool call IDs from an assistant message's 'toolCall' blocks.
 */
export function extractToolCallIds(message: AgentMessage): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(message.content)) {
    return ids;
  }
  for (const part of message.content) {
    if (part.type === 'toolCall' && typeof part['id'] === 'string') {
      ids.add(part['id']);
    }
  }
  return ids;
}

/**
 * Extract the tool call ID a tool result message refers to.
 * Real runtime messages carry it as `toolCallId`; legacy content-part
 * shapes may carry it as a `tool_use_id` field on a 'tool_result' part.
 */
function extractToolResultCallId(message: AgentMessage): string | null {
  if (typeof message.toolCallId === 'string') {
    return message.toolCallId;
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'tool_result' && typeof part['tool_use_id'] === 'string') {
        return part['tool_use_id'];
      }
    }
  }
  return null;
}

/**
 * Find atomic tool call groups in conversation history.
 *
 * A group is a contiguous run of messages: one assistant message containing
 * 'toolCall' blocks followed by its consecutive toolResult messages. Results
 * whose IDs belong to a different call end the group (defensive; should not
 * occur in well-formed history). Results or calls missing IDs are grouped by
 * adjacency.
 *
 * Returns a map from every message index that belongs to a group to the full
 * ascending list of indices in that group. Indices within a group are always
 * contiguous. Messages outside any group are absent from the map.
 */
export function findToolCallGroups(history: AgentMessage[]): Map<number, number[]> {
  const groups = new Map<number, number[]>();

  let i = 0;
  while (i < history.length) {
    if (!isToolCallMessage(history[i]!)) {
      i++;
      continue;
    }

    const callIds = extractToolCallIds(history[i]!);
    const group = [i];
    let j = i + 1;
    while (j < history.length && isToolResultMessage(history[j]!)) {
      const resultId = extractToolResultCallId(history[j]!);
      // A result referencing an ID outside this assistant's calls belongs
      // to some other (malformed) sequence; end the group before it.
      if (resultId !== null && callIds.size > 0 && !callIds.has(resultId)) {
        break;
      }
      group.push(j);
      j++;
    }

    for (const idx of group) {
      groups.set(idx, group);
    }
    i = j;
  }

  return groups;
}
