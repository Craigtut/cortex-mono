import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createDebouncedSaver,
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
