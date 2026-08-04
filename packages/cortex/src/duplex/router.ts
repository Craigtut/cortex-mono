/**
 * DuplexRouter: the facade's control-tool dispatch surface, wake policy,
 * and backpressure between the resident loops (communication.md; decisions
 * D8, D10, D17, D18, D19, D20).
 *
 * Producer proposes, router disposes: the reasoner proposes a wake class
 * per delivery and the router may demote it. Wake classes describe intent,
 * not rate; the router bounds rate with an interrupt token bucket,
 * content-hash dedup over recent deliveries, per-turn and per-exchange
 * delegation caps, dispatch dedup (absorbing retry-induced double
 * dispatch), and a facade-enforced minimum inter-delivery spacing that an
 * always-idle or never-idle consumer signal cannot collapse.
 *
 * The router also owns the conversation-delta buffer (D18): both sides of
 * the conversation are buffered facade-side and flushed as a context-only
 * block INSIDE the next dispatch message, so a directive can never reach
 * the reasoner without the conversation it points at (a directive parked
 * behind a busy reasoner is delivered by a sweep run, which never flushes
 * the loop's silent queue; carrying the block in the dispatch message makes
 * the pairing exact in every loop state). Only a dispatch starts a reasoner
 * turn; deltas alone never do.
 */

import type { CortexLogger } from '../types.js';
import type { WakeClass } from '../session-log.js';
import { NOOP_LOGGER } from '../noop-logger.js';
import {
  buildCancelDirective,
  buildConversationBlock,
  buildLookupDirective,
  buildSpawnDirective,
  buildSteerDirective,
  buildWorkInputDirective,
  composeDispatchMessage,
  DELTA_OVERFLOW_MARKER,
  wrapDeliveryForTalker,
} from './prompts.js';
import type { ConversationDelta } from './prompts.js';
import type { ControlDispatchTarget } from './control-tools.js';
import type { DeliveryIntakeResult, DeliveryTarget } from './reasoner-tools.js';

// ---------------------------------------------------------------------------
// Ports and options
// ---------------------------------------------------------------------------

/** Log entry input the router produces (a subset of the facade's schema). */
export interface RouterLogInput {
  type: 'directive' | 'delivery' | 'lifecycle';
  loopPath: string;
  content: string;
  wake?: WakeClass;
  causedBy?: number;
  data?: Record<string, unknown>;
}

/** What the router needs from the facade. */
export interface DuplexRouterPorts {
  /**
   * Hand content to the talker: wake true starts or parks a turn, wake
   * false lands in the talker's silent queue (never pi's steering queue;
   * the loop's deliver() enforces that).
   */
  deliverToTalker(content: string, wake: boolean): void;
  /** Whether the conversation surface is idle (the default lull signal). */
  talkerIdle(): boolean;
  /**
   * Wake-deliver a composed dispatch message to the reasoner. causeSeq is
   * the log seq of the directive (or work utterance) for causation binding
   * of the run it starts.
   */
  dispatchToReasoner(message: string, causeSeq: number | null): void;
  /** Append a session log entry; returns its seq. */
  appendLog(input: RouterLogInput): number;
  /** Seq of the utterance driving the talker's live run, or null. */
  currentTalkerCauseSeq(): number | null;
  /** Seq of the directive driving the reasoner's live run, or null. */
  currentReasonerCauseSeq(): number | null;
  /** Consumer idle signal (advisory, facade-api.md). */
  idleSignal?: (() => boolean) | undefined;
  logger?: CortexLogger;
  /** Loop-path labels for log entries. Defaults: 'talker' / 'reasoner'. */
  talkerLoopPath?: string;
  reasonerLoopPath?: string;
}

