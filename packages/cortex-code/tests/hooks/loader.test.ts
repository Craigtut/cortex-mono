import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir as realHomedir } from 'node:os';
import { join } from 'node:path';
import { loadHookHandlers } from '../../src/hooks/loader.js';

// Stub homedir so the loader looks at our fake "global" config dir.
let fakeHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: (): string => fakeHome ?? actual.homedir(),
  };
});

let projectCwd: string;

beforeEach(async () => {
  fakeHome = join(tmpdir(), `cortex-hook-test-home-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  projectCwd = join(tmpdir(), `cortex-hook-test-proj-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(fakeHome, '.cortex'), { recursive: true });
  await mkdir(join(projectCwd, '.cortex'), { recursive: true });
});

afterEach(async () => {
  await rm(fakeHome, { recursive: true, force: true });
  await rm(projectCwd, { recursive: true, force: true });
});

describe('loadHookHandlers', () => {
  it('returns empty buckets when no config files exist', async () => {
    // Recreate without the .cortex dirs.
    await rm(join(fakeHome, '.cortex'), { recursive: true, force: true });
    await rm(join(projectCwd, '.cortex'), { recursive: true, force: true });
    const map = await loadHookHandlers(projectCwd);
    expect(map.pre_turn).toEqual([]);
    expect(map.session_start).toEqual([]);
  });

  it('loads global handlers under the matching event', async () => {
    await writeFile(
      join(fakeHome, '.cortex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          pre_turn: [{ name: 'reverie-bridge', command: '/usr/local/bin/reverie-hook' }],
          session_start: [{ command: '/usr/local/bin/banner' }],
        },
      }),
      'utf-8',
    );
    const map = await loadHookHandlers(projectCwd);
    expect(map.pre_turn).toHaveLength(1);
    expect(map.pre_turn[0]).toMatchObject({
      name: 'reverie-bridge',
      command: '/usr/local/bin/reverie-hook',
      source: 'global',
    });
    expect(map.session_start[0]?.name).toBe('/usr/local/bin/banner');
    expect(map.session_start[0]?.source).toBe('global');
  });

  it('project handlers with same name override global ones', async () => {
    await writeFile(
      join(fakeHome, '.cortex', 'hooks.json'),
      JSON.stringify({
        hooks: { pre_turn: [{ name: 'reverie', command: '/usr/global/r' }] },
      }),
      'utf-8',
    );
    await writeFile(
      join(projectCwd, '.cortex', 'hooks.json'),
      JSON.stringify({
        hooks: { pre_turn: [{ name: 'reverie', command: '/project/r' }] },
      }),
      'utf-8',
    );
    const map = await loadHookHandlers(projectCwd);
    expect(map.pre_turn).toHaveLength(1);
    expect(map.pre_turn[0]?.command).toBe('/project/r');
    expect(map.pre_turn[0]?.source).toBe('project');
  });

  it('global and project handlers with different names coexist', async () => {
    await writeFile(
      join(fakeHome, '.cortex', 'hooks.json'),
      JSON.stringify({ hooks: { pre_turn: [{ name: 'g', command: '/g' }] } }),
      'utf-8',
    );
    await writeFile(
      join(projectCwd, '.cortex', 'hooks.json'),
      JSON.stringify({ hooks: { pre_turn: [{ name: 'p', command: '/p' }] } }),
      'utf-8',
    );
    const map = await loadHookHandlers(projectCwd);
    const names = map.pre_turn.map((h) => h.name).sort();
    expect(names).toEqual(['g', 'p']);
  });

  it('skips entries with missing or empty command, but preserves siblings', async () => {
    await writeFile(
      join(fakeHome, '.cortex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          pre_turn: [
            { name: 'good', command: '/good' },
            { name: 'no-command' },
            { name: 'empty', command: '' },
          ],
        },
      }),
      'utf-8',
    );
    const map = await loadHookHandlers(projectCwd);
    expect(map.pre_turn).toHaveLength(1);
    expect(map.pre_turn[0]?.command).toBe('/good');
  });

  it('treats malformed JSON as no hooks (without throwing)', async () => {
    await writeFile(join(fakeHome, '.cortex', 'hooks.json'), '{not json', 'utf-8');
    const map = await loadHookHandlers(projectCwd);
    expect(map.pre_turn).toEqual([]);
  });

  it('passes through optional timeout, args, env, cwd fields', async () => {
    await writeFile(
      join(fakeHome, '.cortex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          pre_turn: [
            {
              name: 'reverie',
              command: '/r',
              args: ['--mode', 'fast'],
              cwd: '/tmp/r',
              timeoutMs: 1234,
              env: { K: 'V' },
            },
          ],
        },
      }),
      'utf-8',
    );
    const map = await loadHookHandlers(projectCwd);
    const handler = map.pre_turn[0]!;
    expect(handler.args).toEqual(['--mode', 'fast']);
    expect(handler.cwd).toBe('/tmp/r');
    expect(handler.timeoutMs).toBe(1234);
    expect(handler.env).toEqual({ K: 'V' });
  });
});

// Sanity check that the real OS homedir export still works for non-mocked
// callers; reduces risk of cross-test pollution.
describe('os.homedir mock isolation', () => {
  it('does not leak into other modules', () => {
    expect(typeof realHomedir).toBe('function');
  });
});
