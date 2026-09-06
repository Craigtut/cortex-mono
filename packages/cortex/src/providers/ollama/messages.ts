import type { Context, Message } from '@earendil-works/pi-ai';

export interface OllamaMessage {
  role: string;
  content: string;
  thinking?: string;
  images?: string[];
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
  tool_call_id?: string;
}

/** Preserve native thinking and call identities, including restored legacy custom-provider turns. */
export function encodeOllamaMessages(context: Context, vision: boolean): OllamaMessage[] {
  const messages: OllamaMessage[] = [];
  if (context.systemPrompt) messages.push({ role: 'system', content: context.systemPrompt });
  const pending = new Map<string, string>();
  const closePending = () => {
    for (const [id, name] of pending) messages.push({ role: 'tool', content: 'Tool execution was interrupted.', tool_name: name, tool_call_id: id });
    pending.clear();
  };
  for (const message of context.messages as Message[]) {
    if (message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason)) continue;
    if (message.role !== 'toolResult') closePending();
    if (message.role === 'assistant') {
      const native: OllamaMessage = { role: 'assistant', content: '' };
      const calls: NonNullable<OllamaMessage['tool_calls']> = [];
      for (const block of message.content) {
        if (block.type === 'text') native.content += block.text;
        if (block.type === 'thinking' && !block.redacted) native.thinking = (native.thinking ?? '') + block.thinking;
        if (block.type === 'toolCall') {
          calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } });
          pending.set(block.id, block.name);
        }
      }
      if (calls.length) native.tool_calls = calls;
      messages.push(native);
    } else {
      const native: OllamaMessage = { role: message.role === 'user' ? 'user' : 'tool', content: '' };
      if (typeof message.content === 'string') native.content = message.content;
      else for (const block of message.content) {
        if (block.type === 'text') native.content += block.text;
        else if (block.type === 'image') {
          if (!vision) throw new Error('The selected Ollama model does not support images');
          (native.images ??= []).push(block.data);
        }
      }
      if (message.role === 'toolResult') {
        // Results for aborted turns whose calls were removed must not become orphan tool messages.
        if (!pending.has(message.toolCallId)) continue;
        native.tool_name = message.toolName;
        native.tool_call_id = message.toolCallId;
        pending.delete(message.toolCallId);
      }
      messages.push(native);
    }
  }
  closePending();
  return messages;
}
