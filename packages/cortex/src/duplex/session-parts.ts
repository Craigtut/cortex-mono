/**
 * The duplex subsystem over an assembled loop pair: every part a duplex
 * session is made of, constructed with the ports that connect it to the
 * others, and wired to the loops in one explicit, ordered pass.
 *
 * Handler registration order is semantics here, not style: on a shared
 * event the handler registered first runs first, so wire() states the order
 * outright (the reply entry before its conversation delta, a dead-letter
 * entry before the broker's recovery, an error entry before the delivery
 * announcing it, run outcomes before the headline run end before
 * digestion). duplex-session-wiring.test.ts pins the observable ones.
 */

import { AgentLoop } from '../agent-loop.js';
import { errorMessageOf } from '../error-classifier.js';
import { routerOptionsFrom } from '../facade/config.js';
import type { ResolvedCortexAgentConfig } from '../facade/config.js';
import type { FacadeServices } from '../facade/session-mode.js';
import type { CausationSource } from './cause-tags.js';
import { DuplexRouter } from './router.js';
import { DUPLEX_ROUTER_DEFAULTS } from './router-contract.js';
import { PermissionBroker } from './permission-broker.js';
import { DuplexHeadlines } from './headlines.js';
import { stripAskFence } from './ask-fence.js';
import { buildControlTools } from './control-tools.js';
import { buildDeliverTool, buildSteerSubAgentTool } from './reasoner-tools.js';
import { QuickLookupManager } from './quick-lookups.js';
import type { QuickLookupOutcome } from './quick-lookups.js';
import { buildQuickLookupConfig, TALKER_HEADLINE_MAX_TOKENS } from './assembly.js';
import { TalkerGuards } from './talker-guards.js';
import { ConversationInput } from './conversation-input.js';
import { MergedEvents } from './merged-events.js';
import { IdleDigestion } from './idle-digestion.js';
import { AggregateBudget } from './aggregate-budget.js';
import { ReasonerDispatcher } from './reasoner-dispatch.js';
import { ReasonerOutcomeReporter } from './reasoner-outcomes.js';
import { ReasonerRunTracker } from './reasoner-run.js';
import { LivenessWatchdog } from './watchdog.js';

export interface DuplexParts {
  readonly router: DuplexRouter;
  /** The consent boundary for every permission ask in the session (D16). */
  readonly broker: PermissionBroker;
  /** The facade-owned quick-lookup fleet (D13). */
  readonly lookups: QuickLookupManager;
  readonly headlines: DuplexHeadlines;
  /** The single owner of "is the reasoner running, and since when". */
  readonly run: ReasonerRunTracker;
  readonly outcomes: ReasonerOutcomeReporter;
  readonly watchdog: LivenessWatchdog;
  readonly digestion: IdleDigestion;
  readonly dispatcher: ReasonerDispatcher;
  readonly input: ConversationInput;
  readonly guards: TalkerGuards;
  readonly merged: MergedEvents;
  readonly aggregate: AggregateBudget;
}

