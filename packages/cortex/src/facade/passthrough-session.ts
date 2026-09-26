/**
 * PassthroughSession: a single reasoner loop behind the facade, reproducing
 * direct AgentLoop behavior exactly (decisions.md D14). The consumer opt-out
 * and the parity baseline for tests.
 */

import type { AgentLoop, DeliverResult, DirectCompletionOptions } from '../agent-loop.js';
import type { PendingAsk, SessionUsage } from '../types.js';
import type { CortexModel } from '../model-wrapper.js';
import type { AgentMessage, ContextManager } from '../context-manager.js';
import type { ObservationalMemoryState } from '../compaction/index.js';
import type { EventBridge } from '../event-bridge.js';
import type { CausationSource } from '../duplex/cause-tags.js';
import type { DuplexRouterState } from '../duplex/router.js';
import type { LogRecorder } from './log-recorder.js';
import {
  gateTerm,
  loopAsksTerm,
  parkedWakesTerm,
  subAgentsTerm,
} from './settlement.js';
import type { SettlementTerm } from './settlement.js';
import type {
  CortexAbortScope,
  CortexDeliverOptions,
  FacadeServices,
  SessionMode,
  SessionStateParts,
} from './session-mode.js';

export class PassthroughSession implements SessionMode {
  readonly causation: CausationSource;
  readonly aggregateBudgetGuard = null;
  private readonly reasoner: AgentLoop;
  private readonly services: FacadeServices;
  private readonly recorder: LogRecorder;
  /** Serializes facade prompt() calls (concurrent prompts queue, never throw). */
  private promptChain: Promise<void> = Promise.resolve();
  /**
   * Seq of the utterance whose facade-initiated reasoner run is currently
   * live. Entries produced by that run (replies, errors, spawn lifecycle)
   * carry it as their causation stamp; entries produced while no
   * facade-initiated run is live (e.g. by a background delivery run) carry
   * no stamp rather than a guessed one.
   */
  private activeCauseSeq: number | null = null;
  /**
   * The talker side and router state of a restored duplex artifact, carried
   * through opaquely: passthrough has no talker loop to hydrate, but the
   * artifact must round-trip getState() without losing that side.
   */
  private retained: SessionStateParts = { talkerHistory: [], talkerMemory: null };

  constructor(reasoner: AgentLoop, services: FacadeServices) {
    this.reasoner = reasoner;
    this.services = services;
    this.recorder = services.recorder;
    this.causation = {
      tags: () => (this.activeCauseSeq !== null
        ? [{ kind: 'utterance', seq: this.activeCauseSeq }]
        : []),
    };
    // Additive handlers (the loop keeps handler arrays), so consumer
    // handlers and their signatures are untouched and parity holds.
    this.recorder.wireConversation(reasoner);
    this.recorder.wireErrors(reasoner);
    this.recorder.wireWork(reasoner);
  }

  get eventBridge(): EventBridge {
    return this.reasoner.getEventBridge();
  }

  get contextManager(): ContextManager {
    return this.reasoner.getContextManager();
  }

  /**
   * Concurrent calls are serialized, each resolving against the turn that
   * carries its input; the utterance is logged when its run starts, so log
   * order always matches execution order even when a deliver() issued in
   * the same tick starts its run ahead of a queued prompt().
   */
  async prompt(input: string, options?: DirectCompletionOptions): Promise<unknown> {
    this.services.noteInputArriving();
    this.services.prompts.begin();
    const run = this.promptChain.then(async () => {
      // Wait for gate quiescence, then act in the SAME frame: between the
      // idle wait resolving and this continuation running, an unrelated
      // continuation (e.g. a background-completion drain) can seize the
      // gate, and AgentLoop.prompt() fails fast on a held gate. The
      // synchronous isLoopActive re-check closes that window exactly.
      for (;;) {
        await this.reasoner.waitForLoopIdle();
        if (this.reasoner.isLoopActive) continue;
        // Re-validate at run start: a teardown that landed while this call
        // was queued must reject it before the utterance is logged.
        this.services.assertPromptable();
        // Logged here rather than at call time: the log is the ordering
        // authority, and content that reached the loop first (a same-tick
        // deliver()) must hold the lower seq.
        const entry = this.recorder.append({
          type: 'utterance',
          loopPath: this.reasoner.loopPath,
          content: input,
          causedBy: null,
        });
        this.activeCauseSeq = entry.seq;
        try {
          return await this.reasoner.prompt(input, options);
        } finally {
          if (this.activeCauseSeq === entry.seq) {
            this.activeCauseSeq = null;
          }
        }
      }
    });
    const settle = (): void => {
      this.services.prompts.end();
    };
    this.promptChain = run.then(settle, settle);
    return run;
  }

