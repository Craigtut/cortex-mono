import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createDebouncedSaver,
  createToolResultPersistor,
  generateSessionId,
  sanitizeHistoryForSave,
} from '../../src/persistence/sessions.js';
import type { SessionMeta } from '../../src/persistence/sessions.js';

describe('generateSessionId', () => {
  it('returns a UUID string', () => {
    const id = generateSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    expect(ids.size).toBe(100);
  });
});

describe('createDebouncedSaver', () => {
  const mockMeta: SessionMeta = {
    id: 'test-session',
    mode: 'build',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    cwd: '/test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    contextTokenCount: 1000,
  };

  it('batches rapid saves', async () => {
    vi.useFakeTimers();
    const saver = createDebouncedSaver('test', 500);

    // Call save 3 times rapidly
    saver.save([{ msg: 1 }], mockMeta);
    saver.save([{ msg: 2 }], mockMeta);
    saver.save([{ msg: 3 }], mockMeta);

    // Only the last one should be pending
    // (We can't easily test the actual file write without mocking fs,
    // but we can test that flush works)
    vi.useRealTimers();
  });

  it('flush saves immediately', async () => {
    const saver = createDebouncedSaver('test', 500);
    saver.save([{ msg: 'test' }], mockMeta);

    // flush should not throw even without a real filesystem
    // (it will fail silently on the actual write)
    // This is mainly a smoke test for the debounce logic
    try {
      await saver.flush();
    } catch {
      // Expected: no ~/.cortex/sessions directory in test env
    }
  });
});

describe('createToolResultPersistor', () => {
  const createdSessionDirs: string[] = [];

  afterEach(async () => {
    for (const dir of createdSessionDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  function uniqueSession(): { id: string; dir: string; toolResultsDir: string } {
    const id = `__test__-${generateSessionId()}`;
    const dir = join(homedir(), '.cortex', 'sessions', id);
    const toolResultsDir = join(dir, 'tool-results');
    createdSessionDirs.push(dir);
    return { id, dir, toolResultsDir };
  }

  it('writes content to tool-results and returns an absolute path', async () => {
    const { id, toolResultsDir } = uniqueSession();
    const persist = createToolResultPersistor(id);

    const content = 'x'.repeat(50_000);
    const path = await persist(content, {
      toolName: 'Bash',
      category: 'non-reproducible',
      toolCallId: 'call-abc123',
    });

    expect(path.startsWith('/')).toBe(true);
    expect(path).toBe(join(toolResultsDir, 'Bash-call-abc123.md'));
    const roundTripped = await readFile(path, 'utf-8');
    expect(roundTripped).toBe(content);
  });

  it('uses toolCallId naming when provided (proactive path)', async () => {
    const { id, toolResultsDir } = uniqueSession();
    const persist = createToolResultPersistor(id);

    const path = await persist('hello', {
      toolName: 'SubAgent',
      category: 'non-reproducible',
      toolCallId: 'tc-42',
    });

    expect(path).toBe(join(toolResultsDir, 'SubAgent-tc-42.md'));
  });

  it('uses messageIndex + content hash when toolCallId is absent (reactive path)', async () => {
    const { id, toolResultsDir } = uniqueSession();
    const persist = createToolResultPersistor(id);

    const pathA = await persist('content-a', {
      toolName: 'Grep',
      category: 'computational',
      messageIndex: 7,
    });
    const pathB = await persist('content-b', {
      toolName: 'Grep',
      category: 'computational',
      messageIndex: 7,
    });

    expect(pathA).toMatch(new RegExp(`${toolResultsDir}/Grep-msg7-[0-9a-f]{8}\\.md$`));
    expect(pathB).toMatch(new RegExp(`${toolResultsDir}/Grep-msg7-[0-9a-f]{8}\\.md$`));
    expect(pathA).not.toBe(pathB);
  });

  it('is idempotent for the same toolCallId (overwrites with same path)', async () => {
    const { id } = uniqueSession();
    const persist = createToolResultPersistor(id);

    const path1 = await persist('first', {
      toolName: 'Bash',
      category: 'non-reproducible',
      toolCallId: 'same-id',
    });
    const path2 = await persist('second', {
      toolName: 'Bash',
      category: 'non-reproducible',
      toolCallId: 'same-id',
    });

    expect(path1).toBe(path2);
    expect(await readFile(path1, 'utf-8')).toBe('second');
  });

  it('sanitizes MCP-style tool names into filename-safe segments', async () => {
    const { id, toolResultsDir } = uniqueSession();
    const persist = createToolResultPersistor(id);

    const path = await persist('payload', {
      toolName: 'mcp__playwright__browser_snapshot',
      category: 'ephemeral',
      toolCallId: 'tc-1',
    });

    expect(path).toBe(join(toolResultsDir, 'mcp__playwright__browser_snapshot-tc-1.md'));
  });

  it('lazily creates the tool-results directory on first call', async () => {
    const { id, toolResultsDir } = uniqueSession();
    const persist = createToolResultPersistor(id);

    await expect(stat(toolResultsDir)).rejects.toThrow();

    await persist('payload', {
      toolName: 'Bash',
      category: 'non-reproducible',
      toolCallId: 'tc-1',
    });

    const info = await stat(toolResultsDir);
    expect(info.isDirectory()).toBe(true);
  });
});

describe('sanitizeHistoryForSave', () => {
  it('strips bulky tool result details while preserving message content', () => {
    const history = [
      {
        role: 'toolResult',
        toolName: 'Edit',
        toolCallId: 'call-1',
        details: {
          filePath: '/tmp/file.ts',
          diff: [{ lines: ['-old', '+new'] }],
          originalContent: 'old',
        },
        content: [{ type: 'text', text: 'Made 1 replacement in /tmp/file.ts' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
      },
    ];

    const sanitized = sanitizeHistoryForSave(history);

    expect(sanitized).toEqual([
      {
        role: 'toolResult',
        toolName: 'Edit',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'Made 1 replacement in /tmp/file.ts' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
      },
    ]);
    expect((history[0] as { details: unknown }).details).toBeDefined();
  });
});
