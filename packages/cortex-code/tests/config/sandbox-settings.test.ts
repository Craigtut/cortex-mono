import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SandboxSettingsStore } from '../../src/config/sandbox-settings.js';

function tmpSettingsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-sandbox-settings-'));
  return path.join(dir, 'workspaces', 'abc123', 'settings.json');
}

describe('SandboxSettingsStore', () => {
  it('has no rung and no notice flag when the settings file does not exist', async () => {
    const store = new SandboxSettingsStore(tmpSettingsPath());
    await store.load();
    expect(store.getRung()).toBeUndefined();
    expect(store.isContainerNoticeShown()).toBe(false);
  });

  it('round-trips the rung through a fresh store', async () => {
    const settingsPath = tmpSettingsPath();
    const store = new SandboxSettingsStore(settingsPath);
    await store.load();
    await store.setRung('trusted');

    const reloaded = new SandboxSettingsStore(settingsPath);
    await reloaded.load();
    expect(reloaded.getRung()).toBe('trusted');
  });

  it('round-trips the container notice flag', async () => {
    const settingsPath = tmpSettingsPath();
    const store = new SandboxSettingsStore(settingsPath);
    await store.load();
    await store.markContainerNoticeShown();

    const reloaded = new SandboxSettingsStore(settingsPath);
    await reloaded.load();
    expect(reloaded.isContainerNoticeShown()).toBe(true);
  });

  it('only touches its own top-level key and keeps the file 0600', async () => {
    const settingsPath = tmpSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ['Bash(git *)'] },
        network: { allowedDomains: ['api.example.com'] },
      }),
    );

    const store = new SandboxSettingsStore(settingsPath);
    await store.load();
    await store.setRung('restricted');

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    expect(settings['permissions']).toEqual({ allow: ['Bash(git *)'] });
    expect(settings['network']).toEqual({ allowedDomains: ['api.example.com'] });
    expect(settings['sandbox']).toEqual({ rung: 'restricted' });
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  it('ignores an invalid persisted rung value', async () => {
    const settingsPath = tmpSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ sandbox: { rung: 'yolo' } }));

    const store = new SandboxSettingsStore(settingsPath);
    await store.load();
    expect(store.getRung()).toBeUndefined();
  });
});
