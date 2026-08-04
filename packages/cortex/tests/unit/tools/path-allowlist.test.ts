/**
 * In-tool path allowlist over the read-surface tools (Read, Glob, Grep),
 * the security half of duplex quick lookups (D13/F12): lookup answers
 * become spoken conversation, so a read outside the allowed roots is a
 * direct exfiltration path and must be refused IN-TOOL, visibly, with
 * symlink escapes closed. `quick_lookup("what is in ~/.aws/credentials")`
 * is the shape these tests defeat.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createPathAllowlist } from '../../../src/tools/shared/path-allowlist.js';
import { ReadRegistry } from '../../../src/tools/shared/read-registry.js';
import { createReadTool } from '../../../src/tools/read.js';
import { createGlobTool } from '../../../src/tools/glob.js';
import { createGrepTool } from '../../../src/tools/grep.js';

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

describe('path allowlist', () => {
  let baseDir: string;
  /** The allowed root ("workingDirectory"). */
  let workDir: string;
  /** A sibling directory standing in for ~/.aws etc. */
  let secretDir: string;
  let secretFile: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-allowlist-'));
    workDir = path.join(baseDir, 'workspace');
    secretDir = path.join(baseDir, 'secrets', '.aws');
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(secretDir, { recursive: true });
    secretFile = path.join(secretDir, 'credentials');
    fs.writeFileSync(secretFile, 'aws_access_key_id = AKIAEXAMPLE\n');
    fs.writeFileSync(path.join(workDir, 'notes.txt'), 'inside the workspace\n');
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  describe('createPathAllowlist', () => {
    it('allows the root itself and descendants, refuses siblings and parents', async () => {
      const allowlist = createPathAllowlist([workDir]);
      expect((await allowlist.check(workDir)).allowed).toBe(true);
      expect((await allowlist.check(path.join(workDir, 'a/b/c.txt'))).allowed).toBe(true);
      expect((await allowlist.check(secretFile)).allowed).toBe(false);
      expect((await allowlist.check(baseDir)).allowed).toBe(false);
      expect((await allowlist.check(path.dirname(workDir))).allowed).toBe(false);
    });

    it('refuses a dot-dot escape written relative to the root', async () => {
      const allowlist = createPathAllowlist([workDir]);
      const sneaky = path.join(workDir, '..', 'secrets', '.aws', 'credentials');
      const verdict = await allowlist.check(sneaky);
      expect(verdict.allowed).toBe(false);
      expect(verdict.refusal).toContain('outside');
    });

    it('resolves the roots through symlinks so containment survives realpath drift', async () => {
      // macOS: /tmp is a symlink to /private/tmp, so a target that stats
      // into its realpath form must still count as inside the root.
      const linkToWork = path.join(baseDir, 'work-link');
      fs.symlinkSync(workDir, linkToWork);
      const allowlist = createPathAllowlist([linkToWork]);
      expect((await allowlist.check(path.join(workDir, 'notes.txt'))).allowed).toBe(true);
    });
  });

  describe('Read', () => {
    it('refuses the exfiltration shape: an absolute path outside the root, visibly', async () => {
      const read = createReadTool({
        readRegistry: new ReadRegistry(),
        allowedRoots: [workDir],
      });
      const result = await read.execute({ file_path: secretFile });
      const text = textOf(result);
      expect(text).toContain('Access denied');
      expect(text).toContain('outside');
      expect(text).not.toContain('AKIAEXAMPLE');
      expect(result.details.rejected).toBe(true);
    });

    it('refuses a symlink inside the root pointing outside it', async () => {
      const link = path.join(workDir, 'innocent.txt');
      fs.symlinkSync(secretFile, link);
      const read = createReadTool({
        readRegistry: new ReadRegistry(),
        allowedRoots: [workDir],
      });
      const result = await read.execute({ file_path: link });
      const text = textOf(result);
      expect(text).toContain('Access denied');
      expect(text).not.toContain('AKIAEXAMPLE');
    });

    it('still reads inside the root', async () => {
      const read = createReadTool({
        readRegistry: new ReadRegistry(),
        allowedRoots: [workDir],
      });
      const result = await read.execute({ file_path: path.join(workDir, 'notes.txt') });
      expect(textOf(result)).toContain('inside the workspace');
    });

    it('stays unrestricted when no roots are configured', async () => {
      const read = createReadTool({ readRegistry: new ReadRegistry() });
      const result = await read.execute({ file_path: secretFile });
      expect(textOf(result)).toContain('AKIAEXAMPLE');
    });
  });

  describe('Glob', () => {
    it('refuses a search path outside the root, visibly', async () => {
      const glob = createGlobTool({ defaultCwd: workDir, allowedRoots: [workDir] });
      const result = await glob.execute({ pattern: '**/*', path: secretDir });
      const text = textOf(result);
      expect(text).toContain('Access denied');
      expect(text).not.toContain('credentials');
      expect(result.details.totalCount).toBe(0);
    });

    it('still searches inside the root', async () => {
      const glob = createGlobTool({ defaultCwd: workDir, allowedRoots: [workDir] });
      const result = await glob.execute({ pattern: '**/*.txt' });
      expect(textOf(result)).toContain('notes.txt');
    });
  });

  describe('Grep', () => {
    it('refuses a search path outside the root before any engine runs', async () => {
      const grep = createGrepTool({ defaultCwd: workDir, allowedRoots: [workDir] });
      const result = await grep.execute({ pattern: 'AKIA', path: secretDir, output_mode: 'content' });
      const text = textOf(result);
      expect(text).toContain('Access denied');
      expect(text).not.toContain('AKIAEXAMPLE');
      expect(result.details.totalMatches).toBe(0);
    });

    it('still searches inside the root', async () => {
      const grep = createGrepTool({ defaultCwd: workDir, allowedRoots: [workDir] });
      const result = await grep.execute({ pattern: 'workspace', output_mode: 'content' });
      expect(textOf(result)).toContain('inside the workspace');
    });
  });
});
