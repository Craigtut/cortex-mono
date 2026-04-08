import type { CortexEvent } from './event-bridge.js';
import { NOOP_LOGGER } from './noop-logger.js';
import type {
  CortexLogger,
  PromptWatchdogDiagnosticsConfig,
} from './types.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 1000;
const DEFAULT_ABORT_WAIT_WARNING_MS = 2000;

interface ActivePromptState {
  startedAt: number;
  inputLength: number;
  messageCount: number;
  provider: string;
  modelId: string;
  lastEventAt: number;
  lastEventType: string;
  eventCount: number;
  toolCallCount: number;
  responseChunkCount: number;
  childEventCount: number;
  sawFirstResponseChunk: boolean;
}

interface PromptStartMeta {
  inputLength: number;
  messageCount: number;
  provider: string;
  modelId: string;
}

interface PromptFinishMeta {
  status: 'resolved' | 'rejected' | 'cancelled';
  durationMs: number;
  turns: number;
  totalCost: number;
  currentContextTokens: number;
  pendingBackgroundResults: number;
}

interface PromptDiagnosticsCallbacks {
  isPrompting: () => boolean;
  isAbortRequested: () => boolean;
}

function maybeUnref(timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
  if ('unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

export class PromptWatchdogDiagnostics {
  private readonly logger: CortexLogger;
  private readonly enabled: boolean;
  private readonly heartbeatIntervalMs: number;
  private readonly abortWaitWarningMs: number;
  private readonly callbacks: PromptDiagnosticsCallbacks;
  private readonly sessionId: string;

  private sequence = 0;
  private activePrompt: ActivePromptState | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private abortWaitTimer: ReturnType<typeof setInterval> | null = null;
  private abortWaitStartedAt: number | null = null;

  constructor(
    config: PromptWatchdogDiagnosticsConfig | undefined,
    logger: CortexLogger | undefined,
    callbacks: PromptDiagnosticsCallbacks,
  ) {
    this.logger = logger ?? NOOP_LOGGER;
    this.enabled = config?.enabled ?? false;
    this.heartbeatIntervalMs = Math.max(250, config?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.abortWaitWarningMs = Math.max(250, config?.abortWaitWarningMs ?? DEFAULT_ABORT_WAIT_WARNING_MS);
    this.callbacks = callbacks;
    this.sessionId = Math.random().toString(36).slice(2, 8);
  }

  startPrompt(meta: PromptStartMeta): void {
    if (!this.enabled) return;

    this.stopHeartbeat();

    this.sequence += 1;
    const now = Date.now();
    this.activePrompt = {
      startedAt: now,
      inputLength: meta.inputLength,
      messageCount: meta.messageCount,
      provider: meta.provider,
      modelId: meta.modelId,
      lastEventAt: now,
      lastEventType: 'prompt_started',
      eventCount: 0,
      toolCallCount: 0,
      responseChunkCount: 0,
      childEventCount: 0,
      sawFirstResponseChunk: false,
    };

    this.logger.info('[Diagnostics] prompt_started', {
      diagnosticsSessionId: this.sessionId,
      promptId: this.currentPromptId(),
      inputLength: meta.inputLength,
      messageCount: meta.messageCount,
      provider: meta.provider,
      model: meta.modelId,
    });

    this.heartbeatTimer = setInterval(() => {
      this.emitHeartbeat();
    }, this.heartbeatIntervalMs);
    maybeUnref(this.heartbeatTimer);
  }

  recordEvent(event: CortexEvent): void {
    if (!this.enabled || !this.activePrompt) return;

    const now = Date.now();
    this.activePrompt.lastEventAt = now;
    this.activePrompt.lastEventType = event.childTaskId ? `${event.type}:child` : event.type;
    this.activePrompt.eventCount += 1;
    if (event.childTaskId) {
      this.activePrompt.childEventCount += 1;
    }

    if (event.type === 'tool_call_start') {
      this.activePrompt.toolCallCount += 1;
      this.logger.debug('[Diagnostics] tool_call_start', {
        diagnosticsSessionId: this.sessionId,
        promptId: this.currentPromptId(),
        toolName: event.payload?.toolName,
        childTaskId: event.childTaskId,
      });
      return;
    }

    if (event.type === 'tool_call_end') {
      const endPayload = event.payload as import('./types.js').ToolCallEndPayload | undefined;
      this.logger.debug('[Diagnostics] tool_call_end', {
        diagnosticsSessionId: this.sessionId,
        promptId: this.currentPromptId(),
        toolName: endPayload?.toolName,
        childTaskId: event.childTaskId,
        durationMs: endPayload?.durationMs,
        isError: endPayload?.isError,
      });
      return;
    }

    if (event.type === 'response_start') {
      this.logger.debug('[Diagnostics] response_started', {
        diagnosticsSessionId: this.sessionId,
        promptId: this.currentPromptId(),
        childTaskId: event.childTaskId,
      });
      return;
    }

    if (event.type === 'response_chunk') {
      this.activePrompt.responseChunkCount += 1;
      if (!this.activePrompt.sawFirstResponseChunk) {
        this.activePrompt.sawFirstResponseChunk = true;
        this.logger.debug('[Diagnostics] first_response_chunk', {
          diagnosticsSessionId: this.sessionId,
          promptId: this.currentPromptId(),
          childTaskId: event.childTaskId,
        });
      }
      return;
    }

    if (event.type === 'response_end' || event.type === 'turn_start' || event.type === 'turn_end' || event.type === 'loop_end') {
      this.logger.debug(`[Diagnostics] ${event.type}`, {
        diagnosticsSessionId: this.sessionId,
        promptId: this.currentPromptId(),
        childTaskId: event.childTaskId,
      });
    }
  }

  recordAbortRequested(): void {
    if (!this.enabled) return;

    this.logger.info('[Diagnostics] abort_requested', {
      diagnosticsSessionId: this.sessionId,
      promptId: this.currentPromptId(),
      isPrompting: this.callbacks.isPrompting(),
      abortRequested: this.callbacks.isAbortRequested(),
    });
  }

  startAbortWait(): void {
    if (!this.enabled) return;

    this.stopAbortWait();
    this.abortWaitStartedAt = Date.now();
    this.logger.debug('[Diagnostics] abort_wait_started', {
      diagnosticsSessionId: this.sessionId,
      promptId: this.currentPromptId(),
    });
    this.abortWaitTimer = setInterval(() => {
      if (this.abortWaitStartedAt === null) return;
      this.logger.warn('[Diagnostics] abort_wait_still_pending', {
        diagnosticsSessionId: this.sessionId,
        promptId: this.currentPromptId(),
        elapsedMs: Date.now() - this.abortWaitStartedAt,
        isPrompting: this.callbacks.isPrompting(),
        abortRequested: this.callbacks.isAbortRequested(),
      });
    }, this.abortWaitWarningMs);
    maybeUnref(this.abortWaitTimer);
  }

  finishAbortWait(): void {
    if (!this.enabled) return;

    const elapsedMs = this.abortWaitStartedAt === null ? 0 : Date.now() - this.abortWaitStartedAt;
    this.stopAbortWait();
    this.logger.info('[Diagnostics] abort_wait_finished', {
      diagnosticsSessionId: this.sessionId,
      promptId: this.currentPromptId(),
      elapsedMs,
    });
  }

  finishPrompt(meta: PromptFinishMeta): void {
    if (!this.enabled || !this.activePrompt) return;

    const snapshot = this.activePrompt;
    this.stopHeartbeat();
    this.logger.info('[Diagnostics] prompt_finished', {
      diagnosticsSessionId: this.sessionId,
      promptId: this.currentPromptId(),
      status: meta.status,
      durationMs: meta.durationMs,
      turns: meta.turns,
      totalCost: meta.totalCost,
      currentContextTokens: meta.currentContextTokens,
      pendingBackgroundResults: meta.pendingBackgroundResults,
      lastEventType: snapshot.lastEventType,
      lastEventAgoMs: Date.now() - snapshot.lastEventAt,
      eventCount: snapshot.eventCount,
      toolCallCount: snapshot.toolCallCount,
      responseChunkCount: snapshot.responseChunkCount,
      childEventCount: snapshot.childEventCount,
    });
    this.activePrompt = null;
  }

  stop(): void {
    this.stopHeartbeat();
    this.stopAbortWait();
    this.activePrompt = null;
  }

  private emitHeartbeat(): void {
    if (!this.activePrompt) return;

    const now = Date.now();
    this.logger.debug('[Diagnostics] prompt_heartbeat', {
      diagnosticsSessionId: this.sessionId,
      promptId: this.currentPromptId(),
      elapsedMs: now - this.activePrompt.startedAt,
      sinceLastEventMs: now - this.activePrompt.lastEventAt,
      lastEventType: this.activePrompt.lastEventType,
      isPrompting: this.callbacks.isPrompting(),
      abortRequested: this.callbacks.isAbortRequested(),
      eventCount: this.activePrompt.eventCount,
      toolCallCount: this.activePrompt.toolCallCount,
      responseChunkCount: this.activePrompt.responseChunkCount,
      childEventCount: this.activePrompt.childEventCount,
    });
  }

  private currentPromptId(): string | null {
    if (!this.activePrompt) return null;
    return `prompt-${this.sequence}`;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private stopAbortWait(): void {
    if (this.abortWaitTimer) {
      clearInterval(this.abortWaitTimer);
      this.abortWaitTimer = null;
    }
    this.abortWaitStartedAt = null;
  }
}
