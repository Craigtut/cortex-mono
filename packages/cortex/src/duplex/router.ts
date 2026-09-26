/**
 * DuplexRouter: traffic between the resident loops (communication.md;
 * decisions D8, D10, D17, D18, D19, D20). It is the talker's control-tool
 * dispatch target and the intake for everything bound back to the talker,
 * composed from the parts that own each rule:
 *
 * - DelegationRegistry: which delegations exist and are still live.
 * - ConversationDeltas: the conversation the reasoner has not seen yet,
 *   flushed INSIDE the next dispatch message (D18), so a directive never
 *   reaches the reasoner without the conversation it points at.
 * - DispatchPolicy: delegation caps, dispatch dedup, bounded refusals.
 * - DeliveryIntake and DeliveryScheduler: the wake policy (producer
 *   proposes, router disposes), dedup, the interrupt bucket and pacing.
 */

import type { CortexLogger } from '../types.js';
import type { WakeClass } from '../session-log.js';
import { NOOP_LOGGER } from '../noop-logger.js';
import { errorMessageOf } from '../error-classifier.js';
import {
  buildCancelDirective,
  buildSpawnDirective,
  buildSteerDirective,
  buildWorkInputDirective,
  composeDispatchMessage,
  wrapDeliveryForTalker,
} from './prompts.js';
import { latestCauseSeq } from './cause-tags.js';
import { DispatchPolicy } from './dispatch-policy.js';
import { DeliveryScheduler } from './delivery-scheduler.js';
import { DeliveryIntake } from './delivery-intake.js';
import { DelegationRegistry } from './delegations.js';
import type { DelegationSnapshot } from './delegations.js';
import { ConversationDeltas } from './conversation-deltas.js';
import { asTrimmedString } from './control-tools.js';
import type { ControlDispatchTarget } from './control-tools.js';
import { DUPLEX_ROUTER_DEFAULTS } from './router-contract.js';
import type {
  DuplexRouterOptions,
  DuplexRouterPorts,
  DuplexRouterState,
  ReasonerDispatchOptions,
  ResolvedRouterOptions,
} from './router-contract.js';
import type { DeliveryIntakeResult, DeliveryTarget } from './reasoner-tools.js';
import type { QuickLookupOutcome, QuickLookupRequestResult } from './quick-lookups.js';


// ---------------------------------------------------------------------------
// DuplexRouter
// ---------------------------------------------------------------------------

export type { DelegationSnapshot } from './delegations.js';
export { DUPLEX_ROUTER_DEFAULTS } from './router-contract.js';
export type {
  DuplexRouterOptions,
  DuplexRouterPorts,
  DuplexRouterState,
  ReasonerDispatchOptions,
  RouterLogInput,
} from './router-contract.js';

export class DuplexRouter implements ControlDispatchTarget, DeliveryTarget {
  private readonly ports: DuplexRouterPorts;
  private readonly options: ResolvedRouterOptions;
  private readonly logger: CortexLogger;
  private readonly now: () => number;
  private readonly talkerLoopPath: string;
  private readonly reasonerLoopPath: string;

  // Delegation registry: human-friendly aliases so a fast-tier model never
  // reproduces UUIDs (communication.md).
  private readonly delegations: DelegationRegistry;

  // Conversation deltas (D18), flushed into the next dispatch message.
  private readonly deltas: ConversationDeltas;

  // Dispatch backpressure (D19).
  private readonly policy: DispatchPolicy;

  // Delivery backpressure and pacing (D19).
  private readonly scheduler: DeliveryScheduler;
  private readonly intake: DeliveryIntake;

  private destroyed = false;

