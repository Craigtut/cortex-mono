/**
 * DuplexHeadlines: the facade-fed live status block for the talker
 * (communication.md "Headlines"; log-and-context.md "Churn: View Injection
 * Outside BP3").
 *
 * The block is FACADE STATE, never a log entry: it churns at tool-call
 * frequency and is rebuilt per talker LLM call through the loop's headline
 * provider, which view-injects it outside the BP3 cache boundary with a
 * hard token cap. It answers "how's it going" with honest staleness: every
 * section carries an as_of age so staleness is a number, not a vibe.
 *
 * Interpolated values (task instructions, tool summaries, stdout tails,
 * ask renderings) reach this block verbatim from untrusted sources, so
 * everything interpolated is escaped: an instruction that contains markup
 * must not be able to fabricate sections or close the block early.
 */

import type { SessionUsage, SubAgentSnapshot } from '../types.js';
import type { EventBridge } from '../event-bridge.js';
import type { DelegationSnapshot } from './delegations.js';
import { clipHeadTail } from '../permission-rendering.js';
import { toolCallSubject } from '../tools/tool-call-subject.js';

/**
 * What the block needs of a pending ask.
 *
 * Deliberately keyed on `voicedAtSeq` rather than the registry's `voiced`
 * boolean. `voiced` is sticky (set at hand-off, never cleared), so an ask
 * whose voicing was lost keeps reporting true while the broker has already
 * decided the user never heard it, and the block would read out a request as
 * answerable that the router would refuse an answer for. The anchor is the
 * broker's live answer to the only question this block is asking.
 */
export interface HeadlineAsk {
  renderedRequest: string;
  requestedAt: number;
  /** Seq of the ask_voiced entry anchoring the CURRENT voicing, or null. */
  voicedAtSeq: number | null;
}

// ---------------------------------------------------------------------------
// Ports and options
// ---------------------------------------------------------------------------

/** The reasoner's run as the block reads it (ReasonerRunTracker). */
export interface HeadlineRunState {
  /** Whether a logical run is in flight, retry backoffs included. */
  logicalRunActive(): boolean;
  /** The live attempt, or null between attempts. */
  attempt(): { startedAt: number } | null;
  /** When the last attempt ended, or null before any has. */
  lastEndedAt(): number | null;
}

/** Live reads the builder pulls at render time (facade closures). */
export interface DuplexHeadlinePorts {
  /** The reasoner's run: whether one is in flight, and since when. */
  reasonerRun: HeadlineRunState;
  /** The reasoner's accumulated session usage (turns, cost, tokens). */
  reasonerUsage(): SessionUsage;
  /** Active sub-agents of the reasoner. */
  activeSubAgents(): SubAgentSnapshot[];
  /** Tracked delegations (friendly aliases) from the router. */
  delegations(): DelegationSnapshot[];
  /**
   * Pending permission asks, from the BROKER rather than the facade's merged
   * consumer view. The broker holds every ask (tool, escalation, network) and
   * is the authority on whether one has actually been read out, which the
   * loop registry's sticky flag is not.
   */
  pendingAsks(): HeadlineAsk[];
  /** Clock override for tests. */
  now?: () => number;
}

/** Bounds on interpolated content, so one field cannot eat the block. */
const MAX_INSTRUCTION_CHARS = 160;
const MAX_TOOL_SUMMARY_CHARS = 120;
const MAX_OUTPUT_LINES = 3;
const MAX_OUTPUT_LINE_CHARS = 200;
const MAX_ASK_CHARS = 400;
const ASK_HEAD_CHARS = 250;
const ASK_TAIL_CHARS = 120;

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/** Escape text interpolated into the block body. */
function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Escape text interpolated into an attribute value. */
function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;');
}

