import { describe, it, expect, beforeEach } from 'vitest';
import { PermissionRuleManager } from '../../src/permissions/rules.js';

describe('PermissionRuleManager', () => {
  let manager: PermissionRuleManager;

  beforeEach(() => {
    manager = new PermissionRuleManager('/tmp/test-cwd');
  });

  describe('matchRule', () => {
    it('returns null when no rules match', () => {
      expect(manager.matchRule('Bash', { command: 'git status' })).toBeNull();
    });

    it('matches tool-wide allow rules', async () => {
      await manager.addRule('session', 'allow', 'Grep', '');
      expect(manager.matchRule('Grep', { pattern: 'anything' })).toBe('allow');
    });

    it('matches Bash prefix patterns', async () => {
      await manager.addRule('session', 'allow', 'Bash', 'git *');
      expect(manager.matchRule('Bash', { command: 'git push origin main' })).toBe('allow');
      expect(manager.matchRule('Bash', { command: 'npm install' })).toBeNull();
    });

    it('matches file path patterns', async () => {
      await manager.addRule('session', 'allow', 'Edit', 'src/auth/*');
      expect(manager.matchRule('Edit', { file_path: 'src/auth/index.ts' })).toBe('allow');
      expect(manager.matchRule('Edit', { file_path: 'src/db/index.ts' })).toBeNull();
    });

    it('matches WebFetch domain patterns', async () => {
      await manager.addRule('session', 'allow', 'WebFetch', 'api.github.com');
      expect(manager.matchRule('WebFetch', { url: 'https://api.github.com/repos' })).toBe('allow');
      expect(manager.matchRule('WebFetch', { url: 'https://github.com/owner/repo' })).toBeNull();
    });
  });

  describe('precedence', () => {
    it('deny overrides allow within the same scope', async () => {
      await manager.addRule('session', 'allow', 'Bash', 'git *');
      await manager.addRule('session', 'deny', 'Bash', 'git push *');
      // "git push" matches both, but deny wins
      expect(manager.matchRule('Bash', { command: 'git push origin main' })).toBe('deny');
    });

    it('does not match rules for different tools', async () => {
      await manager.addRule('session', 'allow', 'Read', 'src/*');
      expect(manager.matchRule('Write', { file_path: 'src/index.ts' })).toBeNull();
    });
  });

  describe('suggestPattern', () => {
    it('suggests patterns for tools', () => {
      expect(manager.suggestPattern('Bash', { command: 'git status' })).toBe('git *');
      expect(manager.suggestPattern('Edit', { file_path: 'src/auth/index.ts' })).toBe('src/auth/*');
    });
  });

  describe('getAllRules', () => {
    it('returns rules organized by scope', async () => {
      await manager.addRule('session', 'allow', 'Bash', 'git *');
      const rules = manager.getAllRules();
      expect(rules.session).toHaveLength(1);
      expect(rules.session[0]?.toolName).toBe('Bash');
      expect(rules.project).toHaveLength(0);
      expect(rules.user).toHaveLength(0);
    });
  });
});