  constructor(ports: DuplexRouterPorts, options?: DuplexRouterOptions) {
    this.ports = ports;
    this.options = { ...DUPLEX_ROUTER_DEFAULTS, ...pruneUndefined(options) };
    this.logger = ports.logger ?? NOOP_LOGGER;
    this.now = options?.now ?? Date.now;
    this.talkerLoopPath = ports.talkerLoopPath ?? 'talker';
    this.reasonerLoopPath = ports.reasonerLoopPath ?? 'reasoner';
    this.deltas = new ConversationDeltas(this.options.deltaBufferMaxChars);
    this.policy = new DispatchPolicy(
      {
        appendLog: (input) => this.ports.appendLog(input),
        currentTalkerCauseTags: () => this.ports.currentTalkerCauseTags(),
        talkerCause: () => this.talkerCause(),
        talkerLoopPath: this.talkerLoopPath,
      },
      {
        maxPerTurn: this.options.maxDispatchesPerTurn,
        maxPerExchange: this.options.maxDispatchesPerExchange,
      },
    );
    this.delegations = new DelegationRegistry({
      now: this.now,
      maxAgeMs: this.options.delegationMaxAgeMs,
    });
    this.scheduler = new DeliveryScheduler(
      {
        deliver: (content) => ports.deliverToTalker(wrapDeliveryForTalker(content), true),
        talkerIdle: () => ports.talkerIdle(),
        // A getter: the consumer's signal is read at every check.
        get idleSignal() {
          return ports.idleSignal;
        },
      },
      {
        minDeliverySpacingMs: this.options.minDeliverySpacingMs,
        whenIdleDegradeMs: this.options.whenIdleDegradeMs,
        idlePollMs: this.options.idlePollMs,
        interruptBucketCapacity: this.options.interruptBucketCapacity,
        interruptRefillMs: this.options.interruptRefillMs,
        deliveryDedupWindowMs: this.options.deliveryDedupWindowMs,
        deliveryDedupMaxEntries: this.options.deliveryDedupMaxEntries,
        now: this.now,
        logger: this.logger,
      },
    );
    this.intake = new DeliveryIntake(
      ports,
      { delegations: this.delegations, deltas: this.deltas, scheduler: this.scheduler },
      { reasonerLoopPath: this.reasonerLoopPath, logger: this.logger },
    );

  }

  // -------------------------------------------------------------------------
  // Conversation flow bookkeeping
  // -------------------------------------------------------------------------

  /**
   * A new user utterance arrived: buffer the delta. The exchange rollover
   * deliberately does NOT happen at arrival, which can be mid talker turn
   * (a barge-in parks behind the live run): it happens when a talker run
   * CONSUMES the utterance (DispatchPolicy.beginDispatch).
   */
  noteUserUtterance(text: string): void {
    this.deltas.push({ speaker: 'user', text });
  }

  /** A talker reply: the other half of the conversation delta (F4). */
  noteTalkerReply(text: string): void {
    this.deltas.push({ speaker: 'assistant', text });
  }

  /** Consumer-provided context for the work surface (no-wake work input). */
  noteWorkContext(text: string): void {
    this.deltas.push({ speaker: 'consumer', text });
  }

  /**
   * A silent conversation input (facade deliver, wake false): conversation
   * context without opening a new exchange.
   */
  noteUserContext(text: string): void {
    this.deltas.push({ speaker: 'user', text });
  }

  /**
   * Compose a consumer work-input dispatch: the pending conversation block
   * ahead of the directive, exactly like a control-tool dispatch. The
   * facade delivers the returned message to the reasoner itself (it owns
   * the causation binding for the run).
   */
  composeWorkDispatch(content: string): string {
    return composeDispatchMessage(this.deltas.consumeBlock(), buildWorkInputDirective(content));
  }

  /**
   * A talker turn boundary: resets the per-turn dispatch cap, and rolls the
   * exchange if the ending run consumed a new utterance (DispatchPolicy).
   */
  noteTalkerTurnEnd(): void {
    this.policy.noteTurnEnd();
  }

  // -------------------------------------------------------------------------
  // Control-tool dispatch (D8/D17: every return is a voiceable receipt)
  // -------------------------------------------------------------------------

  dispatchSpawn(instructionsRaw: unknown): string {
    this.policy.beginDispatch();
    const refused = this.refuseWhenWorkBlocked('spawn_task');
    if (refused !== null) return refused;
    const instructions = asTrimmedString(instructionsRaw);
    if (!instructions) {
      return this.policy.refuse('spawn_task', 'missing instructions',
        'Could not start the task: no instructions given.');
    }
    const dedupKey = this.policy.key('spawn_task', instructions);
    const replay = this.policy.replay(dedupKey);
    if (replay !== undefined) return replay;
    const capRefusal = this.policy.admit('spawn_task');
    if (capRefusal) return capRefusal;

    const alias = this.delegations.reserveAlias();
    const seq = this.ports.appendLog({
      type: 'directive',
      loopPath: this.talkerLoopPath,
      content: `spawn_task ${alias}: ${instructions}`,
      data: { tool: 'spawn_task', alias, instructions },
      ...this.talkerCause(),
    });
    this.delegations.open(alias, instructions, seq);
    if (!this.dispatch(buildSpawnDirective(alias, instructions), seq)) {
      // Never handed over: do not track it as live work (headlines and
      // steer/cancel must not target a task the reasoner never received),
      // and never memoize a success receipt for it.
      this.delegations.remove(alias);
      return 'Could not start that: the handoff failed. Tell the user and try again.';
    }
    const receipt = `Started ${alias}.`;
    this.policy.remember(dedupKey, receipt);
    return receipt;
  }

