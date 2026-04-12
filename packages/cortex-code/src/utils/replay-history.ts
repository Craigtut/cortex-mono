/**
 * Subset of the transcript API that message replay needs. Kept narrow so the
 * replay logic can be unit-tested against a simple fake.
 */
export interface ReplayTranscript {
  addUserMessage(text: string): void;
  startAssistantMessage(): void;
  appendAssistantChunk(chunk: string): void;
  finalizeAssistantMessage(finalText?: string): void;
  startToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): void;
  completeToolCall(toolCallId: string, result: unknown, details: unknown, durationMs: number): void;
  failToolCall(toolCallId: string, error: string, durationMs: number): void;
}

interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

interface HistoryMessage {
  role: string;
  content: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isBlock(v: unknown): v is ContentBlock {
  return isRecord(v) && typeof v['type'] === 'string';
}

function asMessage(v: unknown): HistoryMessage | null {
  if (!isRecord(v)) return null;
  if (typeof v['role'] !== 'string') return null;
  return v as unknown as HistoryMessage;
}

/**
 * Extract plain text from a tool_result `content` field. Tool results arrive
 * either as a string or an array of text blocks; we flatten either shape down
 * to a displayable string. Non-text blocks (images etc.) are ignored.
 */
function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isBlock(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text']);
    }
  }
  return parts.join('\n');
}

/**
 * Replay a saved session's message history into the transcript UI. The
 * history itself is already restored into Cortex's context by
 * `restoreConversationHistory`; this is purely a visual rehydration so the
 * user sees what they resumed.
 *
 * Walks messages in order, preserving interleaved text and tool_use blocks.
 * Pairs `tool_result` blocks in user messages with their earlier `tool_use`
 * by id. Any tool_use that never received a result (session interrupted
 * mid-tool) is rendered as a failed/interrupted call at the end.
 *
 * This function only calls transcript methods, which are pure UI mutations
 * with no network or persistence side effects. Safe to call at any time.
 */
export function replayHistoryToTranscript(
  history: unknown[],
  transcript: ReplayTranscript,
): void {
  const pendingToolCalls = new Set<string>();

  for (const raw of history) {
    const msg = asMessage(raw);
    if (!msg) continue;

    if (msg.role === 'user') {
      replayUserMessage(msg.content, transcript, pendingToolCalls);
    } else if (msg.role === 'assistant') {
      replayAssistantMessage(msg.content, transcript, pendingToolCalls);
    }
  }

  // Tool calls with no matching result: session ended mid-tool. Render as
  // interrupted so the UI doesn't show them as still-running spinners.
  for (const toolCallId of pendingToolCalls) {
    transcript.failToolCall(toolCallId, 'Interrupted before the tool completed.', 0);
  }
}

function replayUserMessage(
  content: unknown,
  transcript: ReplayTranscript,
  pendingToolCalls: Set<string>,
): void {
  if (typeof content === 'string') {
    if (content.trim()) transcript.addUserMessage(content);
    return;
  }
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!isBlock(block)) continue;

    if (block['type'] === 'text') {
      const text = typeof block['text'] === 'string' ? block['text'] : '';
      if (text.trim()) transcript.addUserMessage(text);
    } else if (block['type'] === 'tool_result') {
      const toolUseId = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : '';
      if (!toolUseId) continue;
      const text = extractToolResultText(block['content']);
      const isError = block['is_error'] === true;
      if (isError) {
        transcript.failToolCall(toolUseId, text || 'Tool error.', 0);
      } else {
        transcript.completeToolCall(toolUseId, { summary: text }, undefined, 0);
      }
      pendingToolCalls.delete(toolUseId);
    }
  }
}

function replayAssistantMessage(
  content: unknown,
  transcript: ReplayTranscript,
  pendingToolCalls: Set<string>,
): void {
  if (typeof content === 'string') {
    if (!content.trim()) return;
    transcript.startAssistantMessage();
    transcript.finalizeAssistantMessage(content);
    return;
  }
  if (!Array.isArray(content)) return;

  let assistantOpen = false;
  let assistantText = '';

  const flushAssistant = (): void => {
    if (!assistantOpen) return;
    transcript.finalizeAssistantMessage(assistantText);
    assistantOpen = false;
    assistantText = '';
  };

  for (const block of content) {
    if (!isBlock(block)) continue;

    if (block['type'] === 'text') {
      const text = typeof block['text'] === 'string' ? block['text'] : '';
      if (!text) continue;
      if (!assistantOpen) {
        transcript.startAssistantMessage();
        assistantOpen = true;
      }
      transcript.appendAssistantChunk(text);
      assistantText += text;
    } else if (block['type'] === 'tool_use') {
      flushAssistant();
      const id = typeof block['id'] === 'string' ? block['id'] : '';
      const name = typeof block['name'] === 'string' ? block['name'] : 'unknown';
      const input = isRecord(block['input']) ? block['input'] : {};
      if (!id) continue;
      transcript.startToolCall(id, name, input);
      pendingToolCalls.add(id);
    }
  }

  flushAssistant();
}
