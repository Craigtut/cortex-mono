import { Box, Text, Loader, type TUI, type Component } from '@mariozechner/pi-tui';
import { colors } from './theme.js';

type SubAgentStatus = 'running' | 'completed' | 'failed';

interface SubAgentToolCall {
  name: string;
  summary: string;
  status: 'pending' | 'success' | 'error';
}

// Sub-agent display component with tree-drawing characters for nested tool calls.
// Shows a spinner while running with tree-formatted child tool calls,
// then collapses to a summary line with tool count and token usage on completion.
export class SubAgentComponent implements Component {
  private box: Box;
  private headerText: Text;
  private loader: Loader | null = null;
  private toolCallTexts: Text[] = [];
  private status: SubAgentStatus = 'running';
  private toolCalls: SubAgentToolCall[] = [];
  private resultSummary = '';
  private tokenCount = 0;
  private durationMs = 0;
  private cost = 0;

  constructor(
    private tui: TUI,
    private taskId: string,
    private description: string,
  ) {
    this.box = new Box(1, 0);
    this.headerText = new Text('');
    this.startSpinner();
  }

  /** Add a tool call to the sub-agent's nested display. */
  addToolCall(name: string, summary: string): void {
    this.toolCalls.push({ name, summary, status: 'pending' });
    this.rebuildDisplay();
  }

  /** Mark a tool call as complete. */
  completeToolCall(name: string, summary: string): void {
    const tc = this.toolCalls.find(t => t.name === name && t.status === 'pending');
    if (tc) {
      tc.status = 'success';
      tc.summary = summary;
    }
    this.rebuildDisplay();
  }

  /** Mark the sub-agent as completed. */
  complete(result: string, usage: { tokenCount: number; durationMs: number; cost: number }): void {
    this.status = 'completed';
    this.resultSummary = result;
    this.tokenCount = usage.tokenCount;
    this.durationMs = usage.durationMs;
    this.cost = usage.cost;
    this.stopSpinner();
    this.rebuildDisplay();
  }

  /** Mark the sub-agent as failed. */
  fail(error: string): void {
    this.status = 'failed';
    this.resultSummary = error;
    this.stopSpinner();
    this.rebuildDisplay();
  }

  invalidate(): void {
    this.box.invalidate();
  }

  render(width: number): string[] {
    return this.box.render(width);
  }

  private startSpinner(): void {
    this.loader = new Loader(
      this.tui,
      colors.primary,
      colors.muted,
      `Agent(${this.description.slice(0, 60)})`,
    );
    this.loader.start();
    this.rebuildDisplay();
  }

  private stopSpinner(): void {
    if (this.loader) {
      this.loader.stop();
      this.loader = null;
    }
  }

  private rebuildDisplay(): void {
    this.box.clear();

    // Header line
    if (this.status === 'running' && this.loader) {
      this.box.addChild(this.loader);
    } else if (this.status === 'completed') {
      const stats: string[] = [];
      if (this.toolCalls.length > 0) stats.push(`${this.toolCalls.length} tools`);
      if (this.tokenCount > 0) stats.push(`${(this.tokenCount / 1000).toFixed(1)}k tokens`);
      if (this.cost > 0) stats.push(`$${this.cost.toFixed(4)}`);
      const durationStr = this.durationMs > 0
        ? `  ${colors.muted((this.durationMs / 1000).toFixed(1) + 's')}`
        : '';
      const statsStr = stats.length > 0 ? `  [${stats.join(', ')}]` : '';
      this.headerText.setText(
        `${colors.success('\u2713')} ${colors.bold('Agent')}(${colors.muted(this.description.slice(0, 60))})${durationStr}${colors.muted(statsStr)}`,
      );
      this.box.addChild(this.headerText);
    } else if (this.status === 'failed') {
      this.headerText.setText(
        `${colors.error('\u2717')} ${colors.bold('Agent')}(${colors.muted(this.description.slice(0, 60))})`,
      );
      this.box.addChild(this.headerText);
    }

    // Tool call tree (only shown while running or if expanded)
    if (this.status === 'running' && this.toolCalls.length > 0) {
      for (let i = 0; i < this.toolCalls.length; i++) {
        const tc = this.toolCalls[i]!;
        const isLast = i === this.toolCalls.length - 1;
        const prefix = isLast ? '\u2514\u2500 ' : '\u251C\u2500 '; // └─ or ├─
        const statusIcon = tc.status === 'success' ? colors.success('\u2713')
          : tc.status === 'error' ? colors.error('\u2717')
          : colors.muted('\u2026'); // …

        const line = `  ${colors.muted(prefix)}${tc.name} ${statusIcon}  ${colors.muted(tc.summary)}`;
        this.box.addChild(new Text(line));
      }
    }

    // Result summary (when completed/failed)
    if ((this.status === 'completed' || this.status === 'failed') && this.resultSummary) {
      const prefix = colors.muted('\u2570\u2500 '); // ╰─
      const text = this.resultSummary.slice(0, 200);
      this.box.addChild(new Text(`  ${prefix}${colors.muted(text)}`));
    }
  }
}