  dispatchSteer(taskAliasRaw: unknown, messageRaw: unknown): string {
    this.policy.beginDispatch();
    const refused = this.refuseWhenWorkBlocked('steer_task');
    if (refused !== null) return refused;
    const message = asTrimmedString(messageRaw);
    if (!message) {
      return this.policy.refuse('steer_task', 'missing message',
        'Nothing to send: the redirect was empty.');
    }
    const aliasName = asTrimmedString(taskAliasRaw);
    let alias: string | null = null;
    if (aliasName) {
      const delegation = this.delegations.resolve(aliasName);
      if (!delegation) {
        return this.policy.refuse('steer_task', `unknown task "${aliasName}"`,
          `No task called "${aliasName}" is tracked right now.`);
      }
      if (delegation.cancelled) {
        return `Task ${delegation.alias} was already cancelled; start a new task if the work is wanted again.`;
      }
      alias = delegation.alias;
    }
    const dedupKey = this.policy.key('steer_task', alias ?? '', message);
    const replay = this.policy.replay(dedupKey);
    if (replay !== undefined) return replay;
    const capRefusal = this.policy.admit('steer_task');
    if (capRefusal) return capRefusal;

    const seq = this.ports.appendLog({
      type: 'directive',
      loopPath: this.talkerLoopPath,
      content: `steer_task${alias ? ` ${alias}` : ''}: ${message}`,
      data: { tool: 'steer_task', ...(alias ? { alias } : {}), message },
      ...this.talkerCause(),
    });
    // At the live run's next turn boundary: a redirect that waits for the
    // run to finish arrives after the work it was meant to change.
    if (!this.dispatch(buildSteerDirective(alias, message), seq, { atTurnBoundary: true })) {
      return 'The redirect did not go through. Tell the user and try again.';
    }
    // The redirected run will deliver under the STEER's causation, not the
    // spawn's, so without this the result cannot be matched back to the
    // task it belongs to and the delegation never retires.
    if (alias) this.delegations.addSteer(alias, seq);
    const receipt = `Redirect sent${alias ? ` to ${alias}` : ''}.`;
    this.policy.remember(dedupKey, receipt);
    return receipt;
  }

  dispatchCancel(taskAliasRaw: unknown): string {
    this.policy.beginDispatch();
    const aliasName = asTrimmedString(taskAliasRaw);
    if (!aliasName) {
      return this.policy.refuse('cancel_task', 'missing task alias',
        'Could not cancel: no task named.');
    }
    const delegation = this.delegations.resolve(aliasName);
    if (!delegation) {
      return this.policy.refuse('cancel_task', `unknown task "${aliasName}"`,
        `No task called "${aliasName}" is tracked right now.`);
    }
    if (delegation.cancelled) {
      return `Task ${delegation.alias} is already cancelled.`;
    }
    // No delegation caps: a cancel reduces work, and refusing a user's stop
    // request on a rate cap would be the worse failure.
    const seq = this.ports.appendLog({
      type: 'directive',
      loopPath: this.talkerLoopPath,
      content: `cancel_task ${delegation.alias}`,
      data: { tool: 'cancel_task', alias: delegation.alias },
      ...this.talkerCause(),
    });
    this.delegations.markCancelled(delegation.alias, seq);
    // A live run doing nothing but cancelled work is stopped outright; one
    // that also serves live work gets the stop at its next turn boundary.
    const liveRunCancelled = this.delegations.servesOnlyCancelled(this.ports.currentReasonerCauseTags());
    this.dispatch(buildCancelDirective(delegation.alias, delegation.instructions), seq, {
      atTurnBoundary: true,
      ...(liveRunCancelled ? { abortLiveRun: true } : {}),
    });
    return `Cancelling ${delegation.alias}.`;
  }

