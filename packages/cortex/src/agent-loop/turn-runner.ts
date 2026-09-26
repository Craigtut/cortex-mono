/**
 * Runs one logical turn: the first agent.prompt attempt plus transparent
 * background retries of transient failures (RetryPolicy), with the
 * turn-scoped state around it: whether a turn is in flight, the run's cause
 * tags, the history boundary the cache breakpoints key on, and the unwind
 * promise abort() waits on.
 *
 * Retries resume the failed turn with agent.continue() after trimming pi's
 * synthetic failure stub, so completed tool calls do not re-run and the
 * user message is never duplicated. The returned promise stays pending
 * across the whole backoff window; an abort during a wait cancels it.
 *
 * Reference: error-recovery.md
 */

import type { AgentMessage } from '../context-manager.js';
import type { BudgetGuard } from '../budget-guard.js';
import { classifyError, toError } from '../error-classifier.js';
import { isContextOverflow } from '../compaction/failsafe.js';
import type { CompactionManager } from '../compaction/index.js';
import type { CortexModel } from '../model-wrapper.js';
import type { PromptWatchdogDiagnostics } from '../prompt-diagnostics.js';
import { backoffForAttempt, isRetryableCategory, shouldRetry } from '../retry-policy.js';
import type { CortexToolRuntime } from '../tools/runtime.js';
import type {
  AgentLoopConfig,
  CortexLogger,
  LoopOriginContext,
  RetryExhaustedInfo,
  RetryPolicy,
  RetryScheduledInfo,
  RetrySucceededInfo,
} from '../types.js';
import type { DeliveryQueues, QueuedDelivery } from './delivery-queues.js';
import type { DirectCompletionOptions } from './direct-completion.js';
import { HandlerList } from './handler-list.js';
import type { CacheRetention, PiAgent } from './pi-agent.js';
import type { AbortState } from './run-control.js';
import { sleepUnlessAborted } from './run-control.js';
import { isResumableAfterTrim, trimTrailingFailures } from './transcript-repair.js';

export interface TurnRunnerPorts {
  agent: Pick<PiAgent, 'prompt' | 'continue' | 'state'>;
  config: Pick<AgentLoopConfig, 'persistentRuntime' | 'budgetGuard'>;
  retryPolicy: RetryPolicy;
  abort: AbortState;
  isAborted(): boolean;
  /** First run moves the loop from created to active. */
  activate(): void;
  assertNotShuttingDown(): void;
  emitError(error: Error, wasAborted?: boolean): void;
  cacheRetention(): CacheRetention | null;
  model(): CortexModel;
  queues: Pick<DeliveryQueues, 'takeSilent' | 'takeDeliverableWake' | 'reparkAfterFailedPrompt'>;
  toolRuntime: Pick<CortexToolRuntime, 'resetForLoop'>;
  budget: Pick<BudgetGuard, 'reset' | 'getTurnCount' | 'getTotalCost'>;
  diagnostics: Pick<PromptWatchdogDiagnostics, 'startPrompt' | 'finishPrompt'>;
  compaction(): CompactionManager;
  /** Reactive context-overflow handling (emergency truncation). */
  handleOverflow(): void;
  slotCount(): number;
  notifyTailTrimmed(): void;
  pendingBackgroundCount(): number;
  /** Deliver background completions that arrived while the turn ran. */
  drainBackground(): Promise<void>;
  origin: LoopOriginContext;
  logger: CortexLogger;
}

export class TurnRunner {
  readonly retryScheduled: HandlerList<[RetryScheduledInfo, LoopOriginContext]>;
  readonly retrySucceeded: HandlerList<[RetrySucceededInfo, LoopOriginContext]>;
  readonly retryExhausted: HandlerList<[RetryExhaustedInfo, LoopOriginContext]>;

  private prompting = false;
  // Cause tags of the run in flight (see DeliverOptions.causeTag): computed
  // in the same synchronous frame that takes the delivery batches at run
  // start, assigned as the first statement of the try owning the clearing
  // finally, so a reader can never observe a dead or previous run's tags.
  private activeTags: readonly unknown[] = [];
  // Tag handoff for the deliver() prompted branch: staged immediately
  // before prompt() is called with the gate empty, so the very next run
  // task (that prompt's own) consumes it.
  private pendingCauseTag: unknown = undefined;
  private activeRetention: CacheRetention | null = null;
  // Messages before the current prompt: the boundary between "old history"
  // (stable, cacheable) and "new tick content", which enables cross-tick
  // prefix caching of conversation history. Compaction moves it mid-run.
  private boundaryIndex = 0;
  // Resolves when the current turn's unwind (catch/finally of run) has
  // completed. abort() awaits this so its controller reset can never land
  // before the cancelled turn's error classification observes the abort.
  private unwoundPromise: Promise<void> = Promise.resolve();
  private resolveUnwound: (() => void) | null = null;

