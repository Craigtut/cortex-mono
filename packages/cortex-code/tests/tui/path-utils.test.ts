import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => '/home/runner' };
});

const { shortenPath } = await import('../../src/tui/renderers/path-utils.js');

const HOME = '/home/runner';

describe('shortenPath', () => {
  it('replaces the home directory itself with ~', () => {
    expect(shortenPath(HOME)).toBe('~');
  });

  it('replaces the home prefix when followed by a separator', () => {
    expect(shortenPath(HOME + path.sep + 'projects')).toBe('~' + path.sep + 'projects');
  });

  it('does not shorten a sibling directory that merely shares the prefix', () => {
    const sibling = '/home/runner2' + path.sep + 'projects';
    expect(shortenPath(sibling)).toBe(sibling);
  });

  it('leaves unrelated paths untouched', () => {
    expect(shortenPath('/var/log/system.log')).toBe('/var/log/system.log');
  });
});
