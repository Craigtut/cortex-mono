import { type Component, type TUI, visibleWidth, truncateToWidth } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import { colors } from './theme.js';

export interface StatusBarState {
  mode: string;
  provider: string;
  model: string;
  contextTokenCount: number;
  contextTokenLimit: number;
  gitBranch: string;
  yoloMode: boolean;
  effortLevel: string;
  /** Whether observational memory compaction is the active strategy. */
  observationalMode: boolean;
  /** Token count of the observational memory slot. */
  observationTokenCount: number;
  /** Whether the observer is currently running in the background. */
  observerActive: boolean;
  /** Whether the reflector is currently running in the background. */
  reflectorActive: boolean;
}

// ---------------------------------------------------------------------------
// Pulse animation constants
// ---------------------------------------------------------------------------

/** Dot character for the observer activity indicator. */
const PULSE_CHAR = '\u25CF'; // ●

// Observer pulse: dark to bright blue
const OBSERVER_DARK  = { r: 0x1a, g: 0x1a, b: 0x3e };
const OBSERVER_BRIGHT = { r: 0x4d, g: 0x9e, b: 0xff };

// Reflector pulse: dark to bright violet/purple
const REFLECTOR_DARK  = { r: 0x2a, g: 0x1a, b: 0x3e };
const REFLECTOR_BRIGHT = { r: 0xb4, g: 0x7e, b: 0xff };

/** Full pulse cycle duration in ms. */
const PULSE_CYCLE_MS = 2400;

/** Animation frame interval in ms (~15 FPS, smooth enough for a color fade). */
const PULSE_FRAME_MS = 66;

/**
 * Ease-in-out sine: smooth acceleration and deceleration.
 * Returns 0..1 where 0 = dark, 1 = bright.
 */
function pulseEase(t: number): number {
  return (1 - Math.cos(t * 2 * Math.PI)) / 2;
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
    contextTokenCount: 0,
    contextTokenLimit: 200_000,
    gitBranch: '',
    yoloMode: false,
    effortLevel: '',
    observationalMode: false,
    observationTokenCount: 0,
    observerActive: false,
    reflectorActive: false,
  };

  private hintText: string | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;

  // Pulse animation state
  private tui: TUI | null = null;
  private pulseTimer: ReturnType<typeof setInterval> | null = null;
  private pulseStartTime = 0;

  setState(state: Partial<StatusBarState>): void {
    const wasProcessing = this.state.observerActive || this.state.reflectorActive;
    Object.assign(this.state, state);
    const isProcessing = this.state.observerActive || this.state.reflectorActive;

    // Start/stop pulse animation when background processing changes
    if (isProcessing && !wasProcessing) {
      this.startPulse();
    } else if (!isProcessing && wasProcessing) {
      this.stopPulse();
    }
  }

  /** Provide TUI reference for driving pulse animation renders. */
  setTui(tui: TUI): void {
    this.tui = tui;
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

  /** Clean up timers. */
  destroy(): void {
    this.stopPulse();
    if (this.hintTimer) {
      clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
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
    const tokenStr = this.formatTokens(s.contextTokenCount, s.contextTokenLimit);
    const branchStr = s.gitBranch;
    const memStr = this.buildMemSegment();

    // Try layouts from most detailed to most minimal
    const layouts = [
      // Full: mode [YOLO] [effort] | provider/model    tokens  mem Xk ●    branch
      () => this.layoutFull(modeBadge, yoloBadge, effortBadge, modelStr, tokenStr, memStr, branchStr, width),
      // No provider: mode [YOLO] [effort] | model    tokens  mem Xk ●    branch
      () => this.layoutFull(modeBadge, yoloBadge, effortBadge, s.model, tokenStr, memStr, branchStr, width),
      // No effort badge: mode [YOLO] | model    tokens  mem Xk ●    branch
      () => this.layoutFull(modeBadge, yoloBadge, '', s.model, tokenStr, memStr, branchStr, width),
      // No branch: mode [YOLO] | model    tokens  mem Xk ●
      () => this.layoutFull(modeBadge, yoloBadge, '', s.model, tokenStr, memStr, '', width),
      // No mem: mode [YOLO] | model    tokens
      () => this.layoutFull(modeBadge, yoloBadge, '', s.model, tokenStr, '', '', width),
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

  // -------------------------------------------------------------------------
  // Layout builders
  // -------------------------------------------------------------------------

  private layoutFull(
    modeBadge: string,
    yoloBadge: string,
    effortBadge: string,
    modelStr: string,
    tokenStr: string,
    memStr: string,
    branchStr: string,
    width: number,
  ): string | null {
    const left = colors.primaryBg(modeBadge)
      + (yoloBadge ? ' ' + colors.accentBg(yoloBadge) : '')
      + (effortBadge ? ' ' + colors.muted(effortBadge) : '')
      + colors.muted(' | ')
      + colors.white(modelStr);

    const right = this.colorizeTokens(tokenStr)
      + (memStr ? colors.muted('  ') + memStr : '')
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

  // -------------------------------------------------------------------------
  // Observational memory segment
  // -------------------------------------------------------------------------

  private buildMemSegment(): string {
    const s = this.state;
    // Always show in observational mode, hide in classic mode
    if (!s.observationalMode) return '';

    const countStr = s.observationTokenCount >= 1000
      ? `${(s.observationTokenCount / 1000).toFixed(1)}k`
      : String(s.observationTokenCount);

    const label = colors.muted(`mem ${countStr}`);
    const isProcessing = s.observerActive || s.reflectorActive;

    if (isProcessing) {
      const dot = this.renderPulseDot();
      return `${label} ${dot}`;
    }

    return label;
  }

  // -------------------------------------------------------------------------
  // Pulse animation
  // -------------------------------------------------------------------------

  private renderPulseDot(): string {
    // Reflector takes priority for color (it's the rarer, more notable event)
    const dark = this.state.reflectorActive ? REFLECTOR_DARK : OBSERVER_DARK;
    const bright = this.state.reflectorActive ? REFLECTOR_BRIGHT : OBSERVER_BRIGHT;

    const elapsed = Date.now() - this.pulseStartTime;
    const t = (elapsed % PULSE_CYCLE_MS) / PULSE_CYCLE_MS;
    const k = pulseEase(t);

    const r = Math.round(dark.r + (bright.r - dark.r) * k);
    const g = Math.round(dark.g + (bright.g - dark.g) * k);
    const b = Math.round(dark.b + (bright.b - dark.b) * k);

    return chalk.rgb(r, g, b)(PULSE_CHAR);
  }

  private startPulse(): void {
    if (this.pulseTimer) return;
    this.pulseStartTime = Date.now();
    this.pulseTimer = setInterval(() => {
      this.tui?.requestRender();
    }, PULSE_FRAME_MS);
  }

  private stopPulse(): void {
    if (this.pulseTimer) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Token formatting
  // -------------------------------------------------------------------------

  private formatTokens(count: number, limit: number): string {
    const countStr = count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
    const limitStr = limit >= 1000 ? `${(limit / 1000).toFixed(0)}k` : String(limit);
    return `${countStr}/${limitStr} tokens`;
  }

  private colorizeTokens(tokenStr: string): string {
    const ratio = this.state.contextTokenLimit > 0
      ? this.state.contextTokenCount / this.state.contextTokenLimit
      : 0;

    if (ratio >= 0.9) return colors.error(tokenStr);
    if (ratio >= 0.75) return colors.accent(tokenStr);
    if (ratio >= 0.5) return colors.accent(tokenStr);
    return colors.success(tokenStr);
  }
}
