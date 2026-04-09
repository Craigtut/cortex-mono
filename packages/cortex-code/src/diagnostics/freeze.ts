import { monitorEventLoopDelay } from 'node:perf_hooks';
import { log } from '../logger.js';
import type { FreezeDiagnosticsConfig } from '../config/config.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 1000;
const DEFAULT_EVENT_LOOP_RESOLUTION_MS = 20;
const DEFAULT_SLOW_RENDER_THRESHOLD_MS = 32;

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  if ('unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

function ageMs(timestamp: number | null, now: number): number | null {
  return timestamp === null ? null : now - timestamp;
}

function toMs(nanoseconds: number): number {
  return Number((nanoseconds / 1_000_000).toFixed(3));
}

export class FreezeDiagnostics {
  private readonly enabled: boolean;
  private readonly heartbeatIntervalMs: number;
  private readonly eventLoopResolutionMs: number;
  private readonly slowRenderThresholdMs: number;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly eventLoopDelay;

  private sessionRunning = false;
  private started = false;
  private lastKeypressAt: number | null = null;
  private lastRenderRequestedAt: number | null = null;
  private lastRenderCompletedAt: number | null = null;
  private lastTranscriptMutationAt: number | null = null;
  private lastAbortRequestedAt: number | null = null;
  private renderRequests = 0;
  private completedRenders = 0;
  private slowRenders = 0;
  private keypresses = 0;

  constructor(config: FreezeDiagnosticsConfig | undefined) {
    this.enabled = config?.enabled ?? false;
    this.heartbeatIntervalMs = Math.max(250, config?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.eventLoopResolutionMs = Math.max(1, config?.eventLoopResolutionMs ?? DEFAULT_EVENT_LOOP_RESOLUTION_MS);
    this.slowRenderThresholdMs = Math.max(1, config?.slowRenderThresholdMs ?? DEFAULT_SLOW_RENDER_THRESHOLD_MS);
    this.eventLoopDelay = monitorEventLoopDelay({
      resolution: this.eventLoopResolutionMs,
    });
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  start(): void {
    if (!this.enabled || this.started) return;

    this.started = true;
    this.eventLoopDelay.enable();
    this.heartbeatTimer = setInterval(() => {
      this.emitHeartbeat();
    }, this.heartbeatIntervalMs);
    maybeUnref(this.heartbeatTimer);
    log.info('[FreezeDiagnostics] started', {
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      eventLoopResolutionMs: this.eventLoopResolutionMs,
      slowRenderThresholdMs: this.slowRenderThresholdMs,
    });
  }

  stop(): void {
    if (!this.started) return;

    this.emitHeartbeat('stopped');
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.eventLoopDelay.disable();
    this.started = false;
    log.info('[FreezeDiagnostics] stopped', {
      renderRequests: this.renderRequests,
      completedRenders: this.completedRenders,
      slowRenders: this.slowRenders,
      keypresses: this.keypresses,
    });
  }

  setSessionRunning(running: boolean): void {
    if (!this.enabled || this.sessionRunning === running) return;

    this.sessionRunning = running;
    log.info('[FreezeDiagnostics] session_state', { running });
  }

  recordKeypress(kind: string): void {
    if (!this.enabled) return;

    this.keypresses += 1;
    this.lastKeypressAt = Date.now();
    if (kind === 'ctrl-c' || kind === 'escape') {
      log.info('[FreezeDiagnostics] keypress', { kind });
    }
  }

  recordAbortRequested(source: string): void {
    if (!this.enabled) return;

    this.lastAbortRequestedAt = Date.now();
    log.info('[FreezeDiagnostics] abort_requested', { source });
  }

  recordTranscriptMutation(source: string): void {
    if (!this.enabled) return;

    this.lastTranscriptMutationAt = Date.now();
    if (source === 'assistant_final' || source === 'notification' || source === 'clear') {
      log.debug('[FreezeDiagnostics] transcript_mutation', { source });
    }
  }

  recordRenderRequested(force: boolean): void {
    if (!this.enabled) return;

    this.renderRequests += 1;
    this.lastRenderRequestedAt = Date.now();
    if (force) {
      log.debug('[FreezeDiagnostics] render_requested', { force });
    }
  }

  recordRenderCompleted(durationMs: number): void {
    if (!this.enabled) return;

    this.completedRenders += 1;
    this.lastRenderCompletedAt = Date.now();
    if (durationMs >= this.slowRenderThresholdMs) {
      this.slowRenders += 1;
      log.warn('[FreezeDiagnostics] slow_render', {
        durationMs,
        thresholdMs: this.slowRenderThresholdMs,
      });
    }
  }

  private emitHeartbeat(reason = 'tick'): void {
    if (!this.enabled) return;

    const now = Date.now();
    const eventLoopMeanMs = toMs(this.eventLoopDelay.mean);
    const eventLoopMaxMs = toMs(this.eventLoopDelay.max);
    log.debug('[FreezeDiagnostics] heartbeat', {
      reason,
      sessionRunning: this.sessionRunning,
      renderRequests: this.renderRequests,
      completedRenders: this.completedRenders,
      slowRenders: this.slowRenders,
      keypresses: this.keypresses,
      lastKeypressAgoMs: ageMs(this.lastKeypressAt, now),
      lastRenderRequestedAgoMs: ageMs(this.lastRenderRequestedAt, now),
      lastRenderCompletedAgoMs: ageMs(this.lastRenderCompletedAt, now),
      lastTranscriptMutationAgoMs: ageMs(this.lastTranscriptMutationAt, now),
      lastAbortRequestedAgoMs: ageMs(this.lastAbortRequestedAt, now),
      eventLoopMeanMs,
      eventLoopMaxMs,
    });
    this.eventLoopDelay.reset();
  }
}
