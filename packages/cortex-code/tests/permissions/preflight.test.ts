import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BASH_ESCALATION_PERMISSION_NAME } from '@animus-labs/cortex';
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

  it('sandbox escalation always prompts, even in yolo mode', async () => {
    const out = await preflightPermission(
      BASH_ESCALATION_PERMISSION_NAME,
      { command: 'docker build .', escalateOutsideSandbox: true },
      deps({ yoloMode: true }),
    );
    expect(out.decision).toBe('prompt');
  });

  it('sandbox escalation prompts even while the sandbox auto-run is active', async () => {
    const out = await preflightPermission(
      BASH_ESCALATION_PERMISSION_NAME,
      { command: 'npm test', escalateOutsideSandbox: true },
      deps({ sandboxBashEnforced: true }),
    );
    expect(out.decision).toBe('prompt');
  });

  it('sandbox escalation is never auto-approved by an allow rule', async () => {
    const out = await preflightPermission(
      BASH_ESCALATION_PERMISSION_NAME,
      { command: 'npm test', escalateOutsideSandbox: true },
      deps({ matchRule: async () => 'allow' }),
    );
    expect(out.decision).toBe('prompt');
  });

  it('a plain-Bash deny rule blocks escalation of the same command', async () => {
    const seen: string[] = [];
    const out = await preflightPermission(
      BASH_ESCALATION_PERMISSION_NAME,
      { command: 'git push', escalateOutsideSandbox: true },
      deps({
        matchRule: async (toolName) => {
          seen.push(toolName);
          return 'deny';
        },
      }),
    );
    expect(out.decision).toBe('block');
    // Deny rules are written for the Bash tool; escalation must consult them
    // under that name rather than dodging them via the synthetic one.
    expect(seen).toEqual(['Bash']);
  });

  it('the catastrophic floor blocks escalation regardless of mode', async () => {
    const out = await preflightPermission(
      BASH_ESCALATION_PERMISSION_NAME,
      { command: 'rm -rf /', escalateOutsideSandbox: true },
      deps({ yoloMode: true, sandboxBashEnforced: true }),
    );
    expect(out.decision).toBe('block');
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

  it('blocks a Write through an in-workspace symlink into ~/.cortex (no lexical bypass)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-symlink-'));
    const home = path.join(tmp, 'home');
    const ws = path.join(tmp, 'ws');
    fs.mkdirSync(path.join(home, '.cortex', 'workspaces', 'x'), { recursive: true });
    fs.mkdirSync(ws, { recursive: true });
    const realTarget = path.join(home, '.cortex', 'workspaces', 'x', 'settings.json');
    fs.writeFileSync(realTarget, '{}');
    // The link file sits in the workspace (creating it is allowed inside the
    // sandbox) but points into the config tree.
    const link = path.join(ws, 'notes.txt');
    fs.symlinkSync(realTarget, link);
    try {
      const out = await preflightPermission('Write', { file_path: link }, deps({ home, cwd: ws }));
      expect(out.decision).toBe('block');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('preflightPermission: sandbox policy projection onto in-process file tools', () => {
  const policyDeps = (overrides: Partial<PreflightDeps> = {}): PreflightDeps =>
    deps({
      sandboxDenyWrite: ['/home/user/.zshrc', '/workspace/.git/hooks'],
      sandboxDenyRead: ['/home/user/.ssh'],
      ...overrides,
    });

  it('blocks a Write to a denyWrite path even in yolo mode', async () => {
    const out = await preflightPermission(
      'Write',
      { file_path: '/home/user/.zshrc' },
      policyDeps({ yoloMode: true }),
    );
    expect(out.decision).toBe('block');
    if (out.decision === 'block') expect(out.reason).toContain('write-protected');
  });

  it('blocks Edit and UndoEdit under a denyWrite directory', async () => {
    const edit = await preflightPermission(
      'Edit',
      { file_path: '/workspace/.git/hooks/pre-commit' },
      policyDeps(),
    );
    expect(edit.decision).toBe('block');
    const undo = await preflightPermission(
      'UndoEdit',
      { file_path: '/workspace/.git/hooks/pre-commit' },
      policyDeps(),
    );
    expect(undo.decision).toBe('block');
  });

  it('blocks a Read and an Edit under a denyRead path, even in yolo mode', async () => {
    const read = await preflightPermission(
      'Read',
      { file_path: '/home/user/.ssh/id_ed25519' },
      policyDeps({ yoloMode: true }),
    );
    expect(read.decision).toBe('block');
    if (read.decision === 'block') expect(read.reason).toContain('read-protected');
    const edit = await preflightPermission(
      'Edit',
      { file_path: '/home/user/.ssh/config' },
      policyDeps(),
    );
    expect(edit.decision).toBe('block');
  });

  it('does not block a Read of a denyWrite-only path (rc files stay readable)', async () => {
    const out = await preflightPermission(
      'Read',
      { file_path: '/home/user/.zshrc' },
      policyDeps(),
    );
    expect(out.decision).toBe('prompt');
  });

  it('leaves a normal workspace write on the normal prompt path', async () => {
    const out = await preflightPermission(
      'Write',
      { file_path: '/workspace/src/x.ts' },
      policyDeps(),
    );
    expect(out.decision).toBe('prompt');
  });

  it('does not apply when the sandbox is off (no policy deny sets)', async () => {
    const out = await preflightPermission('Write', { file_path: '/home/user/.zshrc' }, deps());
    expect(out.decision).toBe('prompt');
  });

  it('never applies to Bash (the OS boundary is Bash\'s control)', async () => {
    const out = await preflightPermission(
      'Bash',
      { command: 'echo hi > /home/user/.zshrc' },
      policyDeps({ sandboxBashEnforced: true }),
    );
    expect(out.decision).toBe('allow');
  });

  it('blocks a Write through an in-workspace symlink into a denyWrite path', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-policy-symlink-'));
    const home = path.join(tmp, 'home');
    const ws = path.join(tmp, 'ws');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(ws, { recursive: true });
    const zshrc = path.join(home, '.zshrc');
    fs.writeFileSync(zshrc, '# rc\n');
    const link = path.join(ws, 'notes.txt');
    fs.symlinkSync(zshrc, link);
    try {
      const out = await preflightPermission(
        'Write',
        { file_path: link },
        deps({ home, cwd: ws, sandboxDenyWrite: [zshrc] }),
      );
      expect(out.decision).toBe('block');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
