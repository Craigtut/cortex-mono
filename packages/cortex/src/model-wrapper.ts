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

import { backendConcurrency, modelBackend } from './model-backend.js';
import type { ModelBackend } from './model-backend.js';

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
/**
 * Prompt cache lifetimes per retention tier, in seconds (pi-ai's
 * `Model.promptCache`). A missing tier means the model does not say.
 */
export type ModelPromptCacheLifetimes = Partial<Record<'short' | 'long', number>>;

/**
 * Image input limits (pi-ai's `Model.inputLimits.images`): the cache-safe
 * resize profile a new image should fit before it enters history, and how
 * many images one message or request accepts.
 */
export interface ModelImageInputLimits {
  resize?: { maxWidth?: number; maxHeight?: number; maxBytes?: number; jpegQuality?: number };
  maxPerMessage?: number;
  maxPerRequest?: number;
}

export interface ModelCapabilities {
  promptCaching?: 'automatic-prefix' | undefined;
  /** Image input limits, when the catalog states them. The Read tool enforces the byte ceiling. */
  imageInput?: ModelImageInputLimits | undefined;
  /**
   * How long the provider keeps this model's prompt cache at each retention
   * tier, when the catalog states it. Pass to resolveCacheRetention().
   */
  promptCacheLifetimes?: ModelPromptCacheLifetimes | undefined;
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
    // (Ollama) states it, and everything else is judged by its backend.
    capabilities: {
      concurrency: backendConcurrency(modelBackend(provider, baseUrlOf(model))),
      ...promptCacheLifetimesOf(model),
      ...imageInputOf(model),
      ...(model as { cortexCapabilities?: ModelCapabilities }).cortexCapabilities,
    },
  };
  return wrapped;
}

/** The pi-ai model's stated cache lifetimes, as a capability entry (empty when it states none). */
function promptCacheLifetimesOf(model: unknown): Pick<ModelCapabilities, 'promptCacheLifetimes'> {
  const lifetimes = (model as { promptCache?: unknown }).promptCache;
  if (typeof lifetimes !== 'object' || lifetimes === null) return {};
  const { short, long } = lifetimes as { short?: unknown; long?: unknown };
  const stated: ModelPromptCacheLifetimes = {
    ...(typeof short === 'number' ? { short } : {}),
    ...(typeof long === 'number' ? { long } : {}),
  };
  return Object.keys(stated).length > 0 ? { promptCacheLifetimes: stated } : {};
}

/** The pi-ai model's image input limits, as a capability entry (empty when it states none). */
function imageInputOf(model: unknown): Pick<ModelCapabilities, 'imageInput'> {
  const images = (model as { inputLimits?: { images?: unknown } }).inputLimits?.images;
  return typeof images === 'object' && images !== null
    ? { imageInput: structuredClone(images) as ModelImageInputLimits }
    : {};
}

/** The model's concurrency capability; `unknown` when nothing declared one. */
export function modelConcurrency(model: CortexModel): ModelConcurrency {
  return model.capabilities?.concurrency ?? 'unknown';
}

/** A model reduced to what mode resolution and its notes read. */
export interface ModelDescription extends ModelBackend {
  modelId: string;
  concurrency: ModelConcurrency;
}

export function describeModel(model: CortexModel): ModelDescription {
  return {
    ...modelBackend(model.provider, baseUrlOf(unwrapModel(model))),
    modelId: model.modelId,
    concurrency: modelConcurrency(model),
  };
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

/** The pi model's base URL, when it declares one. */
function baseUrlOf(model: unknown): unknown {
  return model && typeof model === 'object' ? (model as Record<string, unknown>)['baseUrl'] : undefined;
}

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
