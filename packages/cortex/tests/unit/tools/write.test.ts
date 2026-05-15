import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ReadRegistry } from '../../../src/tools/shared/read-registry.js';
import { FileMutationLock } from '../../../src/tools/shared/file-mutation-lock.js';
import { createWriteTool } from '../../../src/tools/write.js';
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

describe('Write tool', () => {
  let registry: ReadRegistry;
  let lock: FileMutationLock;
  let writeTool: ReturnType<typeof createWriteTool>;
  let tmpDir: string;

  beforeEach(() => {
    registry = new ReadRegistry();
    lock = new FileMutationLock();
    writeTool = createWriteTool({ readRegistry: registry, fileMutationLock: lock });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-write-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a new file', async () => {
    const filePath = path.join(tmpDir, 'new-file.txt');
    const result = await writeTool.execute({
      file_path: filePath,
      content: 'hello world',
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Created');
    expect(text).toContain(filePath);
    expect(result.details.isCreate).toBe(true);
    expect(result.details.bytesWritten).toBe(11);

    // Verify file was actually written
    expect(fs.readFileSync(filePath, 'utf8')).toBe('hello world');
  });

  it('rejects critical system paths', async () => {
    const filePath = process.platform === 'win32'
      ? 'C:\\Windows\\cortex-write-test.txt'
      : '/etc/cortex-write-test.txt';

    const result = await writeTool.execute({
      file_path: filePath,
      content: 'blocked',
    });

    expect(getText(result)).toContain('critical system path');
    expect(result.details.bytesWritten).toBe(0);
  });

  it('overwrites an existing file after read', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(filePath, 'original content');
    markFileRead(registry, filePath);

    const result = await writeTool.execute({
      file_path: filePath,
      content: 'new content',
    });

    expect(getText(result)).toContain('Updated');
    expect(result.details.isCreate).toBe(false);
    expect(result.details.originalContent).toBe('original content');
    expect(result.details.diff).not.toBeNull();
    expect(fs.readFileSync(filePath, 'utf8')).toBe('new content');
  });

  it('rejects write without prior read', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(filePath, 'original content');

    const result = await writeTool.execute({
      file_path: filePath,
      content: 'new content',
    });

    expect(getText(result)).toContain('You must Read this file before overwriting it');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('original content');
  });

  it('creates parent directories', async () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'file.txt');

    const result = await writeTool.execute({
      file_path: filePath,
      content: 'nested content',
    });

    expect(result.details.isCreate).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('nested content');
  });

  it('refreshes read state with new mtime after successful write', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(filePath, 'original');
    markFileRead(registry, filePath);

    await writeTool.execute({
      file_path: filePath,
      content: 'updated',
    });

    expect(registry.hasBeenRead(filePath)).toBe(true);
    const state = registry.getState(filePath);
    const newMtime = fs.statSync(filePath).mtimeMs;
    expect(state?.timestamp).toBe(newMtime);
  });

  it('computes diff for updates', async () => {
    const filePath = path.join(tmpDir, 'diff-test.txt');
    fs.writeFileSync(filePath, 'line 1\nline 2\nline 3\n');
    markFileRead(registry, filePath);

    const result = await writeTool.execute({
      file_path: filePath,
      content: 'line 1\nmodified\nline 3\n',
    });

    expect(result.details.diff).not.toBeNull();
    expect(result.details.diff!.length).toBeGreaterThan(0);
  });

  it('computes diff for shifted matching lines without hanging', async () => {
    const filePath = path.join(tmpDir, 'shifted-diff.txt');
    fs.writeFileSync(filePath, 'A\nB\nC\nD\n');
    markFileRead(registry, filePath);

    const result = await writeTool.execute({
      file_path: filePath,
      content: 'A\nX\nC\nY\n',
    });

    expect(result.details.diff).not.toBeNull();
    expect(result.details.diff!.length).toBe(1);
    expect(result.details.diff![0]!.lines).toEqual([
      '-B',
      '-C',
      '-D',
      '+X',
      '+C',
      '+Y',
    ]);
  });

  it('returns null diff for new files', async () => {
    const filePath = path.join(tmpDir, 'brand-new.txt');

    const result = await writeTool.execute({
      file_path: filePath,
      content: 'content',
    });

    expect(result.details.diff).toBeNull();
    expect(result.details.originalContent).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Mtime freshness + content-hash fallback
  // -------------------------------------------------------------------------

  it('rejects write when file was modified externally after Read', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(filePath, 'original');
    const stat = fs.statSync(filePath);
    registry.markRead(filePath, {
      timestamp: stat.mtimeMs,
      contentHash: hashFile(filePath),
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    fs.writeFileSync(filePath, 'changed externally');

    const result = await writeTool.execute({
      file_path: filePath,
      content: 'overwrite',
    });

    expect(getText(result)).toContain('File was modified since last Read');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('changed externally');
  });

  it('allows write when mtime moved backwards (no real change)', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(filePath, 'original');
    markFileRead(registry, filePath);

    const state = registry.getState(filePath);
    const pastMtimeSec = (state!.timestamp - 60_000) / 1000;
    fs.utimesSync(filePath, pastMtimeSec, pastMtimeSec);

    const result = await writeTool.execute({
      file_path: filePath,
      content: 'updated',
    });

    expect(result.details.bytesWritten).toBeGreaterThan(0);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('updated');
  });

  it('allows write when mtime changed but content is byte-identical', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(filePath, 'original');
    const stat = fs.statSync(filePath);
    registry.markRead(filePath, {
      timestamp: stat.mtimeMs,
      contentHash: hashFile(filePath),
    });

    // Formatter-style touch: same bytes, new mtime
    await new Promise(resolve => setTimeout(resolve, 50));
    fs.writeFileSync(filePath, 'original');

    const result = await writeTool.execute({
      file_path: filePath,
      content: 'updated',
    });

    expect(result.details.bytesWritten).toBeGreaterThan(0);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('updated');
  });

  // -------------------------------------------------------------------------
  // Edit after Write without re-read
  // -------------------------------------------------------------------------

  it('allows Edit after Write without re-read', async () => {
    const editTool = createEditTool({ readRegistry: registry, fileMutationLock: lock });
    const filePath = path.join(tmpDir, 'combo.txt');
    fs.writeFileSync(filePath, 'original content');
    markFileRead(registry, filePath);

    // Write refreshes read state with the new mtime
    await writeTool.execute({ file_path: filePath, content: 'new content' });

    // Edit without a fresh Read should still succeed: the Write is
    // authoritative knowledge of current file contents.
    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'new',
      new_string: 'fresh',
    });

    expect(result.details.replacementCount).toBe(1);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('fresh content');
  });

  // -------------------------------------------------------------------------
  // Concurrent mutation safety (FileMutationLock)
  // -------------------------------------------------------------------------

  it('serializes concurrent writes on the same file via lock', async () => {
    const filePath = path.join(tmpDir, 'race.txt');
    fs.writeFileSync(filePath, 'original');
    markFileRead(registry, filePath);

    // Launch two writes concurrently. The lock serializes them,
    // and each successful write refreshes the read state so the
    // next write still passes the freshness check.
    const [r1, r2] = await Promise.all([
      writeTool.execute({ file_path: filePath, content: 'version-A' }),
      writeTool.execute({ file_path: filePath, content: 'version-B' }),
    ]);

    expect(r1.details.bytesWritten).toBeGreaterThan(0);
    expect(r2.details.bytesWritten).toBeGreaterThan(0);
    // One of the two wrote last; the file must be a valid version.
    const final = fs.readFileSync(filePath, 'utf8');
    expect(['version-A', 'version-B']).toContain(final);
  });
});
