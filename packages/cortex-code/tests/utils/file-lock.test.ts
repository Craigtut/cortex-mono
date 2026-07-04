import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFileLock } from '../../src/utils/file-lock.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('withFileLock', () => {
  it('serializes operations on the same path in submission order', async () => {
    const p = '/fake/settings.json';
    const events: string[] = [];

    const first = withFileLock(p, async () => {
      events.push('first:start');
      await tick();
      await tick();
      events.push('first:end');
      return 1;
    });
    const second = withFileLock(p, async () => {
      events.push('second:start');
      events.push('second:end');
      return 2;
    });

    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('does not serialize operations on different paths', async () => {
    const events: string[] = [];
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const a = withFileLock('/fake/a.json', async () => {
      events.push('a:start');
      await gate;
      events.push('a:end');
    });
    const b = withFileLock('/fake/b.json', async () => {
      events.push('b:done');
    });

    await b;
    // b finished while a is still holding its own lock.
    expect(events).toEqual(['a:start', 'b:done']);
    releaseA();
    await a;
  });

  it('a rejection reaches its caller but does not block or fail later work', async () => {
    const p = '/fake/failing.json';
    const failing = withFileLock(p, async () => {
      throw new Error('boom');
    });
    const after = withFileLock(p, async () => 'ok');

    await expect(failing).rejects.toThrow('boom');
    expect(await after).toBe('ok');
  });

  it('two concurrent read-modify-writes of one file both survive', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-file-lock-'));
    const file = path.join(tmp, 'settings.json');

    // The exact pattern the settings stores use: read, mutate one key, write.
    const upsert = (key: string, value: string) =>
      withFileLock(file, async () => {
        let settings: Record<string, unknown> = {};
        try {
          settings = JSON.parse(await fs.promises.readFile(file, 'utf-8')) as Record<
            string,
            unknown
          >;
        } catch {
          settings = {};
        }
        settings[key] = value;
        await fs.promises.writeFile(file, JSON.stringify(settings));
      });

    try {
      await Promise.all([upsert('permissions', 'a'), upsert('network', 'b'), upsert('sandbox', 'c')]);
      const result = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      expect(result).toEqual({ permissions: 'a', network: 'b', sandbox: 'c' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
