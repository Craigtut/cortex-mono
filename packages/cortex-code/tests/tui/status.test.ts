import { describe, it, expect } from 'vitest';
import { StatusBar, type StatusBarState } from '../../src/tui/status.js';

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

/** Render one status line at a generous width and return it without ANSI codes. */
function renderStatus(state: Partial<StatusBarState>, width = 200): string {
  const bar = new StatusBar();
  bar.setState({
    provider: 'anthropic',
    model: 'claude-fable-5',
    gitBranch: 'main',
    effortLevel: 'medium',
    contextTokenCount: 1_000,
    contextTokenLimit: 200_000,
    ...state,
  });
  const lines = bar.render(width);
  bar.destroy();
  return stripAnsi(lines[0] ?? '');
}

describe('StatusBar sandbox indicator', () => {
  it('shows the rung plainly when the OS enforces it', () => {
    const line = renderStatus({ sandboxRung: 'workspace', sandboxEnforcement: 'enforced' });
    expect(line).toContain('sandbox: workspace');
    expect(line).not.toContain('(not enforced)');
    expect(line).not.toContain('(partial)');
  });

  it('marks a configured-but-unenforced sandbox honestly', () => {
    const line = renderStatus({ sandboxRung: 'workspace', sandboxEnforcement: 'none' });
    expect(line).toContain('sandbox: workspace (not enforced)');
  });

  it('marks partial enforcement', () => {
    const line = renderStatus({ sandboxRung: 'trusted', sandboxEnforcement: 'partial' });
    expect(line).toContain('sandbox: trusted (partial)');
  });

  it('shows off as its own explicit state', () => {
    const line = renderStatus({ sandboxRung: 'off', sandboxEnforcement: 'none' });
    expect(line).toContain('sandbox: off');
    expect(line).not.toContain('(not enforced)');
  });

  it('hides the badge until the session reports a rung', () => {
    const line = renderStatus({});
    expect(line).not.toContain('sandbox:');
  });

  it('keeps the badge when narrow width drops the effort segment', () => {
    // Wide enough for the model + tokens + sandbox, too narrow for everything.
    const line = renderStatus(
      { sandboxRung: 'workspace', sandboxEnforcement: 'enforced', gitBranch: '' },
      64,
    );
    expect(line).toContain('sandbox: workspace');
  });
});
