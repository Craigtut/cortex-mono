/**
 * The prompt lock grants in arrival order and binds each release to its own
 * grant, so a late or repeated release never frees another ask's lock.
 */
import { describe, it, expect } from 'vitest';
import { PromptLock } from '../../src/permissions/prompt-lock.js';

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('PromptLock', () => {
  it('ignores a late second release from a holder that already let go', async () => {
    const lock = new PromptLock();
    const releaseFirst = await lock.acquire();
    const second = lock.acquire();
    releaseFirst();
    const releaseSecond = await second;
    expect(lock.isHeld).toBe(true);

    releaseFirst();

    // The second holder still has it, and a third ask still waits.
    expect(lock.isHeld).toBe(true);
    let thirdGranted = false;
    const third = lock.acquire().then((release) => {
      thirdGranted = true;
      return release;
    });
    await flush();
    expect(thirdGranted).toBe(false);

    releaseSecond();
    (await third)();
    expect(lock.isHeld).toBe(false);
  });

  it('grants waiters in arrival order', async () => {
    const lock = new PromptLock();
    const order: string[] = [];
    const release = await lock.acquire();
    const waiters = ['a', 'b', 'c'].map((name) => lock.acquire().then((next) => {
      order.push(name);
      next();
    }));

    release();
    await Promise.all(waiters);

    expect(order).toEqual(['a', 'b', 'c']);
    expect(lock.isHeld).toBe(false);
  });
});