  deliver(content: string, options?: CortexDeliverOptions): DeliverResult {
    const entry = this.recorder.append({
      type: 'utterance',
      loopPath: this.reasoner.loopPath,
      content,
      causedBy: null,
      ...(options?.target !== undefined ? { data: { target: options.target } } : {}),
    });

    const result = this.reasoner.deliver(
      content,
      options?.wake !== undefined ? { wake: options.wake } : undefined,
    );
    if (result.outcome === 'prompted' && result.turn) {
      // Bind causation for the run this delivery started. Parked and
      // queued deliveries have no bindable run in passthrough (the sweep
      // batches them); their runs' entries carry no stamp.
      this.activeCauseSeq = entry.seq;
      const clear = (): void => {
        if (this.activeCauseSeq === entry.seq) {
          this.activeCauseSeq = null;
        }
      };
      void result.turn.then(clear, clear);
    }
    return result;
  }

  /** Matches AgentLoop.steer(), including the no-op while idle. */
  steer(message: string): void {
    this.reasoner.steer(message);
  }

  /**
   * The single reasoner is both surfaces, so every scope aborts its
   * in-flight turn and clears queued deliveries and pi's steering and
   * follow-up queues; 'work' and 'all' additionally cancel running
   * sub-agents. Pending asks resolve as deny through the abort race.
   */
  async abort(scope: CortexAbortScope): Promise<void> {
    // Dropped queued content: silent deliveries, parked wake deliveries
    // (abort() drops those itself too), and pi's steering/follow-up queues.
    this.recorder.recordDroppedQueue(this.reasoner, 'abort', this.reasoner.clearAllQueues());

    const work: Array<Promise<unknown>> = [this.reasoner.abort()];
    if (scope !== 'conversation') {
      for (const taskId of this.reasoner.getSubAgentManager().getActiveTaskIds()) {
        work.push(this.reasoner.cancelSubAgent(taskId));
      }
    }
    await Promise.all(work);
  }

  pendingAsks(): PendingAsk[] {
    return this.reasoner.getPendingAsks();
  }

  settlementTerms(prompts: SettlementTerm): { conversation: SettlementTerm[]; work: SettlementTerm[] } {
    const { reasoner } = this;
    return {
      conversation: [prompts, gateTerm(reasoner)],
      work: [
        prompts,
        gateTerm(reasoner),
        subAgentsTerm(reasoner),
        loopAsksTerm(reasoner),
        parkedWakesTerm(reasoner),
      ],
    };
  }

  setBasePrompt(basePrompt: string): string {
    return this.reasoner.setBasePrompt(basePrompt);
  }

  getBasePrompt(): string {
    return this.reasoner.getBasePrompt();
  }

  setModel(model: CortexModel): void {
    this.reasoner.setModel(model);
  }

  setUtilityModel(model: CortexModel): void {
    this.reasoner.setUtilityModel(model);
  }

  setSessionId(value: string | null): void {
    this.reasoner.setSessionId(value);
  }

  lookupUsage(): SessionUsage | null {
    return null;
  }

  restoreBlocked(): boolean {
    return false;
  }

  /**
   * The retained duplex side, copied like getLog(): a persistence layer
   * that normalizes the snapshot in place must never mutate live state.
   */
  captureState(): SessionStateParts {
    return {
      talkerHistory: structuredClone(this.retained.talkerHistory) as AgentMessage[],
      talkerMemory: structuredClone(this.retained.talkerMemory) as ObservationalMemoryState | null,
      ...(this.retained.router ? { router: structuredClone(this.retained.router) } : {}),
    };
  }

  hydrate(parts: SessionStateParts): void {
    this.retained = { ...this.retained, talkerHistory: parts.talkerHistory, talkerMemory: parts.talkerMemory };
  }

  resetForRestore(routerState: DuplexRouterState | undefined): void {
    this.activeCauseSeq = null;
    const { router: _previous, ...rest } = this.retained;
    this.retained = routerState ? { ...rest, router: routerState } : rest;
  }

  beginDestroy(): void {}

  teardowns(): Array<Promise<void>> {
    return [];
  }

  async closeOwnedResources(): Promise<void> {}

  finishDestroy(): void {}
}
