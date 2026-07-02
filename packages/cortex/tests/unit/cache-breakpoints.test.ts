/**
 * Tests for the cache breakpoint module (cache-breakpoints.ts).
 *
 * Covers:
 * 1. computeCacheBreakpointIndices: API index counting that mirrors pi-ai's
 *    transformMessages + convertMessages (skips, toolResult merging)
 * 2. addCacheControlToMessage: breakpoint stamping on API messages
 * 3. applyCacheBreakpoints: full payload stamping (system/tool stripping,
 *    BP2/BP3 injection, 4-breakpoint budget)
 * 4. resolveDirectCompletionContext: raw/structured direct completion
 *    context assembly and validation
 */

import { describe, it, expect } from 'vitest';
import {
  computeCacheBreakpointIndices,
  addCacheControlToMessage,
  applyCacheBreakpoints,
  resolveDirectCompletionContext,
} from '../../src/cache-breakpoints.js';

describe('computeCacheBreakpointIndices', () => {
  it('computes BP2 for the last slot (2 slots)', () => {
    const messages = [
      { role: 'user', content: 'slot A' },
      { role: 'user', content: 'slot B' },
      { role: 'user', content: 'history msg' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    ];

    const result = computeCacheBreakpointIndices(messages, { slotCount: 2, boundary: 4 });
    // slot A = API index 0, slot B = API index 1 => BP2 = 1
    expect(result.bp2ApiIndex).toBe(1);
  });

  it('computes BP3 at the stable boundary with ephemeral', () => {
    const messages = [
      { role: 'user', content: 'slot A' },
      { role: 'user', content: 'slot B' },
      { role: 'user', content: 'old history' },
      { role: 'assistant', content: [{ type: 'text', text: 'old reply' }] },
      { role: 'user', content: 'ephemeral' },   // injected at boundary
      { role: 'user', content: 'new tick' },
    ];

    // prePromptMessageCount = 4, ephemeral injection extends boundary to 5
    const result = computeCacheBreakpointIndices(messages, { slotCount: 2, boundary: 5 });

    // slot A=0, slot B=1, old history=2, old reply=3, ephemeral=4
    expect(result.bp3ApiIndex).toBe(4);
  });

  it('computes BP3 with both ephemeral and skills injected', () => {
    const messages = [
      { role: 'user', content: 'slot A' },
      { role: 'user', content: 'slot B' },
      { role: 'user', content: 'old history' },
      { role: 'assistant', content: [{ type: 'text', text: 'old reply' }] },
      { role: 'user', content: 'ephemeral' },   // injected
      { role: 'user', content: 'skill' },        // injected
      { role: 'user', content: 'new tick' },
    ];

    // prePromptMessageCount = 4, 2 stable injections => boundary 6
    const result = computeCacheBreakpointIndices(messages, { slotCount: 2, boundary: 6 });

    // slot A=0, slot B=1, old history=2, old reply=3, ephemeral=4, skill=5
    expect(result.bp3ApiIndex).toBe(5);
  });

  it('skips empty user messages for API index counting', () => {
    const messages = [
      { role: 'user', content: '' },        // empty slot (skipped)
      { role: 'user', content: 'slot B' },  // slot B
      { role: 'user', content: 'history' },
    ];

    const result = computeCacheBreakpointIndices(messages, { slotCount: 2, boundary: 3 });

    // Empty slot A is skipped, so BP2 = apiIndex of slot B = 0
    expect(result.bp2ApiIndex).toBe(0);
  });

  it('keeps BP2 when the LAST slot is empty (falls back to previous slot)', () => {
    const messages = [
      { role: 'user', content: 'slot A' },
      { role: 'user', content: '' },        // empty last slot (skipped)
      { role: 'user', content: 'history' },
      { role: 'user', content: 'prompt' },
    ];

    const result = computeCacheBreakpointIndices(messages, { slotCount: 2, boundary: 3 });

    // slot A = 0 survives; BP2 must not be lost
    expect(result.bp2ApiIndex).toBe(0);
    // BP3 = last history message (API index 1)
    expect(result.bp3ApiIndex).toBe(1);
  });

  it('returns -1 for BP2 when all slots are empty', () => {
    const messages = [
      { role: 'user', content: '' },
      { role: 'user', content: '' },
      { role: 'user', content: 'prompt' },
    ];

    const result = computeCacheBreakpointIndices(messages, { slotCount: 2, boundary: 2 });
    expect(result.bp2ApiIndex).toBe(-1);
    expect(result.bp3ApiIndex).toBe(-1);
  });

  it('merges consecutive toolResult messages into one API message', () => {
    const messages = [
      { role: 'user', content: 'slot A' },
      { role: 'user', content: 'slot B' },
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'Read', arguments: {} }] },
      { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'result 1' }] },
      { role: 'toolResult', toolCallId: 't2', content: [{ type: 'text', text: 'result 2' }] },
      { role: 'user', content: 'ephemeral' },
      { role: 'user', content: 'prompt' },
    ];

    // 2 slots + 4 history messages = prePrompt 6, + 1 ephemeral => boundary 7
    const result = computeCacheBreakpointIndices(messages, { slotCount: 2, boundary: 7 });

    // API: slotA=0, slotB=1, user=2, assistant=3, merged toolResults=4,
    // ephemeral=5, prompt=6
    expect(result.bp2ApiIndex).toBe(1);
    expect(result.bp3ApiIndex).toBe(5);
  });

  it('counts separate toolResult runs split by an assistant message', () => {
    const messages = [
      { role: 'user', content: 'slot' },
      { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'r1' }] },
      { role: 'toolResult', toolCallId: 't2', content: [{ type: 'text', text: 'r2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'next' }] },
      { role: 'toolResult', toolCallId: 't3', content: [{ type: 'text', text: 'r3' }] },
      { role: 'user', content: 'prompt' },
    ];

    // slot=0, merged run=1, assistant=2, second run=3, prompt=4
    const result = computeCacheBreakpointIndices(messages, { slotCount: 1, boundary: 5 });
    expect(result.bp2ApiIndex).toBe(0);
    expect(result.bp3ApiIndex).toBe(3);
  });

  it('does not break a toolResult run on removed errored/aborted assistant messages', () => {
    const messages = [
      { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'r1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'error' },
      { role: 'toolResult', toolCallId: 't2', content: [{ type: 'text', text: 'r2' }] },
      { role: 'user', content: 'prompt' },
    ];

    // transformMessages removes the errored assistant, so the two
    // toolResults become adjacent and merge: merged=0, prompt=1
    const result = computeCacheBreakpointIndices(messages, { slotCount: 0, boundary: 3 });
    expect(result.bp3ApiIndex).toBe(0);
  });

  it('breaks a toolResult run on a conversion-skipped empty user message', () => {
    const messages = [
      { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'r1' }] },
      { role: 'user', content: '' },
      { role: 'toolResult', toolCallId: 't2', content: [{ type: 'text', text: 'r2' }] },
      { role: 'user', content: 'prompt' },
    ];

    // The empty user message emits nothing but stops the merge lookahead:
    // run1=0, run2=1, prompt=2
    const result = computeCacheBreakpointIndices(messages, { slotCount: 0, boundary: 3 });
    expect(result.bp3ApiIndex).toBe(1);
  });

  it('skips assistant messages whose blocks are all empty', () => {
    const messages = [
      { role: 'user', content: 'slot' },
      { role: 'assistant', content: [{ type: 'text', text: '   ' }] },  // skipped
      { role: 'user', content: 'history' },
      { role: 'user', content: 'prompt' },
    ];

    // slot=0, (assistant skipped), history=1, prompt=2
    const result = computeCacheBreakpointIndices(messages, { slotCount: 1, boundary: 3 });
    expect(result.bp2ApiIndex).toBe(0);
    expect(result.bp3ApiIndex).toBe(1);
  });

  it('returns -1 for BP3 when boundary equals slotCount (no history)', () => {
    const messages = [
      { role: 'user', content: 'slot A' },
      { role: 'user', content: 'slot B' },
      { role: 'user', content: 'new tick' },
    ];

    const result = computeCacheBreakpointIndices(messages, { slotCount: 2, boundary: 2 });
    expect(result.bp3ApiIndex).toBe(-1);
  });

  it('returns -1 for BP3 when it would duplicate BP2', () => {
    const messages = [
      { role: 'user', content: 'slot A' },
      { role: 'user', content: 'slot B' },
      { role: 'user', content: '' },        // boundary region is all-empty
      { role: 'user', content: 'prompt' },
    ];

    const result = computeCacheBreakpointIndices(messages, { slotCount: 2, boundary: 3 });
    expect(result.bp2ApiIndex).toBe(1);
    expect(result.bp3ApiIndex).toBe(-1);
  });

  it('returns -1 for BP3 when boundary exceeds message count', () => {
    const messages = [
      { role: 'user', content: 'slot A' },
      { role: 'user', content: 'history' },
    ];

    const result = computeCacheBreakpointIndices(messages, { slotCount: 1, boundary: 10 });
    expect(result.bp3ApiIndex).toBe(-1);
  });

  it('returns -1 for BP2 with zero slots', () => {
    const messages = [
      { role: 'user', content: 'message 1' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] },
    ];

    const result = computeCacheBreakpointIndices(messages, { slotCount: 0, boundary: 2 });
    expect(result.bp2ApiIndex).toBe(-1);
  });

  it('returns both -1 for an empty message array', () => {
    const result = computeCacheBreakpointIndices([], { slotCount: 2, boundary: 0 });
    expect(result.bp2ApiIndex).toBe(-1);
    expect(result.bp3ApiIndex).toBe(-1);
  });

  it('handles a realistic loop tick with slots, history, tool calls, and ephemeral', () => {
    const slotCount = 9;
    const messages: Array<Record<string, unknown>> = [];

    for (let i = 0; i < slotCount; i++) {
      messages.push({ role: 'user', content: `<slot-${i}>slot content</slot-${i}>` });
    }
    // 5 turns of history, each: user + assistant(toolCall) + 2 toolResults
    for (let i = 0; i < 5; i++) {
      messages.push({ role: 'user', content: `User message ${i}` });
      messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: `t${i}`, name: 'Read', arguments: {} }] });
      messages.push({ role: 'toolResult', toolCallId: `t${i}a`, content: [{ type: 'text', text: 'a' }] });
      messages.push({ role: 'toolResult', toolCallId: `t${i}b`, content: [{ type: 'text', text: 'b' }] });
    }
    // prePromptMessageCount = 9 + 20 = 29; ephemeral injected => boundary 30
    messages.push({ role: 'user', content: '<ephemeral>tick context</ephemeral>' });
    messages.push({ role: 'user', content: 'New tick prompt' });

    const result = computeCacheBreakpointIndices(messages, { slotCount, boundary: 30 });

    // Slots: API 0..8 => BP2 = 8
    expect(result.bp2ApiIndex).toBe(8);
    // Each history turn is 3 API messages (toolResults merge): 9 slots + 15 = API 9..23,
    // ephemeral = 24 => BP3 = 24
    expect(result.bp3ApiIndex).toBe(24);
  });
});

