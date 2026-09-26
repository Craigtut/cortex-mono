/**
 * ResolutionRecorder: what this assembly resolved to where it differs from
 * what was asked for (resolution-report.ts), and the single write path that
 * keeps its three surfaces (the report, the warn, the lifecycle entry) from
 * drifting.
 *
 * Computed once at construction, plus the one condition that cannot be
 * known then (the unwired egress resolver) and the model notes the facade
 * re-resolves itself (setModel swapping the loops' models).
 */

import type { CortexLogger } from '../types.js';
import {
  cloneResolutionNote,
  collectAssemblyResolutionNotes,
  networkResolverUnwiredNote,
  resolutionWarnText,
  restoreModeMismatchNote,
} from '../resolution-report.js';
import type {
  AssemblyResolution,
  ResolutionNote,
  ResolutionNoteCode,
} from '../resolution-report.js';
import type { LogEntryInput } from './log-recorder.js';
import type { LoopTopology } from './loop-surface.js';
import type { ResolvedCortexAgentConfig } from './config.js';
import { redecideForLoop } from './mode-resolution.js';
import type { ModeResolution } from './mode-resolution.js';
import type { ModeCrossingRestore } from './cross-mode-restore.js';
import type { BudgetGuard } from '../budget-guard.js';

/**
 * Producer identity on a resolution note's lifecycle entry. Not a loop: the
 * facade resolved the configuration, and attributing it to the reasoner or
 * the talker would claim a loop said something about its own assembly.
 */
const RESOLUTION_LOOP_PATH = 'facade';

/**
 * Notes read off the loops' models, re-evaluated when the facade itself
 * changes them (setModel).
 */
const MODEL_RESOLUTION_NOTE_CODES: ReadonlySet<ResolutionNoteCode> = new Set<ResolutionNoteCode>([
  'talker-model-fallback',
  'talker-utility-model-skipped',
  'duplex-not-concurrent',
  'mode-resolved-passthrough',
]);

export interface ResolutionRecorderOptions {
  /** Reads the assembly as it is at the moment of the call. */
  observe: () => AssemblyResolution;
  /**
   * Whether this agent brokered an egress resolver a sandbox should be
   * wired to (duplex, with a sandbox and a network resolver configured).
   */
  brokeredEgressResolver: boolean;
  append: (input: LogEntryInput) => void;
  logger: CortexLogger;
}

export class ResolutionRecorder {
  private readonly options: ResolutionRecorderOptions;
  private readonly notes: ResolutionNote[] = [];
  /** Whether anyone took the resolver to wire into a sandbox. */
  private networkResolverHandedOut = false;
  private unwiredNetworkResolverWarned = false;

  constructor(options: ResolutionRecorderOptions) {
    this.options = options;
  }

  /**
   * The recorder for one facade assembly: the consumer's requests read from
   * its config, the resolution read off the loops (and the session guard)
   * as they are at the moment of reading.
   */
  static forAssembly(parts: {
    config: ResolvedCortexAgentConfig;
    modeResolution: ModeResolution;
    topology: LoopTopology;
    aggregateGuard: () => BudgetGuard | null;
    append: (input: LogEntryInput) => void;
    logger: CortexLogger;
  }): ResolutionRecorder {
    const { config, topology } = parts;
    const talker = topology.conversation !== topology.work ? topology.conversation : null;
    return new ResolutionRecorder({
      observe: () => ({
        mode: talker ? 'duplex' : 'passthrough',
        // Passthrough re-reads the decision against the model it holds now,
        // so the note explaining the mode follows a setModel(). Duplex has
        // no note that reads the decision.
        modeResolution: talker ? parts.modeResolution : redecideForLoop(config, topology.work),
        requestedTalkerModel: config.talker?.model,
        talkerModel: talker?.getModel() ?? null,
        reasonerModel: topology.work.getModel(),
        configuredUtilityModel: config.utilityModel,
        talkerUtilityModel: talker?.getUtilityModel() ?? null,
        aggregateCostCap: parts.aggregateGuard()?.getMaxCost() ?? null,
        perPromptMaxCost: config.budgetGuard?.maxCost,
      }),
      brokeredEgressResolver: talker !== null
        && config.sandbox !== undefined
        && config.resolveNetworkAccess !== undefined,
      append: parts.append,
      logger: parts.logger,
    });
  }

  /** A snapshot copy of the notes (see CortexAgent.getResolutionReport). */
  report(): ResolutionNote[] {
    return this.notes.map(cloneResolutionNote);
  }

  /**
   * Read the assembly back and record what it resolved to. Eager rather than
   * lazy on first read: a report built on demand would observe post-assembly
   * mutation (a setModel(), a setUtilityModel()) and present it as an
   * assembly fact, and would also mean the log entries appeared whenever the
   * consumer happened to look.
   */
  collectAssembly(): void {
    for (const note of this.currentNotes()) this.record(note);
  }