/** Build every part, then wire them to the loops in order. */
export function assembleSessionParts(
  loops: { reasoner: AgentLoop; talker: AgentLoop },
  config: ResolvedCortexAgentConfig,
  services: FacadeServices,
  causation: CausationSource,
): DuplexParts {
  const { reasoner, talker } = loops;
  const { recorder, logger } = services;
  const destroyed = (): boolean => services.destroyed();
  const routerOptions = routerOptionsFrom(config.duplex);
  // Parts refer to each other only through closures, so every part exists
  // by the time any port is called.
  const parts = {} as { -readonly [K in keyof DuplexParts]: DuplexParts[K] };

  // Ephemeral read-only loops on the talker's fast model, spawned on the
  // talker's behalf, with their own small pool.
  parts.lookups = new QuickLookupManager(
    {
      createLoop: async (alias) => {
        const loop = await AgentLoop.create(buildQuickLookupConfig(config, talker.getModel(), alias));
        return { loop, cleanup: parts.merged.forwardLookup(loop) };
      },
      onOutcome: (outcome) => handleLookupOutcome(outcome),
      logger,
    },
    {
      maxConcurrent: config.duplex?.maxConcurrentLookups,
      timeoutMs: config.duplex?.lookupTimeoutMs,
    },
  );
  parts.digestion = new IdleDigestion(
    {
      talker,
      reasoner,
      quiet: () => services.conversationIdle() && parts.router.pendingDeliveryCount === 0,
      destroyed,
      logger,
    },
    config.duplex?.idleDigestionDelayMs ?? 10_000,
  );
  parts.dispatcher = new ReasonerDispatcher({
    reasoner,
    append: (input) => recorder.append(input),
    beforeInput: () => parts.digestion.preempt(),
    cancelAbortStarting: () => parts.outcomes.expectAbort('cancel'),
    cancelAbortFinished: () => parts.outcomes.abortUnwound('cancel'),
    destroyed,
    logger,
  });
  parts.broker = new PermissionBroker(
    {
      appendLog: (input) => recorder.appendAttributed(input),
      // The reserved ask lane: a real wake delivery carrying the ask-kind
      // cause tag, so the run that voices the request is identifiable to
      // the consent check (an answer from that same run cannot bind). No
      // token bucket, no dedup, no queues; it stamps the delivery spacing
      // clock so queued ordinary deliveries hold off behind a fresh ask
      // instead of talking over it.
      voiceToTalker: (content, causeTag) => {
        parts.router.stampReservedLane();
        parts.digestion.preempt();
        return talker.deliver(content, { wake: true, causeTag }).deliveryId;
      },
      currentTalkerCauseTags: () => causation.tags('conversation'),
      talkerLoopPath: talker.loopPath,
      dropParkedDeliveries: (matches) =>
        talker.dropPendingWakeDeliveries((_content, delivery) => matches(delivery.id)),
      logger,
    },
    {
      askTimeoutMs: routerOptions.askTimeoutMs,
      escalationAskTimeoutMs: routerOptions.escalationAskTimeoutMs,
      settleVoiceDelayMs: routerOptions.settleVoiceDelayMs,
    },
  );
  parts.router = new DuplexRouter(
    {
      deliverToTalker: (content, wake) => {
        if (wake) parts.digestion.preempt();
        talker.deliver(content, { wake });
      },
      talkerIdle: () => !talker.isLoopActive,
      spawnLookup: (question, causeSeq) => parts.lookups.request(question, causeSeq),
      dispatchToReasoner: (message, causeSeq, options) =>
        parts.dispatcher.dispatch(message, causeSeq, options),
      appendLog: (input) => recorder.appendAttributed(input),
      currentTalkerCauseTags: () => causation.tags('conversation'),
      currentReasonerCauseTags: () => causation.tags('work'),
      answerAsk: (askId, decision, reason) => parts.broker.answer(askId, decision, reason),
      reasonerAttemptKey: () => parts.run.attemptKey(),
      workRefusal: () => parts.aggregate.workRefusal(),
      idleSignal: config.idleSignal,
      logger,
      talkerLoopPath: talker.loopPath,
      reasonerLoopPath: reasoner.loopPath,
    },
    routerOptions,
  );
  parts.run = new ReasonerRunTracker(reasoner);
  parts.headlines = new DuplexHeadlines({
    reasonerRun: parts.run,
    reasonerUsage: () => reasoner.getSessionUsage(),
    activeSubAgents: () => reasoner.getActiveSubAgents(),
    delegations: () => parts.router.getDelegations(),
    // The BROKER, not the facade's merged consumer view: it holds every
    // ask (tool, escalation, network), and its consent anchor, not the
    // sticky `voiced` flag, says whether one could have been heard.
    pendingAsks: () => parts.broker.getPendingAsks(),
  });
  parts.outcomes = new ReasonerOutcomeReporter({
    reasoner,
    runId: () => parts.run.runId(),
    router: parts.router,
    headlines: parts.headlines,
    aggregateBreached: () => parts.aggregate.guard.isBreached(),
    destroyed,
    now: Date.now,
  });
  parts.watchdog = new LivenessWatchdog(
    {
      runStartedAt: () => parts.run.attempt()?.startedAt ?? null,
      lastOutputAt: () => parts.outcomes.lastOutputAt(),
      activeAliases: () => parts.router.activeAliases(),
      pendingAsks: () => parts.broker.getPendingAsks(),
      reportProgress: (text) => parts.outcomes.reportProgress(text),
    },
    {
      intervalMs: routerOptions.watchdogIntervalMs ?? DUPLEX_ROUTER_DEFAULTS.watchdogIntervalMs,
      now: Date.now,
    },
  );
  parts.input = new ConversationInput({
    talker,
    reasoner,
    router: parts.router,
    recorder,
    prompts: services.prompts,
    beforeInput: () => parts.digestion.preempt(),
    reopenVoicing: () => parts.broker.reopenVoicing(),
    noteInputArriving: () => services.noteInputArriving(),
    promptThroughFacade: (text) => services.prompt(text),
    logger,
  });
  parts.guards = new TalkerGuards(logger);
  wire(loops, parts, services);
  // The merged stream forwards through catch-all listeners, which a bridge
  // runs after every typed handler: consumers see an event only once the
  // session has handled it, whatever the registration order.
  parts.merged = new MergedEvents(talker, reasoner, logger);
  parts.aggregate = new AggregateBudget(config.duplex?.maxTotalCost, parts.merged.bridge, {
    append: (input) => recorder.append(input),
    stopAllWork: () => stopAllWork(),
    retireAllDelegations: () => parts.router.retireAllDelegations(),
    announce: (text) => {
      parts.outcomes.notify(text, 'interrupt', { synthetic: true, terminal: true });
    },
    destroyed,
    workLoopPath: reasoner.loopPath,
    logger,
  });
  return parts;

  /**
   * A quick lookup settled. Non-cancelled outcomes (including timeouts and
   * failures, which must be visible) route through the router: durable
   * lookup_result entry, talker wake, reasoner delta. Cancelled lookups
   * were stopped on purpose (abort, restore, teardown): logged, never
   * delivered.
   */
  function handleLookupOutcome(outcome: QuickLookupOutcome): void {
    if (outcome.status === 'cancelled') {
      if (destroyed()) return;
      recorder.append({
        type: 'lifecycle',
        loopPath: `lookup/${outcome.alias}`,
        content: `Quick lookup ${outcome.alias} cancelled`,
        data: {
          event: 'lookup_cancelled',
          alias: outcome.alias,
          question: outcome.question,
        },
        causedBy: outcome.causeSeq,
      });
      return;
    }
    parts.router.deliverLookupResult(outcome);
    services.markStateDirty();
  }

  /** Stop every piece of running work (the aggregate budget tripped). */
  function stopAllWork(): Promise<unknown> {
    const swallow = (err: unknown): void => {
      logger.warn('budget-breach abort failed', {
        error: errorMessageOf(err),
      });
    };
    const stops: Array<Promise<unknown>> = [];
    stops.push(talker.abort().catch(swallow));
    stops.push(reasoner.abort().catch(swallow));
    for (const taskId of reasoner.getSubAgentManager().getActiveTaskIds()) {
      stops.push(reasoner.cancelSubAgent(taskId).catch(swallow));
    }
    stops.push(parts.lookups.cancelAll().catch(swallow));
    return Promise.all(stops);
  }
}

