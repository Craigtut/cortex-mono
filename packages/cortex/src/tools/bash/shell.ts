/** Shell discovery and command framing for the Bash tool. */
import * as fs from 'node:fs';
import * as path from 'node:path';

interface ShellConfig {
  shell: string;
  args: string[];
}

/**
 * Read /etc/shells and return the set of trusted shell paths.
 */
function readTrustedShells(): Set<string> {
  const trusted = new Set<string>();
  try {
    const content = fs.readFileSync('/etc/shells', 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        trusted.add(trimmed);
      }
    }
  } catch {
    // /etc/shells not available; empty set means we fall back
  }
  return trusted;
}

/**
 * Select the appropriate shell for the current platform.
 */
export function selectShell(customShellPath?: string): ShellConfig {
  // Custom override
  if (customShellPath) {
    if (process.platform === 'win32') {
      return { shell: customShellPath, args: ['-NoProfile', '-NonInteractive', '-Command'] };
    }
    return { shell: customShellPath, args: ['-c'] };
  }

  if (process.platform === 'win32') {
    return selectWindowsShell();
  }

  return selectUnixShell();
}

function selectUnixShell(): ShellConfig {
  const userShell = process.env['SHELL'];

  if (userShell) {
    // Reject fish (incompatible with common bashisms)
    if (userShell.endsWith('/fish')) {
      return findUnixFallback();
    }

    // Validate against /etc/shells
    const trusted = readTrustedShells();
    if (trusted.size === 0 || trusted.has(userShell)) {
      return { shell: userShell, args: ['-c'] };
    }
  }

  return findUnixFallback();
}

function findUnixFallback(): ShellConfig {
  // Try /bin/bash first, then /bin/sh
  for (const shell of ['/bin/bash', '/bin/sh']) {
    try {
      fs.accessSync(shell, fs.constants.X_OK);
      return { shell, args: ['-c'] };
    } catch {
      continue;
    }
  }

  return { shell: '/bin/sh', args: ['-c'] };
}

function selectWindowsShell(): ShellConfig {
  // Resolve to an absolute, normalized path before accessSync and spawn. Windows
  // environment keys can have different casing, including in Node workers.
  const env = (name: string): string | undefined => Object.entries(process.env)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const pathDirs = (env('PATH') ?? '').split(';')
    .map(dir => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(dir => path.win32.isAbsolute(dir));
  const programDirs = [env('ProgramW6432'), env('ProgramFiles'), 'C:\\Program Files']
    .filter((dir): dir is string => !!dir);
  const systemRoot = env('SystemRoot') ?? env('windir') ?? 'C:\\Windows';
  const ps5 = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const candidates = [
    ...pathDirs.map(dir => path.win32.join(dir, 'pwsh.exe')),
    ...programDirs.map(dir => path.win32.join(dir, 'PowerShell', '7', 'pwsh.exe')),
    // A 32-bit Node process can reach native PowerShell through Sysnative.
    ...(process.arch === 'ia32'
      ? [path.win32.join(systemRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
      : []),
    ps5,
    ...pathDirs.map(dir => path.win32.join(dir, 'powershell.exe')),
  ];

  for (const shell of new Set(candidates)) {
    try {
      fs.accessSync(shell, fs.constants.X_OK);
      return { shell, args: ['-NoProfile', '-NonInteractive', '-Command'] };
    } catch {
      continue;
    }
  }

  // The caller reports the missing shell with configuration guidance.
  return { shell: ps5, args: ['-NoProfile', '-NonInteractive', '-Command'] };
}

/** Wrap a command with output encoding, exit status and working-directory capture. */
export function buildShellCommand(command: string, cwdMarker: string): string {
  if (process.platform === 'win32') {
    // Get-Location alone formats a table whose "Path" header corrupts the next
    // spawn cwd. Capture $? as well: failed cmdlets do not set LASTEXITCODE.
    return '$OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
      + command
      + `\n$__ok=$?; $__ec=$LASTEXITCODE; if ($__ok) { $__ec=0 } elseif (-not $__ec) { $__ec=1 }; Write-Output "${cwdMarker}"; (Get-Location).Path; exit $__ec`;
  }
  return `${command}; __ec=$?; echo "${cwdMarker}"; pwd; exit $__ec`;
}
