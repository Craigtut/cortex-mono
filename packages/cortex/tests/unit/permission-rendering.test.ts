import { describe, it, expect } from 'vitest';
import {
  clampRenderedRequest,
  clipHeadTail,
  renderPermissionRequest,
} from '../../src/permission-rendering.js';
import { toolCallSubject } from '../../src/tools/tool-call-subject.js';
import { BASH_ESCALATION_PERMISSION_NAME } from '../../src/tools/bash/index.js';

describe('toolCallSubject', () => {
  it('reads each built-in tool\'s identifying argument', () => {
    expect(toolCallSubject('Bash', { command: 'ls', timeout: 5 })).toEqual({ command: 'ls' });
    expect(toolCallSubject('Read', { file_path: '/a' })).toEqual({ path: '/a' });
    expect(toolCallSubject('Edit', { path: '/legacy' })).toEqual({ path: '/legacy' });
    expect(toolCallSubject('Grep', { pattern: 'x', path: 'src' })).toEqual({ pattern: 'x', scope: 'src' });
    expect(toolCallSubject('WebFetch', { url: 'https://e.x' })).toEqual({ url: 'https://e.x' });
    expect(toolCallSubject('TaskOutput', { task_id: 't1' })).toEqual({ taskId: 't1' });
    expect(toolCallSubject('custom_tool', { a: 1 })).toEqual({});
    expect(toolCallSubject('Bash', null)).toEqual({ command: undefined });
  });
});

describe('renderPermissionRequest', () => {
  it('renders the identifying argument verbatim', () => {
    expect(renderPermissionRequest('Bash', { command: 'rm -rf build' })).toBe('Bash: rm -rf build');
    expect(renderPermissionRequest(BASH_ESCALATION_PERMISSION_NAME, { command: 'curl x' }))
      .toBe(`${BASH_ESCALATION_PERMISSION_NAME}: curl x`);
    expect(renderPermissionRequest('Write', { file_path: '/etc/hosts', content: 'secret' }))
      .toBe('Write: /etc/hosts');
    expect(renderPermissionRequest('Glob', { pattern: '**/*.ts', path: 'src' })).toBe('Glob: **/*.ts in src');
    expect(renderPermissionRequest('Grep', { pattern: 'TODO' })).toBe('Grep: TODO');
    expect(renderPermissionRequest('WebFetch', { url: 'https://e.x' })).toBe('WebFetch: https://e.x');
  });

  it('renders a tool without an identifying argument as its JSON args', () => {
    expect(renderPermissionRequest('mcp__db__query', { sql: 'drop table t' }))
      .toBe('mcp__db__query: {"sql":"drop table t"}');
    expect(renderPermissionRequest('TaskOutput', { task_id: 't1' })).toBe('TaskOutput: {"task_id":"t1"}');
    expect(renderPermissionRequest('Bash', {})).toBe('Bash');
  });

  it('keeps head and tail of an over-cap rendering', () => {
    const command = `echo ${'a'.repeat(1000)} && rm -rf ~/work`;
    const rendered = renderPermissionRequest('Bash', { command });
    expect(rendered.startsWith('Bash: echo aaa')).toBe(true);
    expect(rendered.endsWith('&& rm -rf ~/work')).toBe(true);
    expect(rendered).toMatch(/…\[\d+ chars elided\]…/);
  });
});

describe('clipHeadTail', () => {
  it('returns short values unchanged', () => {
    expect(clipHeadTail('short', 10, 4, 4)).toBe('short');
    expect(clampRenderedRequest('x'.repeat(500))).toBe('x'.repeat(500));
  });

  it('counts code points, not UTF-16 units', () => {
    const emoji = '\u{1F600}'.repeat(10);
    expect(clipHeadTail(emoji, 10, 3, 3)).toBe(emoji);
    const clipped = clipHeadTail(emoji + emoji, 10, 3, 3);
    expect(clipped).toBe(`${'\u{1F600}'.repeat(3)} …[14 chars elided]… ${'\u{1F600}'.repeat(3)}`);
  });
});
