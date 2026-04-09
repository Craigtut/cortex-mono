import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  debugSpy,
  infoSpy,
  warnSpy,
  errorSpy,
} = vi.hoisted(() => ({
  debugSpy: vi.fn(),
  infoSpy: vi.fn(),
  warnSpy: vi.fn(),
  errorSpy: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  log: {
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
  },
}));

import { FreezeDiagnostics } from '../../src/diagnostics/freeze.js';

describe('FreezeDiagnostics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    debugSpy.mockClear();
    infoSpy.mockClear();
    warnSpy.mockClear();
    errorSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits heartbeats when enabled', () => {
    const diagnostics = new FreezeDiagnostics({
      enabled: true,
      heartbeatIntervalMs: 500,
    });

    diagnostics.start();
    diagnostics.setSessionRunning(true);
    vi.advanceTimersByTime(500);

    expect(infoSpy).toHaveBeenCalledWith(
      '[FreezeDiagnostics] started',
      expect.objectContaining({ heartbeatIntervalMs: 500 }),
    );
    expect(debugSpy).toHaveBeenCalledWith(
      '[FreezeDiagnostics] heartbeat',
      expect.objectContaining({
        reason: 'tick',
        sessionRunning: true,
      }),
    );
  });

  it('logs slow renders above the configured threshold', () => {
    const diagnostics = new FreezeDiagnostics({
      enabled: true,
      slowRenderThresholdMs: 10,
    });

    diagnostics.recordRenderCompleted(15);

    expect(warnSpy).toHaveBeenCalledWith(
      '[FreezeDiagnostics] slow_render',
      expect.objectContaining({
        durationMs: 15,
        thresholdMs: 10,
      }),
    );
  });
});
