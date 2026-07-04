import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { preflightPermission, type PreflightDeps } from '../../src/permissions/preflight.js';
import { PermissionRuleManager } from '../../src/permissions/rules.js';

function deps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    yoloMode: false,
    cwd: '/workspace',
    home: '/home/user',
    matchRule: async () => null,
    isReadOnlyInProject: async () => false,
    ...overrides,
  };
}

describe('preflightPermission', () => {
  it('blocks a catastrophic Bash command ahead of everything, even yolo', async () => {
    const out = await preflightPermission('Bash', { command: 'rm -rf /' }, deps({ yoloMode: true }));
    expect(out.decision).toBe('block');
  });

  it('yolo allows non-catastrophic calls', async () => {
    const out = await preflightPermission('Bash', { command: 'ls' }, deps({ yoloMode: true }));
    expect(out.decision).toBe('allow');
  });

  it('honors an explicit deny over the read-only-in-project auto-approve', async () => {
    let readOnlyChecked = false;
    const out = await preflightPermission(
      'Read',
      { file_path: '/workspace/secrets/key.txt' },
      deps({
        matchRule: async () => 'deny',
        isReadOnlyInProject: async () => {
          readOnlyChecked = true;
          return true; // would otherwise auto-allow
        },
      }),
    );
    expect(out.decision).toBe('block');
    // The deny short-circuits before the read-only shortcut is even consulted.
    expect(readOnlyChecked).toBe(false);
  });

  it('auto-approves a read-only-in-project call when no deny applies', async () => {
    const out = await preflightPermission(
      'Read',
      { file_path: '/workspace/src/x.ts' },
      deps({ isReadOnlyInProject: async () => true }),
    );
    expect(out.decision).toBe('allow');
  });

  it('allows via an allow rule when not read-only and not denied', async () => {
    const out = await preflightPermission(
      'Edit',
      { file_path: '/workspace/src/x.ts' },
      deps({ matchRule: async () => 'allow' }),
    );
    expect(out.decision).toBe('allow');
  });

  it('prompts when nothing matches', async () => {
    const out = await preflightPermission('Bash', { command: 'git status' }, deps());
    expect(out.decision).toBe('prompt');
  });

  it('blocks an in-workspace Read deny even though the path is read-only-in-project', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-preflight-'));
    const projectDir = path.join(tmp, 'project');
    fs.mkdirSync(projectDir);
    const secret = path.join(projectDir, 'secrets', 'key.txt');
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, 'k\n');
    try {
      const rules = new PermissionRuleManager(projectDir, { configDir: path.join(tmp, 'config') });
      await rules.addRule('session', 'deny', 'Read', `${projectDir}/secrets/*`);
      const out = await preflightPermission(
        'Read',
        { file_path: secret },
        deps({
          cwd: projectDir,
          matchRule: (t, a) => rules.matchRule(t, a),
          isReadOnlyInProject: async () => true, // read-only shortcut would allow it
        }),
      );
      expect(out.decision).toBe('block');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('sandbox auto-allows a non-catastrophic Bash command that would otherwise prompt', async () => {
    const promptOut = await preflightPermission('Bash', { command: 'npm test' }, deps());
    expect(promptOut.decision).toBe('prompt');
    const allowOut = await preflightPermission(
      'Bash',
      { command: 'npm test' },
      deps({ sandboxBashEnforced: true }),
    );
    expect(allowOut.decision).toBe('allow');
  });

  it('sandbox auto-allow never overrides the catastrophic floor', async () => {
    const out = await preflightPermission(
      'Bash',
      { command: 'rm -rf /' },
      deps({ sandboxBashEnforced: true }),
    );
    expect(out.decision).toBe('block');
  });

  it('sandbox auto-allow never overrides an explicit deny rule', async () => {
    const out = await preflightPermission(
      'Bash',
      { command: 'git push' },
      deps({ sandboxBashEnforced: true, matchRule: async () => 'deny' }),
    );
    expect(out.decision).toBe('block');
  });

  it('sandbox auto-allow applies only to Bash, not in-process tools like Write', async () => {
    const out = await preflightPermission(
      'Write',
      { file_path: '/workspace/x.ts' },
      deps({ sandboxBashEnforced: true }),
    );
    expect(out.decision).toBe('prompt');
  });

  it('network-gated WebFetch auto-runs (the per-host gate is the control)', async () => {
    const promptOut = await preflightPermission('WebFetch', { url: 'https://example.com/' }, deps());
    expect(promptOut.decision).toBe('prompt');
    const allowOut = await preflightPermission(
      'WebFetch',
      { url: 'https://example.com/' },
      deps({ webFetchNetworkGated: true }),
    );
    expect(allowOut.decision).toBe('allow');
  });

  it('network-gated WebFetch still honors an explicit deny rule', async () => {
    const out = await preflightPermission(
      'WebFetch',
      { url: 'https://example.com/' },
      deps({ webFetchNetworkGated: true, matchRule: async () => 'deny' }),
    );
    expect(out.decision).toBe('block');
  });

  it('the WebFetch gate flag does not auto-allow other tools', async () => {
    const out = await preflightPermission(
      'Bash',
      { command: 'npm test' },
      deps({ webFetchNetworkGated: true }),
    );
    expect(out.decision).toBe('prompt');
  });

  it('blocks a Write to ~/.cortex even in yolo mode (config-integrity floor)', async () => {
    const out = await preflightPermission(
      'Write',
      { file_path: '/home/user/.cortex/workspaces/abc/settings.json' },
      deps({ yoloMode: true, home: '/home/user' }),
    );
    expect(out.decision).toBe('block');
  });

  it('blocks an Edit to the project .cortex config', async () => {
    const out = await preflightPermission(
      'Edit',
      { file_path: '/workspace/.cortex/config.json' },
      deps({ cwd: '/workspace' }),
    );
    expect(out.decision).toBe('block');
  });

  it('does not block a Write to a normal workspace file', async () => {
    const out = await preflightPermission(
      'Write',
      { file_path: '/workspace/src/x.ts' },
      deps({ cwd: '/workspace' }),
    );
    expect(out.decision).toBe('prompt');
  });
});