/** Router tunables; every default is overridable for tests and consumers. */
export interface DuplexRouterOptions {
  /** Minimum ms between talker-waking deliveries. */
  minDeliverySpacingMs?: number;
  /** Ms after which a held when_idle delivery degrades to interrupt. */
  whenIdleDegradeMs?: number;
  /** Poll interval while a when_idle delivery waits for a lull. */
  idlePollMs?: number;
  /** Interrupt token bucket capacity (D19). */
  interruptBucketCapacity?: number;
  /** Ms to earn one interrupt token back. */
  interruptRefillMs?: number;
  /** Window for content-hash dedup across recent deliveries. */
  deliveryDedupWindowMs?: number;
  /** Cap on remembered delivery hashes. */
  deliveryDedupMaxEntries?: number;
  /** Delegation dispatches allowed per talker turn. */
  maxDispatchesPerTurn?: number;
  /** Delegation dispatches allowed per exchange (user utterance). */
  maxDispatchesPerExchange?: number;
  /** Reasoner-run silence that triggers a synthesized progress delivery. */
  watchdogIntervalMs?: number;
  /** Char bound on the buffered conversation deltas. */
  deltaBufferMaxChars?: number;
  /** Clock override for tests. */
  now?: () => number;
}

export const DUPLEX_ROUTER_DEFAULTS = {
  minDeliverySpacingMs: 2_000,
  whenIdleDegradeMs: 30_000,
  idlePollMs: 250,
  interruptBucketCapacity: 3,
  interruptRefillMs: 20_000,
  deliveryDedupWindowMs: 120_000,
  deliveryDedupMaxEntries: 32,
  maxDispatchesPerTurn: 4,
  maxDispatchesPerExchange: 8,
  watchdogIntervalMs: 90_000,
  deltaBufferMaxChars: 16_000,
} as const;

type ResolvedOptions = typeof DUPLEX_ROUTER_DEFAULTS;

/** One tracked delegation (a spawn_task dispatch), keyed by alias. */
export interface DelegationSnapshot {
  alias: string;
  instructions: string;
  /** Log seq of the spawn directive. */
  seq: number;
  createdAt: number;
  cancelled: boolean;
}

interface PendingDelivery {
  /** Raw delivered content (wrapped for the talker at delivery time). */
  content: string;
  enqueuedAt: number;
}