  dispatchLookup(questionRaw: unknown): string {
    this.policy.beginDispatch();
    const refused = this.refuseWhenWorkBlocked('quick_lookup');
    if (refused !== null) return refused;
    const question = asTrimmedString(questionRaw);
    if (!question) {
      return this.policy.refuse('quick_lookup', 'missing question',
        'Could not look that up: the question was empty.');
    }
    const dedupKey = this.policy.key('quick_lookup', question);
    const replay = this.policy.replay(dedupKey);
    if (replay !== undefined) return replay;
    const capRefusal = this.policy.admit('quick_lookup');
    if (capRefusal) return capRefusal;

    // Facade-spawned ephemeral read-only sub-agent (D13), never a reasoner
    // directive: the answer must not wait on the reasoner's turn boundary,
    // and the F12 read restrictions are built into the lookup loop's tools.
    const seq = this.ports.appendLog({
      type: 'directive',
      loopPath: this.talkerLoopPath,
      content: `quick_lookup: ${question}`,
      data: { tool: 'quick_lookup', question },
      ...this.talkerCause(),
    });
    let spawn: QuickLookupRequestResult;
    try {
      spawn = this.ports.spawnLookup(question, seq);
    } catch (err) {
      this.logger.error('quick lookup spawn threw', {
        error: errorMessageOf(err),
      });
      spawn = { accepted: false, reason: 'spawn failed' };
    }
    if (!spawn.accepted) {
      // Visible, logged refusal; never memoized, so a retry after the pool
      // drains can succeed.
      return this.policy.refuse('quick_lookup', spawn.reason,
        `Could not start that lookup (${spawn.reason}). Tell the user; they can ask again shortly or hand it to the background agent.`);
    }
    const receipt = 'Looking into that in the background.';
    this.policy.remember(dedupKey, receipt);
    return receipt;
  }

  dispatchAnswerAsk(askIdRaw: unknown, decisionRaw: unknown, reasonRaw: unknown): string {
    this.policy.beginDispatch();
    // The D16 consent rules live in the broker; a refused answer is logged
    // through the bounded dispatch_refused path so the anomaly stays in the
    // log (D16) without one spraying turn growing it unboundedly (N4). No
    // delegation caps here: refusing a user's permission answer on a rate
    // cap would be the worse failure, same rule as cancel_task.
    const outcome = this.ports.answerAsk(askIdRaw, decisionRaw, reasonRaw);
    if (outcome.refusal !== undefined) {
      return this.policy.refuse('answer_ask', outcome.refusal, outcome.receipt);
    }
    return outcome.receipt;
  }

  // -------------------------------------------------------------------------
  // Delivery intake (wake policy, D10/D13/D19)
  // -------------------------------------------------------------------------

  /** A quick lookup settled (cancelled ones are logged by the session). */
  deliverLookupResult(outcome: QuickLookupOutcome): void {
    if (this.destroyed) return;
    this.intake.lookupResult(outcome);
  }

  deliverFromReasoner(
    content: string,
    wakeProposed: WakeClass | undefined,
    meta?: { implicit?: boolean; synthetic?: boolean; terminal?: boolean },
  ): DeliveryIntakeResult {
    if (this.destroyed) {
      return { delivered: false, reason: 'router destroyed' };
    }
    return this.intake.fromReasoner(content, wakeProposed, meta);
  }

  // -------------------------------------------------------------------------
  // Delivery pump (spacing, lull detection, degradation)
  // -------------------------------------------------------------------------

  /** Talker-waking deliveries not yet handed to the talker. */
  get pendingDeliveryCount(): number {
    return this.scheduler.pendingCount;
  }

  /** Resolves once no talker-waking delivery is held by the router. */
  waitForDeliveriesSettled(): Promise<void> {
    return this.scheduler.waitSettled();
  }

  // -------------------------------------------------------------------------
  // Registry and state surfaces
  // -------------------------------------------------------------------------

  /** Snapshot of tracked delegations (copies). */
  getDelegations(): DelegationSnapshot[] {
    return this.delegations.snapshot();
  }

  /** Aliases of the delegations still described as work in progress. */
  activeAliases(): string[] {
    return this.delegations.activeAliases();
  }

  /**
   * Content just went to the talker through the reserved ask lane: queued
   * deliveries hold off one spacing window behind it (DeliveryScheduler).
   */
  stampReservedLane(): void {
    this.scheduler.stampReservedLane();
  }

  /**
   * The reasoner's live run was stopped (an abort of any origin): the work
   * it served is no longer in progress, so it stops being described as
   * live. Nothing is delivered here; whether the user hears about it is the
   * caller's decision (a user abort is already acknowledged, a budget stop
   * is not).
   */
  retireRunDelegations(): void {
    this.delegations.retireFor(this.ports.currentReasonerCauseTags());
  }

  /**
   * All work was stopped (a work-scope abort, a breached session budget):
   * every outstanding delegation stops being live, including ones whose
   * dispatch was still parked and was dropped with the run. Marked, not
   * removed, like result-driven retirement: the aliases stay steerable.
   */
  retireAllDelegations(): void {
    this.delegations.retireAll();
  }

  /** Number of buffered conversation deltas awaiting a dispatch flush. */
  get deltaBufferSize(): number {
    return this.deltas.size;
  }

