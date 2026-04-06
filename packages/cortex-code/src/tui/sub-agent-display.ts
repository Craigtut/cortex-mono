import { Box, Text, Loader, type TUI, type Component } from '@mariozechner/pi-tui';
import { colors } from './theme.js';

type SubAgentStatus = 'running' | 'completed' | 'failed';

// Sub-agent display component with a stable 2-line layout.
// While running: spinner + description + tool count, and a single status line
// showing current activity. On completion: single stats line.
// The display never grows vertically.
export class SubAgentComponent implements Component {
  private box: Box;
  private headerText: Text;
  private activityText: Text;
  private loader: Loader | null = null;
  private status: SubAgentStatus = 'running';
  private toolCount = 0;
  private currentActivity = '';
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
    this.activityText = new Text('');
    this.startSpinner();
  }

  /** Update the current activity and increment the tool count. */
  setActivity(toolName: string, summary: string): void {
    this.toolCount++;
    const displaySummary = summary.length > 60 ? summary.slice(0, 57) + '...' : summary;
    this.currentActivity = displaySummary
      ? `${toolName} ${colors.muted(displaySummary)}`
      : toolName;
    this.rebuildDisplay();
  }

  /** Mark the sub-agent as completed. */
  complete(result: string, usage: { tokenCount: number; durationMs: number; cost: number }): void {
    this.status = 'completed';
    this.tokenCount = usage.tokenCount;
    this.durationMs = usage.durationMs;
    this.cost = usage.cost;
    this.stopSpinner();
    this.rebuildDisplay();
  }

  /** Mark the sub-agent as failed. */
  fail(error: string): void {
    this.status = 'failed';
    this.currentActivity = error;
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

    if (this.status === 'running') {
      // Update the loader label to include tool count
      if (this.loader) {
        const countStr = this.toolCount > 0 ? `  ${colors.muted(`${this.toolCount} tools`)}` : '';
        this.loader.label = `Agent(${this.description.slice(0, 60)})${countStr}`;
        this.box.addChild(this.loader);
      }

      // Single status line showing current activity
      if (this.currentActivity) {
        this.activityText.setText(`  ${colors.muted('\u2514\u2500')} ${this.currentActivity}`);
        this.box.addChild(this.activityText);
      }
    } else if (this.status === 'completed') {
      const stats: string[] = [];
      if (this.toolCount > 0) stats.push(`${this.toolCount} tools`);
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
      const failMsg = this.currentActivity
        ? `  ${colors.muted(this.currentActivity.slice(0, 80))}`
        : '';
      this.headerText.setText(
        `${colors.error('\u2717')} ${colors.bold('Agent')}(${colors.muted(this.description.slice(0, 60))})${failMsg}`,
      );
      this.box.addChild(this.headerText);
    }
  }
}