/** Every handler the session installs, in the order they must run. */
function wire(
  loops: { reasoner: AgentLoop; talker: AgentLoop },
  parts: Omit<DuplexParts, 'merged' | 'aggregate'>,
  services: FacadeServices,
): void {
  const { talker, reasoner } = loops;
  const { router, headlines, outcomes, run, digestion, broker } = parts;
  const { recorder } = services;

  // The talker carries exactly the control toolset (D5/D8); the reasoner
  // gains Deliver (F1), which reports through the outcome reporter, and
  // SteerSubAgent (D12).
  for (const tool of buildControlTools(router)) {
    talker.addConsumerTool(tool);
  }
  reasoner.addConsumerTool(buildDeliverTool(outcomes));
  reasoner.addConsumerTool(buildSteerSubAgentTool(reasoner));

  // Conversation-side log producers and delta capture.
  recorder.wireConversation(talker, (text) => {
    // The reply entry keeps the raw text on purpose: it is the audit trail
    // and has to record what the talker actually said. Only the
    // reasoner-bound copy is sanitized, so a talker that quotes a
    // permission marker cannot carry the fence nonce to the loop that
    // authors the fenced content.
    router.noteTalkerReply(stripAskFence(text));
  });
  recorder.wireErrors(talker);
  recorder.wireErrors(reasoner);
  recorder.wireWork(reasoner);
  // The talker has no background completions, but its parked wake
  // deliveries (user utterances among them) can dead-letter after repeated
  // failed carrying runs; those drops must reach the log.
  recorder.wireDeadLetters(talker, (result) => {
    // A destroyed wake delivery on the conversation surface may be a
    // permission voicing, in which case the user never heard the request
    // the broker still counts as read out: it withdraws the consent anchor
    // and reads it again (D16 anchor rules).
    if (result.kind === 'wake_delivery') {
      broker.noteDeliveryDestroyed(result.deliveryId);
    }
  });

  // The headline block (communication.md): live status per loop and
  // running sub-agent, view-injected into the talker every turn outside
  // BP3, hard token cap with truncation. Session state, never log entries.
  talker.setHeadlineProvider(() => headlines.build(), {
    maxTokens: TALKER_HEADLINE_MAX_TOKENS,
  });
  // After the error log producers: a failure's error entry lands before
  // the delivery that announces it.
  outcomes.wireFailureSurfacing();

  // Attempt boundaries, in the order they must run: the outcome (an
  // implicit result or a failure notice) before the headline clears the
  // attempt's lines, and both before digestion is scheduled.
  run.onAttemptStart(() => outcomes.noteAttemptStart());
  run.onAttemptEnd((event) => outcomes.noteAttemptEnd(event));
  headlines.attach(reasoner.getEventBridge(), run);
  run.onAttemptEnd(() => digestion.schedule());
  const talkerBridge = talker.getEventBridge();
  talkerBridge.on('turn_end', (event) => {
    if (event.childTaskId) return;
    router.noteTalkerTurnEnd();
  });
  // D17 terminate guards and the stop-reason audit, after the turn-end
  // dispatch bookkeeping above.
  parts.guards.attach(talker);
  talkerBridge.on('loop_end', (event) => {
    if (event.childTaskId) return;
    digestion.schedule();
  });
}
