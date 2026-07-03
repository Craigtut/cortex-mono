import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWriteTool, createReadTool, ReadRegistry } from '@animus-labs/cortex';

/**
 * The permission containment layer resolves a file tool's target lexically
 * (path.resolve, no symlink following). This locks the OTHER half of that
 * invariant: the real Write/Read tools resolve their target the same way, so
 * the path the permission layer authorizes is exactly the path the tool
 * touches. If a future refactor made either side follow symlinks while the
 * other stayed lexical, `${cwd}/link/../secret.txt` would let them diverge into
 * a real escape. These tests fail loudly if that ever happens.
 */
describe('file tool path resolution agrees with the permission containment layer', () => {
  let tmpDir: string;
  let projectDir: string;
  let elsewhere: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-tool-path-'));
    projectDir = path.join(tmpDir, 'project');
    elsewhere = path.join(tmpDir, 'elsewhere');
    fs.mkdirSync(projectDir);
    fs.mkdirSync(path.join(elsewhere, 'sub'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Write/Read of `${cwd}/link/../secret.txt` touch the inside path, never the symlink target outside', async () => {
    // A dir symlink inside the workspace pointing OUTSIDE it. If path
    // resolution followed the link, `link/../secret.txt` would resolve to
    // `${elsewhere}/secret.txt` (outside). The tools path.resolve() lexically,
    // collapsing `link/..` to nothing, so they target `${project}/secret.txt`
    // (inside), the same target the permission layer authorizes.
    const linkPath = path.join(projectDir, 'link');
    try {
      fs.symlinkSync(path.join(elsewhere, 'sub'), linkPath, 'dir');
    } catch {
      return; // symlink privileges unavailable (e.g. Windows without dev mode)
    }

    // The file the symlink-following path would have hit, pre-seeded so we can
    // prove it is never touched.
    const outsideSecret = path.join(elsewhere, 'secret.txt');
    fs.writeFileSync(outsideSecret, 'OUTSIDE-SECRET');

    const registry = new ReadRegistry();
    const writeTool = createWriteTool({ readRegistry: registry });
    const readTool = createReadTool({ readRegistry: registry });

    // Build the literal `link/../secret.txt` string (path.join would collapse
    // it early); let the tool's own path.resolve do the lexical collapse.
    const traversalPath = `${projectDir}${path.sep}link${path.sep}..${path.sep}secret.txt`;
    const insidePath = path.join(projectDir, 'secret.txt');

    const writeResult = await writeTool.execute({ file_path: traversalPath, content: 'INSIDE-DATA' });

    // The tool wrote to the inside path, not through the symlink.
    expect(writeResult.details.filePath).toBe(insidePath);
    expect(fs.readFileSync(insidePath, 'utf8')).toBe('INSIDE-DATA');
    // The outside secret is untouched.
    expect(fs.readFileSync(outsideSecret, 'utf8')).toBe('OUTSIDE-SECRET');

    // Read of the same traversal path returns the inside content, never outside.
    const readResult = await readTool.execute({ file_path: traversalPath });
    const text = (readResult.content[0] as { type: 'text'; text: string }).text;
    expect(readResult.details.filePath).toBe(insidePath);
    expect(text).toContain('INSIDE-DATA');
    expect(text).not.toContain('OUTSIDE-SECRET');
  });
});
