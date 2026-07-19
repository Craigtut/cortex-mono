import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { CwdTracker } from '../../../src/tools/shared/cwd-tracker.js';
import {
  createBashTool,
  isBashEscalationRequest,
  BASH_ESCALATION_PERMISSION_NAME,
} from '../../../src/tools/bash/index.js';
import type {
  SandboxCommandFailure,
  SandboxDenial,
  SandboxProvider,
  SandboxSpawnSpec,
  SandboxStatus,
  WrappedSpawn,
} from '../../../src/sandbox/types.js';

/**
 * A fake sandbox provider that records the spawns it is asked to wrap and
 * prepends an observable marker onto the composed command, so a test can prove
 * the Bash tool actually routes execution through wrapSpawn. Optionally
 * classifies failures (recording each classify call) for the denial-note tests.
 */
function makeFakeProvider(options?: {
  classify?: (failure: SandboxCommandFailure) => SandboxDenial | null;
}) {
  const calls: SandboxSpawnSpec[] = [];
  const classifyCalls: SandboxCommandFailure[] = [];
  const classify = options?.classify;
  const provider: SandboxProvider = {
    async initialize(): Promise<SandboxStatus> {
      return { filesystem: 'enforced', network: 'enforced', backend: 'seatbelt', degradations: [] };
    },
    async wrapSpawn(spec: SandboxSpawnSpec): Promise<WrappedSpawn> {
      calls.push(spec);
      // Compose like the unsandboxed path would, but prefix an observable marker
      // so the wrapping is detectable in the command output.
      const args = [...spec.shellArgs, `echo SANDBOXED; ${spec.command}`];
      return { file: spec.shell, args, env: spec.env };
    },
    ...(classify
      ? {
          classifyFailure(failure: SandboxCommandFailure): SandboxDenial | null {
            classifyCalls.push(failure);
            return classify(failure);
          },
        }
      : {}),
    async dispose(): Promise<void> {},
  };
  return { provider, calls, classifyCalls };
}