describe('addCacheControlToMessage', () => {
  it('adds cache_control to last block of array content', () => {
    const message: Record<string, unknown> = {
      role: 'user',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'World' },
      ],
    };

    addCacheControlToMessage(message, { type: 'ephemeral' });

    const content = message['content'] as Array<Record<string, unknown>>;
    expect(content[0]!['cache_control']).toBeUndefined();
    expect(content[1]!['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('adds cache_control with TTL', () => {
    const message: Record<string, unknown> = {
      role: 'user',
      content: [{ type: 'text', text: 'Content' }],
    };

    addCacheControlToMessage(message, { type: 'ephemeral', ttl: '1h' });

    const content = message['content'] as Array<Record<string, unknown>>;
    expect(content[0]!['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('converts string content to block array with cache_control', () => {
    const message: Record<string, unknown> = {
      role: 'user',
      content: 'Hello world',
    };

    addCacheControlToMessage(message, { type: 'ephemeral' });

    const content = message['content'] as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({
      type: 'text',
      text: 'Hello world',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('no-ops on empty array content', () => {
    const message: Record<string, unknown> = { role: 'user', content: [] };
    addCacheControlToMessage(message, { type: 'ephemeral' });
    expect(message['content']).toEqual([]);
  });

  it('no-ops on null/undefined content', () => {
    const message: Record<string, unknown> = { role: 'user', content: null };
    addCacheControlToMessage(message, { type: 'ephemeral' });
    expect(message['content']).toBeNull();
  });

  it('handles tool_result content blocks', () => {
    const message: Record<string, unknown> = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'id1', content: 'result text' }],
    };

    addCacheControlToMessage(message, { type: 'ephemeral' });

    const content = message['content'] as Array<Record<string, unknown>>;
    expect(content[0]!['cache_control']).toEqual({ type: 'ephemeral' });
  });
});

describe('applyCacheBreakpoints', () => {
  const cacheControl = { type: 'ephemeral' };

  function buildPayload(): Record<string, unknown> {
    return {
      system: [
        // OAuth identity block with its own cache_control (pi-ai adds this)
        { type: 'text', text: 'identity', cache_control: { ...cacheControl } },
        { type: 'text', text: 'system prompt', cache_control: { ...cacheControl } },
      ],
      tools: [
        { name: 'a', input_schema: {} },
        { name: 'b', input_schema: {}, cache_control: { ...cacheControl } },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'slot A' }] },
        { role: 'user', content: [{ type: 'text', text: 'slot B' }] },
        { role: 'user', content: [{ type: 'text', text: 'history' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
        // pi-ai stamps the last user message (BP4)
        { role: 'user', content: [{ type: 'text', text: 'prompt', cache_control: { ...cacheControl } }] },
      ],
    };
  }

  function countCacheControls(payload: Record<string, unknown>): number {
    let count = 0;
    const system = payload['system'] as Array<Record<string, unknown>>;
    for (const block of system) {
      if (block['cache_control']) count++;
    }
    const tools = payload['tools'] as Array<Record<string, unknown>>;
    for (const tool of tools) {
      if (tool['cache_control']) count++;
    }
    const messages = payload['messages'] as Array<Record<string, unknown>>;
    for (const msg of messages) {
      const content = msg['content'];
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block['cache_control']) count++;
        }
      }
    }
    return count;
  }

  it('stamps BP2 and BP3 and stays within the 4-breakpoint budget', () => {
    const payload = buildPayload();
    const result = applyCacheBreakpoints(payload, { bp2ApiIndex: 1, bp3ApiIndex: 3 });

    expect(result).toBe(payload);

    const system = payload['system'] as Array<Record<string, unknown>>;
    expect(system[0]!['cache_control']).toBeUndefined();  // identity block stripped
    expect(system[1]!['cache_control']).toEqual(cacheControl);

    const tools = payload['tools'] as Array<Record<string, unknown>>;
    expect(tools[1]!['cache_control']).toBeUndefined();   // tool breakpoint stripped

    const messages = payload['messages'] as Array<Record<string, unknown>>;
    const bp2Content = messages[1]!['content'] as Array<Record<string, unknown>>;
    expect(bp2Content[0]!['cache_control']).toEqual(cacheControl);
    const bp3Content = messages[3]!['content'] as Array<Record<string, unknown>>;
    expect(bp3Content[0]!['cache_control']).toEqual(cacheControl);

    // system + BP2 + BP3 + last user message = 4
    expect(countCacheControls(payload)).toBe(4);
  });

  it('skips BP3 when it duplicates BP2', () => {
    const payload = buildPayload();
    applyCacheBreakpoints(payload, { bp2ApiIndex: 1, bp3ApiIndex: 1 });

    const messages = payload['messages'] as Array<Record<string, unknown>>;
    const content = messages[1]!['content'] as Array<Record<string, unknown>>;
    expect(content[0]!['cache_control']).toEqual(cacheControl);
    expect(countCacheControls(payload)).toBe(3);
  });

  it('skips out-of-range and -1 indices', () => {
    const payload = buildPayload();
    applyCacheBreakpoints(payload, { bp2ApiIndex: -1, bp3ApiIndex: 99 });

    // Only system + last user message remain
    expect(countCacheControls(payload)).toBe(2);
  });

  it('returns undefined when the system prompt carries no cache_control', () => {
    const payload = buildPayload();
    const system = payload['system'] as Array<Record<string, unknown>>;
    delete system[1]!['cache_control'];

    const result = applyCacheBreakpoints(payload, { bp2ApiIndex: 1, bp3ApiIndex: 3 });
    expect(result).toBeUndefined();
  });

  it('returns undefined when the payload has no system blocks', () => {
    const result = applyCacheBreakpoints({ messages: [] }, { bp2ApiIndex: 0, bp3ApiIndex: 1 });
    expect(result).toBeUndefined();
  });

  it('returns undefined when the payload has no messages', () => {
    const payload = buildPayload();
    delete payload['messages'];
    const result = applyCacheBreakpoints(payload, { bp2ApiIndex: 0, bp3ApiIndex: 1 });
    expect(result).toBeUndefined();
  });
});

