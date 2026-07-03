import { describe, expect, it } from 'vitest';
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
