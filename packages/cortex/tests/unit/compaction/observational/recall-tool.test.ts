import { describe, it, expect, vi } from 'vitest';
import { createRecallTool } from '../../../../src/compaction/observational/recall-tool.js';
import type { RecallConfig, RecallResult } from '../../../../src/compaction/observational/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<RecallResult> = {}): RecallResult {
  return {
    content: 'Test content',
    timestamp: new Date('2026-04-10T14:30:00Z'),
    type: 'message',
    role: 'user',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: createRecallTool
// ---------------------------------------------------------------------------

describe('createRecallTool', () => {
  it('returns a tool with correct name and description', () => {
    const config: RecallConfig = {
      search: vi.fn().mockResolvedValue([]),
    };

    const tool = createRecallTool(config);

    expect(tool.name).toBe('recall');
    expect(tool.description).toContain('Search through past conversation history');
    expect(tool.parameters).toBeDefined();
  });

  it('has parameters with query and optional timeRange', () => {
    const config: RecallConfig = {
      search: vi.fn().mockResolvedValue([]),
    };

    const tool = createRecallTool(config);
    const params = tool.parameters as { properties: Record<string, unknown> };

    expect(params.properties).toHaveProperty('query');
    expect(params.properties).toHaveProperty('timeRange');
  });
});

// ---------------------------------------------------------------------------
// Tests: execute
// ---------------------------------------------------------------------------

describe('recall tool execute', () => {
  it('calls search with query and formats results', async () => {
    const results: RecallResult[] = [
      makeResult({ content: 'First result', role: 'user' }),
      makeResult({ content: 'Second result', role: 'assistant', timestamp: new Date('2026-04-10T15:00:00Z') }),
    ];

    const search = vi.fn().mockResolvedValue(results);
    const tool = createRecallTool({ search });

    const output = await tool.execute({ query: 'test query' });

    expect(search).toHaveBeenCalledWith('test query', undefined);
    expect(output).toContain('First result');
    expect(output).toContain('Second result');
    expect(output).toContain('user');
  });

  it('parses time range and passes Date objects to search', async () => {
    const search = vi.fn().mockResolvedValue([]);
    const tool = createRecallTool({ search });

    await tool.execute({
      query: 'auth middleware',
      timeRange: {
        start: '2026-04-10T14:00:00Z',
        end: '2026-04-10T16:00:00Z',
      },
    });

    expect(search).toHaveBeenCalledWith('auth middleware', {
      timeRange: {
        start: expect.any(Date),
        end: expect.any(Date),
      },
    });

    const callOptions = search.mock.calls[0]![1];
    expect(callOptions.timeRange.start.toISOString()).toBe('2026-04-10T14:00:00.000Z');
    expect(callOptions.timeRange.end.toISOString()).toBe('2026-04-10T16:00:00.000Z');
  });

  it('handles partial time range (start only)', async () => {
    const search = vi.fn().mockResolvedValue([]);
    const tool = createRecallTool({ search });

    await tool.execute({
      query: 'test',
      timeRange: { start: '2026-04-10T14:00:00Z' },
    });

    const callOptions = search.mock.calls[0]![1];
    expect(callOptions.timeRange.start).toBeInstanceOf(Date);
    expect(callOptions.timeRange).not.toHaveProperty('end');
  });

  it('handles partial time range (end only)', async () => {
    const search = vi.fn().mockResolvedValue([]);
    const tool = createRecallTool({ search });

    await tool.execute({
      query: 'test',
      timeRange: { end: '2026-04-10T16:00:00Z' },
    });

    const callOptions = search.mock.calls[0]![1];
    expect(callOptions.timeRange.end).toBeInstanceOf(Date);
    expect(callOptions.timeRange).not.toHaveProperty('start');
  });

  it('returns "No results found" for empty results', async () => {
    const search = vi.fn().mockResolvedValue([]);
    const tool = createRecallTool({ search });

    const output = await tool.execute({ query: 'nonexistent' });
    expect(output).toBe('No results found for your query.');
  });

  it('truncates long result content', async () => {
    const longContent = 'x'.repeat(3000);
    const results = [makeResult({ content: longContent })];

    const search = vi.fn().mockResolvedValue(results);
    const tool = createRecallTool({ search });

    const output = await tool.execute({ query: 'test' });

    expect(output).toContain('... (truncated)');
    expect(output.length).toBeLessThan(longContent.length);
  });

  it('limits results to 10 and shows omission count', async () => {
    const results = Array.from({ length: 15 }, (_, i) =>
      makeResult({ content: `Result ${i}` }),
    );

    const search = vi.fn().mockResolvedValue(results);
    const tool = createRecallTool({ search });

    const output = await tool.execute({ query: 'test' });

    expect(output).toContain('Result 0');
    expect(output).toContain('Result 9');
    expect(output).not.toContain('Result 10');
    expect(output).toContain('5 additional results omitted');
  });

  it('includes timestamp and role in formatted output', async () => {
    const results = [
      makeResult({
        content: 'Hello world',
        role: 'user',
        timestamp: new Date('2026-04-10T14:30:00Z'),
      }),
    ];

    const search = vi.fn().mockResolvedValue(results);
    const tool = createRecallTool({ search });

    const output = await tool.execute({ query: 'test' });

    expect(output).toContain('[user]');
    expect(output).toContain('2026-04-10T14:30:00.000Z');
    expect(output).toContain('Hello world');
  });

  it('uses type as fallback when role is not set', async () => {
    const results = [
      makeResult({ content: 'Tool output', type: 'tool-result', role: undefined }),
    ];

    const search = vi.fn().mockResolvedValue(results);
    const tool = createRecallTool({ search });

    const output = await tool.execute({ query: 'test' });

    expect(output).toContain('[tool-result]');
  });
});
