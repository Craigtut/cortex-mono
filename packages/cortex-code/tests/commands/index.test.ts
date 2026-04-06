import { describe, it, expect, beforeEach } from 'vitest';
import { registerCommand, getCommand, getCommands, fuzzyFilterCommands, registerBuiltinCommands } from '../../src/commands/index.js';

describe('Command Registry', () => {
  // Note: registerBuiltinCommands adds to a module-level Map,
  // so we test the actual builtins rather than re-registering.

  it('registers and retrieves commands', () => {
    registerCommand({
      name: 'test-cmd',
      description: 'A test command',
      handler: async () => {},
    });
    const cmd = getCommand('test-cmd');
    expect(cmd).toBeDefined();
    expect(cmd?.name).toBe('test-cmd');
    expect(cmd?.description).toBe('A test command');
  });

  it('returns undefined for unknown commands', () => {
    expect(getCommand('nonexistent')).toBeUndefined();
  });

  describe('fuzzyFilterCommands', () => {
    beforeEach(() => {
      registerBuiltinCommands();
    });

    it('returns all commands for empty query', () => {
      const all = fuzzyFilterCommands('');
      expect(all.length).toBeGreaterThan(0);
    });

    it('filters by fuzzy match', () => {
      const results = fuzzyFilterCommands('co');
      const names = results.map(r => r.name);
      expect(names).toContain('compact');
      expect(names).toContain('cost');
      expect(names).toContain('context-window');
    });

    it('matches non-contiguous characters', () => {
      const results = fuzzyFilterCommands('cw');
      const names = results.map(r => r.name);
      expect(names).toContain('context-window');
    });

    it('returns empty for no matches', () => {
      const results = fuzzyFilterCommands('zzz');
      expect(results).toHaveLength(0);
    });
  });
});
