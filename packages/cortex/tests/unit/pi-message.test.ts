import { describe, it, expect } from 'vitest';
import {
  assistantText,
  assistantUsage,
  findLastAssistant,
  isToolCallPart,
  messageHasText,
  messageHasToolCalls,
  readUsage,
  toolCallArguments,
  toolCallNames,
  totalInputTokens,
  turnInputTokens,
  turnText,
  userMessageText,
  withPlaceholderContent,
} from '../../src/pi-message.js';

describe('pi-message', () => {
  describe('assistantText', () => {
    it('joins text parts and skips thinking and tool calls', () => {
      expect(assistantText({
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: 'a' },
          { type: 'toolCall', name: 'Bash', arguments: {} },
          { type: 'text', text: 'b' },
        ],
      })).toBe('ab');
    });

    it('reads string content and falls back to a top-level text', () => {
      expect(assistantText({ content: 'hi' })).toBe('hi');
      expect(assistantText({ text: 'top' })).toBe('top');
    });

    it('reads malformed input as empty', () => {
      expect(assistantText(null)).toBe('');
      expect(assistantText(undefined)).toBe('');
      expect(assistantText({ content: 42 })).toBe('');
    });
  });

  describe('content probes', () => {
    it('messageHasText ignores empty text parts', () => {
      expect(messageHasText({ content: [{ type: 'text', text: '' }] })).toBe(false);
      expect(messageHasText({ content: [{ type: 'text', text: 'x' }] })).toBe(true);
      expect(messageHasText({ content: '' })).toBe(false);
      expect(messageHasText({ content: 'x' })).toBe(true);
    });

    it('recognizes both tool-call part spellings', () => {
      expect(isToolCallPart({ type: 'toolCall' })).toBe(true);
      expect(isToolCallPart({ type: 'tool_use' })).toBe(true);
      expect(isToolCallPart({ type: 'text' })).toBe(false);
      expect(messageHasToolCalls({ content: [{ type: 'text' }, { type: 'tool_use' }] })).toBe(true);
      expect(messageHasToolCalls({ content: 'text' })).toBe(false);
    });

    it('toolCallArguments returns the named toolCall part arguments', () => {
      const message = {
        content: [
          { type: 'toolCall', name: 'Other', arguments: { a: 1 } },
          { type: 'toolCall', name: 'Emit', arguments: { b: 2 } },
        ],
      };
      expect(toolCallArguments(message, 'Emit')).toEqual({ b: 2 });
      expect(toolCallArguments(message, 'Missing')).toBeNull();
    });

    it('toolCallNames reads assistant tool calls in order', () => {
      expect(toolCallNames({
        role: 'assistant',
        content: [{ type: 'toolCall', name: 'Read' }, { type: 'tool_use', toolName: 'Bash' }, { type: 'tool_use' }],
      })).toEqual(['Read', 'Bash', 'unknown']);
      expect(toolCallNames({ role: 'user', content: [{ type: 'toolCall', name: 'Read' }] })).toEqual([]);
    });

    it('userMessageText joins every text-bearing part', () => {
      expect(userMessageText({ content: 'plain' })).toBe('plain');
      expect(userMessageText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { text: 'b' }] })).toBe('ab');
      expect(userMessageText({})).toBe('');
    });

    it('findLastAssistant returns the latest assistant message', () => {
      const first = { role: 'assistant', content: 'one' };
      const second = { role: 'assistant', content: 'two' };
      expect(findLastAssistant([first, { role: 'user' }, second, { role: 'toolResult' }])).toBe(second);
      expect(findLastAssistant([{ role: 'user' }])).toBeUndefined();
    });

    it('withPlaceholderContent patches only empty content', () => {
      const kept = { role: 'user', content: 'x' };
      expect(withPlaceholderContent(kept)).toBe(kept);
      for (const content of [undefined, null, []]) {
        expect(withPlaceholderContent({ role: 'toolResult', content })).toEqual({
          role: 'toolResult',
          content: [{ type: 'text', text: '(no output)' }],
        });
      }
    });
  });

  describe('usage', () => {
    it('readUsage defaults missing fields and derives totalTokens', () => {
      expect(readUsage({ input: 10, output: 5 })).toEqual({
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });
    });

    it('readUsage with requireNonZero drops an all-zero usage', () => {
      expect(readUsage({ input: 0, output: 0 })).not.toBeNull();
      expect(readUsage({ input: 0, output: 0 }, { requireNonZero: true })).toBeNull();
      expect(readUsage({ cacheRead: 3 }, { requireNonZero: true })).not.toBeNull();
    });

    it('assistantUsage stamps the model', () => {
      expect(assistantUsage({ model: 'm', usage: { input: 1 } })?.model).toBe('m');
      expect(assistantUsage({ usage: { input: 1 } })).not.toHaveProperty('model');
      expect(assistantUsage({ model: 'm' })).toBeNull();
    });

    it('totalInputTokens sums the cache fields and falls back to total minus output', () => {
      expect(totalInputTokens({ input: 1, cacheRead: 2, cacheWrite: 3 })).toBe(6);
      expect(totalInputTokens({ totalTokens: 10, output: 4 })).toBe(6);
      expect(totalInputTokens({ totalTokens: 4, output: 4 })).toBe(0);
    });
  });

  describe('turn_end events', () => {
    it('turnText reads pi typed-part content', () => {
      expect(turnText({
        message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'hello' }] },
      })).toBe('hello');
    });

    it('turnText prefers a top-level text, then message, then result', () => {
      expect(turnText({ text: 'top', message: { content: 'msg' } })).toBe('top');
      expect(turnText({ message: { content: 'msg' }, result: { content: 'res' } })).toBe('msg');
      expect(turnText({ message: { content: [{ type: 'toolCall' }] }, result: { content: 'res' } })).toBe('res');
      expect(turnText({ message: { content: [{ type: 'toolCall' }] } })).toBeNull();
    });

    it('turnInputTokens takes the first non-zero usage location', () => {
      expect(turnInputTokens({ message: { usage: { input: 0 } }, usage: { input: 7 } })).toBe(7);
      expect(turnInputTokens({ message: { usage: { input: 2, cacheRead: 3 } } })).toBe(5);
      expect(turnInputTokens({ result: { usage: { totalTokens: 9, output: 1 } } })).toBe(8);
      expect(turnInputTokens(null)).toBe(0);
    });
  });
});
