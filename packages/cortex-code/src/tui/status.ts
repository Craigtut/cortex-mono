import { type Component, visibleWidth, truncateToWidth } from '@mariozechner/pi-tui';
import { colors } from './theme.js';

export interface StatusBarState {
  mode: string;
  provider: string;
  model: string;
  tokenCount: number;
  tokenLimit: number;
  gitBranch: string;
  yoloMode: boolean;
  effortLevel: string;
}

/**
 * Footer status bar with progressive reduction.
 * Picks the most detailed layout that fits the terminal width.
 */
export class StatusBar implements Component {
  private state: StatusBarState = {
    mode: 'build',
    provider: '',
    model: '',
    tokenCount: 0,
    tokenLimit: 200_000,
    gitBranch: '',
    yoloMode: false,
    effortLevel: '',
  };

  private hintText: string | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;

  setState(state: Partial<StatusBarState>): void {
    Object.assign(this.state, state);
  }

  /** Show a temporary hint in place of the model text. Auto-clears after durationMs. */
  showHint(text: string, durationMs: number): void {
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintText = text;
    this.hintTimer = setTimeout(() => {
      this.hintText = null;
      this.hintTimer = null;
    }, durationMs);
  }

  invalidate(): void {
    // No cache to clear
  }

  render(width: number): string[] {
    const s = this.state;

    // Build segments
    const modeBadge = ` ${s.mode} `;
    const yoloBadge = s.yoloMode ? ` YOLO ` : '';
    const effortBadge = s.effortLevel && s.effortLevel !== 'off'
      ? ` E:${s.effortLevel.charAt(0).toUpperCase() + s.effortLevel.slice(1)} `
      : '';
    const modelStr = this.hintText ?? (s.provider ? `${s.provider}/${s.model}` : s.model);
    const tokenStr = this.formatTokens(s.tokenCount, s.tokenLimit);
    const branchStr = s.gitBranch;

    // Try layouts from most detailed to most minimal
    const layouts = [
      // Full: mode [YOLO] [effort] | provider/model    tokens    branch
      () => this.layoutFull(modeBadge, yoloBadge, effortBadge, modelStr, tokenStr, branchStr, width),
      // No provider: mode [YOLO] [effort] | model    tokens    branch
      () => this.layoutFull(modeBadge, yoloBadge, effortBadge, s.model, tokenStr, branchStr, width),
      // No effort badge: mode [YOLO] | model    tokens    branch
      () => this.layoutFull(modeBadge, yoloBadge, '', s.model, tokenStr, branchStr, width),
      // No branch: mode [YOLO] | model    tokens
      () => this.layoutFull(modeBadge, yoloBadge, '', s.model, tokenStr, '', width),
      // Minimal: mode    tokens
      () => this.layoutMinimal(modeBadge, tokenStr, width),
    ];

    for (const layout of layouts) {
      const result = layout();
      if (result !== null) return [result];
    }

    // Absolute fallback
    return [truncateToWidth(modeBadge, width)];
  }

  private layoutFull(
    modeBadge: string,
    yoloBadge: string,
    effortBadge: string,
    modelStr: string,
    tokenStr: string,
    branchStr: string,
    width: number,
  ): string | null {
    const left = colors.primaryBg(modeBadge)
      + (yoloBadge ? ' ' + colors.accentBg(yoloBadge) : '')
      + (effortBadge ? ' ' + colors.muted(effortBadge) : '')
      + colors.muted(' | ')
      + colors.white(modelStr);

    const right = this.colorizeTokens(tokenStr)
      + (branchStr ? colors.muted('   ') + colors.muted(branchStr) : '');

    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    const totalNeeded = leftWidth + 4 + rightWidth; // 4 = minimum gap

    if (totalNeeded > width) return null;

    const gap = width - leftWidth - rightWidth;
    return left + ' '.repeat(gap) + right;
  }

  private layoutMinimal(modeBadge: string, tokenStr: string, width: number): string | null {
    const left = colors.primaryBg(modeBadge);
    const right = this.colorizeTokens(tokenStr);
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    const totalNeeded = leftWidth + 2 + rightWidth;

    if (totalNeeded > width) return null;

    const gap = width - leftWidth - rightWidth;
    return left + ' '.repeat(gap) + right;
  }

  private formatTokens(count: number, limit: number): string {
    const countStr = count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
    const limitStr = limit >= 1000 ? `${(limit / 1000).toFixed(0)}k` : String(limit);
    return `${countStr}/${limitStr} tokens`;
  }

  private colorizeTokens(tokenStr: string): string {
    const ratio = this.state.tokenLimit > 0
      ? this.state.tokenCount / this.state.tokenLimit
      : 0;

    if (ratio >= 0.9) return colors.error(tokenStr);
    if (ratio >= 0.75) return colors.accent(tokenStr);
    if (ratio >= 0.5) return colors.accent(tokenStr);
    return colors.success(tokenStr);
  }
}
