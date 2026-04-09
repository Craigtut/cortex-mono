import { describe, expect, it } from 'vitest';
import { buildToolDisplayArgs, summarizeToolStartArgs } from '../../src/tui/tool-display-args.js';

describe('tool-display-args', () => {
  it('strips write file bodies from TUI display args while preserving metrics', () => {
    const args = buildToolDisplayArgs('Write', {
      file_path: '/tmp/example.ts',
      content: 'line 1\nline 2\nline 3\n',
    });

    expect(args).toEqual({
      file_path: '/tmp/example.ts',
      content_bytes: Buffer.byteLength('line 1\nline 2\nline 3\n', 'utf8'),
      content_lines: 4,
    });
  });

  it('truncates edit previews and reports byte counts', () => {
    const longOld = 'a'.repeat(150);
    const args = buildToolDisplayArgs('Edit', {
      file_path: '/tmp/example.ts',
      old_string: longOld,
      new_string: 'updated',
      replace_all: true,
    });

    expect(args).toEqual({
      file_path: '/tmp/example.ts',
      old_string: `${'a'.repeat(117)}...`,
      old_string_bytes: 150,
      new_string_bytes: 7,
      replace_all: true,
    });
  });

  it('creates compact structured start summaries for write calls', () => {
    const summary = summarizeToolStartArgs('Write', 'tool-1', {
      file_path: '/tmp/example.ts',
      content: 'one\ntwo\n',
    });

    expect(summary).toEqual({
      toolCallId: 'tool-1',
      toolName: 'Write',
      filePath: '/tmp/example.ts',
      contentBytes: Buffer.byteLength('one\ntwo\n', 'utf8'),
      contentLines: 3,
    });
  });
});
