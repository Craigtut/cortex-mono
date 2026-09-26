/**
 * Hands one line of user input to the agent: steered into a conversation
 * that is already mid-turn, or started as a fresh turn.
 */

import type { CortexAgent } from '@animus-labs/cortex';
import type { FileSessionActivityReporter } from '../activity/session-activity.js';
import type { TranscriptWriter } from '../persistence/transcript-writer.js';
import type { TitleManager } from '../terminal/title-manager.js';
import type { App } from '../tui/app.js';
import { randomThinkingLabel } from '../tui/spinner.js';
import { log } from '../logger.js';
import type { RetryStatusLine } from './retry-status.js';
import type { SessionStatusView } from './status-view.js';
import type { WorkTracker } from './work-tracker.js';

export type TurnAgent = Pick<CortexAgent, 'conversationIdle' | 'steer' | 'prompt' | 'state'>;

export interface TurnRunnerDeps {
  getAgent: () => TurnAgent | null;
  getApp: () => Pick<App, 'transcript' | 'showStatusSpinner'> | null;
  getTitleManager: () => Pick<TitleManager, 'recordUserPrompt'> | null;
  activity: Pick<FileSessionActivityReporter, 'recordWorking' | 'recordError'>;
  transcriptWriter: Pick<TranscriptWriter, 'addUserMessage'>;
  retry: Pick<RetryStatusLine, 'clear'>;
  status: Pick<SessionStatusView, 'refreshEnvironment'>;
  work: Pick<WorkTracker, 'promptInFlight' | 'beginPrompt' | 'endPrompt' | 'watchForSettled'>;
  /** Runs the pre_turn hooks and returns the prompt the agent should see. */
  applyPreTurnHooks: (text: string) => Promise<string>;
}

export class TurnRunner {
  /**
   * True once the onError handler has surfaced the current turn's failure. The
   * agent framework both emits an error (via onError) and re-throws it out of
   * prompt(); without this guard the prompt() catch would render the same
   * failure a second time as a generic "Error". Reset at the start of each turn.
   */
  private lastTurnErrorHandled = false;
  private readonly getAgent: TurnRunnerDeps['getAgent'];
  private readonly getApp: TurnRunnerDeps['getApp'];
  private readonly getTitleManager: TurnRunnerDeps['getTitleManager'];
  private readonly activity: TurnRunnerDeps['activity'];
  private readonly transcriptWriter: TurnRunnerDeps['transcriptWriter'];
  private readonly retry: TurnRunnerDeps['retry'];
  private readonly status: TurnRunnerDeps['status'];
  private readonly work: TurnRunnerDeps['work'];
  private readonly applyPreTurnHooks: TurnRunnerDeps['applyPreTurnHooks'];

  constructor(deps: TurnRunnerDeps) {
    this.getAgent = deps.getAgent;
    this.getApp = deps.getApp;
    this.getTitleManager = deps.getTitleManager;
    this.activity = deps.activity;
    this.transcriptWriter = deps.transcriptWriter;
    this.retry = deps.retry;
    this.status = deps.status;
    this.work = deps.work;
    this.applyPreTurnHooks = deps.applyPreTurnHooks;
  }

  /** The onError handler has shown this turn's failure; do not show it again. */
  markErrorHandled(): void {
    this.lastTurnErrorHandled = true;
  }

  async submit(text: string): Promise<void> {
    const agent = this.getAgent();
    const app = this.getApp();
    if (!agent || !app) return;

    // If the CONVERSATION is already mid-turn, steer it with the new
    // message. Deliberately narrower than isRunning: under duplex the
    // reasoner can be minutes into a task while the talker is free, and the
    // user's next sentence belongs to the talker as a fresh prompt, not
    // steered into a loop that is not listening for it.
    if (this.work.promptInFlight || !agent.conversationIdle) {
      log.info('Steering agent with user message', { text: text.slice(0, 100) });
      void this.activity.recordWorking();
      app.transcript.addUserMessage(text);
      this.transcriptWriter.addUserMessage(text);
      this.getTitleManager()?.recordUserPrompt(text);
      agent.steer(text);
      return;
    }

    log.info('User prompt', { text: text.slice(0, 100) });

    // A fresh turn supersedes any terminal "gave up, send a message" retry line.
    this.retry.clear();

    // Add user message to transcript
    app.transcript.addUserMessage(text);
    this.transcriptWriter.addUserMessage(text);
    this.getTitleManager()?.recordUserPrompt(text);

    // Update ephemeral context
    await this.status.refreshEnvironment();

    // Show spinner
    app.showStatusSpinner(randomThinkingLabel());
    this.work.beginPrompt();
    await this.activity.recordWorking();

    // Run pre_turn hooks: outside processes can inject context the agent
    // should see before this turn (e.g. inter-agent message notifications).
    // Failures inside individual handlers are logged but do not block the
    // turn.
    const promptForAgent = await this.applyPreTurnHooks(text);

    this.lastTurnErrorHandled = false;
    try {
      await agent.prompt(promptForAgent);
    } catch (err) {
      log.error('Prompt error', { error: err instanceof Error ? err.message : String(err) });
      void this.activity.recordError(err instanceof Error ? err : String(err));
      // Classified errors are already surfaced by the onError handler, which
      // both emits and lets the error re-throw here. Only handle throws it did
      // NOT show: stream interruptions and truly-unexpected errors. Shutdown
      // (destroying/destroyed) rejects a pending prompt with a lifecycle
      // error that must not surface as an error toast.
      const agentState = this.getAgent()?.state;
      if (
        agentState !== 'destroyed' &&
        agentState !== 'destroying' &&
        !this.lastTurnErrorHandled
      ) {
        const message = err instanceof Error ? err.message : String(err);
        // Check if this is a stream interruption (partial response already displayed)
        if (message.includes('stream') || message.includes('aborted') || message.includes('interrupted')) {
          app.transcript.appendAssistantChunk('\n\n[response interrupted]');
          app.transcript.finalizeAssistantMessage();
        } else {
          app.transcript.addNotification('Error', message, { severity: 'error' });
        }
      }
    } finally {
      this.work.endPrompt();
      // The turn is NOT necessarily over: under duplex prompt() resolves
      // when the talker has spoken, with the reasoner still working. Hand
      // the "we are done" UI to the settlement watcher, which reads the
      // whole agent rather than the loop that happened to finish first.
      this.work.watchForSettled();
    }
  }
}
