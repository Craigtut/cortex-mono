/**
 * CompositeState: capturing and applying the persisted artifact
 * (persisted-state.ts) across every owner of session state, each in one
 * synchronous frame and in the order restore depends on, plus the composite
 * usage those owners' counters add up to.
 */

import type { LoopDeliveryApi, LoopEventApi } from '../agent-loop.js';
import type { SessionUsage } from '../types.js';
import type { LoopTopology } from './loop-surface.js';
import type { LogRecorder } from './log-recorder.js';
import type { SessionMode } from './session-mode.js';
import { normalizePersistedState, persistedMode } from './persisted-state.js';
import type { CortexAgentPersistedState, CortexAgentStateV2 } from './persisted-state.js';
import { handOverPendingConversation } from './cross-mode-restore.js';
import type { ModeCrossingRestore } from './cross-mode-restore.js';
import type { CortexAgentMode } from './config.js';
import { CompositeUsage } from './composite-usage.js';
import type { UsageReadings } from './composite-usage.js';

export class CompositeState {
  private readonly topology: LoopTopology;
  private readonly recorder: LogRecorder;
  private readonly session: () => SessionMode;
  private readonly usage = new CompositeUsage();

  constructor(parts: { topology: LoopTopology; recorder: LogRecorder; session: () => SessionMode }) {
    this.topology = parts.topology;
    this.recorder = parts.recorder;
    this.session = parts.session;
  }

  /**
   * The composite session usage: every loop and settled quick lookups
   * (children counted once via each loop's own accounting), under the
   * baseline-plus-delta restore model.
   */
  totalUsage(): SessionUsage {
    return this.usage.total(this.usageReadings());
  }

  /** The artifact, read in one frame; the caller guarantees gate quiescence. */
  capture(): CortexAgentStateV2 {
    const { work } = this.topology;
    // Duplex reads the live talker; passthrough carries a restored duplex
    // artifact's talker side and router state through unchanged, so
    // nothing is lost on round trip.
    const session = this.session().captureState();
    const talkerQueued = session.talkerQueuedDeliveries ?? [];
    const reasonerQueued = work.getQueuedDeliveries();
    return {
      version: 2,
      mode: this.mode(),
      log: this.recorder.log.getLog(),
      talkerHistory: session.talkerHistory,
      reasonerHistory: work.getConversationHistory(),
      talkerMemory: session.talkerMemory,
      reasonerMemory: work.getObservationalMemoryState(),
      usage: this.usage.breakdown(this.usageReadings()),
      ...(session.router ? { router: session.router } : {}),
      ...(talkerQueued.length > 0 || reasonerQueued.length > 0
        ? { queuedDeliveries: { talker: talkerQueued, reasoner: reasonerQueued } }
        : {}),
    };
  }

  /**
   * Apply an artifact, all or nothing: the caller has checked nothing is
   * running, and there is no await in here, so it lands in one frame.
   * Returns what crossed a mode boundary, for the caller to report.
   */
  apply(state: CortexAgentPersistedState): ModeCrossingRestore {
    const session = this.session();
    const { work } = this.topology;
    const v2 = normalizePersistedState(state);

    // Deep copies: the caller's artifact stays the caller's (a later
    // in-place mutation of it must never reach live state). Taken before
    // the first mutation below: structuredClone throws on proxies and
    // functions (a reactive-store artifact hands it exactly that), and a
    // clone failure must reject the restore with nothing touched, never
    // half-applied.
    const talkerHistory = structuredClone(v2.talkerHistory);
    const talkerMemory = structuredClone(v2.talkerMemory);
    const routerState = v2.router ? structuredClone(v2.router) : undefined;
    const queued = structuredClone(v2.queuedDeliveries);

    // History before observational state (restore ordering), per loop.
    work.restoreConversationHistory(v2.reasonerHistory);
    if (v2.reasonerMemory) {
      work.restoreObservationalMemoryState(v2.reasonerMemory);
    }
    session.hydrate({ talkerHistory, talkerMemory });
    this.recorder.log.restore(v2.log);

    this.usage.rebase(v2.usage, this.usageReadings());
    this.recorder.resetForRestore();
    // Pre-restore queued content belongs to the replaced session: left in
    // place, queued silent deliveries would flush into the first
    // post-restore prompt (and stale steer/follow-up content into its run).
    // What gets destroyed is recorded in the restored log, which is the
    // durable record of undelivered content from here on.
    this.recorder.recordDroppedQueue(work, 'restore', work.clearAllQueues());
    // The artifact's own queued content is the restored session's.
    requeueSilent(work, queued?.reasoner, this.recorder);
    // A duplex artifact in a passthrough agent: the single loop takes the
    // conversation the reasoner had not seen yet (cross-mode-restore.ts).
    const artifactMode = persistedMode(v2);
    const agentMode = this.mode();
    const handOver = artifactMode === 'duplex' && agentMode === 'passthrough'
      ? handOverPendingConversation(routerState, work)
      : { router: routerState, handedOver: 0 };
    // Everything the mode holds describes the replaced session too; what
    // the artifact carries of the router's state and the talker's queue
    // comes back (passthrough carries both through untouched).
    session.resetForRestore({
      ...(handOver.router ? { router: handOver.router } : {}),
      ...(Array.isArray(queued?.talker) ? { talkerQueuedDeliveries: queued.talker } : {}),
    });
    return {
      artifactMode,
      agentMode,
      conversationLinesHandedOver: handOver.handedOver,
      talkerHistoryLength: talkerHistory.length,
      resultsNotRelayed: Array.isArray(routerState?.pendingDeliveries) ? routerState.pendingDeliveries.length : 0,
    };
  }

  private mode(): CortexAgentMode {
    return this.topology.conversation !== this.topology.work ? 'duplex' : 'passthrough';
  }

  /** Each usage producer's live reading, for the ledger. */
  private usageReadings(): UsageReadings {
    const { work, conversation } = this.topology;
    return {
      reasoner: work.getSessionUsage(),
      talker: conversation !== work ? conversation.getSessionUsage() : null,
      lookups: this.session().lookupUsage(),
    };
  }
}

/**
 * Queue restored silent content on a loop again, oldest first. Best effort
 * per item: content the loop refuses (a malformed artifact entry, a loop
 * with no base prompt yet) is recorded as dropped by the restore rather
 * than failing a restore that has already applied everything else.
 */
export function requeueSilent(
  loop: LoopDeliveryApi & Pick<LoopEventApi, 'loopPath'>,
  contents: unknown,
  recorder: LogRecorder,
): void {
  if (!Array.isArray(contents)) return;
  const refused: string[] = [];
  for (const content of contents) {
    if (typeof content !== 'string') continue;
    try {
      loop.deliver(content, { wake: false });
    } catch {
      refused.push(content);
    }
  }
  recorder.recordDroppedQueue(loop, 'restore', refused);
}
