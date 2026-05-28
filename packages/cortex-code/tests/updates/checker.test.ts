import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import {
  compareVersions,
  isNewer,
  fetchLatestVersion,
  resolveUpdateInfo,
  dismissVersion,
  checkNow,
  type UpdateState,
} from '../../src/updates/checker.js';

vi.mock('node:fs/promises');

const mockReadFile = vi.mocked(fs.readFile);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockMkdir = vi.mocked(fs.mkdir);

function stateFixture(overrides: Partial<UpdateState> = {}): UpdateState {
  return { lastCheckTime: 0, latestVersion: null, dismissedVersion: null, ...overrides };
}

describe('compareVersions', () => {
  it('orders by major, minor, patch', () => {
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.3.0', '0.3.1')).toBe(-1);
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
  });

  it('ignores prerelease suffix and leading v', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(0);
  });
});

describe('isNewer', () => {
  it('is true only for a higher stable release', () => {
    expect(isNewer('0.4.0', '0.3.0')).toBe(true);
    expect(isNewer('0.3.0', '0.3.0')).toBe(false);
    expect(isNewer('0.2.0', '0.3.0')).toBe(false);
  });

  it('never treats a prerelease as newer', () => {
    expect(isNewer('0.4.0-beta.1', '0.3.0')).toBe(false);
  });
});

describe('fetchLatestVersion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns the version from the registry response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '0.5.0' }),
    })));
    expect(await fetchLatestVersion()).toBe('0.5.0');
  });

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await fetchLatestVersion()).toBeNull();
  });

  it('returns null when the request throws (offline/timeout)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await fetchLatestVersion()).toBeNull();
  });
});

describe('resolveUpdateInfo', () => {
  let isTTY: boolean | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined as unknown as string);
    // Force interactive context.
    isTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    delete process.env['CI'];
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
    vi.unstubAllGlobals();
  });

  it('returns null when disabled', async () => {
    const info = await resolveUpdateInfo({ currentVersion: '0.3.0', enabled: false });
    expect(info).toBeNull();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('returns null in a non-TTY context', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const info = await resolveUpdateInfo({ currentVersion: '0.3.0', enabled: true });
    expect(info).toBeNull();
  });

  it('returns null when CI is set to a truthy value', async () => {
    process.env['CI'] = 'true';
    mockReadFile.mockResolvedValue(
      JSON.stringify(stateFixture({ lastCheckTime: Date.now(), latestVersion: '0.4.0' })),
    );
    const info = await resolveUpdateInfo({ currentVersion: '0.3.0', enabled: true });
    expect(info).toBeNull();
    delete process.env['CI'];
  });

  it('still checks when CI is explicitly false', async () => {
    process.env['CI'] = 'false';
    mockReadFile.mockResolvedValue(
      JSON.stringify(stateFixture({ lastCheckTime: Date.now(), latestVersion: '0.4.0' })),
    );
    const info = await resolveUpdateInfo({ currentVersion: '0.3.0', enabled: true });
    expect(info).toMatchObject({ latestVersion: '0.4.0' });
    delete process.env['CI'];
  });

  it('returns prompt info when a newer cached version exists and is not dismissed', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify(stateFixture({ lastCheckTime: Date.now(), latestVersion: '0.4.0' })),
    );
    const info = await resolveUpdateInfo({ currentVersion: '0.3.0', enabled: true });
    expect(info).toMatchObject({ latestVersion: '0.4.0', currentVersion: '0.3.0', shouldPrompt: true });
  });

  it('suppresses the prompt for a dismissed version but still reports the update', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify(stateFixture({ lastCheckTime: Date.now(), latestVersion: '0.4.0', dismissedVersion: '0.4.0' })),
    );
    const info = await resolveUpdateInfo({ currentVersion: '0.3.0', enabled: true });
    expect(info).toMatchObject({ latestVersion: '0.4.0', shouldPrompt: false });
  });

  it('returns null when the cached version is not newer', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify(stateFixture({ lastCheckTime: Date.now(), latestVersion: '0.3.0' })),
    );
    const info = await resolveUpdateInfo({ currentVersion: '0.3.0', enabled: true });
    expect(info).toBeNull();
  });

  it('triggers a background refresh when the cache is stale', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(stateFixture({ lastCheckTime: 0, latestVersion: null })));
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ version: '0.6.0' }) }));
    vi.stubGlobal('fetch', fetchMock);

    await resolveUpdateInfo({ currentVersion: '0.3.0', enabled: true });
    // The refresh is fired but not awaited; let the microtask settle.
    await new Promise((r) => setImmediate(r));
    expect(fetchMock).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalled();
  });
});

describe('dismissVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined as unknown as string);
  });

  it('persists the dismissed version while preserving other state', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify(stateFixture({ lastCheckTime: 123, latestVersion: '0.4.0' })),
    );
    await dismissVersion('0.4.0');
    const written = JSON.parse(mockWriteFile.mock.calls[0]![1] as string);
    expect(written).toMatchObject({ lastCheckTime: 123, latestVersion: '0.4.0', dismissedVersion: '0.4.0' });
  });
});

describe('checkNow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined as unknown as string);
    mockReadFile.mockResolvedValue(JSON.stringify(stateFixture()));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('forces shouldPrompt true when an update is found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: '0.9.0' }) })));
    const info = await checkNow('0.3.0');
    expect(info).toMatchObject({ latestVersion: '0.9.0', shouldPrompt: true });
  });

  it('returns null when already on the latest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: '0.3.0' }) })));
    expect(await checkNow('0.3.0')).toBeNull();
  });
});
