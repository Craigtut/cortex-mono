/**
 * The compact, in-place background-retry line.
 *
 * There is one countdown line and, under duplex, two loops that can retry.
 * The line therefore remembers which loop owns it: without that stamp, a
 * talker retry resolving would wipe the reasoner's countdown, leaving the user
 * staring at nothing through a long backoff on the work they are actually
 * waiting for.
 */

import type { RetryScheduledInfo } from '@animus-labs/cortex';
import type { App } from '../tui/app.js';
import type { TranscriptManager } from '../tui/transcript.js';

/** The slice of the TUI the retry line draws on. */
export type RetryStatusApp = Pick<App, 'hideStatusSpinner'> & {
  transcript: Pick<TranscriptManager, 'setRetryStatus' | 'clearRetryStatus'>;
};

export class RetryStatusLine {
  /** Live retry state while a transient failure is being retried. */
  private retryState: { info: RetryScheduledInfo; loopPath: string } | null = null;
  /** 1s ticker that refreshes the countdown. */
  private retryTicker: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly getApp: () => RetryStatusApp | null) {}

  /**
   * Begin (or update) the countdown. Replaces the "thinking" spinner with a
   * single line that ticks down to the next attempt; a 1s timer keeps the
   * countdown live.
   */
  start(info: RetryScheduledInfo, loopPath: string): void {
    this.retryState = { info, loopPath };
    // A retry wait is not "thinking"; swap the spinner for the status line.
    this.getApp()?.hideStatusSpinner();
    this.renderWaiting();
    this.stopTicker();
    this.retryTicker = setInterval(() => this.renderWaiting(), 1000);
  }

  /**
   * Retries are over (exhausted or disabled): collapse to the terminal
   * 'failed' line, keeping the attempt count the countdown had reached.
   */
  fail(detail: string | undefined): void {
    const attempts = this.retryState?.info.attempt ?? 0;
    const maxAttempts = this.retryState?.info.maxAttempts ?? 0;
    this.stopTicker();
    this.getApp()?.transcript.setRetryStatus({
      phase: 'failed',
      attempt: attempts,
      maxAttempts,
      ...(detail ? { detail } : {}),
    });
  }

  /** Stop the countdown only if `loopPath` owns it; the line itself stays. */
  stopFor(loopPath: string): void {
    if (this.retryState?.loopPath === loopPath) this.stopTicker();
  }

  /** Tear down all retry UI (ticker, line, state). */
  clear(): void {
    this.stopTicker();
    this.retryState = null;
    this.getApp()?.transcript.clearRetryStatus();
  }

  /**
   * Tear down the retry UI only if the loop reporting the resolution is the
   * one whose countdown is on screen. The other loop's retry is not the one
   * the user is watching, and clearing on it would blank a live countdown.
   */
  clearFor(loopPath: string): void {
    if (this.retryState && this.retryState.loopPath !== loopPath) return;
    this.clear();
  }

  /**
   * The agent produced output (text or a tool call) after a retry was pending,
   * which means we reconnected: drop the retry line immediately rather than
   * waiting for the whole turn to resolve.
   */
  noteProgress(): void {
    if (this.retryState) this.clear();
  }

  /** Stop the ticker so it cannot fire after teardown. */
  stopTicker(): void {
    if (this.retryTicker) {
      clearInterval(this.retryTicker);
      this.retryTicker = null;
    }
  }

  /** Render the current waiting/reconnecting line from retryState. */
  private renderWaiting(): void {
    const app = this.getApp();
    if (!this.retryState || !app) return;
    const { info } = this.retryState;
    const secondsRemaining = Math.max(0, (info.nextAttemptAt - Date.now()) / 1000);
    app.transcript.setRetryStatus(
      secondsRemaining > 0
        ? {
            phase: 'waiting',
            attempt: info.attempt,
            maxAttempts: info.maxAttempts,
            secondsRemaining,
            ...(info.causeDetail ? { detail: info.causeDetail } : {}),
          }
        : { phase: 'reconnecting', attempt: info.attempt, maxAttempts: info.maxAttempts },
    );
  }
}