  constructor(private readonly ports: TurnRunnerPorts) {
    this.retryScheduled = new HandlerList('onRetryScheduled', ports.logger);
    this.retrySucceeded = new HandlerList('onRetrySucceeded', ports.logger);
    this.retryExhausted = new HandlerList('onRetryExhausted', ports.logger);
  }

  get isPrompting(): boolean {
    return this.prompting;
  }

  get activeCauseTags(): readonly unknown[] {
    return this.activeTags;
  }

  get activeCacheRetention(): CacheRetention | null {
    return this.activeRetention;
  }

  get boundary(): number {
    return this.boundaryIndex;
  }

  set boundary(value: number) {
    this.boundaryIndex = value;
  }

  /** The current turn's unwind (captured by abort() before it aborts). */
  get unwound(): Promise<void> {
    return this.unwoundPromise;
  }

  /** Stage the cause tag the next consumer run consumes. */
  stagePromptCauseTag(tag: unknown): void {
    this.pendingCauseTag = tag;
  }

  /** Content steered into the run in flight carries its causation too. */
  appendActiveCauseTags(tags: unknown[]): void {
    this.activeTags = [...this.activeTags, ...tags];
  }

  /**
   * One gate-owned loop cycle: run the logical turn, then deliver any
   * background completions that arrived while it ran. Lifecycle is
   * re-checked here (at dequeue time) so a destroy() that lands between
   * enqueue and dequeue can never start a new loop.
   */
  async runCycle(input: string, options?: DirectCompletionOptions): Promise<unknown> {
    this.ports.assertNotShuttingDown();
    try {
      return await this.run(input, options);
    } finally {
      // Deliver background results that arrived while prompting. This runs
      // before the consumer's await resolves, keeping its UI state
      // consistent, and still under the same gate acquisition. A terminal
      // delivery failure is a background concern: it surfaces through
      // onError (once, at this chain root), never by rejecting a consumer
      // turn that already succeeded or replacing that turn's own error.
      try {
        await this.ports.drainBackground();
      } catch (err) {
        this.ports.emitError(toError(err));
      }
    }
  }

