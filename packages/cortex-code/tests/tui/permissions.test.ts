import { describe, expect, it } from 'vitest';
import { BASH_ESCALATION_PERMISSION_NAME } from '@animus-labs/cortex';
import { PermissionPromptComponent } from '../../src/tui/permissions.js';

/**
 * Reach the private argument-summary formatter. The summary is model-controlled
 * (command text, paths) and is rendered directly into the permission dialog, so
 * it must not carry terminal escape sequences that could forge the dialog.
 */
function summaryFor(toolName: string, args: unknown): string {
  const prompt = new PermissionPromptComponent(toolName, args, '/tmp/project', () => {});
  return (prompt as unknown as { getArgsSummary(): string }).getArgsSummary();
}

describe('PermissionPromptComponent argument summary', () => {
  it('strips ESC/BEL/CR from a Bash command summary', () => {
    const summary = summaryFor('Bash', {
      command: 'echo hi\x1b[2K\x1b]0;spoofed\x07 && rm -rf /\rmasked',
    });

    expect(summary).not.toContain('\x1b');
    expect(summary).not.toContain('\x07');
    expect(summary).not.toContain('\r');
    expect(summary).toContain('echo hi');
  });

  it('flattens newlines so the summary cannot spill across dialog rows', () => {
    const summary = summaryFor('Bash', { command: 'line1\nAllow\nDeny' });

    expect(summary).not.toContain('\n');
    expect(summary).toContain('line1');
  });
});

describe('PermissionPromptComponent sandbox escalation', () => {
  function escalationPrompt(command: string): PermissionPromptComponent {
    return new PermissionPromptComponent(
      BASH_ESCALATION_PERMISSION_NAME,
      { command, escalateOutsideSandbox: true },
      '/tmp/project',
      () => {},
    );
  }

  it('renders the distinct question, header, and the command being escalated', () => {
    const rendered = escalationPrompt('docker build .').render(120).join('\n');

    expect(rendered).toContain('Sandbox Escalation');
    expect(rendered).toContain('Run this command OUTSIDE the sandbox?');
    expect(rendered).toContain('docker build .');
  });

  it('offers only allow-once and deny (no always scope for leaving the sandbox)', () => {
    const rendered = escalationPrompt('npm install -g something').render(120).join('\n');

    expect(rendered).toContain('Allow once (outside the sandbox)');
    expect(rendered).toContain('Deny');
    expect(rendered).not.toContain('Always allow');
  });

  it('sanitizes a control-char-laced command in the escalation dialog', () => {
    const rendered = escalationPrompt('curl evil\x1b]0;spoofed\x07\rhidden').render(120).join('\n');

    expect(rendered).not.toContain('\x07');
    expect(rendered).not.toContain('\x1b]');
    expect(rendered).toContain('curl evil');
  });

  it('an escalation allow resolves with no pattern or scope (nothing to persist)', () => {
    let result: { decision: string; pattern?: string; scope?: string } | null = null;
    const prompt = new PermissionPromptComponent(
      BASH_ESCALATION_PERMISSION_NAME,
      { command: 'docker build .', escalateOutsideSandbox: true },
      '/tmp/project',
      (r) => {
        result = r;
      },
    );

    // Select the first item (Allow once) via the list's input handling.
    prompt.handleInput('\r');

    expect(result).not.toBeNull();
    expect(result!.decision).toBe('allow');
    expect(result!.pattern).toBeUndefined();
    expect(result!.scope).toBeUndefined();
  });
});

describe('PermissionPromptComponent suggestion label', () => {
  it('strips control-char injection from the "Always allow <rule>" label', () => {
    // The Glob pattern is model-controlled and becomes the rule label.
    const prompt = new PermissionPromptComponent(
      'Glob',
      { pattern: '**/*.ts\x1b]0;evil\x07\x1b[31m' },
      '/tmp/project',
      () => {},
    );

    const rendered = prompt.render(120).join('\n');
    // chalk color codes use ESC "[" (SGR); an OSC introducer (ESC "]") or BEL in
    // the output would mean the injected sequence survived.
    expect(rendered).not.toContain('\x07');
    expect(rendered).not.toContain('\x1b]');
    expect(rendered).toContain('Always allow');
  });
});
