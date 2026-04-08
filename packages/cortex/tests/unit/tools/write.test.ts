import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ReadRegistry } from '../../../src/tools/shared/read-registry.js';
import { FileMutationLock } from '../../../src/tools/shared/file-mutation-lock.js';
import { createWriteTool } from '../../../src/tools/write.js';
import { createEditTool } from '../../../src/tools/edit.js';

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

  it('invalidates read state after successful write', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(filePath, 'original');
    markFileRead(registry, filePath);

    await writeTool.execute({
      file_path: filePath,
      content: 'updated',
    });

    expect(registry.hasBeenRead(filePath)).toBe(false);
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
  // Edit after Write without re-read
  // -------------------------------------------------------------------------

  it('rejects Edit after Write without re-read', async () => {
    const editTool = createEditTool({ readRegistry: registry, fileMutationLock: lock });
    const filePath = path.join(tmpDir, 'combo.txt');
    fs.writeFileSync(filePath, 'original content');
    markFileRead(registry, filePath);

    // Write overwrites the file and invalidates read state
    await writeTool.execute({ file_path: filePath, content: 'new content' });

    // Edit without re-reading should be rejected
    const result = await editTool.execute({
      file_path: filePath,
      old_string: 'new',
      new_string: 'fresh',
    });

    expect(getText(result)).toContain('You must Read this file before editing it');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('new content');
  });

  // -------------------------------------------------------------------------
  // Concurrent mutation safety (FileMutationLock)
  // -------------------------------------------------------------------------

  it('serializes concurrent writes on the same file via lock', async () => {
    const filePath = path.join(tmpDir, 'race.txt');
    fs.writeFileSync(filePath, 'original');
    markFileRead(registry, filePath);

    // Launch two writes concurrently. Lock serializes them:
    // first succeeds, second is rejected (read state invalidated by first).
    const [r1, r2] = await Promise.all([
      writeTool.execute({ file_path: filePath, content: 'version-A' }),
      writeTool.execute({ file_path: filePath, content: 'version-B' }),
    ]);

    const succeeded = [r1, r2].filter(r => r.details.bytesWritten > 0);
    const rejected = [r1, r2].filter(r => r.details.bytesWritten === 0);
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(getText(rejected[0])).toContain('You must Read this file before overwriting it');
  });
});
