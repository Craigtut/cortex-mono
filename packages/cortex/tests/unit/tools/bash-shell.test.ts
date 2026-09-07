import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { selectShell } from '../../../src/tools/bash/shell.js';

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  accessSync: vi.fn(),
}));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
const env = process.env;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
  process.env = {};
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', arch);
  process.env = env;
  vi.restoreAllMocks();
});

function installed(...files: string[]): void {
  vi.mocked(fs.accessSync).mockImplementation(file => {
    if (!files.includes(String(file))) throw new Error('ENOENT');
  });
}

describe('Windows shell discovery', () => {
  it('uses normalized paths for the default PowerShell 7 installation', () => {
    const shell = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    installed(shell);
    expect(selectShell()).toEqual({ shell, args: ['-NoProfile', '-NonInteractive', '-Command'] });
  });

  it('prefers PowerShell 7 from a quoted PATH with spaces and mixed env casing', () => {
    process.env = { Path: ';"D:\\Portable Apps\\PowerShell";relative;', PROGRAMFILES: 'D:\\Apps' };
    const shell = 'D:\\Portable Apps\\PowerShell\\pwsh.exe';
    installed(shell, 'D:\\Apps\\PowerShell\\7\\pwsh.exe');
    expect(selectShell().shell).toBe(shell);
  });

  it.each(['ProgramW6432', 'ProgramFiles'])('honors %s on another drive', key => {
    process.env[key] = 'E:\\Programs';
    const shell = 'E:\\Programs\\PowerShell\\7\\pwsh.exe';
    installed(shell);
    expect(selectShell().shell).toBe(shell);
  });

  it.each(['SystemRoot', 'windir'])('uses %s for Windows PowerShell 5.1', key => {
    process.env[key] = 'D:\\Windows';
    const shell = 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    installed(shell);
    expect(selectShell().shell).toBe(shell);
  });

  it('finds native Windows PowerShell from 32-bit Node', () => {
    Object.defineProperty(process, 'arch', { value: 'ia32', configurable: true });
    const shell = 'C:\\Windows\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe';
    installed(shell);
    expect(selectShell().shell).toBe(shell);
  });

  it('falls back to Windows PowerShell on PATH', () => {
    process.env['PATH'] = 'D:\\Shells';
    const shell = 'D:\\Shells\\powershell.exe';
    installed(shell);
    expect(selectShell().shell).toBe(shell);
  });

  it('does not discover a shell in an empty or relative PATH entry', () => {
    process.env['PATH'] = ';.;relative';
    installed('pwsh.exe', 'relative\\pwsh.exe');
    expect(selectShell().shell).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('preserves an explicit shell override', () => {
    expect(selectShell('D:\\Custom\\pwsh.exe').shell).toBe('D:\\Custom\\pwsh.exe');
  });
});