  /**
   * Re-evaluate the notes that describe the loops' models after the facade
   * changed them (setModel swaps the reasoner's and re-mirrors an unpinned
   * talker). The mode itself is not re-decided: loops are assembled from it,
   * so a switch that leaves both loops on one serial backend earns a
   * duplex-not-concurrent note
   * rather than a mode change, and a passthrough agent stays passthrough
   * (decisions.md D21). This is not the
   * lazy report the eager design rules out: the facade itself just redid
   * part of the assembly, so the model notes are assembly facts again, and
   * leaving them would report a fallback that no longer exists or miss one
   * that now does (switching onto a provider Cortex cannot enumerate).
   * Mutation the facade did not make (a direct loop setModel) still changes
   * nothing here. A note that stops applying is removed from the report and
   * its clearing is logged, so the log still explains the report.
   */
  refreshModelNotes(): void {
    const fresh = this.currentNotes()
      .filter((note) => MODEL_RESOLUTION_NOTE_CODES.has(note.code));
    for (const code of MODEL_RESOLUTION_NOTE_CODES) {
      const index = this.notes.findIndex((note) => note.code === code);
      const current = index >= 0 ? this.notes[index]! : null;
      const next = fresh.find((note) => note.code === code) ?? null;
      if (current && next && JSON.stringify(current) === JSON.stringify(next)) continue;
      if (current) {
        this.notes.splice(index, 1);
        if (!next) {
          this.options.append({
            type: 'lifecycle',
            loopPath: RESOLUTION_LOOP_PATH,
            content: `Resolution note cleared: ${code}`,
            causedBy: null,
            data: { event: 'resolution_note_cleared', code },
          });
        }
      }
      if (next) this.record(next);
    }
  }

  /**
   * Record what a restore carried across a mode boundary, replacing the
   * previous restore's note. Called after the log is restored, so the
   * lifecycle entry lands in the log the restored session continues; no
   * cleared entry is written for the old note, whose own entry went with
   * the log it was in.
   */
  recordRestore(restore: ModeCrossingRestore): void {
    const index = this.notes.findIndex((note) => note.code === 'restore-mode-mismatch');
    if (index >= 0) this.notes.splice(index, 1);
    if (restore.artifactMode !== restore.agentMode) this.record(restoreModeMismatchNote(restore));
  }

  /** Someone took the egress resolver to wire into a sandbox. */
  handOutNetworkResolver(): void {
    this.networkResolverHandedOut = true;
  }

  /**
   * Record, once, that this agent brokered an egress resolver that nobody
   * ever took to wire into the sandbox, so shell egress asks cannot become
   * conversation the way WebFetch's do.
   *
   * The one resolution note that is not an assembly fact. It cannot be: a
   * consumer wires the resolver on the line after create() returns, so the
   * only honest moment to look is the first prompt.
   *
   * **Duplex only, and the gate is the correctness fix rather than a
   * narrowing.** In passthrough there is no broker: getNetworkAccessResolver()
   * hands back the consumer's own function unchanged, so calling it would
   * change nothing and never calling it proves nothing. The check has no
   * information content there, and it fired anyway, telling the first real
   * consumer that its egress was broken when that consumer had wired the
   * sandbox to its own decision function and was answering every ask through
   * its own UI.
   */
  noteUnwiredIfNeeded(): void {
    if (!this.options.brokeredEgressResolver) return;
    if (this.unwiredNetworkResolverWarned) return;
    if (this.networkResolverHandedOut) return;
    this.unwiredNetworkResolverWarned = true;
    this.record(networkResolverUnwiredNote());
  }

  private currentNotes(): ResolutionNote[] {
    return collectAssemblyResolutionNotes(this.options.observe());
  }

  /**
   * The single write path for a note, and the reason the surfaces cannot
   * drift: the log line and the lifecycle entry are both built from the note
   * here, so there is no second place where the same fact is described.
   *
   * Every note warns regardless of severity. `info` is a classification for
   * the consumer's renderer, not a log level: the warn is the surface a
   * headless consumer has, and demoting the uncapped-session note to
   * `logger.info` would silently withdraw a warning consumers are
   * documented to receive.
   */
  private record(note: ResolutionNote): void {
    this.notes.push(cloneResolutionNote(note));
    this.options.logger.warn(resolutionWarnText(note));
    this.options.append({
      type: 'lifecycle',
      loopPath: RESOLUTION_LOOP_PATH,
      content: note.summary,
      // Assembly is nobody's turn: there is no causing entry to point at,
      // and the fallback stamp would attach it to whatever run happened to
      // be live when a late note landed.
      causedBy: null,
      data: { event: 'resolution_note', note: cloneResolutionNote(note) },
    });
  }
}
