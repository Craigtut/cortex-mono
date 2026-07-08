/**
 * End-to-end proof that the native Windows Tier-1 restricted-token helper
 * actually contains a real child process: writes are confined to the workspace
 * roots + the per-session sandbox temp, the agent-config / .git-internal
 * deny-write targets are unwritable, reads stay broad, credential env vars are
 * scrubbed, and exit codes pass through.
 *
 * This is the Windows analogue of the macOS/Linux adversarial suites. It runs
 * ONLY on win32 with the signed (or locally-built) helper present at
 * defaultHelperPath(); on every other host, and on a Windows checkout with no
 * bundled binary, it skips rather than pretending it verified anything. A
 * silently-broken sandbox is worse than none, so each "must be denied" case
 * asserts the write did NOT land on disk, not merely a non-zero exit.
 *
 * The shell here is PowerShell, matching cortex's own Windows shell selection
 * (`selectWindowsShell`). That is deliberate: the helper reconstructs the child
 * command line with the standard CommandLineToArgvW quoting that Node's
 * child_process.spawn uses, and PowerShell parses its command line by those same
 * rules. (cmd.exe does NOT: it has its own quote parser, so passing it a quoted
 * argument this way mis-parses under both the sandbox AND a plain Node spawn.
 * cortex never uses cmd.exe on Windows, so the helper matches spawn semantics,
 * not cmd's.)
 *
 * Tier-1 honesty: this suite deliberately does NOT assert that reading a secret
 * is denied. Under a same-user WRITE_RESTRICTED token the deny-read ACEs are
 * inert (reads ride the normal token), so a secret read is EXPECTED to succeed;
 * that gap closes with the future Tier-2 dedicated-user backend. What Tier 1
 * enforces and this suite checks is write confinement plus the env scrub.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  WindowsRestrictedTokenProvider,
  defaultHelperPath,
  buildDefaultPolicy,
} from '../src/index.js';

const HELPER_PRESENT = process.platform === 'win32' && fs.existsSync(defaultHelperPath());

/** Windows PowerShell 5.1 is always present on a supported host; pwsh 7 is optional. */
function resolvePowerShell(): string {
  const candidates = [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[1]!;
}
const PS = resolvePowerShell();
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command'];

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

let provider: WindowsRestrictedTokenProvider;
let root: string;
let ws: string;
let sbxTemp: string;
let escape: string;
let agentConfig: string;

/** A PowerShell write that exits non-zero (13) if the write is denied. */
const psWrite = (p: string) =>
  `try { Set-Content -LiteralPath '${p}' -Value 'x' -ErrorAction Stop } catch { exit 13 }`;
const psAppend = (p: string) =>
  `try { Add-Content -LiteralPath '${p}' -Value 'x' -ErrorAction Stop } catch { exit 13 }`;

/** Wrap a PowerShell command through the provider and run it under the real helper. */
async function runContained(command: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const wrapped = await provider.wrapSpawn({
    shell: PS,
    shellArgs: PS_ARGS,
    command,
    cwd: ws,
    env: { PATH: process.env.PATH ?? '', ...extraEnv },
  });
  return new Promise<RunResult>((resolve) => {
    const proc = spawn(wrapped.file, wrapped.args, { cwd: ws, env: wrapped.env });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => (stdout += String(d)));
    proc.stderr?.on('data', (d) => (stderr += String(d)));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }));
  });
}

describe.skipIf(!HELPER_PRESENT)('Windows Tier-1 helper adversarial containment', () => {
  beforeAll(async () => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-win-integ-')));
    ws = path.join(root, 'ws');
    sbxTemp = path.join(root, 'sbx-temp');
    escape = path.join(root, 'escape');
    fs.mkdirSync(ws);
    fs.mkdirSync(sbxTemp);
    fs.mkdirSync(escape);
    // Deny-write targets must exist for their ACE to be applied.
    fs.mkdirSync(path.join(ws, '.git', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.git', 'objects'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.git', 'config'), '[core]\n');
    fs.writeFileSync(path.join(ws, 'source.txt'), 'readable content');
    const cfgDir = path.join(root, 'agent-home', '.cortex');
    fs.mkdirSync(cfgDir, { recursive: true });
    agentConfig = path.join(cfgDir, 'settings.json');
    fs.writeFileSync(agentConfig, '{"trusted":true}');

    provider = new WindowsRestrictedTokenProvider();
    const policy = buildDefaultPolicy('workspace', {
      workspaceRoots: [ws],
      home: path.join(root, 'agent-home'),
      sessionTmpDir: sbxTemp,
      extraDenyWrite: [cfgDir],
    });
    const status = await provider.initialize(policy);
    expect(status.backend).toBe('win-restricted-token');
    expect(status.filesystem).toBe('partial');
    expect(status.network).toBe('none');
  });

  afterAll(async () => {
    await provider?.dispose();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('allows a write inside the workspace', async () => {
    const target = path.join(ws, 'inside.txt');
    const r = await runContained(psWrite(target));
    expect(r.code).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("allows a write to the child's %TEMP% (routed at the sandbox temp)", async () => {
    const r = await runContained("Set-Content -LiteralPath (Join-Path $env:TEMP 'viatemp.txt') -Value 'x'");
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(sbxTemp, 'viatemp.txt'))).toBe(true);
  });

  it('allows reading a workspace file', async () => {
    const r = await runContained(`Get-Content -LiteralPath '${path.join(ws, 'source.txt')}'`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('readable content');
  });

  it('denies a write outside the workspace', async () => {
    const target = path.join(escape, 'out.txt');
    const r = await runContained(psWrite(target));
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('denies a write to the agent config (deny-write)', async () => {
    const before = fs.readFileSync(agentConfig, 'utf8');
    const r = await runContained(psWrite(agentConfig));
    expect(r.code).not.toBe(0);
    expect(fs.readFileSync(agentConfig, 'utf8')).toBe(before);
  });

  it('denies a write to a .git hook (deny-write)', async () => {
    const hook = path.join(ws, '.git', 'hooks', 'pre-commit');
    const r = await runContained(psWrite(hook));
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(hook)).toBe(false);
  });

  it('denies a write to .git/config but leaves the rest of .git writable (commits work)', async () => {
    const cfg = path.join(ws, '.git', 'config');
    const before = fs.readFileSync(cfg, 'utf8');
    const denied = await runContained(psAppend(cfg));
    expect(denied.code).not.toBe(0);
    expect(fs.readFileSync(cfg, 'utf8')).toBe(before);
    // An ordinary .git write (not hooks/config) must still succeed.
    const objects = path.join(ws, '.git', 'objects', 'probe.txt');
    const allowed = await runContained(psWrite(objects));
    expect(allowed.code).toBe(0);
    expect(fs.existsSync(objects)).toBe(true);
  });

  it('scrubs credential env vars from the child', async () => {
    const r = await runContained('Write-Output "TOKEN=[$env:GITHUB_TOKEN]"', {
      GITHUB_TOKEN: 'ghp_secret_value',
    });
    expect(r.stdout).not.toContain('ghp_secret_value');
    expect(r.stdout).toContain('TOKEN=[]');
  });

  it('passes the child exit code through unchanged', async () => {
    const r = await runContained('exit 7');
    expect(r.code).toBe(7);
  });
});
