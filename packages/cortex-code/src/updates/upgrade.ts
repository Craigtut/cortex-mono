import { spawn } from 'node:child_process';

/**
 * Run `npm install -g <package>@latest` with inherited stdio so the user sees
 * npm's own progress output. Resolves to the process exit code (1 on spawn
 * error). The caller is responsible for tearing down the TUI first.
 */
export function runNpmUpgrade(packageName: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', `${packageName}@latest`], {
      stdio: 'inherit',
      // npm is a .cmd shim on Windows; a shell is required to resolve it.
      shell: process.platform === 'win32',
    });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}
