import { describe, it, expect } from 'vitest';
import { extractPattern, formatRule } from '../../src/permissions/patterns.js';

describe('extractPattern', () => {
  describe('Bash', () => {
    it('suggests a two-word prefix when the second token is a subcommand', () => {
      expect(extractPattern('Bash', { command: 'git fetch origin' })).toBe('git fetch *');
      expect(extractPattern('Bash', { command: 'git diff -- README.md' })).toBe('git diff *');
      expect(extractPattern('Bash', { command: 'npm run build' })).toBe('npm run *');
      expect(extractPattern('Bash', { command: 'yarn add express' })).toBe('yarn add *');
      expect(extractPattern('Bash', { command: 'docker compose up -d' })).toBe('docker compose *');
    });

    it('falls back to a one-word prefix when the second token is not a subcommand', () => {
      expect(extractPattern('Bash', { command: 'ls -la' })).toBe('ls *');
      expect(extractPattern('Bash', { command: 'git --version' })).toBe('git *');
      expect(extractPattern('Bash', { command: 'cat file.txt' })).toBe('cat *');
    });

    it('falls back to first token for single-token commands', () => {
      expect(extractPattern('Bash', { command: 'ls' })).toBe('ls *');
    });

    it('skips safe leading env vars when forming the prefix', () => {
      expect(extractPattern('Bash', { command: 'NODE_ENV=test npm run build' })).toBe('npm run *');
    });

    it('suggests no prefix for bare shells and exec wrappers', () => {
      // No safe prefix exists — a `bash *` / `sudo *` rule would allow anything.
      expect(extractPattern('Bash', { command: 'bash -c "rm -rf x"' })).toBe('');
      expect(extractPattern('Bash', { command: 'sudo apt install foo' })).toBe('');
      expect(extractPattern('Bash', { command: 'env FOO=bar do-thing' })).toBe('');
      expect(extractPattern('Bash', { command: 'xargs rm' })).toBe('');
    });

    it('suggests no prefix when led by an unsafe env var', () => {
      expect(extractPattern('Bash', { command: 'PATH=/evil npm run build' })).toBe('');
    });

    it('suggests no prefix for destructive commands', () => {
      // An always-allow rule for these plus any residual parser gap would
      // auto-approve a wipe; they must go through the prompt every time.
      expect(extractPattern('Bash', { command: 'rm -rf build' })).toBe('');
      expect(extractPattern('Bash', { command: 'rm file.txt' })).toBe('');
      expect(extractPattern('Bash', { command: 'find . -delete' })).toBe('');
      expect(extractPattern('Bash', { command: 'find . -name "*.ts"' })).toBe('');
      expect(extractPattern('Bash', { command: 'dd if=a of=b' })).toBe('');
      expect(extractPattern('Bash', { command: 'mkfs.ext4 disk.img' })).toBe('');
      expect(extractPattern('Bash', { command: 'shred -u file' })).toBe('');
      expect(extractPattern('Bash', { command: 'chmod 755 run.sh' })).toBe('');
      expect(extractPattern('Bash', { command: 'chown -R me dir' })).toBe('');
      expect(extractPattern('Bash', { command: 'chgrp staff file' })).toBe('');
      expect(extractPattern('Bash', { command: 'tee out.txt' })).toBe('');
      expect(extractPattern('Bash', { command: 'curl https://example.com' })).toBe('');
      expect(extractPattern('Bash', { command: 'wget https://example.com' })).toBe('');
      expect(extractPattern('Bash', { command: 'scp file host:/tmp' })).toBe('');
      expect(extractPattern('Bash', { command: 'rsync -a src/ dst/' })).toBe('');
    });

    it('suggests no prefix for PowerShell destructive commands', () => {
      expect(extractPattern('Bash', { command: 'Remove-Item -Recurse x' })).toBe('');
      expect(extractPattern('Bash', { command: 'ri -r x' })).toBe('');
      expect(extractPattern('Bash', { command: 'del /s /q x' })).toBe('');
      expect(extractPattern('Bash', { command: 'rd /s /q x' })).toBe('');
      expect(extractPattern('Bash', { command: 'rmdir x' })).toBe('');
      expect(extractPattern('Bash', { command: 'Format-Volume -DriveLetter D' })).toBe('');
      expect(extractPattern('Bash', { command: 'Clear-Disk -Number 1' })).toBe('');
    });

    it('suggests no prefix for destructive git subcommands', () => {
      expect(extractPattern('Bash', { command: 'git clean -fdx' })).toBe('');
      expect(extractPattern('Bash', { command: 'git reset --hard HEAD~1' })).toBe('');
      expect(extractPattern('Bash', { command: 'git checkout -- .' })).toBe('');
      expect(extractPattern('Bash', { command: 'git push --force origin main' })).toBe('');
      expect(extractPattern('Bash', { command: 'git branch -D feature' })).toBe('');
      // Non-destructive git subcommands still get suggestions.
      expect(extractPattern('Bash', { command: 'git status' })).toBe('git status *');
      expect(extractPattern('Bash', { command: 'git log --oneline' })).toBe('git log *');
    });

    it('returns empty for empty command', () => {
      expect(extractPattern('Bash', { command: '' })).toBe('');
    });
  });

  describe('File tools (Edit, Write, Read)', () => {
    it('extracts directory glob from file path', () => {
      expect(extractPattern('Edit', { file_path: 'src/auth/index.ts' })).toBe('src/auth/*');
      expect(extractPattern('Write', { file_path: '/Users/dev/project/README.md' })).toBe('/Users/dev/project/*');
      expect(extractPattern('Read', { file_path: 'docs/api.md' })).toBe('docs/*');
    });

    it('returns * for root-level files', () => {
      expect(extractPattern('Edit', { file_path: 'package.json' })).toBe('*');
    });

    it('returns empty for missing path', () => {
      expect(extractPattern('Read', {})).toBe('');
    });
  });

  describe('Glob', () => {
    it('returns the glob pattern itself', () => {
      expect(extractPattern('Glob', { pattern: 'src/**/*.ts' })).toBe('src/**/*.ts');
    });
  });

  describe('Grep', () => {
    it('returns empty (tool-wide)', () => {
      expect(extractPattern('Grep', { pattern: 'TODO' })).toBe('');
    });
  });

  describe('WebFetch', () => {
    it('extracts hostname from URL', () => {
      expect(extractPattern('WebFetch', { url: 'https://api.github.com/repos/owner/repo' })).toBe('api.github.com');
    });

    it('returns empty for invalid URL', () => {
      expect(extractPattern('WebFetch', { url: 'not-a-url' })).toBe('');
    });
  });

  describe('SubAgent', () => {
    it('returns empty (tool-wide)', () => {
      expect(extractPattern('SubAgent', {})).toBe('');
    });
  });
});

describe('formatRule', () => {
  it('formats tool with pattern', () => {
    expect(formatRule('Bash', 'git *')).toBe('Bash(git *)');
  });

  it('returns just tool name when no pattern', () => {
    expect(formatRule('Grep', '')).toBe('Grep');
  });
});
