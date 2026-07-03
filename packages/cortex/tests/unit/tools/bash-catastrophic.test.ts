import { describe, it, expect } from 'vitest';
import { findCatastrophicCommand, type CatastrophicContext } from '../../../src/tools/bash/catastrophic.js';

const DARWIN: CatastrophicContext = {
  cwd: '/Users/dev/project',
  home: '/Users/dev',
  platform: 'darwin',
};

const LINUX: CatastrophicContext = {
  cwd: '/home/dev/project',
  home: '/home/dev',
  platform: 'linux',
};

const WINDOWS: CatastrophicContext = {
  cwd: 'C:\\Users\\dev\\project',
  home: 'C:\\Users\\dev',
  platform: 'win32',
};

function blocked(command: string, ctx: CatastrophicContext): ReturnType<typeof findCatastrophicCommand> {
  return findCatastrophicCommand(command, ctx);
}

describe('findCatastrophicCommand', () => {
  // -------------------------------------------------------------------------
  // MUST BLOCK: POSIX (parameterized across darwin and linux)
  // -------------------------------------------------------------------------
  describe.each([
    ['darwin', DARWIN],
    ['linux', LINUX],
  ] as const)('POSIX must-block corpus (%s)', (_name, ctx) => {
    const mustBlock: string[] = [
      // Root, in every disguise
      'rm -rf /',
      'rm -rf /.',
      'rm -rf /./',
      'rm -rf /*',
      'rm -rf /*/',
      'rm -rf /home/..',
      'rm -rf /usr/../',
      'rm -fr /',
      'rm -r -f /',
      'rm --recursive --force /',
      'rm -rf "/"',
      "rm -r''f /",
      'rm -rf //',
      'rm -rf --no-preserve-root /',
      'rm -rf -- /',
      // Home root
      'rm -rf ~',
      'rm -rf ~/',
      'rm -rf ~/*',
      'rm -rf $HOME',
      'rm -rf "$HOME"',
      'rm -rf ${HOME}',
      'rm -rf ${HOME}/',
      'rm -rf $HOME/*',
      // System directories
      'rm -rf /usr',
      'rm -rf /etc/',
      'rm -rf /var/*',
      'rm -rf /usr*',
      // Wrappers and verb obfuscation
      'sudo rm -rf /',
      'sudo -u root rm -rf /',
      '\\rm -rf /',
      '"rm" -rf /',
      "r''m -rf /",
      'command rm -rf /',
      'env rm -rf /',
      'timeout 5 rm -rf /',
      'nohup rm -rf /',
      'FOO=bar rm -rf /',
      // Compound commands and substitution recursion
      'git status && rm -rf /',
      'echo hi; rm -rf ~',
      'echo hi\nrm -rf /etc',
      'true & rm -rf /',
      'yes | rm -rf /',
      'echo $(rm -rf /)',
      'echo `rm -rf /usr`',
      'bash -c "rm -rf /"',
      'sh -lc "rm -rf /"',
      "eval 'rm -rf /'",
      'eval rm -rf /',
      "su -c 'rm -rf /' root",
      // Fail closed: unverifiable destructive targets
      'rm -rf "$TARGET"',
      'rm -rf $TARGET',
      'rm -rf ${DIR:-/}',
      'rm -rf $(cat file)',
      'rm -rf `cat file`',
      'echo / | xargs rm -rf',
      'xargs rm -rf < list.txt',
      'find . -print0 | xargs -0 rm -rf',
      'rm -rf {a,b}..{c,d}',
      // cd tricks
      'cd / && rm -rf ./usr',
      'cd /etc && rm -rf .',
      'cd "$DIR" && rm -rf ./build',
      // $IFS obfuscation
      'rm$IFS-rf$IFS/',
      'rm${IFS}-rf${IFS}/etc',
      // Brace expansion
      'rm -rf {/,/tmp/x}',
      'rm -rf /{usr,opt}',
      // Fork bombs (semicolon and newline forms)
      ':(){ :|:& };:',
      ':(){ :|:& }\n:',
      'bomb(){ bomb|bomb& };bomb',
      // Raw devices
      'dd if=/dev/zero of=/dev/sda bs=1M',
      'dd of=/dev/sda',
      'dd of=$DEV',
      'mkfs.ext4 /dev/sdb',
      'mkfs -t ext4 /dev/sdb',
      'wipefs -a /dev/sda',
      'shred /dev/sda',
      'shred -u "$DISK"',
      '> /dev/sda',
      'echo x > /dev/sda',
      'cat junk 2>/dev/nvme0n1',
      'tee /dev/sda < image.img',
      'cp image.img /dev/sda',
      // Recursive permission destruction
      'chmod -R 777 /',
      'chmod -R 000 /etc',
      'chown -R me /usr',
      'chgrp -R staff /',
      'chmod -R 777 "$DIR"',
      // find-based destruction
      'find / -delete',
      'find / -name "*.log" -delete',
      'find /etc -delete',
      'find / -exec rm -rf {} \\;',
      'find $DIR -delete',
      // rsync wipe
      'rsync -a --delete empty/ /',
    ];

    for (const cmd of mustBlock) {
      it(`blocks: ${JSON.stringify(cmd)}`, () => {
        expect(blocked(cmd, ctx)).not.toBeNull();
      });
    }
  });

  // -------------------------------------------------------------------------
  // MUST PASS the floor: POSIX
  // -------------------------------------------------------------------------
  describe.each([
    ['darwin', DARWIN],
    ['linux', LINUX],
  ] as const)('POSIX must-pass corpus (%s)', (_name, ctx) => {
    const mustPass: string[] = [
      'rm -rf ./build',
      'rm -rf build',
      'rm -rf node_modules',
      'rm -rf ~/project/dist',
      'rm -rf dist/*',
      'rm -rf /tmp/scratch-xyz',
      'rm -rf ./build ./dist coverage',
      'rm file.txt',
      'rm -f *.log',
      'rm -rf .',                       // workspace root itself: explicit decision
      'rm -rf ../project-backup',
      'git status && rm -rf ./build',
      'cd packages/app && rm -rf dist',
      'rm -rf /usr/local/lib/node_modules/foo', // deep system path: prompt, not floor
      'rm -rf ~/Library/Caches/myapp',  // deep inside home
      'rm -rf build*',                  // bounded glob in project cwd
      'git clean -fdx',
      'npm install',
      'chmod 755 run.sh',
      'chmod -R 755 ./scripts',
      'chown -R dev ./data',
      'shred -u secrets.txt',
      'find . -name "*.tmp" -delete',
      'find ./build -delete',
      'find src -name "*.ts" -print',
      'find / -name "config" -print',   // read-only find on root is fine
      'dd if=/dev/zero of=disk.img bs=1M count=10',
      'dd if=/dev/sda of=backup.img',   // reading a device is fine
      'mkfs.ext4 disk.img',
      'cat /dev/sda',
      'echo hi > out.txt',
      'echo "rm -rf /"',                // quoted string argument, not a command
      "echo ':(){ :|:& };:'",           // quoted fork bomb text is data
      'echo hello ; ls -la',
      'rsync -a --delete src/ dest/',
      'tail -f /var/log/system.log',
      'rm -rf "$HOME/project/dist"',    // $HOME expands, deep path passes
      'grep -r "pattern" /etc',
      'echo money > ledger.txt 2>&1',
    ];

    for (const cmd of mustPass) {
      it(`passes: ${JSON.stringify(cmd)}`, () => {
        expect(blocked(cmd, ctx)).toBeNull();
      });
    }
  });

  // -------------------------------------------------------------------------
  // MUST BLOCK: Windows (PowerShell + cmd.exe)
  // -------------------------------------------------------------------------
  describe('Windows must-block corpus', () => {
    const mustBlock: string[] = [
      // Drive roots
      'Remove-Item -Recurse -Force C:\\',
      'Remove-Item C:\\ -Recurse -Force',
      'Remove-Item -Recurse -Force C:',
      'Remove-Item -Recurse -Force D:\\',
      'remove-item -recurse -force c:\\',
      'Remove-Item -Recurse -Force /',
      'rm -r C:\\',
      'rm -rf /',
      'rd /s /q C:\\',
      'del /s /q C:\\',
      // User profile root
      'Remove-Item -Recurse -Force $env:USERPROFILE',
      'Remove-Item -Recurse -Force ~',
      'rd /s /q %USERPROFILE%',
      'del /s /q "%USERPROFILE%"',
      // System directories
      'ri -r -fo C:\\Windows',
      'Remove-Item -Recurse C:\\Windows',
      'Remove-Item -Recurse -Force "C:\\Program Files"',
      'Remove-Item -Recurse -Force C:\\ProgramData',
      'Remove-Item -Recurse -Force C:\\Users',
      'rd /s /q %SystemRoot%',
      'Remove-Item -Recurse -Force $env:ProgramData',
      'Remove-Item -Recurse -Force C:\\Win*',
      // -Path parameter form
      'Remove-Item -Path C:\\ -Recurse -Force',
      // Unresolvable destructive targets
      'Remove-Item -Recurse -Force $target',
      'del /s /q %SOMEVAR%',
      // Disk destruction
      'Format-Volume -DriveLetter C',
      'format-volume -driveletter c',
      'Clear-Disk -Number 0 -RemoveData',
      'Remove-Partition -DiskNumber 0 -PartitionNumber 1',
      'format C:',
      'format C: /q',
      'dd of=\\\\.\\PhysicalDrive0',
      // Chained
      'Get-ChildItem; Remove-Item -Recurse -Force C:\\',
      'echo hi && rd /s /q C:\\',
    ];

    for (const cmd of mustBlock) {
      it(`blocks: ${JSON.stringify(cmd)}`, () => {
        expect(blocked(cmd, WINDOWS)).not.toBeNull();
      });
    }
  });

  // -------------------------------------------------------------------------
  // MUST PASS: Windows
  // -------------------------------------------------------------------------
  describe('Windows must-pass corpus', () => {
    const mustPass: string[] = [
      'Remove-Item -Recurse -Force .\\dist',
      'Remove-Item -Recurse -Force dist',
      'Remove-Item -Recurse -Force C:\\Users\\dev\\project\\build',
      'Remove-Item -Recurse -Force $env:USERPROFILE\\project\\dist',
      'Remove-Item file.txt',
      'Remove-Item -Force file.txt',
      'del /q build\\output.txt',
      'rd /s /q node_modules',
      'del /s /q %USERPROFILE%\\project\\tmp',
      'Get-ChildItem -Recurse',
      'rm -r .\\build',
      'format-list',
    ];

    for (const cmd of mustPass) {
      it(`passes: ${JSON.stringify(cmd)}`, () => {
        expect(blocked(cmd, WINDOWS)).toBeNull();
      });
    }
  });

  // -------------------------------------------------------------------------
  // PowerShell verbs are caught on POSIX hosts too (pwsh runs everywhere)
  // -------------------------------------------------------------------------
  describe('PowerShell on POSIX hosts', () => {
    it('blocks Remove-Item -Recurse -Force ~ on darwin', () => {
      const result = blocked('Remove-Item -Recurse -Force ~', DARWIN);
      expect(result?.category).toBe('home-root');
    });

    it('blocks Remove-Item -Recurse -Force / on linux', () => {
      const result = blocked('Remove-Item -Recurse -Force /', LINUX);
      expect(result?.category).toBe('filesystem-root');
    });

    it('blocks pwsh -c with a catastrophic command on darwin', () => {
      expect(blocked('pwsh -c "Remove-Item -Recurse -Force ~"', DARWIN)).not.toBeNull();
    });

    it('passes Remove-Item on a project path on darwin', () => {
      expect(blocked('Remove-Item -Recurse -Force ./dist', DARWIN)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------------
  describe('categories', () => {
    it('classifies root deletion as filesystem-root', () => {
      expect(blocked('rm -rf /', DARWIN)?.category).toBe('filesystem-root');
      expect(blocked('rm -rf /home/..', LINUX)?.category).toBe('filesystem-root');
      expect(blocked('Remove-Item -Recurse -Force C:\\', WINDOWS)?.category).toBe('filesystem-root');
    });

    it('classifies system directory deletion as system-directory', () => {
      expect(blocked('rm -rf /etc', LINUX)?.category).toBe('system-directory');
      expect(blocked('rm -rf /Library', DARWIN)?.category).toBe('system-directory');
      expect(blocked('ri -r -fo C:\\Windows', WINDOWS)?.category).toBe('system-directory');
    });

    it('classifies home deletion as home-root', () => {
      expect(blocked('rm -rf ~', DARWIN)?.category).toBe('home-root');
      expect(blocked('rm -rf $HOME', LINUX)?.category).toBe('home-root');
      expect(blocked('rd /s /q %USERPROFILE%', WINDOWS)?.category).toBe('home-root');
    });

    it('classifies raw disk writes as block-device', () => {
      expect(blocked('dd of=/dev/sda', LINUX)?.category).toBe('block-device');
      expect(blocked('> /dev/sda', LINUX)?.category).toBe('block-device');
      expect(blocked('Format-Volume -DriveLetter C', WINDOWS)?.category).toBe('block-device');
    });

    it('classifies fork bombs as fork-bomb', () => {
      expect(blocked(':(){ :|:& };:', LINUX)?.category).toBe('fork-bomb');
      expect(blocked(':(){ :|:& }\n:', DARWIN)?.category).toBe('fork-bomb');
    });

    it('classifies unverifiable destructive targets as unresolved-target', () => {
      expect(blocked('rm -rf "$TARGET"', DARWIN)?.category).toBe('unresolved-target');
      expect(blocked('rm -rf $(cat file)', LINUX)?.category).toBe('unresolved-target');
      expect(blocked('echo / | xargs rm -rf', DARWIN)?.category).toBe('unresolved-target');
    });

    it('returns an actionable reason for unresolved targets', () => {
      const result = blocked('rm -rf "$TARGET"', DARWIN);
      expect(result?.reason).toMatch(/statically verified/);
      expect(result?.reason).toMatch(/concrete/);
    });

    it('marks hard blocks as non-overridable in the reason', () => {
      const result = blocked('rm -rf /', DARWIN);
      expect(result?.reason).toMatch(/cannot be approved, allow-listed, or overridden/);
    });
  });

  // -------------------------------------------------------------------------
  // cwd sensitivity
  // -------------------------------------------------------------------------
  describe('cwd sensitivity', () => {
    it('blocks rm -rf * when cwd is the filesystem root', () => {
      expect(blocked('rm -rf *', { ...DARWIN, cwd: '/' })).not.toBeNull();
    });

    it('blocks rm -rf * when cwd is the home root', () => {
      expect(blocked('rm -rf *', { ...DARWIN, cwd: '/Users/dev' })?.category).toBe('home-root');
    });

    it('blocks rm -rf . when cwd is a system directory', () => {
      expect(blocked('rm -rf .', { ...LINUX, cwd: '/etc' })?.category).toBe('system-directory');
    });

    it('passes rm -rf * in a project directory', () => {
      expect(blocked('rm -rf *', DARWIN)).toBeNull();
    });

    it('blocks relative traversal that resolves to home', () => {
      expect(blocked('rm -rf ..', DARWIN)?.category).toBe('home-root'); // /Users/dev
    });

    it('blocks relative traversal that resolves to a system dir', () => {
      expect(blocked('rm -rf ../..', DARWIN)?.category).toBe('system-directory'); // /Users
    });

    it('blocks relative traversal that resolves to the root', () => {
      expect(blocked('rm -rf ../../..', DARWIN)?.category).toBe('filesystem-root');
    });

    it('fails closed on relative destructive targets after cd to an unknown dir', () => {
      expect(blocked('cd "$WORK" && rm -rf ./stale', DARWIN)?.category).toBe('unresolved-target');
    });

    it('tracks cd correctly for safe relative deletes', () => {
      expect(blocked('cd packages/app && rm -rf ./dist', DARWIN)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Case sensitivity
  // -------------------------------------------------------------------------
  describe('case handling', () => {
    it('blocks case-variant paths on darwin (case-insensitive filesystem)', () => {
      expect(blocked('rm -rf /ETC', DARWIN)).not.toBeNull();
      expect(blocked('RM -rf /', DARWIN)).not.toBeNull();
    });

    it('does not treat case-variants as system paths on linux', () => {
      expect(blocked('rm -rf /ETC', LINUX)).toBeNull();
    });

    it('is case-insensitive on Windows', () => {
      expect(blocked('REMOVE-ITEM -RECURSE -FORCE c:\\windows', WINDOWS)).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Misc hardening
  // -------------------------------------------------------------------------
  describe('hardening', () => {
    it('strips invisible characters before analysis', () => {
      expect(blocked('rm ​-rf /', DARWIN)).not.toBeNull();
    });

    it('handles empty and whitespace commands', () => {
      expect(blocked('', DARWIN)).toBeNull();
      expect(blocked('   ', DARWIN)).toBeNull();
    });

    it('does not block a deep path even when quoted oddly', () => {
      expect(blocked('rm -rf "./bu ild"', DARWIN)).toBeNull();
    });

    it('blocks nested shell strings several levels deep', () => {
      expect(blocked('bash -c "sh -c \'rm -rf /\'"', LINUX)).not.toBeNull();
    });

    it('blocks catastrophic commands hidden behind subshells', () => {
      expect(blocked('(rm -rf /)', DARWIN)).not.toBeNull();
      expect(blocked('{ rm -rf /; }', DARWIN)).not.toBeNull();
    });

    it('uses process.platform when ctx.platform is omitted', () => {
      expect(findCatastrophicCommand('rm -rf /', { cwd: process.cwd(), home: '/Users/dev' })).not.toBeNull();
    });

    it('treats --recursive= variants as recursive', () => {
      expect(blocked('rm --recursive=yes -f /', LINUX)).not.toBeNull();
    });

    it('blocks a leading control operator followed by a wipe', () => {
      expect(blocked('; rm -rf /', LINUX)).not.toBeNull();
      expect(blocked('|| rm -rf /', LINUX)).not.toBeNull();
    });

    it('lets a deep path under a system directory fall through to the prompt', () => {
      // Design decision: the floor guards top-level system dirs, not every
      // nested path; deleting one nested tree goes through normal permissions.
      expect(blocked('rm -rf /usr/local/lib/node_modules/foo', LINUX)).toBeNull();
      expect(blocked('rm -rf /System/Library/Caches', DARWIN)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // ANSI-C ($'...') and locale ($"...") quoting
  // -------------------------------------------------------------------------
  describe('ANSI-C and locale quoting', () => {
    const mustBlock: Array<[string, CatastrophicContext]> = [
      // hex-encoded slash -> filesystem root
      ["rm -rf $'\\x2f'", LINUX],
      ["rm -rf $'\\x2F'", LINUX],
      // octal 1/2/3-digit -> filesystem root
      ["rm -rf $'\\057'", LINUX],
      ["rm -rf $'\\57'", LINUX],
      // literal char inside $'...'
      ["rm -rf $'/'", LINUX],
      // partial ANSI-C then literal suffix -> /etc (NOT saved by --preserve-root)
      ["rm -rf $'\\x2f'etc", LINUX],
      // fully hex-encoded path -> /etc
      ["rm -rf $'\\x2f\\x65\\x74\\x63'", LINUX],
      // fully octal-encoded path -> /etc
      ["rm -rf $'\\57\\145\\164\\143'", LINUX],
      // unicode escapes
      ["rm -rf $'\\u002f'System", DARWIN],
      ["rm -rf $'\\U0000002f'", LINUX],
      // encoded device / redirect / disk tools
      ["dd of=$'\\x2fdev\\x2fsda'", LINUX],
      ["> $'\\x2fdev\\x2fsda'", LINUX],
      ["shred $'\\x2fdev\\x2fsda'", LINUX],
      ["mkfs.ext4 $'\\x2fdev\\x2fsdb'", LINUX],
      ["find $'\\x2f' -delete", LINUX],
      ["chmod -R 000 $'\\x2f'", LINUX],
      // locale quoting is a no-op expansion equal to the inner string
      ['rm -rf $"/etc"', LINUX],
      ['rm -rf $"/"', LINUX],
    ];
    for (const [cmd, ctx] of mustBlock) {
      it(`blocks: ${JSON.stringify(cmd)}`, () => {
        expect(blocked(cmd, ctx)).not.toBeNull();
      });
    }

    it('fails closed on an ANSI-C escape it cannot decode', () => {
      // \q is not a valid escape; the decoder must not silently drop it.
      expect(blocked("rm -rf $'\\q'", { ...LINUX, cwd: '/' })).not.toBeNull();
    });

    const mustPass: Array<[string, CatastrophicContext]> = [
      // Tab escape resolves into the workspace; not catastrophic.
      ["rm -rf $'my\\tdir'", DARWIN],
      ["rm -rf $'build'", DARWIN],
      // Non-destructive verb: ANSI-C content is irrelevant.
      ["grep $'\\t' file.txt", DARWIN],
      ["echo $'\\x2f'", DARWIN],
    ];
    for (const [cmd, ctx] of mustPass) {
      it(`passes: ${JSON.stringify(cmd)}`, () => {
        expect(blocked(cmd, ctx)).toBeNull();
      });
    }
  });

  // -------------------------------------------------------------------------
  // chmod/chown --reference (no positional mode operand)
  // -------------------------------------------------------------------------
  describe('chmod/chown --reference', () => {
    it('blocks recursive chmod --reference targeting root/system dirs', () => {
      expect(blocked('chmod -R --reference=/etc/hosts /', LINUX)).not.toBeNull();
      expect(blocked('chown -R --reference=/etc/hosts /', LINUX)).not.toBeNull();
      expect(blocked('chmod -R --reference=/etc/hosts /etc', LINUX)?.category).toBe('system-directory');
      expect(blocked('chmod -R --reference /etc/hosts /', LINUX)).not.toBeNull(); // space form
      expect(blocked('chown -R --from=me:me /', LINUX)).not.toBeNull();
    });

    it('still treats a positional mode as non-target', () => {
      // operand[0] is the mode; only ./scripts is a target -> passes.
      expect(blocked('chmod -R 755 ./scripts', DARWIN)).toBeNull();
      expect(blocked('chown -R me ./data', DARWIN)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // find -- end-of-options and broadened -exec
  // -------------------------------------------------------------------------
  describe('find end-of-options and exec', () => {
    it('consumes -- and collects the following start path', () => {
      expect(blocked('find -- / -delete', LINUX)).not.toBeNull();
      expect(blocked('find -L -- /etc -delete', LINUX)?.category).toBe('system-directory');
      expect(blocked('find -H -- / -delete', LINUX)).not.toBeNull();
    });

    it('treats any -exec-family on a protected start path as destructive', () => {
      expect(blocked('find / -exec chmod 000 {} +', LINUX)).not.toBeNull();
      expect(blocked('find / -exec grep x {} \\;', LINUX)).not.toBeNull();
      expect(blocked('find /etc -execdir rm {} +', LINUX)).not.toBeNull();
      expect(blocked('find / -ok rm {} \\;', LINUX)).not.toBeNull();
    });

    it('does not over-block -exec on a project path', () => {
      expect(blocked('find ./build -exec chmod 000 {} +', DARWIN)).toBeNull();
      expect(blocked('find . -name "*.tmp" -delete', DARWIN)).toBeNull();
      expect(blocked('find / -name config -print', LINUX)).toBeNull(); // read-only
    });
  });

  // -------------------------------------------------------------------------
  // Recursion cap fails closed
  // -------------------------------------------------------------------------
  describe('recursion cap', () => {
    const nestEval = (n: number, inner: string): string =>
      `${Array(n).fill('eval').join(' ')} ${inner}`;

    it('detects a catastrophic command within the cap', () => {
      expect(blocked(nestEval(5, 'rm -rf /'), LINUX)).not.toBeNull();
    });

    it('fails closed (blocks) past the cap rather than returning null', () => {
      const deep = blocked(nestEval(8, 'rm -rf /'), LINUX);
      expect(deep).not.toBeNull();
      expect(deep?.category).toBe('unresolved-target');
      // Even a benign inner command blocks: 8 levels of eval is pathological.
      expect(blocked(nestEval(8, 'echo hi'), LINUX)?.category).toBe('unresolved-target');
    });

    it('treats --recursive= variants as recursive', () => {
      expect(blocked('rm --recursive=yes -f /', LINUX)).not.toBeNull();
    });

    it('blocks a leading control operator followed by a wipe', () => {
      expect(blocked('; rm -rf /', LINUX)).not.toBeNull();
      expect(blocked('|| rm -rf /', LINUX)).not.toBeNull();
    });

    it('lets a deep path under a system directory fall through to the prompt', () => {
      // Design decision: the floor guards top-level system dirs, not every
      // nested path; deleting one nested tree goes through normal permissions.
      expect(blocked('rm -rf /usr/local/lib/node_modules/foo', LINUX)).toBeNull();
      expect(blocked('rm -rf /System/Library/Caches', DARWIN)).toBeNull();
    });
  });
});
