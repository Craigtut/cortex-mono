import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isPathWithinRealCwd } from '../../src/permissions/path-containment.js';

describe('isPathWithinRealCwd', () => {
  let tmpDir: string;
  let projectDir: string;
  let outsideDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-path-containment-'));
    projectDir = path.join(tmpDir, 'project');
    outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(projectDir);
    fs.mkdirSync(outsideDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('allows paths inside the real project directory', async () => {
    const filePath = path.join(projectDir, 'src', 'index.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'export {};\n');

    await expect(isPathWithinRealCwd(filePath, projectDir)).resolves.toBe(true);
    await expect(isPathWithinRealCwd('src/index.ts', projectDir)).resolves.toBe(true);
  });

  it('allows nonexistent paths under the real project directory', async () => {
    await expect(isPathWithinRealCwd('src/new-file.ts', projectDir)).resolves.toBe(true);
  });

  it('rejects symlinks that resolve outside the project directory', async () => {
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret\n');

    const linkPath = path.join(projectDir, 'secret-link');
    try {
      fs.symlinkSync(outsideFile, linkPath);
    } catch {
      return;
    }

    await expect(isPathWithinRealCwd(linkPath, projectDir)).resolves.toBe(false);
  });

  it('rejects nonexistent paths under symlinked directories outside the project', async () => {
    const linkPath = path.join(projectDir, 'outside-link');
    try {
      fs.symlinkSync(outsideDir, linkPath, 'dir');
    } catch {
      return;
    }

    await expect(isPathWithinRealCwd(path.join(linkPath, 'new-file.txt'), projectDir)).resolves.toBe(false);
  });
});
