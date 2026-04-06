import { Box, Text, SelectList, type SelectItem, type Component } from '@mariozechner/pi-tui';
import { colors, selectListTheme } from './theme.js';
import { extractPattern, formatRule } from '../permissions/patterns.js';
import type { PermissionDecision } from '../permissions/rules.js';

export interface PermissionResult {
  decision: PermissionDecision;
  pattern?: string;
  scope?: 'session' | 'project' | 'user';
}

type PermissionCallback = (result: PermissionResult) => void;

/**
 * Inline permission prompt component.
 * Renders in chatContainer. Input is routed here from the CustomEditor
 * when this prompt is active.
 */
export class PermissionPromptComponent implements Component {
  private box: Box;
  private selectList: SelectList;
  private resolved = false;
  private suggestedPattern: string;

  constructor(
    private toolName: string,
    private toolArgs: unknown,
    private callback: PermissionCallback,
  ) {
    this.suggestedPattern = extractPattern(toolName, toolArgs);
    const argsSummary = this.getArgsSummary();

    // Build the prompt box
    this.box = new Box(1, 0);

    // Header
    const headerLine = colors.primaryMuted('\u2500\u2500\u2500 Permission Required ' + '\u2500'.repeat(40));
    this.box.addChild(new Text(headerLine));

    // Tool name and action
    this.box.addChild(new Text(colors.bold(toolName)));
    this.box.addChild(new Text(colors.white(argsSummary)));
    this.box.addChild(new Text('')); // spacing

    // Build options
    const items: SelectItem[] = [
      { value: 'allow', label: 'Allow' },
    ];

    if (this.suggestedPattern) {
      items.push({
        value: 'always-allow',
        label: `Always allow  ${formatRule(toolName, this.suggestedPattern)}`,
      });
    }

    items.push({ value: 'deny', label: 'Deny' });

    this.selectList = new SelectList(items, items.length, selectListTheme);

    this.selectList.onSelect = (item) => {
      if (this.resolved) return;
      this.resolved = true;

      switch (item.value) {
        case 'allow':
          this.callback({ decision: 'allow' });
          break;
        case 'always-allow':
          this.callback({
            decision: 'allow',
            pattern: this.suggestedPattern,
            scope: 'session',
          });
          break;
        case 'deny':
          this.callback({ decision: 'deny' });
          break;
      }
    };

    this.selectList.onCancel = () => {
      if (this.resolved) return;
      this.resolved = true;
      this.callback({ decision: 'deny' });
    };

    this.box.addChild(this.selectList);
  }

  /** Replace prompt with a one-line result summary. */
  showResult(decision: PermissionDecision): void {
    this.box.clear();
    const icon = decision === 'allow' ? colors.success('\u2713') : colors.error('\u2717');
    const label = decision === 'allow' ? 'Allowed' : 'Denied';
    this.box.addChild(new Text(`${icon} ${label}: ${this.toolName}(${this.getArgsSummary()})`));
  }

  handleInput(data: string): void {
    if (!this.resolved) {
      this.selectList.handleInput(data);
    }
  }

  invalidate(): void {
    this.box.invalidate();
  }

  render(width: number): string[] {
    return this.box.render(width);
  }

  private getArgsSummary(): string {
    const args = this.toolArgs as Record<string, unknown>;
    switch (this.toolName) {
      case 'Bash':
        return String(args['command'] ?? '');
      case 'Edit':
      case 'Write':
      case 'Read':
        return String(args['file_path'] ?? args['path'] ?? '');
      case 'WebFetch':
        return String(args['url'] ?? '');
      case 'Glob':
        return String(args['pattern'] ?? '');
      case 'Grep':
        return String(args['pattern'] ?? '');
      case 'SubAgent':
        return String(args['description'] ?? args['instructions'] ?? '').slice(0, 60);
      case 'TaskOutput':
        return String(args['taskId'] ?? args['id'] ?? '');
      default:
        return JSON.stringify(args).slice(0, 80);
    }
  }
}
