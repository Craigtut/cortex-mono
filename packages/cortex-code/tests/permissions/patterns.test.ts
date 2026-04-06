import { describe, it, expect } from 'vitest';
import { extractPattern, formatRule } from '../../src/permissions/patterns.js';

describe('extractPattern', () => {
  describe('Bash', () => {
    it('extracts first token as prefix', () => {
      expect(extractPattern('Bash', { command: 'git push origin main' })).toBe('git *');
    });

    it('uses two tokens for package managers', () => {
      expect(extractPattern('Bash', { command: 'npm run build' })).toBe('npm run *');
      expect(extractPattern('Bash', { command: 'yarn add express' })).toBe('yarn add *');
      expect(extractPattern('Bash', { command: 'pip install requests' })).toBe('pip install *');
    });

    it('falls back to first token for single-token commands', () => {
      expect(extractPattern('Bash', { command: 'ls' })).toBe('ls *');
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
