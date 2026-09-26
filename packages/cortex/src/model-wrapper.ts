/**
 * CortexModel: branded opaque type for type-safe model passing.
 *
 * Wraps pi-ai's Model<any> with a branded type to prevent consumers
 * from accidentally passing raw pi-ai models where cortex models
 * are expected (and vice versa).
 *
 * The consumer can read provider, modelId, and contextWindow for
 * display and configuration. The underlying pi-ai Model object is
 * accessed internally by AgentLoop when constructing the
 * pi-agent-core Agent.
 *
 * Reference: provider-manager.md
 */

import { providerConcurrency } from './provider-registry.js';

// ---------------------------------------------------------------------------
// Branded type
// ---------------------------------------------------------------------------

/**
 * Opaque model handle. The consumer receives this from ProviderManager
 * and passes it to AgentLoop. The consumer never inspects its internals
 * beyond the declared fields.
 *
 * Internally, this wraps pi-ai's Model<T> type.
 */
export interface ModelCapabilities {
  promptCaching?: 'automatic-prefix' | undefined;
  structuredOutput?: 'json-schema' | undefined;
  trainedContextWindow?: number | undefined;
  /** Whether the backend serves this model while another request is in flight. */
  concurrency?: ModelConcurrency | undefined;
}

/**
 * Whether a model's backend serves a request while another is in flight,
 * which is what decides whether duplex can overlap its talker and reasoner.
 *
 * - `parallel`: concurrent requests are served concurrently (hosted APIs).
 * - `serial`: requests queue behind each other (Ollama by default).
 * - `unknown`: Cortex cannot tell (custom endpoints, unregistered providers).
 */
export type ModelConcurrency = 'parallel' | 'serial' | 'unknown';

export interface CortexModel {
  /** @internal Brand tag for nominal type safety. */
  readonly __brand: 'CortexModel';
  /** Provider identifier (e.g., 'anthropic', 'openai', 'google'). */
  readonly provider: string;
  /** Model identifier (e.g., 'claude-sonnet-4-20250514'). */
  readonly modelId: string;
  /** Backend context capacity in tokens, before applying any loop compaction budget. */
  readonly contextWindow: number;
  readonly capabilities?: ModelCapabilities;
}

// The symbol key used to store the underlying pi-ai model.
const INNER_MODEL = Symbol.for('cortex.innerModel');

/**
 * Internal storage shape: a CortexModel with the hidden pi-ai model
 * attached via a Symbol key.
 */
interface WrappedModel extends CortexModel {
  [INNER_MODEL]: unknown;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wrap a pi-ai Model object into a CortexModel.
 *
 * @param model - The pi-ai Model object to wrap
 * @param provider - The provider identifier
 * @param modelId - The model identifier
 * @param contextWindow - The context window size (default: 200000)
 * @returns An opaque CortexModel handle
 */
export function wrapModel(
  model: unknown,
  provider: string,
  modelId: string,
  contextWindow?: number,
): CortexModel {
  // A nullish model would produce a branded handle that passes isCortexModel()
  // yet has nothing to unwrap, deferring the failure to deep inside the agentic
  // loop. Reject it here so the caller gets an actionable error at the source.
  if (model == null) {
    throw new Error(
      `wrapModel: cannot wrap a nullish model (provider "${provider}", model "${modelId}")`,
    );
  }
  const wrapped: WrappedModel = {
    __brand: 'CortexModel' as const,
    provider,
    modelId,
    contextWindow: contextWindow ?? extractContextWindow(model) ?? 200_000,
    [INNER_MODEL]: model,
    // Concurrency always resolves: a model creator that knows its backend
    // (Ollama) states it, and everything else is judged by provider id.
    capabilities: {
      concurrency: providerConcurrency(provider),
      ...(model as { cortexCapabilities?: ModelCapabilities }).cortexCapabilities,
    },
  };
  return wrapped;
}

/** The model's concurrency capability; `unknown` when nothing declared one. */
export function modelConcurrency(model: CortexModel): ModelConcurrency {
  return model.capabilities?.concurrency ?? 'unknown';
}

/**
 * Unwrap a CortexModel to retrieve the underlying pi-ai Model object.
 *
 * @param cortexModel - The CortexModel to unwrap
 * @returns The underlying pi-ai Model object
 * @throws Error if the object is not a valid CortexModel
 */
export function unwrapModel(cortexModel: CortexModel): unknown {
  if (!isCortexModel(cortexModel)) {
    throw new Error('Expected a CortexModel created by wrapModel()');
  }
  return (cortexModel as WrappedModel)[INNER_MODEL];
}

/**
 * Check whether a value is a valid CortexModel (has the correct brand
 * and contains a wrapped inner model).
 *
 * @param value - The value to check
 * @returns True if the value is a valid CortexModel
 */
export function isCortexModel(value: unknown): value is CortexModel {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string | symbol, unknown>;
  return (
    obj['__brand'] === 'CortexModel' &&
    typeof obj['provider'] === 'string' &&
    typeof obj['modelId'] === 'string' &&
    typeof obj['contextWindow'] === 'number' &&
    INNER_MODEL in obj
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to extract the context window size from a pi-ai Model object.
 * Pi-ai models expose contextWindow as a property.
 */
function extractContextWindow(model: unknown): number | undefined {
  if (model && typeof model === 'object') {
    const obj = model as Record<string, unknown>;
    const cw = obj['contextWindow'];
    if (typeof cw === 'number') {
      return cw;
    }
  }
  return undefined;
}
