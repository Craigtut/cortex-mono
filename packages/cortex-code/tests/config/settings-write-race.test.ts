/**
 * The three per-workspace settings stores (permission rules, network domain
 * grants, sandbox rung) share one settings.json, each owning a top-level key
 * with the same read-modify-write pattern. These tests race real stores
 * against the same file and assert no store's key is lost, which is exactly
 * what happened before the shared write lock: both read, both write, second
 * write drops the first store's key.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NetworkGrantStore } from '../../src/permissions/network.js';
import { PermissionRuleManager, workspaceSettingsPath } from '../../src/permissions/rules.js';
import { SandboxSettingsStore } from '../../src/config/sandbox-settings.js';

let tmp: string;
let cwd: string;
let configDir: string;
let settingsPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-settings-race-'));
  cwd = path.join(tmp, 'ws');
  configDir = path.join(tmp, 'config');
  fs.mkdirSync(cwd, { recursive: true });
  settingsPath = workspaceSettingsPath(cwd, configDir);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
}

describe('concurrent settings.json writes across stores', () => {
  it('a network grant and a sandbox rung written concurrently both survive', async () => {
    const grants = new NetworkGrantStore(settingsPath);
    const sandbox = new SandboxSettingsStore(settingsPath);
    await grants.load();
    await sandbox.load();

    await Promise.all([grants.add('example.com'), sandbox.setRung('trusted')]);

    const settings = readSettings();
    expect((settings['network'] as { allowedDomains: string[] }).allowedDomains).toContain(
      'example.com',
    );
    expect((settings['sandbox'] as { rung: string }).rung).toBe('trusted');
  });

  it('a permission rule and a network grant written concurrently both survive', async () => {
    const rules = new PermissionRuleManager(cwd, { configDir });
    const grants = new NetworkGrantStore(settingsPath);
    await rules.loadPersistedRules();
    await grants.load();

    await Promise.all([
      rules.addRule('project', 'allow', 'Bash', 'git status'),
      grants.add('api.example.com'),
    ]);

    const settings = readSettings();
    expect((settings['permissions'] as { allow: string[] }).allow).toContain('Bash(git status)');
    expect((settings['network'] as { allowedDomains: string[] }).allowedDomains).toContain(
      'api.example.com',
    );
  });

  it('all three stores racing on a fresh file lose nothing', async () => {
    const rules = new PermissionRuleManager(cwd, { configDir });
    const grants = new NetworkGrantStore(settingsPath);
    const sandbox = new SandboxSettingsStore(settingsPath);
    await Promise.all([rules.loadPersistedRules(), grants.load(), sandbox.load()]);

    await Promise.all([
      rules.addRule('project', 'deny', 'Read', `${cwd}/secrets/*`),
      grants.add('registry.internal'),
      sandbox.setRung('restricted'),
      sandbox.markContainerNoticeShown(),
    ]);

    const settings = readSettings();
    expect((settings['permissions'] as { deny: string[] }).deny).toContain(
      `Read(${cwd}/secrets/*)`,
    );
    expect((settings['network'] as { allowedDomains: string[] }).allowedDomains).toContain(
      'registry.internal',
    );
    const sandboxKey = settings['sandbox'] as { rung: string; containerNoticeShown: boolean };
    expect(sandboxKey.rung).toBe('restricted');
    expect(sandboxKey.containerNoticeShown).toBe(true);
  });
});
