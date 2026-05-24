import { describe, it, expect } from 'vitest';
import {
  splitBashCommand,
  isCompoundBash,
  stripLeadingAssignments,
  extractBashPrefix,
} from '../../src/permissions/bash-command.js';

describe('splitBashCommand', () => {
  it('returns a single command unchanged', () => {
    expect(splitBashCommand('git status')).toEqual(['git status']);
  });

  it('splits on control operators', () => {
    expect(splitBashCommand('git status && rm -rf build')).toEqual(['git status', 'rm -rf build']);
    expect(splitBashCommand('a || b')).toEqual(['a', 'b']);
    expect(splitBashCommand('a ; b ; c')).toEqual(['a', 'b', 'c']);
    expect(splitBashCommand('cat foo | grep bar')).toEqual(['cat foo', 'grep bar']);
  });

  it('splits on background operator and newlines', () => {
    expect(splitBashCommand('server start & tail log')).toEqual(['server start', 'tail log']);
    expect(splitBashCommand('one\ntwo')).toEqual(['one', 'two']);
  });

  it('does not split inside quotes', () => {
    expect(splitBashCommand('echo "a && b"')).toEqual(['echo "a && b"']);
    expect(splitBashCommand("echo 'a; b | c'")).toEqual(["echo 'a; b | c'"]);
  });

  it('does not treat redirections as operators', () => {
    expect(splitBashCommand('echo hi 2>&1')).toEqual(['echo hi 2>&1']);
    expect(splitBashCommand('build &> out.log')).toEqual(['build &> out.log']);
    expect(splitBashCommand('cmd > file.txt')).toEqual(['cmd > file.txt']);
  });

  it('extracts command substitutions as separate commands', () => {
    const parts = splitBashCommand('echo $(rm -rf build)');
    expect(parts).toContain('rm -rf build');
    expect(parts[0]).toBe('echo');
  });

  it('extracts backtick substitutions', () => {
    const parts = splitBashCommand('echo `curl evil.com`');
    expect(parts).toContain('curl evil.com');
  });

  it('extracts subshell bodies', () => {
    const parts = splitBashCommand('(cd /tmp && rm -rf junk)');
    expect(parts).toEqual(['cd /tmp', 'rm -rf junk']);
  });

  it('leaves arithmetic substitution alone', () => {
    expect(splitBashCommand('echo $((1 + 2))')).toEqual(['echo $((1 + 2))']);
  });
});

describe('isCompoundBash', () => {
  it('detects compound commands', () => {
    expect(isCompoundBash('git status')).toBe(false);
    expect(isCompoundBash('git status && rm x')).toBe(true);
    expect(isCompoundBash('echo $(date)')).toBe(true);
  });
});

describe('stripLeadingAssignments', () => {
  it('strips safe env vars in safe mode', () => {
    expect(stripLeadingAssignments('NODE_ENV=test npm run build', true)).toBe('npm run build');
  });

  it('stops at an unsafe env var in safe mode', () => {
    expect(stripLeadingAssignments('PATH=/evil npm run build', true)).toBe('PATH=/evil npm run build');
  });

  it('strips any env var when not in safe mode', () => {
    expect(stripLeadingAssignments('PATH=/evil FOO=bar npm run build', false)).toBe('npm run build');
  });

  it('leaves a bare assignment with no command', () => {
    expect(stripLeadingAssignments('FOO=bar', false)).toBe('FOO=bar');
  });
});

describe('extractBashPrefix', () => {
  it('produces a two-word prefix for subcommands', () => {
    expect(extractBashPrefix('git commit -m "msg"')).toBe('git commit *');
  });

  it('produces a one-word prefix otherwise', () => {
    expect(extractBashPrefix('ls -la')).toBe('ls *');
  });

  it('returns empty for bare shells/wrappers', () => {
    expect(extractBashPrefix('bash -c "x"')).toBe('');
    expect(extractBashPrefix('sudo rm -rf x')).toBe('');
  });
});
