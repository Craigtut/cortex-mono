import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpConfigWatcher } from '../../src/mcp/mcp-watcher.js';

describe('McpConfigWatcher', () => {
  let onChange: ReturnType<typeof vi.fn>;
  let cwd: string;

  beforeEach(async () => {
    onChange = vi.fn();
    cwd = await mkTmp();
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('debounces a burst of events into one listener call', async () => {
    let listenerForDir: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    const watchFn = ((dir: unknown, _opts: unknown, cb: (eventType: string, filename: string | Buffer | null) => void) => {
      void dir;
      listenerForDir = cb;
      return { close: () => {} } as unknown as ReturnType<typeof import('node:fs').watch>;
    }) as unknown as typeof import('node:fs').watch;

    // Create the project .cortex dir so attach() takes the happy path for that scope.
    const projectDir = join(cwd, '.cortex');
    await mkdir(projectDir, { recursive: true });

    const watcher = new McpConfigWatcher({
      cwd,
      onChange,
      debounceMs: 30,
      watchFn,
    });
    await watcher.start();

    // Fire several events in quick succession.
    expect(listenerForDir).toBeDefined();
    listenerForDir!('change', 'mcp.json');
    listenerForDir!('change', 'mcp.json');
    listenerForDir!('change', 'mcp.json');

    // No callback should have fired yet (debounce window).
    expect(onChange).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('project');

    await watcher.stop();
  });

  it('filters out events for files other than mcp.json', async () => {
    let listenerForDir: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    const watchFn = ((_dir: unknown, _opts: unknown, cb: (eventType: string, filename: string | Buffer | null) => void) => {
      listenerForDir = cb;
      return { close: () => {} } as unknown as ReturnType<typeof import('node:fs').watch>;
    }) as unknown as typeof import('node:fs').watch;
    await mkdir(join(cwd, '.cortex'), { recursive: true });
    const watcher = new McpConfigWatcher({ cwd, onChange, debounceMs: 10, watchFn });
    await watcher.start();
    listenerForDir!('change', 'other-file.json');
    listenerForDir!('change', 'trusted-mcp.json');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(onChange).not.toHaveBeenCalled();
    await watcher.stop();
  });

  it('pulse() triggers an immediate-debounced manual notification', async () => {
    const watchFn = ((_dir: unknown, _opts: unknown) => ({ close: () => {} } as unknown as ReturnType<typeof import('node:fs').watch>)) as unknown as typeof import('node:fs').watch;
    const watcher = new McpConfigWatcher({ cwd, onChange, debounceMs: 5, watchFn });
    await watcher.start();
    watcher.pulse();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onChange).toHaveBeenCalledWith('manual');
    await watcher.stop();
  });

  it('stop() prevents further notifications even with pending events', async () => {
    let listenerForDir: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    const watchFn = ((_dir: unknown, _opts: unknown, cb: (eventType: string, filename: string | Buffer | null) => void) => {
      listenerForDir = cb;
      return { close: () => {} } as unknown as ReturnType<typeof import('node:fs').watch>;
    }) as unknown as typeof import('node:fs').watch;
    await mkdir(join(cwd, '.cortex'), { recursive: true });
    const watcher = new McpConfigWatcher({ cwd, onChange, debounceMs: 30, watchFn });
    await watcher.start();
    listenerForDir!('change', 'mcp.json');
    await watcher.stop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(onChange).not.toHaveBeenCalled();
  });
});

async function mkTmp(): Promise<string> {
  const dir = join(tmpdir(), `mcp-watcher-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
