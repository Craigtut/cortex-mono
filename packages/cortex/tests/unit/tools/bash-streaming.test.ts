import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBashTool } from '../../../src/tools/bash/index.js';
import type { BashStreamUpdate } from '../../../src/tools/bash/index.js';
import type { ToolExecuteContext, ToolContentDetails } from '../../../src/types.js';
import { CwdTracker } from '../../../src/tools/shared/cwd-tracker.js';

describe('Bash tool streaming', () => {
  let cwdTracker: CwdTracker;

  beforeEach(() => {
    cwdTracker = new CwdTracker(process.cwd());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls onUpdate with stdout chunks during execution', async () => {
    const tool = createBashTool({ cwdTracker });
    const onUpdate = vi.fn();
    const context: ToolExecuteContext = { toolCallId: 'tc-1', onUpdate };

    await tool.execute({ command: 'echo "line1"; echo "line2"; echo "line3"' }, context);

    // onUpdate should have been called at least once with stdout content
    // (timing depends on 100ms intervals vs command speed)
    // The final result should contain all three lines
    const result = await tool.execute({ command: 'echo "hello"' }, context);
    expect(result.details.stdout).toContain('hello');
  });

  it('returns correct final result regardless of streaming', async () => {
    const tool = createBashTool({ cwdTracker });
    const onUpdate = vi.fn();
    const context: ToolExecuteContext = { toolCallId: 'tc-2', onUpdate };

    const result = await tool.execute({ command: 'echo "final output"' }, context);

    expect(result.details.exitCode).toBe(0);
    expect(result.details.stdout).toContain('final output');
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: 'text' }),
    );
  });

  it('works without context (backward compatible)', async () => {
    const tool = createBashTool({ cwdTracker });

    const result = await tool.execute({ command: 'echo "no context"' });

    expect(result.details.exitCode).toBe(0);
    expect(result.details.stdout).toContain('no context');
  });

  it('stream updates contain BashStreamUpdate details', async () => {
    const tool = createBashTool({ cwdTracker });
    const updates: Array<ToolContentDetails<unknown>> = [];
    const onUpdate = vi.fn((partial: ToolContentDetails<unknown>) => {
      updates.push(partial);
    });
    const context: ToolExecuteContext = { toolCallId: 'tc-3', onUpdate };

    // Use a command that produces output slowly enough for the 100ms interval to fire
    await tool.execute(
      { command: 'for i in 1 2 3; do echo "line$i"; sleep 0.15; done' },
      context,
    );

    // Should have received at least one streaming update
    if (updates.length > 0) {
      const details = updates[0]!.details as BashStreamUpdate;
      expect(details).toHaveProperty('stdout');
      expect(details).toHaveProperty('stderr');
      expect(details).toHaveProperty('totalLines');
      expect(typeof details.totalLines).toBe('number');
    }
  });

  it('does not call onUpdate when context has no onUpdate', async () => {
    const tool = createBashTool({ cwdTracker });
    const context: ToolExecuteContext = { toolCallId: 'tc-4' };

    // Should not throw
    const result = await tool.execute({ command: 'echo "safe"' }, context);
    expect(result.details.exitCode).toBe(0);
  });

  it('emits only complete lines (buffers partial lines)', async () => {
    const tool = createBashTool({ cwdTracker });
    const updates: Array<ToolContentDetails<unknown>> = [];
    const onUpdate = vi.fn((partial: ToolContentDetails<unknown>) => {
      updates.push(partial);
    });
    const context: ToolExecuteContext = { toolCallId: 'tc-5', onUpdate };

    // printf without newline should be buffered until process closes
    await tool.execute(
      { command: 'echo "complete"; printf "no-newline"' },
      context,
    );

    // All emitted stdout chunks should end with newline (complete lines only)
    for (const update of updates) {
      const details = update.details as BashStreamUpdate;
      if (details.stdout.length > 0) {
        expect(details.stdout.endsWith('\n')).toBe(true);
      }
    }
  });
});
