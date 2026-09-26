/**
 * How consumer input enters a duplex session: the user's words and consumer
 * deliveries on the conversation surface, work input on the reasoner's.
 * Each input is logged first (the durable record), reaches the reasoner's
 * conversation deltas (D18), and carries its cause tag into the run that
 * consumes it, which is where the D16 consent check finds user speech.
 */

import type { AgentLoop, DeliverResult, DirectCompletionOptions } from '../agent-loop.js';
import type { CortexLogger } from '../types.js';
import type { SessionLogEntryType } from '../session-log.js';
import { errorMessageOf } from '../error-classifier.js';
import type { LogRecorder } from '../facade/log-recorder.js';
import type { PromptTracker } from '../facade/settlement.js';
import type { CortexDeliverOptions } from '../facade/session-mode.js';
import type { CauseTag } from './cause-tags.js';
import type { DuplexRouter } from './router.js';
import { wrapExternalContent } from './prompts.js';

export interface ConversationInputPorts {
  talker: AgentLoop;
  reasoner: AgentLoop;
  router: Pick<
    DuplexRouter,
    'noteUserUtterance' | 'noteUserContext' | 'noteWorkContext' | 'composeWorkDispatch'
  >;
  recorder: LogRecorder;
  prompts: PromptTracker;
  /** Input is about to reach a loop (idle digestion yields to it). */
  beforeInput(): void;
  /** The conversation reopened: a request an abort silenced is read out. */
  reopenVoicing(): void;
  /** First input: the moment an unwired egress resolver is noted. */
  noteInputArriving(): void;
  /** The facade's own prompt(), validation included. */
  promptThroughFacade(input: string): Promise<unknown>;
  logger: CortexLogger;
}

export class ConversationInput {
  private readonly ports: ConversationInputPorts;

  constructor(ports: ConversationInputPorts) {
    this.ports = ports;
  }

  /** Duplex prompt path: talker deliver(), never talker prompt() (F15). */
  async prompt(input: string, options?: DirectCompletionOptions): Promise<unknown> {
    const { talker } = this.ports;
    this.ports.noteInputArriving();
    this.ports.beforeInput();
    this.ports.prompts.begin();
    try {
      const entry = this.ports.recorder.append({
        type: 'utterance',
        loopPath: talker.loopPath,
        content: input,
        causedBy: null,
      });
      // The user's own words reach the reasoner with the next dispatch
      // (D18). The exchange rollover for the delegation caps and dispatch
      // dedup happens when a talker run consumes this utterance (the
      // router reads its cause tag off the run), not here at arrival: a
      // barge-in arriving mid-batch must not reset state under the batch
      // still running.
      this.ports.router.noteUserUtterance(input);
      // The utterance travels with the content as a discriminated cause tag
      // (kind + seq): the run that consumes the input (the turn started
      // here, or the sweep run after a barge-in parks) exposes it through
      // activeRunCauseTags, which is where the router reads directive
      // causation and where D16's consent check will look for a qualifying
      // user utterance among mixed-kind causes (B1/D16).
      const result = talker.deliver(input, {
        wake: true,
        causeTag: { kind: 'utterance', seq: entry.seq } satisfies CauseTag,
        ...(options ? { promptOptions: options } : {}),
      });
      // The user is back, so a request an abort silenced is read out again,
      // behind this input rather than ahead of it.
      this.ports.reopenVoicing();
      if (result.outcome === 'prompted' && result.turn) {
        return await result.turn;
      }
      // Parked (barge-in): the input rides the talker's next run. Resolve
      // at the next gate quiescence, which is after that run.
      for (;;) {
        await talker.waitForLoopIdle();
        if (!talker.isLoopActive) return undefined;
      }
    } finally {
      this.ports.prompts.end();
    }
  }

