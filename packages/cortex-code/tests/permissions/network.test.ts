import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NetworkAccessRequest, SandboxNetworkPolicy } from '@animus-labs/cortex';
import {
  NetworkAccessController,
  NetworkGrantStore,
  type NetworkPromptChoice,
} from '../../src/permissions/network.js';

function tmpSettingsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-network-'));
  return path.join(dir, 'workspaces', 'abc123', 'settings.json');
}

function allowlistPolicy(overrides: Partial<SandboxNetworkPolicy> = {}): SandboxNetworkPolicy {
  return {
    mode: 'allowlist',
    allowedDomains: ['registry.npmjs.org', '*.npmjs.org', 'github.com'],
    deniedDomains: [],
    allowLocalBinding: true,
    ...overrides,
  };
}

function makeController(opts: {
  policy?: SandboxNetworkPolicy | undefined;
  store?: NetworkGrantStore;
  onPrompt?: (req: NetworkAccessRequest) => Promise<NetworkPromptChoice>;
}): { controller: NetworkAccessController; prompts: NetworkAccessRequest[] } {
  const prompts: NetworkAccessRequest[] = [];
  const controller = new NetworkAccessController({
    getPolicy: () => opts.policy,
    store: opts.store ?? new NetworkGrantStore(tmpSettingsPath()),
    prompt: async (req) => {
      prompts.push(req);
      return opts.onPrompt ? opts.onPrompt(req) : 'deny';
    },
  });
  return { controller, prompts };
}

const shellReq = (host: string): NetworkAccessRequest => ({ host, port: 443, via: 'shell' });

describe('NetworkAccessController', () => {
  it('allows everything without prompting when no policy is active (sandbox off)', async () => {
    const { controller, prompts } = makeController({ policy: undefined });
    const d = await controller.resolve(shellReq('anything.example.com'));
    expect(d.decision).toBe('allow');
    expect(prompts).toHaveLength(0);
  });

  it('allows everything without prompting in full mode (trusted rung)', async () => {
    const { controller, prompts } = makeController({ policy: allowlistPolicy({ mode: 'full' }) });
    const d = await controller.resolve(shellReq('anything.example.com'));
    expect(d.decision).toBe('allow');
    expect(prompts).toHaveLength(0);
  });

  it('denies everything without prompting in deny mode (restricted rung)', async () => {
    const { controller, prompts } = makeController({ policy: allowlistPolicy({ mode: 'deny' }) });
    const d = await controller.resolve(shellReq('registry.npmjs.org'));
    expect(d.decision).toBe('deny');
    expect(prompts).toHaveLength(0);
  });

  it('denied domains are refused on every mode, ahead of the allowlist and prompt', async () => {
    const { controller, prompts } = makeController({
      policy: allowlistPolicy({ mode: 'full', deniedDomains: ['evil.example.com'] }),
    });
    const d = await controller.resolve(shellReq('evil.example.com'));
    expect(d.decision).toBe('deny');
    expect(prompts).toHaveLength(0);
  });

  it('auto-allows the seeded allowlist, including wildcard entries, without prompting', async () => {
    const { controller, prompts } = makeController({ policy: allowlistPolicy() });
    expect((await controller.resolve(shellReq('registry.npmjs.org'))).decision).toBe('allow');
    expect((await controller.resolve(shellReq('api.npmjs.org'))).decision).toBe('allow');
    expect((await controller.resolve(shellReq('GitHub.com'))).decision).toBe('allow');
    expect(prompts).toHaveLength(0);
  });

  it('prompts for an unmatched host and honors a one-shot allow', async () => {
    const { controller, prompts } = makeController({
      policy: allowlistPolicy(),
      onPrompt: async () => 'once',
    });

    const first = await controller.resolve(shellReq('new.example.com'));
    expect(first).toEqual({ decision: 'allow', scope: 'once' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ host: 'new.example.com', via: 'shell' });

    // Once does not grant: the next request prompts again.
    await controller.resolve(shellReq('new.example.com'));
    expect(prompts).toHaveLength(2);
  });

  it('a session grant covers later requests from both paths without re-prompting', async () => {
    const { controller, prompts } = makeController({
      policy: allowlistPolicy(),
      onPrompt: async () => 'session',
    });

    const viaShell = await controller.resolve(shellReq('api.example.com'));
    expect(viaShell).toEqual({ decision: 'allow', scope: 'session' });

    const viaWebFetch = await controller.resolve({
      host: 'API.example.com.',
      via: 'webfetch',
      url: 'https://API.example.com./page',
    });
    expect(viaWebFetch.decision).toBe('allow');
    expect(prompts).toHaveLength(1);
  });

  it('an always grant persists through the store and covers a fresh controller', async () => {
    const settingsPath = tmpSettingsPath();
    const store = new NetworkGrantStore(settingsPath);
    await store.load();

    const { controller, prompts } = makeController({
      policy: allowlistPolicy(),
      store,
      onPrompt: async () => 'always',
    });
    const d = await controller.resolve(shellReq('trusted.example.com'));
    expect(d).toEqual({ decision: 'allow', scope: 'always' });
    expect(prompts).toHaveLength(1);

    // A new session (fresh store + controller reading the same settings file)
    // auto-allows without prompting.
    const store2 = new NetworkGrantStore(settingsPath);
    await store2.load();
    const second = makeController({ policy: allowlistPolicy(), store: store2 });
    const d2 = await second.controller.resolve(shellReq('trusted.example.com'));
    expect(d2).toEqual({ decision: 'allow', scope: 'always' });
    expect(second.prompts).toHaveLength(0);
  });

  it('a denied prompt refuses the request and is not remembered as a grant', async () => {
    let answer: NetworkPromptChoice = 'deny';
    const { controller, prompts } = makeController({
      policy: allowlistPolicy(),
      onPrompt: async () => answer,
    });

    expect((await controller.resolve(shellReq('blocked.example.com'))).decision).toBe('deny');
    // The user can change their mind on the next ask.
    answer = 'once';
    expect((await controller.resolve(shellReq('blocked.example.com'))).decision).toBe('allow');
    expect(prompts).toHaveLength(2);
  });

  it('coalesces concurrent requests for the same host and channel onto one prompt', async () => {
    let release!: (choice: NetworkPromptChoice) => void;
    const { controller, prompts } = makeController({
      policy: allowlistPolicy(),
      onPrompt: () => new Promise<NetworkPromptChoice>((resolve) => { release = resolve; }),
    });

    // Same host, same channel (one curl opening several connections).
    const a = controller.resolve(shellReq('burst.example.com'));
    const b = controller.resolve(shellReq('burst.example.com'));
    await new Promise((r) => setImmediate(r));
    release('once');

    expect((await a).decision).toBe('allow');
    expect((await b).decision).toBe('allow');
    expect(prompts).toHaveLength(1);
  });

  it('does not coalesce across channels: shell and webfetch to one host prompt separately', async () => {
    const releases: Array<(c: NetworkPromptChoice) => void> = [];
    const { controller, prompts } = makeController({
      policy: allowlistPolicy(),
      onPrompt: () => new Promise<NetworkPromptChoice>((resolve) => { releases.push(resolve); }),
    });

    // A webfetch carries a URL that may hold exfiltrated data; it must not be
    // answered behind an in-flight shell prompt showing the wrong context.
    const a = controller.resolve(shellReq('burst.example.com'));
    const b = controller.resolve({
      host: 'burst.example.com',
      via: 'webfetch',
      url: 'https://burst.example.com/?leak=secret',
    });
    await new Promise((r) => setImmediate(r));
    expect(prompts).toHaveLength(2);
    releases.forEach((r) => r('once'));
    expect((await a).decision).toBe('allow');
    expect((await b).decision).toBe('allow');
  });

  it('fails closed when the prompt throws', async () => {
    const { controller } = makeController({
      policy: allowlistPolicy(),
      onPrompt: async () => {
        throw new Error('TUI unavailable');
      },
    });
    expect((await controller.resolve(shellReq('x.example.com'))).decision).toBe('deny');
  });
});

