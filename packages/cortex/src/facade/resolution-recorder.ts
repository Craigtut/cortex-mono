/**
 * ResolutionRecorder: what this assembly resolved to where it differs from
 * what was asked for (resolution-report.ts), and the single write path that
 * keeps its three surfaces (the report, the warn, the lifecycle entry) from
 * drifting.
 *
 * Computed once at construction, plus the one condition that cannot be
 * known then (the unwired egress resolver) and the model notes the facade
 * re-resolves itself (setModel re-mirroring an unpinned talker).
 */

import type { CortexLogger } from '../types.js';
import {
  cloneResolutionNote,
  collectAssemblyResolutionNotes,
  networkResolverUnwiredNote,
  resolutionWarnText,
} from '../resolution-report.js';
import type {
  AssemblyResolution,
  ResolutionNote,
  ResolutionNoteCode,
} from '../resolution-report.js';
import type { LogEntryInput } from './log-recorder.js';

/**
 * Producer identity on a resolution note's lifecycle entry. Not a loop: the
 * facade resolved the configuration, and attributing it to the reasoner or
 * the talker would claim a loop said something about its own assembly.
 */
const RESOLUTION_LOOP_PATH = 'facade';

/**
 * Notes read off the talker's model, re-evaluated when the facade itself
 * re-resolves that model (setModel on an unpinned talker).
 */
const MODEL_RESOLUTION_NOTE_CODES: ReadonlySet<ResolutionNoteCode> = new Set<ResolutionNoteCode>([
  'talker-model-fallback',
  'talker-utility-model-skipped',
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
   * Re-evaluate the notes that describe the talker's model after the facade
   * re-resolved it (setModel re-mirrors an unpinned talker). This is not the
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