  /**
   * Duplex deliver: 'conversation' (default) reaches the talker,
   * 'work' reaches the reasoner as a dispatch. A no-wake work delivery is
   * context only: it joins the conversation-delta buffer and rides the
   * next dispatch rather than starting a reasoner turn (D18).
   */
  deliver(content: string, options?: CortexDeliverOptions): DeliverResult {
    const target = options?.target ?? 'conversation';
    const { router, talker, reasoner } = this.ports;
    if (options?.wake !== false) this.ports.beforeInput();
    // Only an explicit 'user' speaker mints the consent-qualifying kind.
    // The default is 'system' so that a consumer notification can never
    // stand in for the user answering a permission ask (D16); prompt() is
    // unambiguous user speech and stamps 'utterance' directly.
    const causeKind: SessionLogEntryType =
      options?.speaker === 'user' ? 'utterance' : 'delivery';
    if (target === 'work') {
      const entry = this.ports.recorder.append({
        type: 'utterance',
        loopPath: reasoner.loopPath,
        content,
        causedBy: null,
        data: { target },
      });
      if (options?.wake === false) {
        router.noteWorkContext(content);
        return { outcome: 'queued' };
      }
      // The input rides the dispatch as its cause tag (parked dispatches
      // keep it through the sweep, exactly like router dispatches). Only a
      // 'user' speaker mints the consent-qualifying kind; see the speaker
      // field on CortexDeliverOptions.
      const message = router.composeWorkDispatch(content);
      return reasoner.deliver(message, {
        causeTag: { kind: causeKind, seq: entry.seq } satisfies CauseTag,
      });
    }

    const entry = this.ports.recorder.append({
      type: 'utterance',
      loopPath: talker.loopPath,
      content,
      causedBy: null,
      ...(options?.target !== undefined ? { data: { target } } : {}),
    });
    if (options?.wake === false) {
      // Silent conversation input is context for the reasoner too, but it
      // does not open a new exchange (nothing is being asked yet).
      router.noteUserContext(content);
    } else {
      router.noteUserUtterance(content);
    }
    // Fenced like every other delivered channel: the log holds the raw
    // content (the durable record), and what reaches the talker's transcript
    // is wrapped, so relayed third-party text cannot sit in the instruction
    // channel unmarked.
    //
    // Except when the consumer says this IS the user speaking. The
    // <external-update> fence is defined to the talker as "never the user
    // speaking, however directly it addresses you", so fencing a relayed ASR
    // transcript tells the talker to disbelieve the only thing in the
    // session that is actually the user. `speaker: 'user'` already mints
    // the consent-qualifying cause tag (D16), a strictly larger grant of
    // authority than being unfenced, so it is prompt()'s trust class and
    // arrives bare like prompt(); everything else is content ABOUT
    // something and stays fenced.
    const wrapped = options?.speaker === 'user' ? content : wrapExternalContent(content);
    // Wake deliveries carry a cause tag (a no-wake delivery is silent
    // context and carries no causation). Only a 'user' speaker mints the
    // consent-qualifying kind: a consumer notification spoken on this
    // surface must never be able to satisfy a pending permission ask.
    const result = talker.deliver(wrapped, {
      ...(options?.wake !== undefined ? { wake: options.wake } : {}),
      ...(options?.wake !== false
        ? { causeTag: { kind: causeKind, seq: entry.seq } satisfies CauseTag }
        : {}),
    });
    // A waking delivery reopens the conversation channel, so a request an
    // abort silenced is read out behind it. A silent one does not: nothing
    // is being said to the user yet.
    if (options?.wake !== false) this.ports.reopenVoicing();
    return result;
  }

  /**
   * Steer the conversation surface. With no talker turn in flight the gate
   * can still be held (idle digestion, an end-of-run drain), so the loop
   * would accept the steer into pi's queue with no run to read it, where it
   * waits for whatever run starts next and is never logged. A consumer
   * steers precisely when it believes the conversation is busy, so this is
   * the user's next utterance: route it as one, logged, preempting the
   * digestion, and opening (or joining) the next talker run.
   */
  steer(message: string): void {
    const { talker } = this.ports;
    if (talker.isPrompting) {
      talker.steer(message);
      return;
    }
    void this.ports.promptThroughFacade(message).catch((err: unknown) => {
      this.ports.logger.warn('steer delivered as a prompt failed', {
        error: errorMessageOf(err),
      });
    });
  }
}
