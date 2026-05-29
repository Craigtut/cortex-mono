/**
 * Public hook contract.
 *
 * Hooks are subprocesses Cortex Code spawns at well-defined lifecycle points.
 * Each handler receives a single JSON envelope on stdin, writes a single JSON
 * response on stdout, and exits. Stderr is collected and logged but never
 * parsed. Handlers are external programs in any language: the contract is
 * just "JSON in, JSON out".
 *
 * v1 ships `pre_turn` only. The other events are reserved names so future
 * work can expand without breaking config files written today.
 */

/** Event names Cortex emits to hooks. */
export type HookEvent =
  | 'pre_turn'
  | 'post_turn'
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'session_start'
  | 'session_end';

/** Envelope sent to every hook handler. */
export interface HookEnvelopeBase {
  /** Stable id of the Cortex session firing the hook. */
  sessionId: string;
  /** Working directory of the Cortex session. */
  cwd: string;
  /** Wall-clock timestamp of the firing event, ISO-8601 UTC. */
  timestamp: string;
  /** Hook config schema version. v1 in this release. */
  version: number;
}

/** Envelope for `pre_turn`. */
export interface PreTurnEnvelope extends HookEnvelopeBase {
  event: 'pre_turn';
  /** The user's submitted prompt before agent processing. */
  userPrompt: string;
}

/** Any hook envelope; discriminate on `event`. */
export type HookEnvelope =
  | PreTurnEnvelope
  | (HookEnvelopeBase & { event: Exclude<HookEvent, 'pre_turn'> });

/**
 * Response shape Cortex understands. Unknown keys are ignored; missing keys
 * are treated as "no change".
 */
export interface HookResponse {
  /**
   * Free-form string prepended to the user's prompt as additional context
   * before the agent sees it. Useful for hooks that want to inject reminders,
   * peer-message notifications, or contextual facts.
   */
  additionalContext?: string;
}

/** One handler registration, parsed from `hooks.json`. */
export interface HookHandler {
  /** Human-readable name for diagnostics; matches the registry key. */
  name: string;
  /** Executable path or command resolvable via PATH. */
  command: string;
  /** Optional argv entries. */
  args?: string[];
  /** Optional working directory; defaults to the session cwd. */
  cwd?: string;
  /** Per-handler timeout in milliseconds. Defaults to 5000. */
  timeoutMs?: number;
  /** Optional env vars layered on top of the parent process env. */
  env?: Record<string, string>;
  /** Source file the handler was loaded from, for diagnostics. */
  source: 'global' | 'project';
}

/** Hook config file shape (`~/.cortex/hooks.json`, `.cortex/hooks.json`). */
export interface HookConfigFile {
  /** Hooks per event. Keys are [`HookEvent`] names. */
  hooks?: Partial<Record<HookEvent, Array<{
    name?: string;
    command: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }>>>;
}
