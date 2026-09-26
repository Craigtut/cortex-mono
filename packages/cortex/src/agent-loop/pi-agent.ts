/**
 * The pi-agent-core / pi-ai boundary AgentLoop is written against: the
 * minimal Agent and Model contracts (structural, so the real classes load
 * lazily), plus the one crossing point for thinking levels.
 */

import type { AgentMessage, AgentStateAccessor } from '../context-manager.js';
import type { PiEventSource } from '../event-bridge.js';
import type { CortexTool } from '../tool-contract.js';
import type { ModelThinkingCapabilities, ThinkingLevel } from '../types.js';
import { THINKING_LEVEL_ORDER } from '../types.js';

// ---------------------------------------------------------------------------
// Minimal pi-agent-core/pi-ai type contracts
// ---------------------------------------------------------------------------

/**
 * Minimal Agent interface matching pi-agent-core's Agent class.
 * Defined here to avoid a hard runtime dependency; the real Agent is
 * passed at construction time.
 */
export interface PiAgent extends AgentStateAccessor, PiEventSource {
  /**
   * Start a new run. Accepts either a plain prompt string or a prepared batch
   * of messages (pi pushes every batch message into the transcript at run
   * start); Cortex uses the batch form to flush queued silent deliveries
   * ahead of the real prompt.
   */
  prompt(input: string | AgentMessage[], options?: {
    update?: (event: unknown) => void;
    signal?: AbortSignal;
  }): Promise<unknown>;
  /**
   * Resume the agentic loop from the current transcript without adding a new
   * message. Used for background retries; the last message must be a user or
   * tool-result (Cortex trims pi-agent-core's synthetic failure message first).
   */
  continue(): Promise<unknown>;
  abort(): void;
  waitForIdle(): Promise<void>;
  reset(): void;

  /**
   * Inject a steering message into the running agentic loop.
   * Pi applies steering after the current assistant turn and tool batch finish.
   * Only effective while a prompt() call is in progress.
   */
  steer(message: { role: string; content: string }): void;

  /**
   * Queue a message that pi injects only at a would-stop point: after the
   * model has produced what would otherwise be the run's final answer.
   * Optional because older test doubles predate it; the real pi Agent
   * always has it.
   */
  followUp?(message: { role: string; content: string }): void;

  /** Drain mode of pi's steering queue ('all' | 'one-at-a-time'). */
  steeringMode?: string;
  /** Drain mode of pi's follow-up queue ('all' | 'one-at-a-time'). */
  followUpMode?: string;
  /** Remove all queued steering messages. */
  clearSteeringQueue?(): void;
  /** Remove all queued follow-up messages. */
  clearFollowUpQueue?(): void;
  /**
   * True when pi's steering or follow-up queue still holds messages.
   * Unused by Cortex itself: wake parking is loop-owned precisely because
   * this can only answer "is anything queued", never "is THIS content
   * still queued". Kept for consumers and tests.
   */
  hasQueuedMessages?(): boolean;

  /**
   * Context transformation hook installed by Cortex.
   */
  transformContext?: (messages: unknown[]) => Promise<unknown[]>;
}

/** Drain mode for pi's steering and follow-up queues. */
export type QueueDrainMode = 'all' | 'one-at-a-time';

/**
 * Minimal Model interface matching pi-ai's Model type.
 * Only the fields we need for provider validation and utility model resolution.
 */
export interface PiModel {
  provider: string;
  name: string;
  contextWindow?: number;
  [key: string]: unknown;
}

export type RegisteredTool = CortexTool;

export interface AgentLoopConstructorOptions {
  enableSubAgentTool?: boolean;
  enableLoadSkillTool?: boolean;
}

export type CacheRetention = 'none' | 'short' | 'long';

// ---------------------------------------------------------------------------
// ThinkingLevel crossing to pi (names are identical; see toPiThinkingLevel)
// ---------------------------------------------------------------------------

/**
 * Cortex's level names are pi's level names, so both directions are identity.
 *
 * These used to remap "max" <-> "xhigh", back when Cortex's vocabulary topped
 * out one rung below pi's. That collapse silently under-requested: on a model
 * exposing both xhigh and max, asking for Cortex "max" sent "xhigh". Worse,
 * when pi later re-keyed a model's thinkingLevelMap onto "max", the sent
 * "xhigh" missed the lookup entirely and fell through pi's `default` branch to
 * "high" — two rungs down, with nothing logged. Keep these as the single
 * documented crossing point rather than inlining casts at call sites.
 */
export function toPiThinkingLevel(level: ThinkingLevel): string {
  return level;
}

/** Narrow a pi level name to Cortex's union, or null if pi added one we don't model. */
export function fromPiThinkingLevel(level: string): ThinkingLevel | null {
  return (THINKING_LEVEL_ORDER as readonly string[]).includes(level)
    ? (level as ThinkingLevel)
    : null;
}

/**
 * Strongest supported level that is no stronger than `level`.
 *
 * Falls back to the weakest supported level when the request sits below
 * everything the model offers, and to 'off' when the model offers nothing.
 * Ranking runs through THINKING_LEVEL_ORDER rather than the supported list's
 * own indices, so an out-of-order or sparse list from a provider still
 * compares correctly.
 */
export function clampToSupported(
  level: ThinkingLevel,
  supported: readonly ThinkingLevel[],
): ThinkingLevel {
  if (supported.includes(level)) return level;
  if (supported.length === 0) return 'off';

  const rank = (l: ThinkingLevel): number => THINKING_LEVEL_ORDER.indexOf(l);
  const wanted = rank(level);
  const ranked = [...supported].sort((a, b) => rank(a) - rank(b));

  let best: ThinkingLevel | null = null;
  for (const candidate of ranked) {
    if (rank(candidate) <= wanted) best = candidate;
  }
  return best ?? ranked[0]!;
}

/**
 * Narrow pi's per-model level list to Cortex's union, preserving pi's order
 * and dropping anything Cortex does not model. Order matters: callers clamp
 * against this list, so it must run weakest to strongest.
 */
export function fromPiThinkingLevels(levels: readonly string[]): ThinkingLevel[] {
  const mapped: ThinkingLevel[] = [];
  for (const level of levels) {
    const cortexLevel = fromPiThinkingLevel(level);
    if (cortexLevel !== null && !mapped.includes(cortexLevel)) {
      mapped.push(cortexLevel);
    }
  }
  return mapped;
}

/**
 * Thinking support of a pi model, from pi-ai's per-model level list, or a
 * conservative guess from its `reasoning` flag when pi-ai cannot answer.
 */
export async function modelThinkingCapabilities(piModel: PiModel): Promise<ModelThinkingCapabilities> {
  try {
    const { getSupportedThinkingLevels } = await import('@earendil-works/pi-ai');
    const supportedLevels = fromPiThinkingLevels(
      getSupportedThinkingLevels(piModel as any),
    );
    return {
      supportsThinking: supportedLevels.some(level => level !== 'off'),
      supportsMax: supportedLevels.includes('max'),
      supportedLevels,
    };
  } catch {
    const supportsThinking = (piModel as Record<string, unknown>)['reasoning'] === true;
    const supportedLevels: ThinkingLevel[] = supportsThinking
      ? ['minimal', 'low', 'medium', 'high']
      : ['off'];
    return {
      supportsThinking,
      supportsMax: false,
      supportedLevels,
    };
  }
}