describe('NetworkGrantStore', () => {
  it('persists grants with 0600 permissions and normalizes the host', async () => {
    const settingsPath = tmpSettingsPath();
    const store = new NetworkGrantStore(settingsPath);
    await store.load();
    await store.add('API.Example.COM.');

    expect([...store.getDomains()]).toEqual(['api.example.com']);
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(raw.network.allowedDomains).toEqual(['api.example.com']);
    const mode = fs.statSync(settingsPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('does not duplicate an existing grant', async () => {
    const store = new NetworkGrantStore(tmpSettingsPath());
    await store.load();
    await store.add('a.example.com');
    await store.add('a.example.com');
    expect(store.getDomains()).toHaveLength(1);
  });

  it('preserves other settings keys in the shared file', async () => {
    const settingsPath = tmpSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: ['Bash(git *)'] } }, null, 2),
    );

    const store = new NetworkGrantStore(settingsPath);
    await store.load();
    await store.add('a.example.com');

    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(raw.permissions.allow).toEqual(['Bash(git *)']);
    expect(raw.network.allowedDomains).toEqual(['a.example.com']);
  });

  it('loads persisted grants and tolerates a missing or malformed file', async () => {
    const settingsPath = tmpSettingsPath();
    const missing = new NetworkGrantStore(settingsPath);
    await missing.load();
    expect(missing.getDomains()).toEqual([]);

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ network: { allowedDomains: ['x.example.com', 42] } }));
    const loaded = new NetworkGrantStore(settingsPath);
    await loaded.load();
    expect(loaded.getDomains()).toEqual(['x.example.com']);
  });
});
