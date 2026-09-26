/**
 * The pi-ai boundary for ProviderManager: every dynamic import of pi-ai,
 * and the pi shapes Cortex reads through it.
 *
 * Pi-ai is loaded dynamically so consumers never import it directly. If the
 * dependency is missing or unavailable, the loaders throw clear errors.
 */

// ---------------------------------------------------------------------------
// Pi-ai dynamic import types
// ---------------------------------------------------------------------------

/**
 * Shape of the pi-ai functions ProviderManager uses. pi-ai 0.80 split these
 * across entrypoints: catalog reads live on `providers/all`, thinking-level
 * helpers on the root, and completion on the temporary `/compat` shim.
 * `loadPiAi()` composes them back into this single object.
 */
export interface PiAiModule {
  getModel: (provider: string, modelId: string) => unknown;
  getModels: (provider: string) => Array<Record<string, unknown>>;
  getSupportedThinkingLevels?: ((model: unknown) => string[]) | undefined;
  completeSimple?: ((model: unknown, context: unknown, options?: unknown) => Promise<unknown>) | undefined;
  complete?: ((model: unknown, context: unknown, options?: unknown) => Promise<unknown>) | undefined;
}

/** A pi OAuth credential blob. `expires` is epoch millis. */
export interface PiOAuthCredential extends Record<string, unknown> {
  type: 'oauth';
  access: string;
  refresh: string;
  expires: number;
}

/** Request auth pi derives from a credential. */
interface PiModelAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
}

/**
 * pi's per-provider OAuth implementation, reached through
 * `builtinProviders()` rather than a global registry.
 *
 * The registry pi used to export (`getOAuthProvider`, `getOAuthApiKey`, ...)
 * is gone: its entrypoint is a types-only shim now, so those reads yielded
 * undefined rather than failing. Notably there is no `getOAuthApiKey`
 * replacement; deriving a usable key is now the app's job, which is what
 * {@link ProviderManager.resolveOAuthApiKey} reimplements on top of
 * refresh + toAuth.
 */
export interface PiOAuthAuth {
  name: string;
  isSubscription?: boolean;
  loginLabel?: string;
  login: (interaction: PiAuthInteraction) => Promise<PiOAuthCredential>;
  refresh: (credential: PiOAuthCredential, signal: AbortSignal) => Promise<PiOAuthCredential>;
  toAuth: (credential: PiOAuthCredential) => Promise<PiModelAuth>;
}

/** pi's login prompt shapes. `select` resolves to the chosen option id. */
export type PiAuthPrompt = { signal?: AbortSignal } & (
  | { type: 'text'; message: string; placeholder?: string }
  | { type: 'secret'; message: string; placeholder?: string }
  | { type: 'select'; message: string; options: readonly { id: string; label: string; description?: string }[] }
  | { type: 'manual_code'; message: string; placeholder?: string }
);

/** pi's login progress events. */
export type PiAuthEvent =
  | { type: 'info'; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: 'progress'; message: string };

export interface PiAuthInteraction {
  signal: AbortSignal;
  prompt: (prompt: PiAuthPrompt) => Promise<string>;
  notify: (event: PiAuthEvent) => void;
}

interface PiBuiltinProvider {
  id: string;
  name?: string;
  auth?: { oauth?: PiOAuthAuth };
}

// ---------------------------------------------------------------------------
// Pi-ai dynamic import helpers
// ---------------------------------------------------------------------------

/**
 * Lazily load the pi-ai main module.
 * Throws a clear error if pi-ai is not installed.
 */
export async function loadPiAi(): Promise<PiAiModule> {
  try {
    // pi-ai 0.80 split the old root "global API" across entrypoints. Compose
    // the subset ProviderManager needs from their durable homes: catalog reads
    // from `providers/all`, thinking-level helpers from root, and completion
    // from the temporary `/compat` shim (pinned pending the Phase 2
    // createModels() migration). String-literal paths avoid bundler resolution.
    const catalogPath = '@earendil-works/pi-ai/providers/all';
    const rootPath = '@earendil-works/pi-ai';
    const compatPath = '@earendil-works/pi-ai/compat';
    const [catalog, root, compat] = await Promise.all([
      import(/* @vite-ignore */ catalogPath) as Promise<{
        getBuiltinModel: (provider: string, modelId: string) => unknown;
        getBuiltinModels: (provider: string) => Array<Record<string, unknown>>;
      }>,
      import(/* @vite-ignore */ rootPath) as Promise<{
        getSupportedThinkingLevels?: (model: unknown) => string[];
      }>,
      import(/* @vite-ignore */ compatPath) as Promise<{
        complete?: (model: unknown, context: unknown, options?: unknown) => Promise<unknown>;
        completeSimple?: (model: unknown, context: unknown, options?: unknown) => Promise<unknown>;
      }>,
    ]);
    return {
      getModel: catalog.getBuiltinModel,
      getModels: catalog.getBuiltinModels,
      getSupportedThinkingLevels: root.getSupportedThinkingLevels,
      complete: compat.complete,
      completeSimple: compat.completeSimple,
    };
  } catch {
    throw new Error(
      'pi-ai is not installed. Install @earendil-works/pi-ai to use ProviderManager.'
    );
  }
}

/**
 * Load pi's builtin provider list, asserting the symbol we need is really there.
 *
 * The assertion is the point. A dynamic import of a module that exports
 * nothing SUCCEEDS and yields `{}`, so a try/catch around the import cannot
 * detect an emptied entrypoint, and a cast to a hand-written all-optional
 * interface makes `{}` typecheck. That combination is exactly how pi-ai
 * gutting its `/oauth` entrypoint reached users as the false message
 * "provider does not support OAuth". Check for the function, and name it when
 * it is missing, so the next pi reshape fails loudly here instead of being
 * laundered into a plausible lie downstream.
 */
async function loadPiBuiltinProviders(): Promise<PiBuiltinProvider[]> {
  let mod: Record<string, unknown>;
  try {
    const modulePath = '@earendil-works/pi-ai/providers/all';
    mod = await import(/* @vite-ignore */ modulePath) as Record<string, unknown>;
  } catch {
    throw new Error(
      'pi-ai is not installed. Install @earendil-works/pi-ai to use OAuth features.',
    );
  }

  const builtinProviders = mod['builtinProviders'];
  if (typeof builtinProviders !== 'function') {
    throw new Error(
      'pi-ai/providers/all does not export builtinProviders(). The installed ' +
        'pi-ai is incompatible with this version of Cortex.',
    );
  }
  return (builtinProviders as () => PiBuiltinProvider[])();
}

/**
 * Resolve one provider's OAuth implementation, or null if it has none.
 */
export async function loadPiOAuth(providerId: string): Promise<PiOAuthAuth | null> {
  const providers = await loadPiBuiltinProviders();
  return providers.find(p => p.id === providerId)?.auth?.oauth ?? null;
}

/** Provider ids whose pi definition ships an OAuth flow. */
export async function loadOAuthCapableProviderIds(): Promise<string[]> {
  const providers = await loadPiBuiltinProviders();
  return providers.filter(p => p.auth?.oauth).map(p => p.id).sort();
}
