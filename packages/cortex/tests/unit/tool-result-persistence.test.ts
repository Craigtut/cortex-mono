import { describe, it, expect, vi } from 'vitest';
import {
  applyResultPersistence,
  processToolResult,
  MAX_RESULT_TOKENS,
  BOOKEND_CHARS,
  SKIP_RESULT_PERSISTENCE,
  DEFAULT_TOOL_THRESHOLDS,
  resolveThreshold,
} from '../../src/tool-result-persistence.js';
import type { PersistResultFn } from '../../src/types.js';

const SMALL_CONTENT = 'hello world\n'.repeat(10);
const LARGE_CONTENT = 'x'.repeat(MAX_RESULT_TOKENS * 4 + 5_000); // ~30K tokens

describe('applyResultPersistence', () => {
  it('passes through content under the threshold unchanged', async () => {
    const out = await applyResultPersistence(SMALL_CONTENT, {
      toolName: 'Bash',
      toolCallId: 'call-1',
    });
    expect(out).toBe(SMALL_CONTENT);
  });

  it('returns a bookend-only notice when no persistResult is configured', async () => {
    const out = await applyResultPersistence(LARGE_CONTENT, {
      toolName: 'Grep', // uses default 25K threshold
      toolCallId: 'call-1',
    });
    expect(out).toContain('[Result truncated:');
    expect(out).toContain('25,000 token limit');
    expect(out).toContain('tokens trimmed');
    // Bookend keeps head and tail
    expect(out.startsWith('[Result truncated:')).toBe(true);
    expect(out).not.toContain('Use the Read tool with offset/limit');
  });

  it('persists and returns a bookend + file reference when persistResult is configured', async () => {
    const persistResult = vi.fn<PersistResultFn>().mockResolvedValue('/tmp/cortex-result-1.txt');

    const out = await applyResultPersistence(LARGE_CONTENT, {
      toolName: 'SubAgent',
      toolCallId: 'call-2',
      persistResult,
    });

    expect(persistResult).toHaveBeenCalledOnce();
    const [contentArg, metadataArg] = persistResult.mock.calls[0]!;
    expect(contentArg).toBe(LARGE_CONTENT);
    expect(metadataArg.toolName).toBe('SubAgent');
    expect(metadataArg.toolCallId).toBe('call-2');
    expect(metadataArg.category).toBeDefined();
    expect(metadataArg.messageIndex).toBeUndefined();

    expect(out).toContain('[Result persisted: /tmp/cortex-result-1.txt');
    expect(out).toContain('Use the Read tool with offset/limit');
    expect(out).toContain('tokens trimmed');
  });

  it('falls back to bookend-only when persistResult throws', async () => {
    const persistResult = vi.fn<PersistResultFn>().mockRejectedValue(new Error('disk full'));

    const out = await applyResultPersistence(LARGE_CONTENT, {
      toolName: 'Bash',
      toolCallId: 'call-3',
      persistResult,
    });

    expect(persistResult).toHaveBeenCalledOnce();
    expect(out).toContain('[Result truncated:');
    expect(out).not.toContain('persisted');
    expect(out).not.toContain('Use the Read tool');
  });

  it('skips tools in SKIP_RESULT_PERSISTENCE even when content is huge', async () => {
    const persistResult = vi.fn<PersistResultFn>().mockResolvedValue('/tmp/never.txt');

    for (const toolName of SKIP_RESULT_PERSISTENCE) {
      const out = await applyResultPersistence(LARGE_CONTENT, {
        toolName,
        toolCallId: 'call-x',
        persistResult,
      });
      expect(out).toBe(LARGE_CONTENT);
    }
    expect(persistResult).not.toHaveBeenCalled();
  });

  it('passes toolCategories through to persistResult metadata', async () => {
    const persistResult = vi.fn<PersistResultFn>().mockResolvedValue('/tmp/x.txt');

    await applyResultPersistence(LARGE_CONTENT, {
      toolName: 'CustomTool',
      toolCallId: 'call-4',
      persistResult,
      toolCategories: { CustomTool: 'computational' },
    });

    expect(persistResult.mock.calls[0]![1].category).toBe('computational');
  });

  it('uses default category "ephemeral" when tool is unknown', async () => {
    const persistResult = vi.fn<PersistResultFn>().mockResolvedValue('/tmp/x.txt');

    await applyResultPersistence(LARGE_CONTENT, {
      toolName: 'UnknownTool',
      toolCallId: 'call-5',
      persistResult,
    });

    expect(persistResult.mock.calls[0]![1].category).toBe('ephemeral');
  });

  it('preserves head and tail content in the bookend', async () => {
    const head = 'HEAD-MARKER-START';
    const tail = 'TAIL-MARKER-END';
    const middle = 'm'.repeat(MAX_RESULT_TOKENS * 4 + 5_000);
    const content = `${head}\n${middle}\n${tail}`;

    const out = await applyResultPersistence(content, {
      toolName: 'Grep',
      toolCallId: 'call-6',
    });

    expect(out).toContain(head);
    expect(out).toContain(tail);
    expect(out).toContain('tokens trimmed');
    // Verify bookend size honors BOOKEND_CHARS
    // (head + tail < total content, so we expect significant reduction)
    expect(out.length).toBeLessThan(content.length);
  });
});