/** FNV-1a 32-bit; cheap content identity for dedup, not security. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// DuplexRouter
// ---------------------------------------------------------------------------

export class DuplexRouter implements ControlDispatchTarget, DeliveryTarget {
  private readonly ports: DuplexRouterPorts;
  private readonly options: ResolvedOptions;
  private readonly logger: CortexLogger;
  private readonly now: () => number;
  private readonly talkerLoopPath: string;
  private readonly reasonerLoopPath: string;

  // Delegation registry: human-friendly aliases so a fast-tier model never
  // reproduces UUIDs (communication.md).
  private readonly delegations = new Map<string, DelegationSnapshot>();
  private nextAliasNumber = 1;

  // Conversation deltas (D18), flushed into the next dispatch message.
  private deltaBuffer: ConversationDelta[] = [];
  private deltaBufferChars = 0;
  private deltaOverflowed = false;

  // Dispatch backpressure (D19).
  private dispatchesThisTurn = 0;
  private dispatchesThisExchange = 0;
  /** dedup key -> receipt of the original dispatch (retries replay it). */
  private dispatchDedup = new Map<string, string>();

  // Delivery backpressure (D19).
  private interruptTokens: number;
  private lastTokenRefillAt: number;
  private recentDeliveryHashes: Array<{ hash: number; at: number }> = [];
  private lastDeliveryAt = 0;

  // Delivery queues: interrupts ahead of held when_idle content.
  private interruptQueue: PendingDelivery[] = [];
  private whenIdleQueue: PendingDelivery[] = [];
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private pumpTimerAt = 0;
  private settleWaiters: Array<() => void> = [];

  // Liveness watchdog over reasoner runs (communication.md).
  private reasonerRunning = false;
  private reasonerRunStartAt = 0;
  private lastReasonerOutputAt = 0;
  private readonly watchdogTimer: ReturnType<typeof setInterval>;

  private destroyed = false;

  constructor(ports: DuplexRouterPorts, options?: DuplexRouterOptions) {
    this.ports = ports;
    this.options = { ...DUPLEX_ROUTER_DEFAULTS, ...pruneUndefined(options) };
    this.logger = ports.logger ?? NOOP_LOGGER;
    this.now = options?.now ?? Date.now;
    this.talkerLoopPath = ports.talkerLoopPath ?? 'talker';
    this.reasonerLoopPath = ports.reasonerLoopPath ?? 'reasoner';
    this.interruptTokens = this.options.interruptBucketCapacity;
    this.lastTokenRefillAt = this.now();

    // The watchdog checks well inside its interval so a hung run is noticed
    // at most ~1.25 intervals after its last output.
    const checkEvery = Math.min(Math.max(50, Math.floor(this.options.watchdogIntervalMs / 4)), 15_000);
    this.watchdogTimer = setInterval(() => this.watchdogTick(), checkEvery);
    this.watchdogTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Conversation flow bookkeeping
  // -------------------------------------------------------------------------

  /** A new user utterance: buffer the delta and open a fresh exchange. */
  noteUserUtterance(text: string): void {
    this.pushDelta({ speaker: 'user', text });
    this.dispatchesThisExchange = 0;
    this.dispatchesThisTurn = 0;
    this.dispatchDedup.clear();
  }

  /** A talker reply: the other half of the conversation delta (F4). */
  noteTalkerReply(text: string): void {
    this.pushDelta({ speaker: 'assistant', text });
  }

  /** Consumer-provided context for the work surface (no-wake work input). */
  noteWorkContext(text: string): void {
    this.pushDelta({ speaker: 'consumer', text });
  }

  /**
   * A silent conversation input (facade deliver, wake false): conversation
   * context without opening a new exchange.
   */
  noteUserContext(text: string): void {
    this.pushDelta({ speaker: 'user', text });
  }

  /**
   * Compose a consumer work-input dispatch: the pending conversation block
   * ahead of the directive, exactly like a control-tool dispatch. The
   * facade delivers the returned message to the reasoner itself (it owns
   * the causation binding for the run).
   */
  composeWorkDispatch(content: string): string {
    return composeDispatchMessage(this.consumeConversationBlock(), buildWorkInputDirective(content));
  }

  /** A talker turn boundary: resets the per-turn dispatch cap. */
  noteTalkerTurnEnd(): void {
    this.dispatchesThisTurn = 0;
  }

  /** Reasoner run lifecycle, for the liveness watchdog. */
  noteReasonerRunStart(): void {
    this.reasonerRunning = true;
    const now = this.now();
    this.reasonerRunStartAt = now;
    this.lastReasonerOutputAt = now;
  }

  noteReasonerRunEnd(): void {
    this.reasonerRunning = false;
  }

  // -------------------------------------------------------------------------
  // Control-tool dispatch (D8/D17: every return is a voiceable receipt)
  // -------------------------------------------------------------------------

  dispatchSpawn(instructionsRaw: unknown): string {
    const instructions = asTrimmedString(instructionsRaw);
    if (!instructions) {
      return this.refuseDispatch('spawn_task', 'missing instructions',
        'Could not start the task: no instructions given.');
    }
    const dedupKey = `spawn_task:${fnv1a(instructions)}`;
    const replay = this.dispatchDedup.get(dedupKey);
    if (replay !== undefined) return replay;
    const capRefusal = this.applyDispatchCaps('spawn_task');
    if (capRefusal) return capRefusal;

    const alias = `task-${this.nextAliasNumber++}`;
    const seq = this.ports.appendLog({
      type: 'directive',
      loopPath: this.talkerLoopPath,
      content: `spawn_task ${alias}: ${instructions}`,
      data: { tool: 'spawn_task', alias, instructions },
      ...this.talkerCause(),
    });
    this.delegations.set(alias, {
      alias,
      instructions,
      seq,
      createdAt: this.now(),
      cancelled: false,
    });
    this.dispatch(buildSpawnDirective(alias, instructions), seq);
    const receipt = `Started ${alias}.`;
    this.dispatchDedup.set(dedupKey, receipt);
    return receipt;
  }

  dispatchSteer(taskAliasRaw: unknown, messageRaw: unknown): string {
    const message = asTrimmedString(messageRaw);
    if (!message) {
      return this.refuseDispatch('steer_task', 'missing message',
        'Nothing to send: the redirect was empty.');
    }
    const aliasName = asTrimmedString(taskAliasRaw);
    let alias: string | null = null;
    if (aliasName) {
      const delegation = this.resolveDelegation(aliasName);
      if (!delegation) {
        return this.refuseDispatch('steer_task', `unknown task "${aliasName}"`,
          `No task called "${aliasName}" is tracked right now.`);
      }
      if (delegation.cancelled) {
        return `Task ${delegation.alias} was already cancelled; start a new task if the work is wanted again.`;
      }
      alias = delegation.alias;
    }
    const dedupKey = `steer_task:${alias ?? ''}:${fnv1a(message)}`;
    const replay = this.dispatchDedup.get(dedupKey);
    if (replay !== undefined) return replay;
    const capRefusal = this.applyDispatchCaps('steer_task');
    if (capRefusal) return capRefusal;

    const seq = this.ports.appendLog({
      type: 'directive',
      loopPath: this.talkerLoopPath,
      content: `steer_task${alias ? ` ${alias}` : ''}: ${message}`,
      data: { tool: 'steer_task', ...(alias ? { alias } : {}), message },
      ...this.talkerCause(),
    });
    this.dispatch(buildSteerDirective(alias, message), seq);
    const receipt = `Redirect sent${alias ? ` to ${alias}` : ''}.`;
    this.dispatchDedup.set(dedupKey, receipt);
    return receipt;
  }

  dispatchCancel(taskAliasRaw: unknown): string {
    const aliasName = asTrimmedString(taskAliasRaw);
    if (!aliasName) {
      return this.refuseDispatch('cancel_task', 'missing task alias',
        'Could not cancel: no task named.');
    }
    const delegation = this.resolveDelegation(aliasName);
    if (!delegation) {
      return this.refuseDispatch('cancel_task', `unknown task "${aliasName}"`,
        `No task called "${aliasName}" is tracked right now.`);
    }
    if (delegation.cancelled) {
      return `Task ${delegation.alias} is already cancelled.`;
    }
    // No delegation caps: a cancel reduces work, and refusing a user's stop
    // request on a rate cap would be the worse failure.
    delegation.cancelled = true;
    const seq = this.ports.appendLog({
      type: 'directive',
      loopPath: this.talkerLoopPath,
      content: `cancel_task ${delegation.alias}`,
      data: { tool: 'cancel_task', alias: delegation.alias },
      ...this.talkerCause(),
    });
    this.dispatch(buildCancelDirective(delegation.alias, delegation.instructions), seq);
    return `Cancelling ${delegation.alias}.`;
  }

  dispatchLookup(questionRaw: unknown): string {
    const question = asTrimmedString(questionRaw);
    if (!question) {
      return this.refuseDispatch('quick_lookup', 'missing question',
        'Could not look that up: the question was empty.');
    }
    const dedupKey = `quick_lookup:${fnv1a(question)}`;
    const replay = this.dispatchDedup.get(dedupKey);
    if (replay !== undefined) return replay;
    const capRefusal = this.applyDispatchCaps('quick_lookup');
    if (capRefusal) return capRefusal;

    // 2b-i interim: the question routes to the reasoner as a directive, so
    // the capability exists end to end. 2b-ii replaces this dispatch with a
    // facade-spawned read-only ephemeral sub-agent (D13) so the answer does
    // not wait on the reasoner's turn boundary, with the F12 read
    // restrictions built in-tool.
    const seq = this.ports.appendLog({
      type: 'directive',
      loopPath: this.talkerLoopPath,
      content: `quick_lookup: ${question}`,
      data: { tool: 'quick_lookup', question },
      ...this.talkerCause(),
    });
    this.dispatch(buildLookupDirective(question), seq);
    const receipt = 'Looking into that in the background.';
    this.dispatchDedup.set(dedupKey, receipt);
    return receipt;
  }

  dispatchAnswerAsk(_askIdRaw: unknown, _decisionRaw: unknown, _reasonRaw: unknown): string {
    // The permission broker is 2b-ii. Until it lands, no ask is ever routed
    // to the talker, so the only truthful receipt is that nothing is
    // pending; the tool exists now so the talker's toolset and prompts are
    // stable across the sub-phases. The broker replaces this body with the
    // D16 consent rules (most-recently-voiced binding, allow-once,
    // utterance-after-voicing causation).
    return 'There are no pending permission requests to answer.';
  }

  /**
   * Consumer input addressed to the work surface (facade deliver target
   * 'work'). Bypasses the delegation caps (it is consumer input, not model
   * delegation) but still flushes the conversation block.
   */
  dispatchWorkInput(content: string, causeSeq: number | null): void {
    this.dispatch(buildWorkInputDirective(content), causeSeq);
  }

  // -------------------------------------------------------------------------
  // Reasoner delivery intake (wake policy, D10/D19)
  // -------------------------------------------------------------------------

  deliverFromReasoner(
    content: string,
    wakeProposed: WakeClass | undefined,
    meta?: { implicit?: boolean; synthetic?: boolean },
  ): DeliveryIntakeResult {
    if (this.destroyed) {
      return { delivered: false, reason: 'router destroyed' };
    }
    const now = this.now();
    this.lastReasonerOutputAt = now;

    // Content-hash dedup over recent deliveries: a reasoner (or its retry
    // ladder) emitting the same content repeatedly costs one delivery.
    this.pruneRecentHashes(now);
    const hash = fnv1a(content.trim());
    if (this.recentDeliveryHashes.some((entry) => entry.hash === hash)) {
      this.logger.info('duplicate delivery absorbed', { hash });
      return { delivered: false, reason: 'duplicate of a recent delivery' };
    }
    this.recentDeliveryHashes.push({ hash, at: now });
    if (this.recentDeliveryHashes.length > this.options.deliveryDedupMaxEntries) {
      this.recentDeliveryHashes.shift();
    }

    // Producer proposes, router disposes: interrupts draw from the token
    // bucket and demote to when_idle when it is empty.
    const proposed: WakeClass = wakeProposed ?? 'when_idle';
    let wake: WakeClass = proposed;
    let demoted = false;
    if (proposed === 'interrupt') {
      this.refillInterruptTokens(now);
      if (this.interruptTokens > 0) {
        this.interruptTokens -= 1;
      } else {
        wake = 'when_idle';
        demoted = true;
        this.logger.info('interrupt delivery demoted to when_idle (token bucket empty)');
      }
    }

    // The log is the durable record of the delivery; a delivery dropped
    // later (abort, restore) stays retained here (facade-api.md abort
    // table).
    this.ports.appendLog({
      type: 'delivery',
      loopPath: this.reasonerLoopPath,
      content,
      wake,
      data: {
        proposedWake: proposed,
        ...(demoted ? { demoted: true } : {}),
        ...(meta?.implicit ? { implicit: true } : {}),
        ...(meta?.synthetic ? { synthetic: true } : {}),
      },
      ...this.reasonerCause(),
    });

    if (wake === 'silent') {
      // Silent never wakes and never waits: it lands in the talker's own
      // silent queue (never pi's steering queue) and surfaces with the next
      // real prompt.
      try {
        this.ports.deliverToTalker(wrapDeliveryForTalker(content), false);
      } catch (err) {
        this.logger.error('silent delivery to talker failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return { delivered: true, wake };
    }

    const pending: PendingDelivery = { content, enqueuedAt: now };
    if (wake === 'interrupt') {
      this.interruptQueue.push(pending);
    } else {
      this.whenIdleQueue.push(pending);
    }
    this.pump();
    return { delivered: true, wake };
  }

  // -------------------------------------------------------------------------
  // Delivery pump (spacing, lull detection, degradation)
  // -------------------------------------------------------------------------

  /** Talker-waking deliveries not yet handed to the talker. */
  get pendingDeliveryCount(): number {
    return this.interruptQueue.length + this.whenIdleQueue.length;
  }

  /** Resolves once no talker-waking delivery is held by the router. */
  waitForDeliveriesSettled(): Promise<void> {
    if (this.pendingDeliveryCount === 0) return Promise.resolve();
    return new Promise((resolve) => this.settleWaiters.push(resolve));
  }

  private pump(): void {
    if (this.destroyed) return;
    for (;;) {
      if (this.interruptQueue.length === 0 && this.whenIdleQueue.length === 0) {
        this.notifySettled();
        return;
      }
      const now = this.now();
      // Minimum inter-delivery spacing holds regardless of wake class or
      // idle signal (the anti-collapse rule in communication.md).
      const spacingReadyAt = this.lastDeliveryAt + this.options.minDeliverySpacingMs;
      if (this.lastDeliveryAt > 0 && now < spacingReadyAt) {
        // Re-checked at the poll cadence rather than in one long sleep, so
        // the wait stays responsive to queue drops and clock control.
        this.scheduleAt(Math.min(spacingReadyAt, now + this.options.idlePollMs));
        return;
      }
      if (this.interruptQueue.length > 0) {
        this.deliverNow(this.interruptQueue.shift()!);
        continue;
      }
      const head = this.whenIdleQueue[0]!;
      const degradeAt = head.enqueuedAt + this.options.whenIdleDegradeMs;
      if (this.channelIdle()) {
        this.whenIdleQueue.shift();
        this.deliverNow(head);
        continue;
      }
      if (now >= degradeAt) {
        // The lull never came (no signal, or a signal that never reports
        // idle): the delivery interrupts rather than starving.
        this.logger.info('when_idle delivery degraded to interrupt after delay', {
          heldMs: now - head.enqueuedAt,
        });
        this.whenIdleQueue.shift();
        this.deliverNow(head);
        continue;
      }
      this.scheduleAt(Math.min(now + this.options.idlePollMs, degradeAt));
      return;
    }
  }

  private deliverNow(item: PendingDelivery): void {
    this.lastDeliveryAt = this.now();
    try {
      this.ports.deliverToTalker(wrapDeliveryForTalker(item.content), true);
    } catch (err) {
      // The content stays in the log (the durable record); the talker-side
      // failure is loop-owned territory (its deliver() never throws while
      // healthy, so this is teardown or a bug).
      this.logger.error('delivery to talker failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private channelIdle(): boolean {
    const signal = this.ports.idleSignal;
    if (signal) {
      try {
        return signal() === true;
      } catch (err) {
        this.logger.warn('idle signal threw; treating as not idle', {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    }
    return this.ports.talkerIdle();
  }

  private scheduleAt(at: number): void {
    if (this.destroyed) return;
    if (this.pumpTimer !== null) {
      if (at >= this.pumpTimerAt) return;
      clearTimeout(this.pumpTimer);
    }
    this.pumpTimerAt = at;
    const timer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, Math.max(0, at - this.now()));
    timer.unref?.();
    this.pumpTimer = timer;
  }

  private notifySettled(): void {
    if (this.settleWaiters.length === 0) return;
    const waiters = this.settleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private refillInterruptTokens(now: number): void {
    const capacity = this.options.interruptBucketCapacity;
    if (this.interruptTokens >= capacity) {
      this.lastTokenRefillAt = now;
      return;
    }
    const earned = Math.floor((now - this.lastTokenRefillAt) / this.options.interruptRefillMs);
    if (earned > 0) {
      this.interruptTokens = Math.min(capacity, this.interruptTokens + earned);
      this.lastTokenRefillAt += earned * this.options.interruptRefillMs;
    }
  }

  private pruneRecentHashes(now: number): void {
    const cutoff = now - this.options.deliveryDedupWindowMs;
    this.recentDeliveryHashes = this.recentDeliveryHashes.filter((entry) => entry.at >= cutoff);
  }

  // -------------------------------------------------------------------------
  // Watchdog (a working reasoner must be distinguishable from a hung one)
  // -------------------------------------------------------------------------

  private watchdogTick(): void {
    if (this.destroyed || !this.reasonerRunning) return;
    const now = this.now();
    if (now - this.lastReasonerOutputAt < this.options.watchdogIntervalMs) return;
    const elapsedS = Math.max(1, Math.round((now - this.reasonerRunStartAt) / 1000));
    const aliases = this.activeAliases();
    const text = aliases.length > 0
      ? `Background work (${aliases.join(', ')}) is still running, about ${elapsedS}s so far; no update from it yet.`
      : `Background work is still running, about ${elapsedS}s so far; no update from it yet.`;
    // Rides the normal intake (log entry, dedup, spacing); marks itself
    // synthetic and resets the silence clock through lastReasonerOutputAt.
    this.deliverFromReasoner(text, 'when_idle', { synthetic: true });
  }

  // -------------------------------------------------------------------------
  // Registry and state surfaces
  // -------------------------------------------------------------------------

  /** Snapshot of tracked delegations (copies). */
  getDelegations(): DelegationSnapshot[] {
    return [...this.delegations.values()].map((delegation) => ({ ...delegation }));
  }

  private activeAliases(): string[] {
    return [...this.delegations.values()]
      .filter((delegation) => !delegation.cancelled)
      .map((delegation) => delegation.alias);
  }

  private resolveDelegation(aliasName: string): DelegationSnapshot | undefined {
    const exact = this.delegations.get(aliasName);
    if (exact) return exact;
    const lower = aliasName.toLowerCase();
    for (const delegation of this.delegations.values()) {
      if (delegation.alias.toLowerCase() === lower) return delegation;
    }
    return undefined;
  }

  /** Number of buffered conversation deltas awaiting a dispatch flush. */
  get deltaBufferSize(): number {
    return this.deltaBuffer.length;
  }

  /**
   * Drop held talker-waking deliveries (abort scope 'conversation'/'all').
   * The delivery entries stay in the log: retained, not delivered.
   */
  dropPendingDeliveries(): number {
    const dropped = this.pendingDeliveryCount;
    this.interruptQueue = [];
    this.whenIdleQueue = [];
    this.notifySettled();
    return dropped;
  }

  /** Drop buffered conversation deltas (abort scope 'work'/'all'). */
  dropWorkContext(): number {
    const dropped = this.deltaBuffer.length;
    this.deltaBuffer = [];
    this.deltaBufferChars = 0;
    this.deltaOverflowed = false;
    return dropped;
  }

  /** Reset the router wholesale (facade restore()). */
  resetForRestore(): void {
    this.dropPendingDeliveries();
    this.dropWorkContext();
    this.delegations.clear();
    this.dispatchDedup.clear();
    this.recentDeliveryHashes = [];
    this.dispatchesThisTurn = 0;
    this.dispatchesThisExchange = 0;
    this.reasonerRunning = false;
    this.lastDeliveryAt = 0;
    this.interruptTokens = this.options.interruptBucketCapacity;
    this.lastTokenRefillAt = this.now();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.watchdogTimer);
    if (this.pumpTimer !== null) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    this.interruptQueue = [];
    this.whenIdleQueue = [];
    this.notifySettled();
  }

  // -------------------------------------------------------------------------
  // Dispatch internals
  // -------------------------------------------------------------------------

  /** Flush the conversation block and hand the dispatch to the reasoner. */
  private dispatch(directive: string, causeSeq: number | null): void {
    const message = composeDispatchMessage(this.consumeConversationBlock(), directive);
    try {
      this.ports.dispatchToReasoner(message, causeSeq);
    } catch (err) {
      // A dispatch that never reached the reasoner must not vanish
      // silently (F11): record it; the receipt already told the talker
      // something, and the entry keeps the audit trail truthful.
      this.logger.error('dispatch to reasoner failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.ports.appendLog({
        type: 'lifecycle',
        loopPath: this.reasonerLoopPath,
        content: 'Dispatch to the reasoner failed',
        data: {
          event: 'dispatch_failed',
          error: err instanceof Error ? err.message : String(err),
        },
        ...(causeSeq !== null ? { causedBy: causeSeq } : {}),
      });
    }
  }

  /**
   * Enforce the per-turn and per-exchange delegation caps. Returns the
   * refusal receipt when a cap is hit, null when the dispatch may proceed
   * (and counts it).
   */
  private applyDispatchCaps(tool: string): string | null {
    if (this.dispatchesThisTurn >= this.options.maxDispatchesPerTurn) {
      return this.refuseDispatch(tool, 'per-turn delegation cap',
        'Delegation limit reached for this turn; summarize for the user instead of dispatching more.');
    }
    if (this.dispatchesThisExchange >= this.options.maxDispatchesPerExchange) {
      return this.refuseDispatch(tool, 'per-exchange delegation cap',
        'Delegation limit reached for this exchange; wait for the user before dispatching more.');
    }
    this.dispatchesThisTurn += 1;
    this.dispatchesThisExchange += 1;
    return null;
  }

  /**
   * Record a refused or failed dispatch as a lifecycle entry (a user
   * instruction must never vanish silently, F11) and return the receipt.
   */
  private refuseDispatch(tool: string, reason: string, receipt: string): string {
    this.ports.appendLog({
      type: 'lifecycle',
      loopPath: this.talkerLoopPath,
      content: `Dispatch refused: ${tool} (${reason})`,
      data: { event: 'dispatch_refused', tool, reason },
      ...this.talkerCause(),
    });
    return receipt;
  }

  private consumeConversationBlock(): string | null {
    if (this.deltaBuffer.length === 0) return null;
    const deltas = this.deltaBuffer.splice(0);
    this.deltaBufferChars = 0;
    if (this.deltaOverflowed) {
      deltas.unshift({ speaker: 'consumer', text: DELTA_OVERFLOW_MARKER });
      this.deltaOverflowed = false;
    }
    return buildConversationBlock(deltas);
  }

  private pushDelta(delta: ConversationDelta): void {
    this.deltaBuffer.push(delta);
    this.deltaBufferChars += delta.text.length;
    while (
      this.deltaBufferChars > this.options.deltaBufferMaxChars &&
      this.deltaBuffer.length > 1
    ) {
      const removed = this.deltaBuffer.shift()!;
      this.deltaBufferChars -= removed.text.length;
      this.deltaOverflowed = true;
    }
  }

  private talkerCause(): { causedBy?: number } {
    const seq = this.ports.currentTalkerCauseSeq();
    return seq !== null ? { causedBy: seq } : {};
  }

  private reasonerCause(): { causedBy?: number } {
    const seq = this.ports.currentReasonerCauseSeq();
    return seq !== null ? { causedBy: seq } : {};
  }
}

/** Drop undefined values so spreads never clobber defaults with undefined. */
function pruneUndefined(
  options: DuplexRouterOptions | undefined,
): Partial<ResolvedOptions> {
  if (!options) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && key !== 'now') out[key] = value;
  }
  return out as Partial<ResolvedOptions>;
}
