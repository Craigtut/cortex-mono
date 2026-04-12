import { describe, it, expect } from 'vitest';
import {
  replayHistoryToTranscript,
  type ReplayTranscript,
} from '../../src/utils/replay-history.js';

type Call =
  | { kind: 'user'; text: string }
  | { kind: 'assistantStart' }
  | { kind: 'assistantChunk'; text: string }
  | { kind: 'assistantFinal'; text: string | undefined }
  | { kind: 'toolStart'; id: string; name: string; args: Record<string, unknown> }
  | { kind: 'toolComplete'; id: string; result: unknown }
  | { kind: 'toolFail'; id: string; error: string };

function makeFakeTranscript(): { transcript: ReplayTranscript; calls: Call[] } {
  const calls: Call[] = [];
  const transcript: ReplayTranscript = {
    addUserMessage: (text) => calls.push({ kind: 'user', text }),
    startAssistantMessage: () => calls.push({ kind: 'assistantStart' }),
    appendAssistantChunk: (text) => calls.push({ kind: 'assistantChunk', text }),
    finalizeAssistantMessage: (text) => calls.push({ kind: 'assistantFinal', text }),
    startToolCall: (id, name, args) => calls.push({ kind: 'toolStart', id, name, args }),
    completeToolCall: (id, result) => calls.push({ kind: 'toolComplete', id, result }),
    failToolCall: (id, error) => calls.push({ kind: 'toolFail', id, error }),
  };
  return { transcript, calls };
}

describe('replayHistoryToTranscript', () => {
  it('replays a plain user message', () => {
    const { transcript, calls } = makeFakeTranscript();
    replayHistoryToTranscript(
      [{ role: 'user', content: 'hello' }],
      transcript,
    );
    expect(calls).toEqual([{ kind: 'user', text: 'hello' }]);
  });

  it('replays a plain assistant message via start + finalize', () => {
    const { transcript, calls } = makeFakeTranscript();
    replayHistoryToTranscript(
      [{ role: 'assistant', content: 'hi there' }],
      transcript,
    );
    expect(calls).toEqual([
      { kind: 'assistantStart' },
      { kind: 'assistantFinal', text: 'hi there' },
    ]);
  });

  it('extracts text blocks from assistant content arrays', () => {
    const { transcript, calls } = makeFakeTranscript();
    replayHistoryToTranscript(
      [{
        role: 'assistant',
        content: [{ type: 'text', text: 'part one' }, { type: 'text', text: ' part two' }],
      }],
      transcript,
    );
    expect(calls).toEqual([
      { kind: 'assistantStart' },
      { kind: 'assistantChunk', text: 'part one' },
      { kind: 'assistantChunk', text: ' part two' },
      { kind: 'assistantFinal', text: 'part one part two' },
    ]);
  });

  it('pairs tool_use with tool_result by id across messages', () => {
    const { transcript, calls } = makeFakeTranscript();
    replayHistoryToTranscript(
      [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'looking' },
            { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/x' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' },
          ],
        },
      ],
      transcript,
    );
    expect(calls).toEqual([
      { kind: 'assistantStart' },
      { kind: 'assistantChunk', text: 'looking' },
      { kind: 'assistantFinal', text: 'looking' },
      { kind: 'toolStart', id: 'tu_1', name: 'Read', args: { path: '/x' } },
      { kind: 'toolComplete', id: 'tu_1', result: { summary: 'file contents' } },
    ]);
  });

  it('flattens tool_result content arrays to text', () => {
    const { transcript, calls } = makeFakeTranscript();
    replayHistoryToTranscript(
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'Grep', input: {} }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }],
          }],
        },
      ],
      transcript,
    );
    const complete = calls.find(c => c.kind === 'toolComplete') as
      { kind: 'toolComplete'; result: { summary: string } } | undefined;
    expect(complete?.result).toEqual({ summary: 'line one\nline two' });
  });

  it('renders is_error tool_result as failToolCall', () => {
    const { transcript, calls } = makeFakeTranscript();
    replayHistoryToTranscript(
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'command failed',
            is_error: true,
          }],
        },
      ],
      transcript,
    );
    expect(calls).toContainEqual({ kind: 'toolFail', id: 'tu_1', error: 'command failed' });
  });

  it('marks unpaired tool_use as interrupted', () => {
    const { transcript, calls } = makeFakeTranscript();
    replayHistoryToTranscript(
      [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_orphan', name: 'Bash', input: {} }],
      }],
      transcript,
    );
    const fail = calls.find(c => c.kind === 'toolFail');
    expect(fail).toMatchObject({ kind: 'toolFail', id: 'tu_orphan' });
    expect((fail as { error: string }).error).toMatch(/interrupted/i);
  });

  it('preserves interleaved text/tool_use order in assistant messages', () => {
    const { transcript, calls } = makeFakeTranscript();
    replayHistoryToTranscript(
      [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'before' },
          { type: 'tool_use', id: 'tu_1', name: 'A', input: {} },
          { type: 'text', text: 'after' },
          { type: 'tool_use', id: 'tu_2', name: 'B', input: {} },
        ],
      }],
      transcript,
    );
    const kinds = calls.map(c => c.kind);
    expect(kinds).toEqual([
      'assistantStart',
      'assistantChunk',
      'assistantFinal',
      'toolStart',
      'assistantStart',
      'assistantChunk',
      'assistantFinal',
      'toolStart',
      'toolFail', // tu_1 unpaired
      'toolFail', // tu_2 unpaired
    ]);
  });

  it('skips malformed messages gracefully', () => {
    const { transcript, calls } = makeFakeTranscript();
    replayHistoryToTranscript(
      [
        null,
        'not an object',
        { role: 'system', content: 'ignored' },
        { role: 'user', content: '   ' }, // whitespace-only
        { role: 'assistant', content: [{ type: 'unknown_block' }] },
      ],
      transcript,
    );
    expect(calls).toEqual([]);
  });

  it('ignores empty tool_result content without crashing', () => {
    const { transcript, calls } = makeFakeTranscript();
    replayHistoryToTranscript(
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'X', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [] }],
        },
      ],
      transcript,
    );
    expect(calls).toContainEqual({ kind: 'toolComplete', id: 'tu_1', result: { summary: '' } });
  });

  it('handles user content arrays with text and tool_result together', () => {
    const { transcript, calls } = makeFakeTranscript();
    replayHistoryToTranscript(
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'X', input: {} }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
            { type: 'text', text: 'now do Y' },
          ],
        },
      ],
      transcript,
    );
    expect(calls).toEqual([
      { kind: 'toolStart', id: 'tu_1', name: 'X', args: {} },
      { kind: 'toolComplete', id: 'tu_1', result: { summary: 'ok' } },
      { kind: 'user', text: 'now do Y' },
    ]);
  });
});