function clip(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function ageSeconds(now: number, timestamp: number): number {
  return Math.max(0, Math.round((now - timestamp) / 1000));
}

/**
 * Identifying detail for the headline's "Current:" line, mirroring the
 * loop's own log-line summarization: paths, commands, and patterns without
 * content or results. Escaping happens inside the headline builder.
 */
function summarizeHeadlineArgs(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;
  const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const subject = toolCallSubject(toolName, args);
  if ('command' in subject) return str(subject.command)?.slice(0, 120) ?? null;
  if ('path' in subject) return str(subject.path);
  if ('pattern' in subject) return str(subject.pattern);
  if ('url' in subject) return str(subject.url);
  return null;
}

// ---------------------------------------------------------------------------
// DuplexHeadlines
// ---------------------------------------------------------------------------

export class DuplexHeadlines {
  private readonly ports: DuplexHeadlinePorts;
  private readonly now: () => number;

  // Event-fed state (attach() wires the reasoner's bridge into these).
  private currentTool: { name: string; summary: string | null; startedAt: number } | null = null;
  private lastOutputLines: string[] = [];
  private lastOutputAt: number | null = null;
  private retry: {
    category: string;
    attempt: number;
    maxAttempts: number;
    at: number;
  } | null = null;

  constructor(ports: DuplexHeadlinePorts) {
    this.ports = ports;
    this.now = ports.now ?? Date.now;
  }

  /**
   * Feed the block from the reasoner: its own tool calls and last
   * user-facing output. Child tool activity reaches the block through
   * activeSubAgents() (the sub-agent manager tracks it), so only main-loop
   * events feed here. An attempt starting or ending clears the per-attempt
   * lines (the current tool, a retry in progress).
   */
  attach(
    reasonerBridge: EventBridge,
    run: {
      onAttemptStart(listener: () => void): void;
      onAttemptEnd(listener: () => void): void;
    },
  ): void {
    run.onAttemptStart(() => this.noteAttemptBoundary());
    run.onAttemptEnd(() => this.noteAttemptBoundary());
    reasonerBridge.on('tool_call_start', (event) => {
      if (event.childTaskId) return;
      const payload = event.payload as { toolName?: string; args?: Record<string, unknown> } | undefined;
      if (!payload?.toolName) return;
      this.noteToolStart(payload.toolName, summarizeHeadlineArgs(payload.toolName, payload.args));
    });
    reasonerBridge.on('tool_call_end', (event) => {
      if (event.childTaskId) return;
      this.noteToolEnd();
    });
    reasonerBridge.on('turn_end', (event) => {
      if (event.childTaskId) return;
      const userFacing = event.textOutput?.userFacing;
      if (userFacing && userFacing.trim().length > 0) {
        this.noteOutput(userFacing);
      }
    });
  }

  /** A reasoner attempt started or ended: its current tool and retry are over. */
  noteAttemptBoundary(): void {
    this.currentTool = null;
    this.retry = null;
  }

  /**
   * The reasoner is waiting out a retry backoff.
   *
   * Without this the block says `state="working"` for the whole ladder, and
   * on the default policy that can be hours. The talker's grounding rules
   * then have it honestly answer "still working on it" to a session that is
   * failing over and over, which is the one answer that makes the user wait
   * instead of intervening. Retrying is a different fact from working and
   * the block has to be able to say it.
   */
  noteRetry(info: { category: string; attempt: number; maxAttempts: number }): void {
    this.retry = { ...info, at: this.now() };
  }

  /** The retry ladder ended (succeeded, gave up, or the run finished). */
  clearRetry(): void {
    this.retry = null;
  }

  /** A tool started on the reasoner's main loop. */
  noteToolStart(name: string, summary?: string | null): void {
    this.currentTool = { name, summary: summary ?? null, startedAt: this.now() };
  }

  /** The reasoner's current tool finished. */
  noteToolEnd(): void {
    this.currentTool = null;
  }

  /** User-facing text of a completed reasoner turn (the last-output feed). */
  noteOutput(userFacing: string): void {
    const lines = userFacing
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return;
    this.lastOutputLines = lines.slice(-MAX_OUTPUT_LINES);
    this.lastOutputAt = this.now();
  }

  /**
   * Render the status block, or null when there is nothing worth showing
   * (idle, no delegations, no sub-agents, no pending asks): injecting an
   * empty frame every turn would spend tokens saying nothing.
   */
  build(): string | null {
    const now = this.now();
    const sections: string[] = [];

    const run = this.ports.reasonerRun;
    const running = run.logicalRunActive();
    const attempt = run.attempt();
    const lastEndedAt = run.lastEndedAt();
    // Cancelled and completed delegations are not work in progress. Without
    // the completed filter the block lists work that finished hours ago
    // beside `<work state="idle">`, and the talker's grounding rules then
    // have it honestly report that as still running.
    const delegations = this.ports.delegations().filter(
      (delegation) => !delegation.cancelled && delegation.completedAt === null,
    );
    const subAgents = this.ports.activeSubAgents();
    const asks = this.ports.pendingAsks();

    // Asks render FIRST, ahead of everything else.
    //
    // The block has a hard token cap and the loop enforces it by cutting from
    // the TAIL, so whatever renders last is what disappears when the block
    // grows. Everything above the asks is unbounded in count (one entry per
    // delegation, one per running sub-agent), which means the section holding
    // a live permission request was the one guaranteed to be dropped first,
    // and the loop that raised it blocks for as long as the talker cannot see
    // it. Ordering by consequence rather than by section age costs nothing
    // and removes the failure entirely.
    this.appendAskSections(sections, asks, now);

    if (running || this.retry !== null || this.lastOutputLines.length > 0) {
      const usage = this.ports.reasonerUsage();
      const attrs: string[] = [`state="${running ? 'working' : 'idle'}"`];
      if (running && attempt !== null) {
        attrs.push(`duration="${ageSeconds(now, attempt.startedAt)}s"`);
      }
      if (!running && lastEndedAt !== null) {
        attrs.push(`idle_for="${ageSeconds(now, lastEndedAt)}s"`);
      }
      attrs.push(`turns="${usage.totalTurns}"`, `cost="$${usage.totalCost.toFixed(4)}"`);
      const lines: string[] = [];
      if (this.retry !== null) {
        lines.push(
          `  Retrying after a ${escapeText(this.retry.category)} failure: ` +
          `attempt ${this.retry.attempt} of ${this.retry.maxAttempts} ` +
          `(as of ${ageSeconds(now, this.retry.at)}s ago)`,
        );
      }
      if (running && this.currentTool) {
        const summary = this.currentTool.summary
          ? ` ${escapeText(clip(this.currentTool.summary, MAX_TOOL_SUMMARY_CHARS))}`
          : '';
        lines.push(
          `  Current: ${escapeText(this.currentTool.name)}${summary} ` +
          `(as of ${ageSeconds(now, this.currentTool.startedAt)}s ago)`,
        );
      }
      if (this.lastOutputLines.length > 0 && this.lastOutputAt !== null) {
        lines.push(`  Last update (as of ${ageSeconds(now, this.lastOutputAt)}s ago):`);
        for (const line of this.lastOutputLines) {
          lines.push(`  ${escapeText(clip(line, MAX_OUTPUT_LINE_CHARS))}`);
        }
      }
      sections.push(
        `<work ${attrs.join(' ')}>` + (lines.length > 0 ? `\n${lines.join('\n')}\n` : '') + '</work>',
      );
    }

    for (const delegation of delegations) {
      sections.push(
        `<task alias="${escapeAttribute(delegation.alias)}" ` +
        `age="${ageSeconds(now, delegation.createdAt)}s">` +
        `${escapeText(clip(delegation.instructions, MAX_INSTRUCTION_CHARS))}</task>`,
      );
    }

    for (const subAgent of subAgents) {
      const tool = subAgent.lastToolName && subAgent.lastToolStartedAt !== null
        ? ` tool="${escapeAttribute(subAgent.lastToolName)}" ` +
          `tool_as_of="${ageSeconds(now, subAgent.lastToolStartedAt)}s ago"`
        : '';
      sections.push(
        `<sub-agent status="${escapeAttribute(subAgent.status)}" ` +
        `duration="${ageSeconds(now, subAgent.spawnedAt)}s" ` +
        `turns="${subAgent.turnsUsed}" cost="$${subAgent.liveCostUsd.toFixed(4)}"${tool}>` +
        `${escapeText(clip(subAgent.instructions, MAX_INSTRUCTION_CHARS))}</sub-agent>`,
      );
    }

    if (sections.length === 0) return null;
    return `<work-status>\n${sections.join('\n')}\n</work-status>`;
  }

  /**
   * The ask sections: the VOICED one verbatim, everything queued behind it
   * as a bare count.
   *
   * Rendering every pending ask with its request text re-opens F2
   * mis-binding through a surface the D16 router rules never see. Two asks
   * pending is a multi-loop situation (the reasoner's `npm install` voiced,
   * a sub-agent's `rm -rf ~/work` queued behind it), and a block listing both
   * hands the talker two readable requests with nothing distinguishing which
   * one the user was asked about. It reads both out, the user says "yes, the
   * npm one", and a bare answer_ask binds to whichever the broker voiced
   * first. The consent would be genuine and the audit trail clean.
   *
   * So the block carries only what the user could actually have heard.
   *
   * **No ask id here, deliberately.** The id is the nonce that fences the
   * verbatim request in the voicing (prompts.ts buildAskVoicing), and that
   * fence holds only while the id stays away from whoever authored the text
   * inside it. This block is rebuilt and injected on EVERY talker call, in
   * the surface the talker is most encouraged to quote from, and the
   * talker's own output reaches the reasoner verbatim through two channels
   * (spoken replies in the conversation-delta buffer, and the answer_ask
   * reason). "The block reaches the talker alone" is true of the block and
   * not of what the talker then says. It also buys nothing: a bare
   * `answer_ask({decision})` binds to the voiced ask, and the router refuses
   * an allow for anything else, so an id can never make an accepted answer
   * possible that a bare answer would not.
   */
  private appendAskSections(
    sections: string[],
    asks: readonly HeadlineAsk[],
    now: number,
  ): void {
    const voicedAsks = asks.filter((ask) => ask.voicedAtSeq !== null);
    const queuedCount = asks.length - voicedAsks.length;
    for (const ask of voicedAsks) {
      // The verbatim rendering, escaped: the talker's answer to "what is
      // it waiting on" must carry the actual command or path (F14), and a
      // hostile rendering must not fabricate block structure. Over-cap
      // renderings keep their tail, matching the producer's rule.
      sections.push(
        `<pending-ask voiced="true" ` +
        `age="${ageSeconds(now, ask.requestedAt)}s">` +
        `${escapeText(clipHeadTail(ask.renderedRequest, MAX_ASK_CHARS, ASK_HEAD_CHARS, ASK_TAIL_CHARS))}` +
        '</pending-ask>',
      );
    }
    if (queuedCount > 0) {
      sections.push(
        `<queued-asks count="${queuedCount}">Not read out yet; ` +
        'one request is answered at a time. Do not describe or answer these.' +
        '</queued-asks>',
      );
    }
  }
}
