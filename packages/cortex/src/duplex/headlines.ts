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

import type { PendingAsk, SessionUsage, SubAgentSnapshot } from '../types.js';
import type { DelegationSnapshot } from './router.js';

// ---------------------------------------------------------------------------
// Ports and options
// ---------------------------------------------------------------------------

/** Live reads the builder pulls at render time (facade closures). */
export interface DuplexHeadlinePorts {
  /** Whether the reasoner has a run in flight. */
  reasonerRunning(): boolean;
  /** The reasoner's accumulated session usage (turns, cost, tokens). */
  reasonerUsage(): SessionUsage;
  /** Active sub-agents of the reasoner. */
  activeSubAgents(): SubAgentSnapshot[];
  /** Tracked delegations (friendly aliases) from the router. */
  delegations(): DelegationSnapshot[];
  /** Pending permission asks (voiced state included). */
  pendingAsks(): PendingAsk[];
  /** Clock override for tests. */
  now?: () => number;
}

/** Bounds on interpolated content, so one field cannot eat the block. */
const MAX_INSTRUCTION_CHARS = 160;
const MAX_TOOL_SUMMARY_CHARS = 120;
const MAX_OUTPUT_LINES = 3;
const MAX_OUTPUT_LINE_CHARS = 200;
const MAX_ASK_CHARS = 400;

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

// ---------------------------------------------------------------------------
// DuplexHeadlines
// ---------------------------------------------------------------------------

export class DuplexHeadlines {
  private readonly ports: DuplexHeadlinePorts;
  private readonly now: () => number;

  // Event-fed state (facade wires the reasoner's bridge into these).
  private currentTool: { name: string; summary: string | null; startedAt: number } | null = null;
  private runStartedAt: number | null = null;
  private lastRunEndedAt: number | null = null;
  private lastOutputLines: string[] = [];
  private lastOutputAt: number | null = null;

  constructor(ports: DuplexHeadlinePorts) {
    this.ports = ports;
    this.now = ports.now ?? Date.now;
  }

  /** The reasoner's main loop started a run. */
  noteRunStart(): void {
    this.runStartedAt = this.now();
    this.currentTool = null;
  }

  /** The reasoner's main loop finished its run. */
  noteRunEnd(): void {
    this.runStartedAt = null;
    this.currentTool = null;
    this.lastRunEndedAt = this.now();
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

    const running = this.ports.reasonerRunning();
    const delegations = this.ports.delegations().filter((delegation) => !delegation.cancelled);
    const subAgents = this.ports.activeSubAgents();
    const asks = this.ports.pendingAsks();

    if (running || this.lastOutputLines.length > 0) {
      const usage = this.ports.reasonerUsage();
      const attrs: string[] = [`state="${running ? 'working' : 'idle'}"`];
      if (running && this.runStartedAt !== null) {
        attrs.push(`duration="${ageSeconds(now, this.runStartedAt)}s"`);
      }
      if (!running && this.lastRunEndedAt !== null) {
        attrs.push(`idle_for="${ageSeconds(now, this.lastRunEndedAt)}s"`);
      }
      attrs.push(`turns="${usage.totalTurns}"`, `cost="$${usage.totalCost.toFixed(4)}"`);
      const lines: string[] = [];
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

    for (const ask of asks) {
      // The verbatim rendering, escaped: the talker's answer to "what is
      // it waiting on" must carry the actual command or path (F14), and a
      // hostile rendering must not fabricate block structure.
      sections.push(
        `<pending-ask voiced="${ask.voiced}" ` +
        `age="${ageSeconds(now, ask.requestedAt)}s">` +
        `${escapeText(clip(ask.renderedRequest, MAX_ASK_CHARS))}</pending-ask>`,
      );
    }

    if (sections.length === 0) return null;
    return `<work-status>\n${sections.join('\n')}\n</work-status>`;
  }
}
