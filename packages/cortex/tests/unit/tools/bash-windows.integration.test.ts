import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBashTool } from '../../../src/tools/bash/index.js';
import { CwdTracker } from '../../../src/tools/shared/cwd-tracker.js';

const shells = [
  { name: 'discovered PowerShell', shellPath: undefined },
  {
    name: 'Windows PowerShell 5.1',
    shellPath: path.win32.join(process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  },
];

// Real process tests, runnable on the Windows runner without credentials.
describe.skipIf(process.platform !== 'win32').each(shells)('$name execution', ({ shellPath }) => {
  let directory: string;
  let tool: ReturnType<typeof createBashTool>;

  beforeEach(() => {
    // os.tmpdir() can be an 8.3 short path (C:\Users\RUNNER~1\...) while
    // PowerShell reports the long one; the native realpath expands it.
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex windows ')));
    tool = createBashTool({ cwdTracker: new CwdTracker(directory), ...(shellPath ? { shellPath } : {}) });
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('spawns PowerShell and can run a second command in the captured directory', async () => {
    const first = await tool.execute({ command: 'Write-Output "hello"' });
    expect(first.details.exitCode).toBe(0);
    expect(first.details.stdout.trim()).toBe('hello');
    expect(first.details.finalCwd).toBe(directory);
    const second = await tool.execute({ command: 'Write-Output "second"' });
    expect(second.details.exitCode).toBe(0);
    expect(second.details.stdout.trim()).toBe('second');
  });

  it('tracks a directory change with spaces and UTF-8 output', async () => {
    const subdirectory = path.join(directory, 'child directory');
    fs.mkdirSync(subdirectory);
    const changed = await tool.execute({ command: "Set-Location 'child directory'" });
    expect(changed.details.finalCwd).toBe(subdirectory);
    const result = await tool.execute({ command: 'Write-Output "héllo 世界"' });
    expect(result.details.exitCode).toBe(0);
    expect(result.details.stdout.trim()).toBe('héllo 世界');
    expect(result.details.finalCwd).toBe(subdirectory);
  });

  it('reports failed cmdlets as failures', async () => {
    const result = await tool.execute({ command: "Get-Item 'missing-cortex-file'" });
    expect(result.details.exitCode).toBe(1);
    expect(result.details.stderr).toContain('missing-cortex-file');
  });

  it('preserves native program exit codes', async () => {
    const result = await tool.execute({ command: 'node -e "process.exit(42)"' });
    expect(result.details.exitCode).toBe(42);
  });

  it('captures the directory after a trailing PowerShell comment', async () => {
    const result = await tool.execute({ command: 'Write-Output "hello" # comment' });
    expect(result.details.exitCode).toBe(0);
    expect(result.details.stdout.trim()).toBe('hello');
    expect(result.details.finalCwd).toBe(directory);
  });
});
