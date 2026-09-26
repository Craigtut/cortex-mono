/**
 * AgentLoop's public surface, models and their settings (primary and
 * utility models, thinking level, context window, cache retention, session
 * key). AgentLoop implements this interface; the member docs here are
 * AgentLoop's documentation.
 */

import type { CortexModel } from '../../model-wrapper.js';
import type { ModelThinkingCapabilities, ThinkingLevel } from '../../types.js';

export interface LoopModelApi {
  /** Get the primary model. */
  getModel(): CortexModel;

  /** Get the resolved utility model. */
  getUtilityModel(): CortexModel;

  /**
   * Peek at the utility model that auto-resolution would produce for the
   * current primary model, without applying it or clearing a manual override.
   *
   * For providers Cortex cannot enumerate (e.g. Ollama, custom
   * OpenAI-compatible endpoints) this is the primary model itself. Useful for
   * labeling an "Auto" choice in a UI with the model that will actually run.
   */
  getAutoResolvedUtilityModel(): CortexModel;

  /**
   * Hot-swap the primary model without restarting the agent. Re-resolves
   * the utility model unless it was overridden.
   *
   * @param model - The new CortexModel to use
   */
  setModel(model: CortexModel): void;

  /**
   * Explicitly set the utility model, overriding auto-resolution.
   * The utility model must be from the same provider as the primary model.
   * After calling this, setModel() will NOT auto-resolve the utility model.
   * Call resetUtilityModel() to restore auto-resolution.
   *
   * @param model - The CortexModel to use as the utility model
   */
  setUtilityModel(model: CortexModel): void;

  /**
   * Reset the utility model to auto-resolution based on the primary model's provider.
   * Clears any manual override set by setUtilityModel().
   */
  resetUtilityModel(): void;

  /** Whether the utility model has been manually overridden. */
  isUtilityModelOverridden(): boolean;

  /**
   * Change the thinking/reasoning effort level.
   *
   * Does not validate against the model: callers that want a guaranteed
   * accepted value should pass the result of {@link clampThinkingLevel}.
   *
   * @param level - The consumer-facing thinking level
   */
  setThinkingLevel(level: ThinkingLevel): void;

  /**
   * Get the current thinking/reasoning effort level.
   *
   * @returns The current consumer-facing thinking level, or 'medium' if unset
   *   or set to a level this Cortex build does not model.
   */
  getThinkingLevel(): ThinkingLevel;

  /**
   * Get the thinking capabilities of the current primary model, from pi-ai's
   * per-model metadata.
   *
   * @returns Capabilities object describing thinking support
   */
  getModelThinkingCapabilities(): Promise<ModelThinkingCapabilities>;

  /**
   * Clamp a requested thinking level to the nearest level the current model
   * accepts, never exceeding what was asked for.
   *
   * Clamps against the model's own advertised levels rather than pi's
   * global ladder, where a level the installed pi does not know can clamp
   * to "off".
   *
   * Callers should surface a clamp to users when latency or cost changes.
   */
  clampThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel>;

  /**
   * Set the cache retention policy, applied to every provider request from
   * the agentic loop and to direct completions that do not override it.
   */
  setCacheRetention(value: 'none' | 'short' | 'long'): void;

  /**
   * Get the current cache retention policy.
   * Returns null if not yet resolved (pi-ai will use its own default).
   */
  getCacheRetention(): 'none' | 'short' | 'long' | null;

  /**
   * Set the stable cache/session key forwarded to the provider as its
   * prompt_cache_key. Use a value stable across calls that share a prefix.
   * Pass null to clear (the provider then generates its own per-request key).
   */
  setSessionId(value: string | null): void;

  /** Get the current cache/session key, or null if unset. */
  getSessionId(): string | null;

  /**
   * Set the context window size (from model metadata).
   * If a contextWindowLimit is set, the effective value will be
   * min(limit, contextWindow).
   */
  setContextWindow(contextWindow: number): void;

  /**
   * Set a user-configured limit on the context window.
   * The effective context window becomes min(limit, model.contextWindow)
   * without increasing explicit limits. This does not resize server allocation.
   * Pass null to remove the limit and use the model's full context window.
   */
  setContextWindowLimit(limit: number | null): void;

  /** Get the raw user-configured context window limit (null = no limit). */
  readonly contextWindowLimit: number | null;

  /** Get the effective context window after clamping the limit to backend capacity. */
  readonly effectiveContextWindow: number;

  /** Get the model's actual context window (unaffected by consumer limits). */
  readonly modelContextWindow: number;
}
