import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ReadRegistry } from '../../../src/tools/shared/read-registry.js';
import { FileMutationLock } from '../../../src/tools/shared/file-mutation-lock.js';
import { createEditTool } from '../../../src/tools/edit.js';

/** Mark a file as read with its actual mtime (mirrors what the Read tool does). */
function markFileRead(registry: ReadRegistry, filePath: string): void {
  const stat = fs.statSync(filePath);
  registry.markRead(filePath, { timestamp: stat.mtimeMs });
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { type: 'text'; text: string }).text;
}

describe('Edit tool', () => {
  let registry: ReadRegistry;
  let lock: FileMutationLock;
  let editTool: ReturnType<typeof createEditTool>;
  let tmpDir: string;

  beforeEach(() => {
    registry = new ReadRegistry();
    lock = new FileMutationLock();
    editTool = createEditTool({ readRegistry: registry, fileMutationLock: lock });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-edit-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces a unique string', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world\nfoo bar\n');
    markFileRead(registry, filePath);

    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'foo bar',
      new_string: 'baz qux',
    });

    expect(getText(result)).toContain('1 replacement');
    expect(result.details.replacementCount).toBe(1);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('hello world\nbaz qux\n');
  });

  it('replaces all occurrences with replaceAll', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'foo bar foo bar foo\n');
    markFileRead(registry, filePath);

    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'foo',
      new_string: 'baz',
      replace_all: true,
    });

    expect(result.details.replacementCount).toBe(3);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('baz bar baz bar baz\n');
  });

  it('rejects non-unique match without replaceAll', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'foo bar foo bar\n');
    markFileRead(registry, filePath);

    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'foo',
      new_string: 'baz',
    });

    expect(getText(result)).toContain('Found 2 matches');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('foo bar foo bar\n');
  });

  it('returns error when old_string not found', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world\n');
    markFileRead(registry, filePath);

    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'nonexistent',
      new_string: 'replacement',
    });

    expect(getText(result)).toContain('not found');
  });

  it('returns error when old_string equals new_string', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world\n');
    markFileRead(registry, filePath);

    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'hello',
    });

    expect(getText(result)).toContain('identical');
  });

  it('rejects edit without prior read', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world\n');

    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'hi',
    });

    expect(getText(result)).toContain('You must Read this file before editing it');
  });

  it('returns error for nonexistent file', async () => {
    const result = await editTool.execute({
      file_path: '/nonexistent/file.txt',
      old_string: 'hello',
      new_string: 'hi',
    });

    expect(getText(result)).toContain('File does not exist');
  });

  it('handles multi-line replacements', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'line 1\nline 2\nline 3\n');
    markFileRead(registry, filePath);

    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'line 1\nline 2',
      new_string: 'replaced 1\nreplaced 2',
    });

    expect(result.details.replacementCount).toBe(1);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('replaced 1\nreplaced 2\nline 3\n');
  });

  it('normalizes CRLF line endings for matching', async () => {
    const filePath = path.join(tmpDir, 'crlf.txt');
    fs.writeFileSync(filePath, 'hello\r\nworld\r\n');
    markFileRead(registry, filePath);

    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'hello\nworld',
      new_string: 'hi\nthere',
    });

    expect(result.details.replacementCount).toBe(1);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toBe('hi\r\nthere\r\n');
  });

  it('produces a diff in details', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world\n');
    markFileRead(registry, filePath);

    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'hi',
    });

    expect(result.details.diff.length).toBeGreaterThan(0);
    expect(result.details.originalContent).toBe('hello world\n');
  });

  it('computes diff for shifted matching lines without hanging', async () => {
    const filePath = path.join(tmpDir, 'shifted-edit.txt');
    fs.writeFileSync(filePath, 'A\nB\nC\nD\n');
    markFileRead(registry, filePath);

    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'B\nC\nD',
      new_string: 'X\nC\nY',
    });

    expect(result.details.replacementCount).toBe(1);
    expect(result.details.diff).toEqual([{
      oldStart: 2,
      oldLines: 3,
      newStart: 2,
      newLines: 3,
      lines: ['-B', '-C', '-D', '+X', '+C', '+Y'],
    }]);
  });

  // -------------------------------------------------------------------------
  // Mtime freshness check
  // -------------------------------------------------------------------------

  it('rejects edit when file was modified externally after Read', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world\n');
    markFileRead(registry, filePath);

    // Simulate external modification (change file content, which updates mtime)
    // Need a small delay to ensure mtime actually changes
    await new Promise(resolve => setTimeout(resolve, 50));
    fs.writeFileSync(filePath, 'hello world\n');

    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'hi',
    });

    expect(getText(result)).toContain('File was modified since last Read');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('hello world\n');
  });

  // -------------------------------------------------------------------------
  // Read invalidation after mutation
  // -------------------------------------------------------------------------

  it('invalidates read state after successful edit', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world\n');
    markFileRead(registry, filePath);

    await editTool.execute({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'hi',
    });

    expect(registry.hasBeenRead(filePath)).toBe(false);
  });

  it('rejects second edit without re-read', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'aaa bbb ccc\n');
    markFileRead(registry, filePath);

    // First edit succeeds
    const r1 = await editTool.execute({
      file_path: filePath,
      old_string: 'aaa',
      new_string: 'xxx',
    });
    expect(r1.details.replacementCount).toBe(1);

    // Second edit (without re-read) should be rejected
    const r2 = await editTool.execute({
      file_path: filePath,
      old_string: 'bbb',
      new_string: 'yyy',
    });
    expect(getText(r2)).toContain('You must Read this file before editing it');
    // File should only have the first edit
    expect(fs.readFileSync(filePath, 'utf8')).toBe('xxx bbb ccc\n');
  });

  // -------------------------------------------------------------------------
  // Concurrent mutation safety (FileMutationLock)
  // -------------------------------------------------------------------------

  it('serializes concurrent edits on the same file via lock', async () => {
    const filePath = path.join(tmpDir, 'race.txt');
    fs.writeFileSync(filePath, 'alpha beta gamma\n');
    markFileRead(registry, filePath);

    // Launch two edits concurrently. The lock serializes them:
    // first succeeds, second is rejected (read state invalidated by first).
    const [r1, r2] = await Promise.all([
      editTool.execute({ file_path: filePath, old_string: 'alpha', new_string: 'ALPHA' }),
      editTool.execute({ file_path: filePath, old_string: 'beta', new_string: 'BETA' }),
    ]);

    // Exactly one should succeed, one should be rejected
    const succeeded = [r1, r2].filter(r => r.details.replacementCount > 0);
    const rejected = [r1, r2].filter(r => r.details.replacementCount === 0);
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(getText(rejected[0])).toMatch(/Read|modified/);
  });

  it('allows concurrent edits on different files', async () => {
    const fileA = path.join(tmpDir, 'a.txt');
    const fileB = path.join(tmpDir, 'b.txt');
    fs.writeFileSync(fileA, 'hello\n');
    fs.writeFileSync(fileB, 'world\n');
    markFileRead(registry, fileA);
    markFileRead(registry, fileB);

    const [rA, rB] = await Promise.all([
      editTool.execute({ file_path: fileA, old_string: 'hello', new_string: 'hi' }),
      editTool.execute({ file_path: fileB, old_string: 'world', new_string: 'earth' }),
    ]);

    expect(rA.details.replacementCount).toBe(1);
    expect(rB.details.replacementCount).toBe(1);
    expect(fs.readFileSync(fileA, 'utf8')).toBe('hi\n');
    expect(fs.readFileSync(fileB, 'utf8')).toBe('earth\n');
  });
});
