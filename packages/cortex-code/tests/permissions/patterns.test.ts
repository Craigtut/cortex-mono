import { describe, it, expect } from 'vitest';
import { extractPattern, formatRule } from '../../src/permissions/patterns.js';

describe('extractPattern', () => {
  describe('Bash', () => {
    it('suggests a two-word prefix when the second token is a subcommand', () => {
      expect(extractPattern('Bash', { command: 'git push origin main' })).toBe('git push *');
      expect(extractPattern('Bash', { command: 'git diff -- README.md' })).toBe('git diff *');
      expect(extractPattern('Bash', { command: 'npm run build' })).toBe('npm run *');
      expect(extractPattern('Bash', { command: 'yarn add express' })).toBe('yarn add *');
      expect(extractPattern('Bash', { command: 'docker compose up -d' })).toBe('docker compose *');
    });

    it('falls back to a one-word prefix when the second token is not a subcommand', () => {
      expect(extractPattern('Bash', { command: 'ls -la' })).toBe('ls *');
      expect(extractPattern('Bash', { command: 'git --version' })).toBe('git *');
      expect(extractPattern('Bash', { command: 'cat file.txt' })).toBe('cat *');
      expect(extractPattern('Bash', { command: 'chmod 755 run.sh' })).toBe('chmod *');
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