describe('module exports', () => {
  it('exports the expected constants', () => {
    expect(MAX_RESULT_TOKENS).toBe(25_000);
    expect(BOOKEND_CHARS).toBe(1_500);
  });

  it('SKIP_RESULT_PERSISTENCE includes Read, Edit, Write, Glob', () => {
    expect(SKIP_RESULT_PERSISTENCE.has('Read')).toBe(true);
    expect(SKIP_RESULT_PERSISTENCE.has('Edit')).toBe(true);
    expect(SKIP_RESULT_PERSISTENCE.has('Write')).toBe(true);
    expect(SKIP_RESULT_PERSISTENCE.has('Glob')).toBe(true);
    // Tools that should NOT be in skip set
    expect(SKIP_RESULT_PERSISTENCE.has('Grep')).toBe(false);
    expect(SKIP_RESULT_PERSISTENCE.has('Bash')).toBe(false);
    expect(SKIP_RESULT_PERSISTENCE.has('WebFetch')).toBe(false);
    expect(SKIP_RESULT_PERSISTENCE.has('SubAgent')).toBe(false);
    expect(SKIP_RESULT_PERSISTENCE.has('TaskOutput')).toBe(false);
  });

  it('DEFAULT_TOOL_THRESHOLDS sets Bash to a tighter cap', () => {
    expect(DEFAULT_TOOL_THRESHOLDS.Bash).toBe(7_500);
  });
});

describe('resolveThreshold', () => {
  it('returns the default for unlisted tools', () => {
    expect(resolveThreshold('Grep')).toBe(MAX_RESULT_TOKENS);
    expect(resolveThreshold('SubAgent')).toBe(MAX_RESULT_TOKENS);
    expect(resolveThreshold('SomeMcpTool')).toBe(MAX_RESULT_TOKENS);
  });

  it('returns the built-in override for Bash', () => {
    expect(resolveThreshold('Bash')).toBe(7_500);
  });

  it('consumer overrides win over built-in defaults', () => {
    expect(resolveThreshold('Bash', { Bash: 12_000 })).toBe(12_000);
  });

  it('consumer can set thresholds for tools not in built-in defaults', () => {
    expect(resolveThreshold('CustomTool', { CustomTool: 5_000 })).toBe(5_000);
  });

  it('falls back to MAX_RESULT_TOKENS when neither has the tool', () => {
    expect(resolveThreshold('Whatever', { OtherTool: 1_000 })).toBe(MAX_RESULT_TOKENS);
  });
});

describe('per-tool thresholds via applyResultPersistence', () => {
  // ~10K-token content: under default 25K, but over Bash's 7.5K override.
  const MEDIUM_CONTENT = 'x'.repeat(10_000 * 4 + 100);

  it('applies the Bash default threshold (7.5K) when called for Bash', async () => {
    const out = await applyResultPersistence(MEDIUM_CONTENT, {
      toolName: 'Bash',
      toolCallId: 'call-bash-1',
    });
    expect(out).toContain('[Result truncated:');
    expect(out).toContain('7,500 token limit');
  });

  it('does NOT trigger for the same content on Grep (uses 25K default)', async () => {
    const out = await applyResultPersistence(MEDIUM_CONTENT, {
      toolName: 'Grep',
      toolCallId: 'call-grep-1',
    });
    expect(out).toBe(MEDIUM_CONTENT);
  });

  it('respects consumer overrides', async () => {
    // 12K-token content with a consumer override that sets Grep to 5K
    const content = 'y'.repeat(12_000 * 4 + 100);
    const out = await applyResultPersistence(content, {
      toolName: 'Grep',
      toolCallId: 'call-grep-2',
      thresholds: { Grep: 5_000 },
    });
    expect(out).toContain('[Result truncated:');
    expect(out).toContain('5,000 token limit');
  });

  it('consumer override can raise a tool above its default', async () => {
    // Same MEDIUM_CONTENT (10K tokens) on Bash, but override to 15K
    const out = await applyResultPersistence(MEDIUM_CONTENT, {
      toolName: 'Bash',
      toolCallId: 'call-bash-2',
      thresholds: { Bash: 15_000 },
    });
    // Now under threshold, passes through
    expect(out).toBe(MEDIUM_CONTENT);
  });
});