  /**
   * Run one logical prompt turn (first attempt plus transparent background
   * retries). Must be called while holding the loop gate; all mutation of
   * shared loop state (tool runtime, history boundary, prompting flag)
   * happens here, after the gate has been acquired.
   *
   * @param fromDrain - True for the background-completion delivery path,
   *   which deliberately starts a fresh loop after an abort. The consumer
   *   path (false) instead cancels a turn whose controller was aborted
   *   before it dequeued (e.g. a same-frame prompt()+abort()).
   * @param retryPolicyOverride - Per-run retry policy. The drain passes a
   *   policy whose elapsed ceiling is its remaining delivery budget, so a
   *   re-queued delivery cannot re-enter the full retry ladder.
   * @param causeTags - Cause tags for content a drain-started run carries
   *   itself (the sweep passes its batch's tags; the non-drain path derives
   *   tags from the spliced wake batch and the pending prompt tag instead).
   */
  async run(
    input: string,
    options?: DirectCompletionOptions,
    fromDrain = false,
    retryPolicyOverride?: RetryPolicy,
    causeTags?: unknown[],
  ): Promise<unknown> {
    // Transition to ACTIVE on first loop
    this.ports.activate();

    // Consume the deliver()-prompted cause tag first thing, even on paths
    // that cancel before the run starts: the tag belongs to THIS cycle, and
    // leaving it pending would mislabel a later, unrelated run.
    let directCauseTag: unknown;
    if (!fromDrain) {
      directCauseTag = this.pendingCauseTag;
      this.pendingCauseTag = undefined;
    }

    // Abort visibility at dequeue. prompt() installs a fresh (non-aborted)
    // controller synchronously, so if THIS controller is aborted here an
    // abort() must have landed between enqueue and dequeue.
    if (this.ports.abort.signal.aborted) {
      if (fromDrain) {
        // A scheduled drain delivers background results by starting a fresh
        // loop even after an abort, so replace the aborted controller and
        // proceed.
        this.ports.abort.renewIfAborted();
      } else {
        // A consumer turn cancelled before it ever reached pi. Surface it
        // like any other cancellation and never start the run.
        const abortErr = new Error('Prompt aborted before it started');
        abortErr.name = 'AbortError';
        this.ports.emitError(abortErr, true);
        throw abortErr;
      }
    }

    const effectiveRetention = options?.cacheRetention ?? this.ports.cacheRetention();
    this.activeRetention = effectiveRetention ?? null;

    // Flush queued silent deliveries into this prompt's message batch. Only
    // real prompts flush (never drain-started delivery runs): the queue's
    // contract is "available in context at the next real prompt", and the
    // drain's failure unwind counts messages from its own pre-delivery
    // boundary, which flushed extras would corrupt. Taken AFTER the abort
    // check above so a turn cancelled before it started leaves the queue
    // intact for the next prompt.
    const silentBatch = fromDrain ? [] : this.ports.queues.takeSilent();
    // Parked wake deliveries ride ahead of the prompt in the same batch,
    // taken in this same synchronous frame (before pi pushes the batch at
    // run start) so a sweep task that fires later finds nothing and cannot
    // re-deliver content this run consumed. Items an abort cancelled are
    // dropped by the take, not spliced into a post-abort prompt. If the
    // run fails terminally without progressing past the batch, the catch
    // below unwinds the wake portion and re-parks it: content the caller
    // was told was 'parked' must end in a run that answers it, never
    // silently demote to inert transcript context.
    const wakeBatch = fromDrain ? [] : this.ports.queues.takeDeliverableWake();

    // Compute this run's cause tags in the same synchronous frame the
    // batches were taken: caller-supplied tags (sweep runs), tags riding the
    // spliced wake batch, and the deliver()-prompted input's own tag. The
    // ASSIGNMENT happens as the first statement of the try below, so the
    // clearing finally is paired with the set by construction: a throwing
    // consumer logger (or diagnostics sink) between here and the try leaves
    // the tags untouched instead of live for a run that never happened,
    // where the next error entry would read the dead run's stamp (the fault
    // class the interceptor site fixed the same way). Nothing between the
    // batch take and the try awaits, so the same-frame property holds.
    const runCauseTags: readonly unknown[] = [
      ...(causeTags ?? []),
      ...wakeBatch.map((item) => item.causeTag).filter((tag) => tag !== undefined),
      ...(directCauseTag !== undefined ? [directCauseTag] : []),
    ];

    // Long-lived mode keeps workspace state (cwd, read-before-edit registry,
    // undo history) across prompts; transient state resets regardless.
    this.ports.toolRuntime.resetForLoop(
      this.ports.config.persistentRuntime ? { preserveWorkspaceState: true } : undefined,
    );
    // Budget limits cover the whole logical turn: reset here (once per
    // prompt) instead of on loop_start, which pi-agent-core emits again for
    // every background-retry continuation. Under a lifetime budget scope the
    // guard is never reset, so limits bound the loop's whole life.
    if ((this.ports.config.budgetGuard?.scope ?? 'prompt') === 'prompt') {
      this.ports.budget.reset();
    }
    this.prompting = true;
    const loopStartMs = Date.now();

    // Record the message count before this prompt so the transformContext
    // hook knows where "old history" ends and "new tick content" begins.
    // This enables cache breakpoint optimization: old history is stable
    // across ticks and can be cached, while new content changes each tick.
    this.boundaryIndex = this.ports.agent.state.messages.length;

    this.ports.logger.debug('loop start', {
      messageCount: this.boundaryIndex,
      inputLength: input.length,
    });

    this.ports.diagnostics.startPrompt({
      inputLength: input.length,
      messageCount: this.boundaryIndex,
      provider: this.ports.model().provider,
      modelId: this.ports.model().modelId,
    });

    // Created immediately before the try so every code path that leaves a
    // pending turnUnwound is guaranteed to hit the finally that resolves it
    // (abort() awaits this promise and must never hang).
    this.unwoundPromise = new Promise<void>((resolve) => {
      this.resolveUnwound = resolve;
    });

    let promptStatus: 'resolved' | 'rejected' | 'cancelled' = 'resolved';
    try {
      this.activeTags = runCauseTags;
      return await this.runWithRetry(
        input, fromDrain, retryPolicyOverride, silentBatch, wakeBatch,
      );
    } catch (err) {
      const error = toError(err);
      promptStatus = this.ports.isAborted() ? 'cancelled' : 'rejected';
      // A wake delivery spliced into a failed consumer prompt would
      // otherwise sit in the transcript with no run ever answering it.
      // Unwind and re-park it so a sweep re-delivers it with a run of its
      // own. An aborted turn instead cancels its spliced deliveries, the
      // same way abort() cancels parked ones.
      if (promptStatus !== 'cancelled') {
        this.ports.queues.reparkAfterFailedPrompt(wakeBatch, silentBatch.length, error.message);
      }
      // Classification, overflow handling, retry orchestration, and the onError
      // emission all happen inside runTurnWithRetry. Here we only record status
      // for diagnostics and re-throw to the consumer.
      throw error;
    } finally {
      this.activeRetention = null;
      this.prompting = false;
      this.activeTags = [];

      this.ports.logger.debug('loop complete', {
        durationMs: Date.now() - loopStartMs,
        turns: this.ports.budget.getTurnCount(),
        totalCost: this.ports.budget.getTotalCost(),
        currentContextTokens: this.ports.compaction().currentContextTokenCount,
      });

      this.ports.diagnostics.finishPrompt({
        status: promptStatus,
        durationMs: Date.now() - loopStartMs,
        turns: this.ports.budget.getTurnCount(),
        totalCost: this.ports.budget.getTotalCost(),
        currentContextTokens: this.ports.compaction().currentContextTokenCount,
        pendingBackgroundResults: this.ports.pendingBackgroundCount(),
      });

      // Signal that this turn has fully unwound (status classified, flags
      // cleared). abort() waits on this before resetting the controller.
      this.resolveUnwound?.();
      this.resolveUnwound = null;
    }
  }

