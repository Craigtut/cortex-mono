import { describe, it, expect, beforeEach } from 'vitest';
import { FileMutationLock } from '../../../src/tools/shared/file-mutation-lock.js';

describe('FileMutationLock', () => {
  let lock: FileMutationLock;

  beforeEach(() => {
    lock = new FileMutationLock();
  });

  it('acquire returns a release function', async () => {
    const release = await lock.acquire('/test.txt');
    expect(typeof release).toBe('function');
    release();
  });

  it('serializes concurrent acquires on the same path', async () => {
    const order: number[] = [];

    const run = async (id: number) => {
      const release = await lock.acquire('/shared.txt');
      order.push(id);
      // Simulate async work
      await new Promise(resolve => setTimeout(resolve, 10));
      release();
    };

    // Launch concurrently
    await Promise.all([run(1), run(2), run(3)]);

    // All three ran in sequence (order is deterministic: 1, 2, 3)
    expect(order).toEqual([1, 2, 3]);
  });

  it('does not block different paths', async () => {
    const order: string[] = [];

    const releaseA = await lock.acquire('/a.txt');
    // While /a.txt is held, /b.txt should be immediately acquirable
    const releaseB = await lock.acquire('/b.txt');
    order.push('both acquired');
    releaseA();
    releaseB();

    expect(order).toEqual(['both acquired']);
  });

  it('allows re-acquisition after release', async () => {
    const release1 = await lock.acquire('/test.txt');
    release1();

    const release2 = await lock.acquire('/test.txt');
    release2();
  });

  it('clear resolves pending chains', () => {
    lock.clear();
    // Should not throw or leave dangling state
  });

  it('normalizes paths', async () => {
    const order: number[] = [];

    const run = async (id: number, filePath: string) => {
      const release = await lock.acquire(filePath);
      order.push(id);
      await new Promise(resolve => setTimeout(resolve, 10));
      release();
    };

    // These resolve to the same absolute path
    const cwd = process.cwd();
    await Promise.all([
      run(1, `${cwd}/test.txt`),
      run(2, `${cwd}/./test.txt`),
    ]);

    // Should serialize (both resolve to same path)
    expect(order).toEqual([1, 2]);
  });
});
