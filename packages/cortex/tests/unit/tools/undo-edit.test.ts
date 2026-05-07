import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EditHistory } from '../../../src/tools/shared/edit-history.js';
import { FileMutationLock } from '../../../src/tools/shared/file-mutation-lock.js';
import { ReadRegistry } from '../../../src/tools/shared/read-registry.js';
import { createEditTool } from '../../../src/tools/edit.js';
import { createWriteTool } from '../../../src/tools/write.js';
import { createUndoEditTool } from '../../../src/tools/undo-edit.js';

function markFileRead(registry: ReadRegistry, filePath: string): void {
  const stat = fs.statSync(filePath);
  registry.markRead(filePath, { timestamp: stat.mtimeMs });
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { type: 'text'; text: string }).text;
}

describe('UndoEdit tool', () => {
  let registry: ReadRegistry;
  let lock: FileMutationLock;
  let history: EditHistory;
  let editTool: ReturnType<typeof createEditTool>;
  let writeTool: ReturnType<typeof createWriteTool>;
  let undoTool: ReturnType<typeof createUndoEditTool>;
  let tmpDir: string;

  beforeEach(() => {
    registry = new ReadRegistry();
    lock = new FileMutationLock();
    history = new EditHistory();
    editTool = createEditTool({
      readRegistry: registry,
      fileMutationLock: lock,
      editHistory: history,
    });
    writeTool = createWriteTool({
      readRegistry: registry,
      fileMutationLock: lock,
      editHistory: history,
    });
    undoTool = createUndoEditTool({
      editHistory: history,
      readRegistry: registry,
      fileMutationLock: lock,
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-undo-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy paths
  // -------------------------------------------------------------------------

  it('restores the prior content of an Edit', async () => {
    const filePath = path.join(tmpDir, 'edit.txt');
    fs.writeFileSync(filePath, 'hello world\n');
    markFileRead(registry, filePath);

    await editTool.execute({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'HELLO',
    });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('HELLO world\n');

    const result = await undoTool.execute({ file_path: filePath });
    expect(result.details.rejected).toBe(false);
    expect(result.details.restored).toBe(true);
    expect(result.details.revertedSource).toBe('Edit');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('hello world\n');
    expect(getText(result)).toContain('Undid Edit');
  });

  it('restores prior content after a Write overwrite', async () => {
    const filePath = path.join(tmpDir, 'w.txt');
    fs.writeFileSync(filePath, 'original\n');
    markFileRead(registry, filePath);

    await writeTool.execute({ file_path: filePath, content: 'overwritten\n' });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('overwritten\n');

    const result = await undoTool.execute({ file_path: filePath });
    expect(result.details.restored).toBe(true);
    expect(result.details.revertedSource).toBe('Write');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('original\n');
  });

  it('deletes a file that Write just created', async () => {
    const filePath = path.join(tmpDir, 'new.txt');
    expect(fs.existsSync(filePath)).toBe(false);

    await writeTool.execute({ file_path: filePath, content: 'fresh\n' });
    expect(fs.existsSync(filePath)).toBe(true);

    const result = await undoTool.execute({ file_path: filePath });
    expect(result.details.deleted).toBe(true);
    expect(result.details.revertedSource).toBe('Write');
    expect(fs.existsSync(filePath)).toBe(false);
    expect(getText(result)).toContain('file deleted');
  });

  it('peels back mutations one at a time', async () => {
    const filePath = path.join(tmpDir, 'stack.txt');
    fs.writeFileSync(filePath, 'v0\n');
    markFileRead(registry, filePath);

    await editTool.execute({ file_path: filePath, old_string: 'v0', new_string: 'v1' });
    await editTool.execute({ file_path: filePath, old_string: 'v1', new_string: 'v2' });
    await editTool.execute({ file_path: filePath, old_string: 'v2', new_string: 'v3' });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('v3\n');

    await undoTool.execute({ file_path: filePath });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('v2\n');
    await undoTool.execute({ file_path: filePath });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('v1\n');
    await undoTool.execute({ file_path: filePath });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('v0\n');
  });

  it('refreshes the read registry so the next Edit does not need a re-Read', async () => {
    const filePath = path.join(tmpDir, 'refresh.txt');
    fs.writeFileSync(filePath, 'start\n');
    markFileRead(registry, filePath);

    await editTool.execute({ file_path: filePath, old_string: 'start', new_string: 'middle' });
    await undoTool.execute({ file_path: filePath });

    // No manual re-Read: subsequent Edit must still succeed.
    const next = await editTool.execute({
      file_path: filePath,
      old_string: 'start',
      new_string: 'final',
    });
    expect(next.details.replacementCount).toBe(1);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('final\n');
  });

  // -------------------------------------------------------------------------
  // Rejection cases
  // -------------------------------------------------------------------------

  it('rejects when no mutation has been recorded for the file', async () => {
    const filePath = path.join(tmpDir, 'never.txt');
    fs.writeFileSync(filePath, 'untouched\n');

    const result = await undoTool.execute({ file_path: filePath });
    expect(result.details.rejected).toBe(true);
    expect(getText(result)).toContain('No recorded Edit or Write');
    // File must not have been touched.
    expect(fs.readFileSync(filePath, 'utf8')).toBe('untouched\n');
  });

  it('rejects when the file has been externally modified after the edit', async () => {
    const filePath = path.join(tmpDir, 'drift.txt');
    fs.writeFileSync(filePath, 'starting\n');
    markFileRead(registry, filePath);

    await editTool.execute({
      file_path: filePath,
      old_string: 'starting',
      new_string: 'edited',
    });

    // Simulate an external change that our history did not record.
    fs.writeFileSync(filePath, 'external\n');

    const result = await undoTool.execute({ file_path: filePath });
    expect(result.details.rejected).toBe(true);
    expect(getText(result)).toContain('modified');
    // File contents must not have been stomped by the refused undo.
    expect(fs.readFileSync(filePath, 'utf8')).toBe('external\n');
  });

  it('pushes the entry back onto the stack when the undo is rejected', async () => {
    const filePath = path.join(tmpDir, 'drift.txt');
    fs.writeFileSync(filePath, 'starting\n');
    markFileRead(registry, filePath);

    await editTool.execute({
      file_path: filePath,
      old_string: 'starting',
      new_string: 'edited',
    });

    const stackDepthBefore = history.depth(filePath);
    expect(stackDepthBefore).toBe(1);

    // Drift the file, then fail to undo.
    fs.writeFileSync(filePath, 'external\n');
    const rejected = await undoTool.execute({ file_path: filePath });
    expect(rejected.details.rejected).toBe(true);

    // Fix the drift: restore the post-edit state byte-exactly, then try again.
    fs.writeFileSync(filePath, 'edited\n');
    const depthAfterReject = history.depth(filePath);
    expect(depthAfterReject).toBe(1); // entry preserved

    // Now the undo should succeed and roll back to 'starting'.
    const ok = await undoTool.execute({ file_path: filePath });
    expect(ok.details.restored).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('starting\n');
  });

  it('rejects when the file has been deleted since the edit', async () => {
    const filePath = path.join(tmpDir, 'gone.txt');
    fs.writeFileSync(filePath, 'existing\n');
    markFileRead(registry, filePath);

    await editTool.execute({
      file_path: filePath,
      old_string: 'existing',
      new_string: 'modified',
    });
    fs.unlinkSync(filePath);

    const result = await undoTool.execute({ file_path: filePath });
    expect(result.details.rejected).toBe(true);
    expect(getText(result)).toContain('deleted');
  });

  // -------------------------------------------------------------------------
  // Resilience against post-mutation formatter-style mtime bumps
  // -------------------------------------------------------------------------

  it('allows undo when mtime changed but bytes are byte-identical', async () => {
    const filePath = path.join(tmpDir, 'fmt.txt');
    fs.writeFileSync(filePath, 'start\n');
    markFileRead(registry, filePath);

    await editTool.execute({
      file_path: filePath,
      old_string: 'start',
      new_string: 'after',
    });

    // Simulate a formatter that touches mtime without changing bytes.
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(filePath, future, future);

    const result = await undoTool.execute({ file_path: filePath });
    expect(result.details.restored).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('start\n');
  });

  // -------------------------------------------------------------------------
  // Stack isolation
  // -------------------------------------------------------------------------

  it('undos are file-scoped (editing file A does not affect file B history)', async () => {
    const fileA = path.join(tmpDir, 'a.txt');
    const fileB = path.join(tmpDir, 'b.txt');
    fs.writeFileSync(fileA, 'A-start\n');
    fs.writeFileSync(fileB, 'B-start\n');
    markFileRead(registry, fileA);
    markFileRead(registry, fileB);

    await editTool.execute({ file_path: fileA, old_string: 'A-start', new_string: 'A-edit' });
    await editTool.execute({ file_path: fileB, old_string: 'B-start', new_string: 'B-edit' });

    // Undo A only.
    await undoTool.execute({ file_path: fileA });
    expect(fs.readFileSync(fileA, 'utf8')).toBe('A-start\n');
    expect(fs.readFileSync(fileB, 'utf8')).toBe('B-edit\n');

    // B's undo remains available.
    const undoB = await undoTool.execute({ file_path: fileB });
    expect(undoB.details.restored).toBe(true);
    expect(fs.readFileSync(fileB, 'utf8')).toBe('B-start\n');
  });
});