  /**
   * Run one user turn, transparently retrying transient failures in the
   * background per the configured RetryPolicy.
   *
   * The first attempt uses `agent.prompt(input)`. Each retry resumes the failed
   * turn with `agent.continue()` after trimming pi-agent-core's synthetic
   * failure message, so completed tool calls do not re-run and the user message
   * is never duplicated. The returned promise stays pending across the whole
   * backoff window; an abort during a backoff wait cancels it.
   *
   * On a non-retryable failure (auth, a 404 classified as unknown, context
   * overflow, abort) or once retries are exhausted, it emits onError and throws
   * exactly as the non-retrying path did, so the consumer's existing handling
   * is unchanged for those cases.
   *
   * @param fromDrain - True for background-completion deliveries. The drain
   *   chain re-queues a failed delivery and re-attempts it, so per-attempt
   *   onError emission is deferred to the chain root: a later attempt that
   *   succeeds surfaces no error at all, and a terminal failure surfaces
   *   exactly once (mirroring how an in-run retry that recovers reports
   *   onRetrySucceeded rather than onError).
   */
  private async runWithRetry(
    input: string,
    fromDrain = false,
    retryPolicyOverride?: RetryPolicy,
    silentBatch: QueuedDelivery[] = [],
    wakeBatch: QueuedDelivery[] = [],
  ): Promise<unknown> {
    const policy = retryPolicyOverride ?? this.ports.retryPolicy;
    let retryIndex = 0;
    let firstFailureAt: number | undefined;

    // Parked wake deliveries and queued silent deliveries ride ahead of the
    // prompt in one message batch; pi pushes every batch message into the
    // transcript at run start, so after the first attempt they are durable
    // history and retries (continue()) see them without re-sending. Both
    // queues are spliced by runPromptOnce in the same synchronous frame as
    // this call, so a sweep task that fires later finds nothing and cannot
    // re-deliver content this run consumed. Drain-started runs splice
    // neither queue: their failure unwind counts messages from the
    // pre-delivery boundary, which flushed extras would corrupt, and the
    // sweep delivers parked wake content with a run of its own.
    const leadingBatch = [...wakeBatch, ...silentBatch];
    const promptInput: string | AgentMessage[] = leadingBatch.length > 0
      ? [
          ...leadingBatch.map((item): AgentMessage => ({
            role: 'user',
            content: item.content,
            timestamp: item.timestamp,
          })),
          { role: 'user', content: input, timestamp: Date.now() },
        ]
      : input;

    // Resolves to the turn result, or throws after onError has been emitted.
    for (;;) {
      try {
        const result =
          retryIndex === 0 ? await this.ports.agent.prompt(promptInput) : await this.ports.agent.continue();

        // Pi-agent-core catches streaming/provider errors internally and stores
        // them in state.errorMessage without re-throwing. Surface these so
        // Cortex's error classification and consumer handlers can process them.
        const agentState = this.ports.agent.state as Record<string, unknown>;
        const stateError = agentState['errorMessage'] ?? agentState['error'];
        if (stateError) {
          throw new Error(String(stateError));
        }

        // An abort can end the run cleanly: the stream returns a message with
        // stopReason 'aborted' (no error state) and prompt() resolves. Trim
        // the aborted assistant stub so it does not linger in history and get
        // rewritten to "(no output)" on a later turn. No-op when the last
        // message is a normal assistant turn.
        if (this.ports.isAborted()) {
          this.trimFailureStubs();
        }

        if (retryIndex > 0) {
          this.retrySucceeded.emit({ attempts: retryIndex }, this.ports.origin);
        }
        return result;
      } catch (err) {
        const error = toError(err);
        const aborted = this.ports.isAborted();
        const classified = classifyError(error, { wasAborted: aborted });

        // Reactive overflow detection: emergency truncation, then surface (not
        // retried by default; context_overflow is not a retryable category).
        if (isContextOverflow(error)) {
          this.ports.handleOverflow();
        }

        if (firstFailureAt === undefined) firstFailureAt = Date.now();
        const elapsedMs = Date.now() - firstFailureAt;

        // Only retry when the policy allows AND the transcript can actually be
        // resumed (last message after trimming is a user/tool-result, never a
        // dangling assistant turn that continue() would reject).
        const policyAllowsRetry = shouldRetry(
          classified,
          { retryIndex, elapsedMs, aborted },
          policy,
        );
        const willRetry = policyAllowsRetry && this.resumableAfterTrim();

        if (!willRetry) {
          // Signal "gave up" only when the retry budget was genuinely exhausted
          // (not when the transcript simply could not be resumed), and only if
          // we had actually been retrying a transient failure. Never for a
          // drain delivery: its ladder ending is not terminal (the batch is
          // re-queued and the next attempt may succeed), so like onError the
          // give-up signal is the chain root's to make (dead-letter).
          if (
            !fromDrain &&
            retryIndex > 0 &&
            !aborted &&
            !policyAllowsRetry &&
            isRetryableCategory(classified.category, policy)
          ) {
            this.retryExhausted.emit({ attempts: retryIndex, category: classified.category }, this.ports.origin);
          }
          // A user abort is a cancellation, not a failure to keep: remove the
          // aborted assistant stub pi appended, exactly as the retry path
          // does, so it cannot linger in history and later be rewritten to
          // "(no output)". Non-abort failures keep their stub (unchanged).
          if (aborted) {
            this.trimFailureStubs();
          }
          if (!fromDrain) {
            this.ports.emitError(error, aborted);
          }
          throw error;
        }

        const delayMs = backoffForAttempt(policy, retryIndex);
        const attemptNumber = retryIndex + 1;
        const scheduled: RetryScheduledInfo = {
          category: classified.category,
          attempt: attemptNumber,
          maxAttempts: policy.maxAttempts,
          delayMs,
          nextAttemptAt: Date.now() + delayMs,
          originalMessage: classified.originalMessage,
        };
        if (classified.causeDetail !== undefined) {
          scheduled.causeDetail = classified.causeDetail;
        }
        this.retryScheduled.emit(scheduled, this.ports.origin);
        this.ports.logger.warn('scheduling background retry', {
          category: classified.category,
          attempt: attemptNumber,
          maxAttempts: policy.maxAttempts,
          delayMs,
        });

        const completed = await sleepUnlessAborted(delayMs, this.ports.abort.signal);
        if (!completed) {
          // Aborted during the wait: surface as cancelled, do not retry. Throw a
          // fresh AbortError rather than the original transient failure so the
          // consumer's catch sees a cancellation (matching the in-run abort
          // path) instead of a stale network/rate-limit message. The synthetic
          // failure stub that was awaiting this retry is trimmed like any
          // other aborted turn.
          this.trimFailureStubs();
          if (!fromDrain) {
            this.ports.emitError(error, true);
          }
          const abortErr = new Error('Prompt aborted during retry backoff');
          abortErr.name = 'AbortError';
          throw abortErr;
        }

        // Remove pi-agent-core's synthetic failure message so continue() sees a
        // user/tool-result as the last message and resumes cleanly.
        this.trimFailureStubs();
        retryIndex += 1;
      }
    }
  }

  /** Whether trimming the failure stubs leaves a transcript continue() can resume. */
  private resumableAfterTrim(): boolean {
    return isResumableAfterTrim(this.ports.agent.state.messages as AgentMessage[], this.ports.slotCount());
  }

  /** Remove trailing synthetic failure messages so continue() can resume. */
  private trimFailureStubs(): void {
    if (trimTrailingFailures(this.ports.agent.state.messages as AgentMessage[])) {
      this.ports.notifyTailTrimmed();
    }
  }
}
