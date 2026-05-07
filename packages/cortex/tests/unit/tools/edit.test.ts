import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ReadRegistry } from '../../../src/tools/shared/read-registry.js';
import { FileMutationLock } from '../../../src/tools/shared/file-mutation-lock.js';
import { createEditTool } from '../../../src/tools/edit.js';

function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

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

    expect(getText(result)).toContain('Found 2 exact matches');
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
    // Read with a real content hash so the fallback has something to compare against.
    const stat = fs.statSync(filePath);
    registry.markRead(filePath, {
      timestamp: stat.mtimeMs,
      contentHash: hashFile(filePath),
    });

    // External modification that actually changes the bytes
    await new Promise(resolve => setTimeout(resolve, 50));
    fs.writeFileSync(filePath, 'different content\n');

    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'different',
      new_string: 'hi',
    });

    expect(getText(result)).toContain('File was modified since last Read');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('different content\n');
  });

  it('allows edit when mtime moved backwards (no real change)', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world\n');
    markFileRead(registry, filePath);

    // Simulate a filesystem/cloud-sync quirk that moves mtime backwards
    const state = registry.getState(filePath);
    const pastMtimeSec = (state!.timestamp - 60_000) / 1000;
    fs.utimesSync(filePath, pastMtimeSec, pastMtimeSec);

    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'hi',
    });

    expect(result.details.replacementCount).toBe(1);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('hi world\n');
  });

  it('allows edit when mtime changed but content is byte-identical', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world\n');
    const stat = fs.statSync(filePath);
    registry.markRead(filePath, {
      timestamp: stat.mtimeMs,
      contentHash: hashFile(filePath),
    });

    // Simulate a formatter/antivirus touching mtime without changing bytes
    await new Promise(resolve => setTimeout(resolve, 50));
    fs.writeFileSync(filePath, 'hello world\n');

    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'hi',
    });

    expect(result.details.replacementCount).toBe(1);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('hi world\n');
  });

  it('rejects edit on mtime change with no contentHash (partial read)', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world\n');
    // Partial read: no contentHash stored, so no fallback is possible.
    const stat = fs.statSync(filePath);
    registry.markRead(filePath, { timestamp: stat.mtimeMs, offset: 1, limit: 1 });

    await new Promise(resolve => setTimeout(resolve, 50));
    fs.writeFileSync(filePath, 'hello world\n');

    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'hi',
    });

    expect(getText(result)).toContain('File was modified since last Read');
  });

  // -------------------------------------------------------------------------
  // Read state refresh after mutation
  // -------------------------------------------------------------------------

  it('refreshes read state with new mtime after successful edit', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world\n');
    markFileRead(registry, filePath);

    await editTool.execute({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'hi',
    });

    // State preserved, now reflecting the new on-disk mtime
    expect(registry.hasBeenRead(filePath)).toBe(true);
    const state = registry.getState(filePath);
    const newMtime = fs.statSync(filePath).mtimeMs;
    expect(state?.timestamp).toBe(newMtime);
  });

  it('allows consecutive edits without re-read', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'aaa bbb ccc\n');
    markFileRead(registry, filePath);

    const r1 = await editTool.execute({
      file_path: filePath,
      old_string: 'aaa',
      new_string: 'xxx',
    });
    expect(r1.details.replacementCount).toBe(1);

    // Second edit without re-reading should succeed: the agent's own
    // edit is authoritative knowledge of current file contents.
    const r2 = await editTool.execute({
      file_path: filePath,
      old_string: 'bbb',
      new_string: 'yyy',
    });
    expect(r2.details.replacementCount).toBe(1);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('xxx yyy ccc\n');
  });

  // -------------------------------------------------------------------------
  // Concurrent mutation safety (FileMutationLock)
  // -------------------------------------------------------------------------

  it('serializes concurrent edits on the same file via lock', async () => {
    const filePath = path.join(tmpDir, 'race.txt');
    fs.writeFileSync(filePath, 'alpha beta gamma\n');
    markFileRead(registry, filePath);

    // Launch two edits concurrently. The lock serializes them, and
    // each successful edit refreshes the read state with the new
    // mtime so the next edit still sees a fresh read.
    const [r1, r2] = await Promise.all([
      editTool.execute({ file_path: filePath, old_string: 'alpha', new_string: 'ALPHA' }),
      editTool.execute({ file_path: filePath, old_string: 'beta', new_string: 'BETA' }),
    ]);

    expect(r1.details.replacementCount).toBe(1);
    expect(r2.details.replacementCount).toBe(1);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('ALPHA BETA gamma\n');
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

  // -------------------------------------------------------------------------
  // Tiered fuzzy matching (integration with edit-matcher)
  // -------------------------------------------------------------------------

  describe('tiered matching', () => {
    it('falls back to tier 2 when needle has trailing whitespace haystack lacks', async () => {
      const filePath = path.join(tmpDir, 'trim.ts');
      fs.writeFileSync(filePath, 'const x = 1;\nconst y = 2;\n');
      markFileRead(registry, filePath);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'const x = 1;   ',
        new_string: 'const x = 42;',
      });

      expect(result.details.replacementCount).toBe(1);
      expect(result.details.matchTier).toBe('line-trimmed');
      expect(getText(result)).toContain('trailing-whitespace tolerance');
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        'const x = 42;\nconst y = 2;\n',
      );
    });

    it('falls back to tier 3 and re-indents replacement to match haystack', async () => {
      const filePath = path.join(tmpDir, 'indent.ts');
      const original = [
        'class Foo {',
        '    constructor() {',
        '        this.x = 1;',
        '    }',
        '}',
        '',
      ].join('\n');
      fs.writeFileSync(filePath, original);
      markFileRead(registry, filePath);

      const result = await editTool.execute({
        file_path: filePath,
        // Model wrote the block with no leading indent
        old_string: ['constructor() {', '    this.x = 1;', '}'].join('\n'),
        new_string: ['constructor() {', '    this.x = 99;', '}'].join('\n'),
      });

      expect(result.details.replacementCount).toBe(1);
      expect(result.details.matchTier).toBe('indentation-flexible');
      expect(getText(result)).toContain('indentation tolerance');
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        [
          'class Foo {',
          '    constructor() {',
          '        this.x = 99;',
          '    }',
          '}',
          '',
        ].join('\n'),
      );
    });

    it('preserves CRLF line endings when tier 3 matches', async () => {
      const filePath = path.join(tmpDir, 'indent-crlf.ts');
      // CRLF-terminated, 4-space indent. Needle is a multi-line block
      // with zero indent so tier 1/2 cannot match as substrings and
      // tier 3 fires (re-indenting the replacement).
      const content = '    foo();\r\n    bar();\r\n';
      fs.writeFileSync(filePath, content);
      markFileRead(registry, filePath);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'foo();\nbar();',
        new_string: 'baz();\nqux();',
      });

      expect(result.details.replacementCount).toBe(1);
      expect(result.details.matchTier).toBe('indentation-flexible');
      // Replacement gets re-indented with the haystack's 4 spaces and
      // CRLF terminators survive the round-trip.
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        '    baz();\r\n    qux();\r\n',
      );
    });

    it('includes nearest-match snippet when no tier matches', async () => {
      const filePath = path.join(tmpDir, 'miss.ts');
      fs.writeFileSync(
        filePath,
        [
          'function compute() {',
          '  const ratio = 0.7;',
          '  return ratio * 100;',
          '}',
          '',
        ].join('\n'),
      );
      markFileRead(registry, filePath);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'const ratio = 0.9;',
        new_string: 'const ratio = 0.5;',
      });

      const text = getText(result);
      expect(text).toContain('not found');
      expect(text).toContain('Nearest match');
      expect(text).toContain('const ratio = 0.7;');
      expect(text).toContain('<- nearest');
      expect(result.details.replacementCount).toBe(0);
    });

    it('reports tier-2 ambiguity with the specific tolerance used', async () => {
      const filePath = path.join(tmpDir, 'amb-tier2.ts');
      fs.writeFileSync(filePath, 'alpha\nalpha\n');
      markFileRead(registry, filePath);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'alpha ',
        new_string: 'beta',
      });

      const text = getText(result);
      expect(text).toContain('2 possible matches');
      expect(text).toContain('trailing-whitespace tolerance');
      expect(text).toMatch(/lines 1, 2/);
      expect(result.details.replacementCount).toBe(0);
      // Nothing on disk should have changed.
      expect(fs.readFileSync(filePath, 'utf8')).toBe('alpha\nalpha\n');
    });

    it('reports tier-1 ambiguity with line numbers', async () => {
      const filePath = path.join(tmpDir, 'amb-tier1.ts');
      fs.writeFileSync(
        filePath,
        ['first', 'target = 1;', 'middle', 'target = 2;', 'last', ''].join('\n'),
      );
      markFileRead(registry, filePath);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'target',
        new_string: 'result',
      });

      const text = getText(result);
      expect(text).toContain('2 exact matches');
      expect(text).toMatch(/lines 2, 4/);
      expect(text).toContain('replace_all: true');
    });

    it('prefers exact over fuzzy when both would match', async () => {
      const filePath = path.join(tmpDir, 'prefer-exact.ts');
      // Exact substring present on line 1, would-be tier-3 candidate on line 2.
      fs.writeFileSync(filePath, 'foo();\n    foo();\n');
      markFileRead(registry, filePath);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'foo();',
        new_string: 'bar();',
        replace_all: true,
      });

      expect(result.details.matchTier).toBe('exact');
      // Both occurrences replaced via tier 1 replace_all.
      expect(fs.readFileSync(filePath, 'utf8')).toBe('bar();\n    bar();\n');
    });

    it('leaves the file unchanged when ambiguous tier-3 rejects', async () => {
      const filePath = path.join(tmpDir, 'amb-tier3.ts');
      const content = ['function f() {', '  x();', '  x();', '}', ''].join('\n');
      fs.writeFileSync(filePath, content);
      markFileRead(registry, filePath);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: '    x();', // over-indented vs the 2-space haystack region
        new_string: '    y();',
      });

      expect(getText(result)).toContain('indentation tolerance');
      expect(result.details.replacementCount).toBe(0);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
    });

    it('refreshes read registry after a fuzzy match so next edit needs no re-Read', async () => {
      const filePath = path.join(tmpDir, 'refresh.ts');
      fs.writeFileSync(filePath, 'const x = 1;\n');
      markFileRead(registry, filePath);

      await editTool.execute({
        file_path: filePath,
        old_string: 'const x = 1;   ',
        new_string: 'const x = 42;',
      });

      // Second edit, same session — no re-Read, must still succeed.
      const second = await editTool.execute({
        file_path: filePath,
        old_string: 'const x = 42;',
        new_string: 'const x = 7;',
      });
      expect(second.details.replacementCount).toBe(1);
      expect(fs.readFileSync(filePath, 'utf8')).toBe('const x = 7;\n');
    });
  });
});
