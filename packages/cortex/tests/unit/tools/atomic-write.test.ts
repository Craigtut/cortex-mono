import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  atomicWrite,
  resolveRealTarget,
  CriticalPathWriteError,
} from '../../../src/tools/shared/atomic-write.js';

const isWindows = process.platform === 'win32';

describe('atomicWrite', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-atomic-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes new content atomically', async () => {
    const filePath = path.join(tmpDir, 'new.txt');
    await atomicWrite(filePath, 'hello');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('hello');
  });

  it('leaves no leftover temp files behind', async () => {
    const filePath = path.join(tmpDir, 'clean.txt');
    await atomicWrite(filePath, 'body');
    const leftovers = fs.readdirSync(tmpDir).filter((n) => n.startsWith('.atomic-'));
    expect(leftovers).toEqual([]);
  });

  // --- Mode preservation (POSIX only; Windows has no real chmod) ---

  it.skipIf(isWindows)('overwriting a 0600 file keeps 0600', async () => {
    const filePath = path.join(tmpDir, 'secret.env');
    fs.writeFileSync(filePath, 'TOKEN=old');
    fs.chmodSync(filePath, 0o600);

    await atomicWrite(filePath, 'TOKEN=new');

    expect(fs.readFileSync(filePath, 'utf8')).toBe('TOKEN=new');
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.skipIf(isWindows)('overwriting a 0755 file keeps the executable bit', async () => {
    const filePath = path.join(tmpDir, 'script.sh');
    fs.writeFileSync(filePath, '#!/bin/sh\necho old\n');
    fs.chmodSync(filePath, 0o755);

    await atomicWrite(filePath, '#!/bin/sh\necho new\n');

    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o755);
    // The +x bits survived the rename.
    expect(mode & 0o111).toBe(0o111);
  });

  it.skipIf(isWindows)('new files are not forced to the overwritten target mode', async () => {
    // Sanity: a brand-new file uses the platform default, not 0600/0755.
    const filePath = path.join(tmpDir, 'plain.txt');
    await atomicWrite(filePath, 'x');
    const mode = fs.statSync(filePath).mode & 0o777;
    // Readable/writable by owner at minimum; exact value depends on umask.
    expect(mode & 0o600).toBe(0o600);
  });

  // --- Symlink safety ---

  it.skipIf(isWindows)('refuses to write through a symlink to a critical path', async () => {
    const linkPath = path.join(tmpDir, 'innocent-name');
    // Workspace-local symlink whose lexical path is harmless but which
    // resolves to a critical system file.
    fs.symlinkSync('/etc/passwd', linkPath);

    const before = fs.readFileSync('/etc/passwd', 'utf8');

    await expect(atomicWrite(linkPath, 'pwned')).rejects.toBeInstanceOf(
      CriticalPathWriteError,
    );

    // The critical file was not touched.
    expect(fs.readFileSync('/etc/passwd', 'utf8')).toBe(before);
    // And the symlink itself was not replaced with a regular file.
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });

  it.skipIf(isWindows)('resolves a symlinked ancestor to its real target', () => {
    // A directory symlink in the workspace; a file path underneath it must
    // resolve through the link to the real directory.
    const realDir = path.join(tmpDir, 'real');
    fs.mkdirSync(realDir);
    const linkDir = path.join(tmpDir, 'link');
    fs.symlinkSync(realDir, linkDir);

    const resolved = resolveRealTarget(path.join(linkDir, 'file.txt'));
    expect(resolved).toBe(path.join(fs.realpathSync(realDir), 'file.txt'));
  });
});
