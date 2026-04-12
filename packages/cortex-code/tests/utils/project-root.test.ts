import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProjectRoot, sameProject } from '../../src/utils/project-root.js';

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'project-root-test-')));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('findProjectRoot', () => {
  it('returns the repo root when cwd is inside a .git repo', () => {
    const repo = join(tmpRoot, 'repoA');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const sub = join(repo, 'packages', 'inner');
    mkdirSync(sub, { recursive: true });

    expect(findProjectRoot(sub)).toBe(repo);
    expect(findProjectRoot(repo)).toBe(repo);
  });

  it('supports .git files (git worktrees) not just directories', () => {
    const repo = join(tmpRoot, 'repoWorktree');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, '.git'), 'gitdir: /elsewhere');

    expect(findProjectRoot(repo)).toBe(repo);
  });

  it('falls back to the resolved cwd when no .git ancestor exists', () => {
    // Use a dir under tmpRoot that has no .git anywhere in its chain up to tmpRoot.
    // (tmpRoot itself may be under /private/var which has no .git, confirming the
    // "no ancestor found" fallback returns the cwd itself.)
    const dir = join(tmpRoot, 'loose');
    mkdirSync(dir, { recursive: true });

    expect(findProjectRoot(dir)).toBe(dir);
  });

  it('resolves symlinks so symlinked paths match their real location', () => {
    const repo = join(tmpRoot, 'repoSymlink');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'pkg'), { recursive: true });
    const link = join(tmpRoot, 'linkToPkg');
    symlinkSync(join(repo, 'pkg'), link);

    expect(findProjectRoot(link)).toBe(repo);
  });

  it('handles non-existent paths by returning the resolved input', () => {
    const missing = join(tmpRoot, 'does', 'not', 'exist');
    const result = findProjectRoot(missing);
    expect(result).toBe(missing);
  });
});

describe('sameProject', () => {
  it('returns true for two paths inside the same repo', () => {
    const repo = join(tmpRoot, 'repoSame');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const a = join(repo, 'a');
    const b = join(repo, 'nested', 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });

    expect(sameProject(a, b)).toBe(true);
  });

  it('returns false for paths in different repos', () => {
    const repo1 = join(tmpRoot, 'repo1');
    const repo2 = join(tmpRoot, 'repo2');
    mkdirSync(join(repo1, '.git'), { recursive: true });
    mkdirSync(join(repo2, '.git'), { recursive: true });

    expect(sameProject(repo1, repo2)).toBe(false);
  });
});