describe('processToolResult', () => {
  const LARGE = 'x'.repeat(MAX_RESULT_TOKENS * 4 + 5_000);

  it('returns non-object results unchanged', async () => {
    expect(await processToolResult(undefined, { toolName: 'X', toolCallId: '1' })).toBeUndefined();
    expect(await processToolResult(null, { toolName: 'X', toolCallId: '1' })).toBeNull();
    expect(await processToolResult('a string', { toolName: 'X', toolCallId: '1' })).toBe('a string');
    expect(await processToolResult(42, { toolName: 'X', toolCallId: '1' })).toBe(42);
  });

  it('returns the same object reference when nothing is modified', async () => {
    const result = {
      content: [{ type: 'text', text: 'small content' }],
      details: { foo: 'bar' },
    };
    const out = await processToolResult(result, { toolName: 'Grep', toolCallId: '1' });
    expect(out).toBe(result);
  });

  it('returns the same reference when content is missing or empty', async () => {
    const r1 = { content: undefined };
    const r2 = { content: [] };
    const r3 = { details: {} };
    expect(await processToolResult(r1, { toolName: 'X', toolCallId: '1' })).toBe(r1);
    expect(await processToolResult(r2, { toolName: 'X', toolCallId: '1' })).toBe(r2);
    expect(await processToolResult(r3, { toolName: 'X', toolCallId: '1' })).toBe(r3);
  });

  it('passes image content parts through unchanged', async () => {
    const imagePart = { type: 'image', data: 'base64-blob', mimeType: 'image/png' };
    const result = {
      content: [imagePart],
      details: {},
    };
    const out = await processToolResult(result, { toolName: 'Read', toolCallId: '1' });
    // Same reference (no text parts means no modification)
    expect(out).toBe(result);
  });

  it('processes text parts but leaves image parts untouched in mixed content', async () => {
    const persistResult = vi.fn<PersistResultFn>().mockResolvedValue('/tmp/out.txt');
    const imagePart = { type: 'image', data: 'base64', mimeType: 'image/png' };
    const result = {
      content: [
        imagePart,
        { type: 'text', text: LARGE },
        { type: 'text', text: 'tiny text' },
      ],
      details: {},
    };
    const out = await processToolResult(result, {
      toolName: 'SubAgent',
      toolCallId: '1',
      persistResult,
    });

    const newContent = (out as { content: unknown[] }).content;
    expect(newContent.length).toBe(3);
    // Image part identity preserved
    expect(newContent[0]).toBe(imagePart);
    // Large text part was processed
    expect((newContent[1] as { text: string }).text).toContain('[Result persisted:');
    // Tiny text part unchanged
    expect(newContent[2]).toBe(result.content[2]);
    // Persist callback called once (only for the large part)
    expect(persistResult).toHaveBeenCalledOnce();
  });

  it('processes multiple oversized text parts independently', async () => {
    const persistResult = vi.fn<PersistResultFn>()
      .mockResolvedValueOnce('/tmp/a.txt')
      .mockResolvedValueOnce('/tmp/b.txt');

    const result = {
      content: [
        { type: 'text', text: LARGE },
        { type: 'text', text: LARGE },
      ],
      details: {},
    };
    const out = await processToolResult(result, {
      toolName: 'SubAgent',
      toolCallId: '1',
      persistResult,
    });

    const newContent = (out as { content: { text: string }[] }).content;
    expect(newContent[0]!.text).toContain('/tmp/a.txt');
    expect(newContent[1]!.text).toContain('/tmp/b.txt');
    expect(persistResult).toHaveBeenCalledTimes(2);
  });

  it('preserves details and other top-level fields when content is replaced', async () => {
    const result = {
      content: [{ type: 'text', text: LARGE }],
      details: { totalFiles: 5, durationMs: 12 },
      extra: 'preserved',
    };
    const out = await processToolResult(result, { toolName: 'Grep', toolCallId: '1' });
    expect((out as { details: unknown }).details).toBe(result.details);
    expect((out as { extra: string }).extra).toBe('preserved');
  });

  it('preserves part-level fields beyond type/text', async () => {
    const result = {
      content: [{ type: 'text', text: LARGE, customField: 'keep-me' }],
      details: {},
    };
    const out = await processToolResult(result, { toolName: 'Grep', toolCallId: '1' });
    const part = (out as { content: { customField?: string }[] }).content[0]!;
    expect(part.customField).toBe('keep-me');
  });
});