describe('Bash tool sandbox seam', () => {
  let cwdTracker: CwdTracker;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-bash-sandbox-'));
    cwdTracker = new CwdTracker(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('leaves execution unchanged when no provider is configured (no-op default)', async () => {
    const tool = createBashTool({ cwdTracker });
    const result = await tool.execute({ command: 'echo plain' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('plain');
    expect(text).not.toContain('SANDBOXED');
    expect(result.details.exitCode).toBe(0);
  });

  it('reports gracefully and notifies the provider when the wrapper fails to launch', async () => {
    // The wrapper's file points at a binary that does not exist, so the spawn
    // emits an 'error' (ENOENT) — the mid-session "helper quarantined by
    // antivirus" case. The tool must (a) call notifyWrappedSpawnFailure and
    // (b) return an actionable message, not a raw "spawn ENOENT".
    const notifyCalls: Array<{ code?: string; message: string }> = [];
    const missingHelper = path.join(tmpDir, 'no-such-helper-binary.exe');
    const provider: SandboxProvider = {
      async initialize(): Promise<SandboxStatus> {
        return { filesystem: 'partial', network: 'none', backend: 'win-restricted-token', degradations: [] };
      },
      async wrapSpawn(spec: SandboxSpawnSpec): Promise<WrappedSpawn> {
        return { file: missingHelper, args: ['whatever', spec.command], env: spec.env };
      },
      notifyWrappedSpawnFailure(error): void {
        notifyCalls.push(error);
      },
      async dispose(): Promise<void> {},
    };
    const tool = createBashTool({ cwdTracker, sandbox: provider });
    const result = await tool.execute({ command: 'echo hello' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(notifyCalls).toHaveLength(1);
    expect(text).toContain('OS sandbox wrapper could not be launched');
    expect(text).not.toMatch(/^Failed to execute command/);
    expect(result.details.exitCode).toBeNull();
  });

  it('routes the spawn through the provider when configured', async () => {
    const { provider, calls } = makeFakeProvider();
    const tool = createBashTool({ cwdTracker, sandbox: provider });

    // Capture before execution: the tool resolves symlinks in the tracked cwd
    // after parsing `pwd` output, so getCwd() changes once the command runs.
    const expectedCwd = cwdTracker.getCwd();
    const result = await tool.execute({ command: 'echo hello' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    // The wrapped command ran (marker present) and the original ran too.
    expect(text).toContain('SANDBOXED');
    expect(text).toContain('hello');
    expect(result.details.exitCode).toBe(0);

    // wrapSpawn was invoked once with the resolved shell, command, and cwd.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.shell).toBeTruthy();
    expect(calls[0]!.command).toContain('echo hello');
    expect(calls[0]!.cwd).toBe(expectedCwd);

    // The env handed to the provider is already sanitized (injection vectors
    // stripped) and still carries PATH.
    expect(calls[0]!.env['NODE_OPTIONS']).toBeUndefined();
    expect(calls[0]!.env['PATH'] ?? calls[0]!.env['Path']).toBeTruthy();
  });

  it('preserves working-directory tracking through the wrapper', async () => {
    const { provider } = makeFakeProvider();
    const tool = createBashTool({ cwdTracker, sandbox: provider });

    const subDir = path.join(tmpDir, 'nested');
    fs.mkdirSync(subDir);
    await tool.execute({ command: `cd "${subDir}"` });

    expect(cwdTracker.getCwd()).toBe(subDir);
  });
});

describe('Bash tool single-command escalation', () => {
  let cwdTracker: CwdTracker;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-bash-escalate-'));
    cwdTracker = new CwdTracker(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs the command uncontained when the permission gate approved it', async () => {
    const { provider, calls } = makeFakeProvider();
    const tool = createBashTool({ cwdTracker, sandbox: provider, permissionGated: true });

    // Reaching execute() with the flag set models an approved escalation: the
    // gate (resolvePermission via beforeToolCall) already saw the call under
    // BASH_ESCALATION_PERMISSION_NAME and did not block it.
    const result = await tool.execute({ command: 'echo escaped', escalateOutsideSandbox: true });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(text).toContain('escaped');
    expect(text).not.toContain('SANDBOXED');
    expect(result.details.exitCode).toBe(0);
    // The provider was never asked to wrap this spawn.
    expect(calls).toHaveLength(0);
  });

  it('refuses escalation when no permission gate is configured (fail closed)', async () => {
    const { provider, calls } = makeFakeProvider();
    const tool = createBashTool({ cwdTracker, sandbox: provider });

    const witness = path.join(tmpDir, 'should-not-exist');
    const result = await tool.execute({
      command: `touch "${witness}"`,
      escalateOutsideSandbox: true,
    });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(text).toContain('Escalation outside the sandbox is unavailable');
    expect(result.details.exitCode).toBeNull();
    // Nothing ran, sandboxed or otherwise.
    expect(fs.existsSync(witness)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('ignores the flag when no sandbox provider is configured', async () => {
    const tool = createBashTool({ cwdTracker });

    const result = await tool.execute({ command: 'echo plain', escalateOutsideSandbox: true });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    // No sandbox to escape: the command just runs, no refusal.
    expect(text).toContain('plain');
    expect(result.details.exitCode).toBe(0);
  });

  it('still applies the catastrophic floor to an approved escalation', async () => {
    const { provider, calls } = makeFakeProvider();
    const tool = createBashTool({ cwdTracker, sandbox: provider, permissionGated: true });

    const result = await tool.execute({ command: 'rm -rf /', escalateOutsideSandbox: true });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(text).toContain('hard block');
    expect(result.details.exitCode).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('a normal call with the flag unset is wrapped exactly as before', async () => {
    const { provider, calls } = makeFakeProvider();
    const tool = createBashTool({ cwdTracker, sandbox: provider, permissionGated: true });

    const result = await tool.execute({ command: 'echo contained', escalateOutsideSandbox: false });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(text).toContain('SANDBOXED');
    expect(text).toContain('contained');
    expect(calls).toHaveLength(1);
  });
});

describe('Bash tool sandbox denial notes', () => {
  let cwdTracker: CwdTracker;
  let tmpDir: string;

  const writeDenial: SandboxDenial = {
    dimension: 'filesystem-write',
    detail: 'file-write-create /etc/blocked',
    escalatable: true,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-bash-denial-'));
    cwdTracker = new CwdTracker(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends a self-explaining note when the provider attributes the failure', async () => {
    const { provider } = makeFakeProvider({ classify: () => writeDenial });
    const tool = createBashTool({ cwdTracker, sandbox: provider });

    const result = await tool.execute({ command: 'exit 3' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(result.details.exitCode).toBe(3);
    expect(text).toContain('sandbox denial');
    expect(text).toContain('file-write-create /etc/blocked');
    // The model is told escalation exists and that a human must approve it.
    expect(text).toContain('escalateOutsideSandbox: true');
    expect(text).toContain('the user must approve');
  });

  it('passes the provider the exact composed command given to wrapSpawn', async () => {
    const { provider, calls, classifyCalls } = makeFakeProvider({ classify: () => null });
    const tool = createBashTool({ cwdTracker, sandbox: provider });

    await tool.execute({ command: 'exit 5' });

    // The violation store matches on the command tag from the wrapped spawn, so
    // attribution must use the same string (cwd-capture suffix included).
    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]!.command).toBe(calls[0]!.command);
    expect(classifyCalls[0]!.exitCode).toBe(5);
  });

  it('does not consult the provider on success', async () => {
    const { provider, classifyCalls } = makeFakeProvider({ classify: () => writeDenial });
    const tool = createBashTool({ cwdTracker, sandbox: provider });

    const result = await tool.execute({ command: 'echo fine' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(result.details.exitCode).toBe(0);
    expect(text).not.toContain('sandbox denial');
    expect(classifyCalls).toHaveLength(0);
  });

  it('adds no note when the provider does not attribute the failure', async () => {
    const { provider, classifyCalls } = makeFakeProvider({ classify: () => null });
    const tool = createBashTool({ cwdTracker, sandbox: provider });

    const result = await tool.execute({ command: 'exit 1' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(classifyCalls).toHaveLength(1);
    expect(text).not.toContain('sandbox denial');
    expect(text).toContain('Exit code: 1');
  });

  it('does not classify an escalated (unwrapped) failure', async () => {
    const { provider, classifyCalls } = makeFakeProvider({ classify: () => writeDenial });
    const tool = createBashTool({ cwdTracker, sandbox: provider, permissionGated: true });

    const result = await tool.execute({ command: 'exit 2', escalateOutsideSandbox: true });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    // The command ran outside the sandbox; its failure cannot be a denial.
    expect(result.details.exitCode).toBe(2);
    expect(classifyCalls).toHaveLength(0);
    expect(text).not.toContain('sandbox denial');
  });

  it('a throwing classifier never breaks the result (best-effort)', async () => {
    const { provider } = makeFakeProvider({
      classify: () => {
        throw new Error('violation store unavailable');
      },
    });
    const tool = createBashTool({ cwdTracker, sandbox: provider });

    const result = await tool.execute({ command: 'exit 4' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(result.details.exitCode).toBe(4);
    expect(text).toContain('Exit code: 4');
    expect(text).not.toContain('sandbox denial');
  });
});

describe('isBashEscalationRequest', () => {
  it('recognizes a Bash call with the flag set to true', () => {
    expect(isBashEscalationRequest('Bash', { command: 'ls', escalateOutsideSandbox: true })).toBe(true);
  });

  it('requires a literal boolean true (no truthy coercion)', () => {
    expect(isBashEscalationRequest('Bash', { command: 'ls', escalateOutsideSandbox: 'true' })).toBe(false);
    expect(isBashEscalationRequest('Bash', { command: 'ls', escalateOutsideSandbox: 1 })).toBe(false);
  });

  it('is false for other tools, absent flags, and non-object args', () => {
    expect(isBashEscalationRequest('Write', { escalateOutsideSandbox: true })).toBe(false);
    expect(isBashEscalationRequest('Bash', { command: 'ls' })).toBe(false);
    expect(isBashEscalationRequest('Bash', null)).toBe(false);
    expect(isBashEscalationRequest('Bash', undefined)).toBe(false);
  });

  it('the synthetic permission name is stable API', () => {
    expect(BASH_ESCALATION_PERMISSION_NAME).toBe('Bash(escalate)');
  });
});
