import { Box, Text, Loader, type TUI, type Component } from '@mariozechner/pi-tui';
import { colors } from './theme.js';

export type ToolCallStatus = 'pending' | 'success' | 'error';

const MAX_COLLAPSED_LINES = 20;

/**
 * Renders a tool call as a Box component with status transitions.
 * Pending: spinner + tool name + args
 * Success: checkmark + tool name + duration + collapsed result
 * Error: X + tool name + error summary
 */
export class ToolCallComponent implements Component {
  private box: Box;
  private headerText: Text;
  private resultText: Text | null = null;
  private loader: Loader | null = null;
  private status: ToolCallStatus = 'pending';
  private expanded = false;
  private fullResult = '';
  private duration = '';

  // Global toggle state shared across all tool calls
  static globalExpanded = false;

  constructor(
    private tui: TUI,
    private toolName: string,
    private argsSummary: string,
  ) {
    this.box = new Box(1, 0);
    this.headerText = new Text('', 1);
    this.box.addChild(this.headerText);
    this.updateHeader();
    this.startSpinner();
  }

  /** Mark tool call as complete with result. */
  complete(result: string, durationMs: number): void {
    this.status = 'success';
    this.duration = this.formatDuration(durationMs);
    this.fullResult = result;
    this.stopSpinner();
    this.updateHeader();
    this.updateResult();
  }

  /** Mark tool call as failed with error. */
  fail(error: string, durationMs: number): void {
    this.status = 'error';
    this.duration = this.formatDuration(durationMs);
    this.fullResult = error;
    this.stopSpinner();
    this.updateHeader();
    this.updateResult();
  }

  /** Toggle expanded/collapsed state. */
  toggleExpand(): void {
    this.expanded = !this.expanded;
    this.updateResult();
  }

  /** Set expanded state based on global toggle. */
  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.updateResult();
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
      `${this.toolName}(${this.argsSummary})`,
    );
    this.loader.start();
    this.box.clear();
    this.box.addChild(this.loader);
  }

  private stopSpinner(): void {
    if (this.loader) {
      this.loader.stop();
      this.loader = null;
    }
  }

  private updateHeader(): void {
    let header: string;
    switch (this.status) {
      case 'pending':
        header = `${colors.muted(this.toolName)}(${colors.muted(this.argsSummary)})`;
        break;
      case 'success':
        header = `${colors.success('\u2713')} ${colors.bold(this.toolName)}(${colors.muted(this.argsSummary)})  ${colors.muted(this.duration)}`;
        break;
      case 'error':
        header = `${colors.error('\u2717')} ${colors.bold(this.toolName)}(${colors.muted(this.argsSummary)})  ${colors.muted(this.duration)}`;
        break;
    }
    this.headerText.setText(header);
  }

  private updateResult(): void {
    if (this.status === 'pending') return;

    // Remove old result text
    if (this.resultText) {
      this.box.removeChild(this.resultText);
      this.resultText = null;
    }

    // Rebuild box: header + optional result
    this.box.clear();
    this.box.addChild(this.headerText);

    if (!this.fullResult) return;

    const isExpanded = this.expanded || ToolCallComponent.globalExpanded;
    const lines = this.fullResult.split('\n');

    if (isExpanded || lines.length <= MAX_COLLAPSED_LINES) {
      // Show full result
      this.resultText = new Text(
        lines.map(l => colors.muted(`  \u2502 ${l}`)).join('\n'),
      );
    } else {
      // Collapsed: show first lines + "N more" hint
      const shown = lines.slice(0, MAX_COLLAPSED_LINES);
      const remaining = lines.length - MAX_COLLAPSED_LINES;
      const collapsed = [
        ...shown.map(l => colors.muted(`  \u2502 ${l}`)),
        colors.muted(`  \u2502 ... ${remaining} more lines (ctrl+e to expand)`),
      ].join('\n');
      this.resultText = new Text(collapsed);
    }

    this.box.addChild(this.resultText);
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }
}