  /**
   * Drop held talker-waking deliveries (abort scope 'conversation'/'all').
   * The delivery entries stay in the log: retained, not delivered.
   */
  dropPendingDeliveries(): number {
    return this.scheduler.dropPending();
  }

  /** Drop buffered conversation deltas (abort scope 'work'/'all'). */
  dropWorkContext(): number {
    return this.deltas.drop();
  }

  /**
   * The session-scoped part of the router's state, for the persisted
   * artifact. Copies throughout: the snapshot never aliases live state.
   */
  exportState(): DuplexRouterState {
    return {
      ...this.delegations.exportState(),
      pendingDeliveries: this.scheduler.pendingContents(),
      ...this.deltas.exportState(),
    };
  }

  /**
   * Re-apply persisted router state after {@link resetForRestore}. Returns
   * the delegations that were still outstanding: whatever run served them
   * did not survive the restore, so they are retired here rather than left
   * listed as live, and the caller decides how to tell the conversation.
   *
   * `logAliasFloor` is the highest task alias number the restored log
   * mentions: an artifact written before this state was persisted (or with
   * it stripped) still never reissues an alias its transcript already uses.
   *
   * Held deliveries come back silent: they reach the talker's context and
   * surface with the user's next turn. A restore is a state operation, so
   * it never starts a talker turn on its own (the consumer may not even
   * have wired its event handlers yet), and whatever urgency the results
   * had belonged to the moment they were produced.
   */
  restoreState(state: DuplexRouterState | undefined, logAliasFloor: number): DelegationSnapshot[] {
    const interrupted = this.delegations.restoreState(state, logAliasFloor);
    if (!state) return interrupted;

    this.deltas.restoreState(state);

    for (const content of Array.isArray(state.pendingDeliveries) ? state.pendingDeliveries : []) {
      if (typeof content !== 'string' || content.trim().length === 0) continue;
      try {
        this.ports.deliverToTalker(wrapDeliveryForTalker(content), false);
      } catch (err) {
        this.logger.error('restoring a held delivery to the talker failed', {
          error: errorMessageOf(err),
        });
      }
    }
    return interrupted;
  }

  /** Reset the router wholesale (facade restore()). */
  resetForRestore(): void {
    this.scheduler.reset();
    this.dropWorkContext();
    this.delegations.clear();
    this.policy.reset();
    this.intake.reset();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scheduler.destroy();
  }

  // -------------------------------------------------------------------------
  // Dispatch internals
  // -------------------------------------------------------------------------

  /**
   * Flush the conversation block and hand the dispatch to the reasoner.
   * Returns whether the handover happened: a throw is logged as a
   * dispatch_failed lifecycle entry (a user instruction must never vanish
   * silently, F11) and reported to the caller, which must return a failure
   * receipt and must NOT memoize a success one (S2: a memoized "Started"
   * for work that was never handed over would replay on the retry that
   * could have succeeded).
   */
  private dispatch(
    directive: string,
    causeSeq: number | null,
    options?: ReasonerDispatchOptions,
  ): boolean {
    const message = composeDispatchMessage(this.deltas.consumeBlock(), directive);
    try {
      this.ports.dispatchToReasoner(message, causeSeq, options);
      return true;
    } catch (err) {
      this.logger.error('dispatch to reasoner failed', {
        error: errorMessageOf(err),
      });
      this.ports.appendLog({
        type: 'lifecycle',
        loopPath: this.reasonerLoopPath,
        content: 'Dispatch to the reasoner failed',
        data: {
          event: 'dispatch_failed',
          error: errorMessageOf(err),
        },
        ...(causeSeq !== null ? { causedBy: causeSeq } : {}),
      });
      return false;
    }
  }

  private refuseWhenWorkBlocked(tool: string): string | null {
    const reason = this.ports.workRefusal?.() ?? null;
    if (reason === null) return null;
    return this.policy.refuse(tool, reason,
      `Could not do that: ${reason}. Tell the user plainly; no more background work can run in this session.`);
  }

  private talkerCause(): { causedBy?: number } {
    const seq = latestCauseSeq(this.ports.currentTalkerCauseTags());
    return seq !== null ? { causedBy: seq } : {};
  }
}

/** Drop undefined values so spreads never clobber defaults with undefined. */
function pruneUndefined(
  options: DuplexRouterOptions | undefined,
): Partial<ResolvedRouterOptions> {
  if (!options) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && key !== 'now') out[key] = value;
  }
  return out as Partial<ResolvedRouterOptions>;
}