describe('resolveDirectCompletionContext', () => {
  it('passes raw contexts through untouched with null indices', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const result = resolveDirectCompletionContext({
      systemPrompt: 'system',
      messages,
    });

    expect(result.systemPrompt).toBe('system');
    expect(result.messages).toBe(messages);
    expect(result.indices).toBeNull();
  });

  it('assembles structured contexts as [slots][history][ephemeral][prompt]', () => {
    const history = [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] },
    ];
    const result = resolveDirectCompletionContext({
      systemPrompt: 'system',
      slots: ['rubric', 'corpus'],
      history,
      ephemeral: 'volatile state',
      prompt: 'the question',
    });

    expect(result.messages).toEqual([
      { role: 'user', content: 'rubric' },
      { role: 'user', content: 'corpus' },
      ...history,
      { role: 'user', content: 'volatile state' },
      { role: 'user', content: 'the question' },
    ]);

    // BP2 after last slot (API 1); BP3 at end of history (API 3),
    // NOT on the ephemeral message (API 4)
    expect(result.indices).toEqual({ bp2ApiIndex: 1, bp3ApiIndex: 3 });
  });

  it('places BP3 at end of history even without ephemeral', () => {
    const result = resolveDirectCompletionContext({
      systemPrompt: 'system',
      slots: ['stable'],
      history: [{ role: 'user', content: 'h1' }],
      prompt: 'q',
    });

    expect(result.indices).toEqual({ bp2ApiIndex: 0, bp3ApiIndex: 1 });
  });

  it('produces only BP2 for slots-only contexts', () => {
    const result = resolveDirectCompletionContext({
      systemPrompt: 'system',
      slots: ['a', 'b'],
      prompt: 'q',
    });

    expect(result.indices).toEqual({ bp2ApiIndex: 1, bp3ApiIndex: -1 });
  });

  it('produces only BP3 for history-only contexts', () => {
    const result = resolveDirectCompletionContext({
      systemPrompt: 'system',
      history: [
        { role: 'user', content: 'h1' },
        { role: 'assistant', content: [{ type: 'text', text: 'h2' }] },
      ],
      prompt: 'q',
    });

    expect(result.indices).toEqual({ bp2ApiIndex: -1, bp3ApiIndex: 1 });
  });

  it('returns null indices for prompt-only contexts', () => {
    const result = resolveDirectCompletionContext({
      systemPrompt: 'system',
      prompt: 'just a question',
    });

    expect(result.messages).toEqual([{ role: 'user', content: 'just a question' }]);
    expect(result.indices).toBeNull();
  });

  it('drops empty and whitespace-only slots', () => {
    const result = resolveDirectCompletionContext({
      systemPrompt: 'system',
      slots: ['', '  ', 'real slot'],
      prompt: 'q',
    });

    expect(result.messages[0]).toEqual({ role: 'user', content: 'real slot' });
    expect(result.indices).toEqual({ bp2ApiIndex: 0, bp3ApiIndex: -1 });
  });

  it('skips empty ephemeral content', () => {
    const result = resolveDirectCompletionContext({
      systemPrompt: 'system',
      slots: ['s'],
      ephemeral: '   ',
      prompt: 'q',
    });

    expect(result.messages).toEqual([
      { role: 'user', content: 's' },
      { role: 'user', content: 'q' },
    ]);
  });

  it('merges consecutive toolResult history for BP3 placement', () => {
    const result = resolveDirectCompletionContext({
      systemPrompt: 'system',
      history: [
        { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'Read', arguments: {} }] },
        { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'r1' }] },
        { role: 'toolResult', toolCallId: 't2', content: [{ type: 'text', text: 'r2' }] },
      ],
      prompt: 'q',
    });

    // assistant=0, merged toolResults=1, prompt=2 => BP3 = 1
    expect(result.indices).toEqual({ bp2ApiIndex: -1, bp3ApiIndex: 1 });
  });

  it('throws when both messages and prompt are provided', () => {
    expect(() => resolveDirectCompletionContext({
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'x' }],
      prompt: 'y',
    } as never)).toThrow(/cannot mix shapes/);
  });

  it('throws when neither messages nor prompt is provided', () => {
    expect(() => resolveDirectCompletionContext({
      systemPrompt: 's',
    } as never)).toThrow(/either `messages`.*or `prompt`/);
  });

  it('throws on an empty prompt', () => {
    expect(() => resolveDirectCompletionContext({
      systemPrompt: 's',
      prompt: '   ',
    })).toThrow(/non-empty `prompt`/);
  });
});
