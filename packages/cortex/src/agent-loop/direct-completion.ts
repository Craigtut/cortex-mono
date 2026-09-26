/**
 * Direct (non-agentic) completions: one model call, no tools run, no
 * transcript. directComplete and structuredComplete use the primary
 * model, utilityComplete the utility model; all three share credential
 * resolution, cache options, abort and silent-error handling, usage
 * accounting, and error surfacing through the loop's onError.
 */

import {
  applyCacheBreakpoints,
  resolveDirectCompletionContext,
} from '../cache-breakpoints.js';
import type { CacheBreakpointIndices, DirectCompletionContext } from '../cache-breakpoints.js';
import { toError } from '../error-classifier.js';
import type { CortexModel } from '../model-wrapper.js';
import { assistantText, assistantUsage, toolCallArguments } from '../pi-message.js';
import { parseSchemaCompletion, structuredCompletionRequest } from '../structured-completion.js';
import type { CortexLogger, CortexUsage } from '../types.js';
import type { CacheRetention, PiModel } from './pi-agent.js';
import type { UsageLedger } from './usage-ledger.js';

export interface DirectCompletionOptions {
  cacheRetention?: CacheRetention;
  /**
   * Per-call cache affinity key, sent as the `x-session-affinity` header on
   * Anthropic requests so repeated calls route to the same cache. Defaults to
   * the agent's sessionId. Set a distinct value per pipeline when running
   * several independent direct-completion pipelines with different stable
   * prefixes.
   */
  sessionId?: string;
  /**
   * Optional abort signal to cancel an in-flight completion. When the signal
   * fires, the call rejects with an `AbortError` (an Error whose `name` is
   * `'AbortError'`) so callers can distinguish caller-initiated cancellation
   * from a genuine failure. Applies to `directComplete`, `structuredComplete`,
   * and `utilityComplete`.
   */
  signal?: AbortSignal;
  /**
   * Category tag this completion's spend is recorded under in the loop's
   * session usage (see SessionUsage.utility) and on the emitted
   * utility_usage event. Cortex tags its internal calls ('observer',
   * 'reflector', 'summarization', 'webfetch', 'bash_utility'); consumer
   * calls default to 'direct', 'structured', or 'utility' by entry point.
   */
  usageCategory?: string;
}

export interface DirectCompletionPorts {
  models(): { primary: CortexModel; primaryPi: PiModel; utility: CortexModel; utilityPi: PiModel };
  getApiKey: ((provider: string) => Promise<string>) | undefined;
  cacheRetention(): CacheRetention | null;
  sessionId(): string | null;
  isAborted(): boolean;
  emitError(error: Error, wasAborted?: boolean): void;
  /** Report a call's spend (the loop's utility_usage event feeds the ledger). */
  emitUtilityUsage(category: string, usage: CortexUsage): void;
  ledger: UsageLedger;
  logger: CortexLogger;
}

type CompleteFn = typeof import('@earendil-works/pi-ai/compat').complete;

/** What distinguishes one direct entry point from another. */
interface CompletionSpec<T> {
  entry: 'directComplete' | 'structuredComplete' | 'utilityComplete';
  target: 'primary' | 'utility';
  missingDependencyMessage: string;
  defaultUsageCategory: string;
  /** Extra request context and options, built once credentials resolved. */
  request?: () => { context: Record<string, unknown>; options: Record<string, unknown> };
  logFields?: Record<string, unknown>;
  read(result: unknown): T;
}

export class DirectCompletions {
  constructor(private readonly ports: DirectCompletionPorts) {}

  /**
   * Make a direct LLM completion call using the primary model.
   * NOT an agentic tool-use loop. Used for structured output phases
   * like THOUGHT and REFLECT where a single LLM response is needed
   * without tool execution.
   *
   * Accepts either a raw context ({ systemPrompt, messages }) passed to
   * pi-ai verbatim, or a structured context ({ systemPrompt, slots?,
   * history?, ephemeral?, prompt }) that Cortex assembles with the same
   * cache breakpoint strategy the agentic loop uses. See
   * StructuredCompletionContext for the caching contract.
   *
   * Dynamically imports pi-ai's complete() function. If pi-ai is not
   * installed, throws a clear error.
   *
   * @param context - Raw or structured completion context
   * @returns The response text from the LLM
   * @throws Error if pi-ai is not installed or the call fails
   */
  direct(context: DirectCompletionContext, options?: DirectCompletionOptions): Promise<string> {
    return this.run({
      entry: 'directComplete',
      target: 'primary',
      missingDependencyMessage:
        'directComplete() requires @earendil-works/pi-ai to be installed. ' +
        'Install it as a dependency or peer dependency.',
      defaultUsageCategory: 'direct',
      read: assistantText,
    }, context, options);
  }

  /**
   * Make a structured output LLM call using the tool-call-as-structured-output pattern.
   *
   * Defines a tool whose input_schema matches the desired output structure,
   * passes it via pi-ai's complete() with tools, and extracts the tool call
   * arguments as the structured result. This works across all providers that
   * support tool use (Anthropic, OpenAI, Google, Mistral, etc.) without
   * needing provider-specific structured output parameters.
   *
   * Accepts the same raw or structured contexts as directComplete(). Note
   * for cached structured contexts: tool definitions precede the system
   * prompt in Anthropic's cacheable prefix, so keep the schema byte-stable
   * across calls or the whole prefix misses.
   *
   * @param context - Raw or structured completion context
   * @param schema - Tool schema defining the structured output shape (TypeBox or JSON Schema)
   * @param toolName - Name for the virtual tool (default: 'structured_output')
   * @param toolDescription - Description for the virtual tool
   * @returns The parsed tool call arguments, or null if the model didn't call the tool
   */
  structured(
    context: DirectCompletionContext,
    schema: unknown,
    toolName: string,
    toolDescription: string,
    options?: DirectCompletionOptions,
  ): Promise<Record<string, unknown> | null> {
    const tool = {
      name: toolName,
      description: toolDescription,
      parameters: schema,
    };
    const primary = (): CortexModel => this.ports.models().primary;
    return this.run({
      entry: 'structuredComplete',
      target: 'primary',
      missingDependencyMessage: 'structuredComplete() requires @earendil-works/pi-ai to be installed.',
      defaultUsageCategory: 'structured',
      // The provider capability selects native schema output or a forced tool.
      request: () => structuredCompletionRequest(primary(), schema, tool),
      logFields: { toolName },
      read: (result) => primary().capabilities?.structuredOutput === 'json-schema'
        ? parseSchemaCompletion(result, schema)
        : toolCallArguments(result, toolName),
    }, context, options);
  }

  /**
   * Make a utility completion call using the utility model.
   * Convenience wrapper for internal operations (WebFetch summarization,
   * safety classification, etc.).
   *
   * Analogous to directComplete() but uses the utility model (smaller, cheaper)
   * instead of the primary model. Accepts the same raw or structured contexts
   * as directComplete(). Dynamically imports pi-ai's complete() function.
   *
   * @param context - Raw or structured completion context
   * @returns The response text from the LLM
   * @throws Error if pi-ai is not installed or the call fails
   */
  utility(context: DirectCompletionContext, options?: DirectCompletionOptions): Promise<string> {
    return this.run({
      entry: 'utilityComplete',
      target: 'utility',
      missingDependencyMessage:
        'utilityComplete() requires @earendil-works/pi-ai to be installed. ' +
        'Install it as a dependency or peer dependency.',
      defaultUsageCategory: 'utility',
      read: assistantText,
    }, context, options);
  }

  private async run<T>(
    spec: CompletionSpec<T>,
    context: DirectCompletionContext,
    options?: DirectCompletionOptions,
  ): Promise<T> {
    // pi-ai 0.80 relocated complete() to the temporary /compat shim; pinned
    // here pending the planned createModels() migration (Phase 2).
    let completeFn: CompleteFn;
    try {
      const piAi = await import('@earendil-works/pi-ai/compat');
      completeFn = piAi.complete;
    } catch {
      throw new Error(spec.missingDependencyMessage);
    }

    // Validate and assemble the context. Structured contexts get the
    // [slots][history][ephemeral][prompt] layout plus BP2/BP3 indices.
    const resolved = resolveDirectCompletionContext(context);

    const models = this.ports.models();
    const model = spec.target === 'primary' ? models.primary : models.utility;
    const piModel = spec.target === 'primary' ? models.primaryPi : models.utilityPi;

    // Resolve the API key for the model's provider. A resolution failure is
    // remembered rather than swallowed: pi-ai may still succeed via env vars,
    // but if the call below fails we surface this (more actionable) cause
    // instead.
    let apiKey: string | undefined;
    let keyError: Error | undefined;
    if (this.ports.getApiKey) {
      try {
        apiKey = await this.ports.getApiKey(model.provider);
      } catch (err) {
        keyError = toError(err);
      }
    }

    this.ports.ledger.lastDirect = null;
    const completeOptions = this.completeOptions(apiKey, options, resolved.indices);
    const request = spec.request?.();

    const startMs = Date.now();
    try {
      // Pass messages through to pi-ai as-is. Pi-ai's transformMessages() and
      // provider-specific convertMessages() handle all format normalization:
      // UserMessage (string or content blocks), AssistantMessage (content block
      // arrays with text/thinking/toolCall), and ToolResultMessage.
      const result = await completeFn(
        piModel as unknown as Parameters<CompleteFn>[0],
        {
          systemPrompt: resolved.systemPrompt,
          messages: resolved.messages,
          ...request?.context,
        } as Parameters<CompleteFn>[1],
        (request
          ? { ...(completeOptions ?? {}), ...request.options }
          : completeOptions) as Parameters<CompleteFn>[2] | undefined,
      );

      // Caller-initiated cancellation takes precedence over error/usage handling.
      throwIfAborted(result, options?.signal);

      // Check for silent errors: pi-ai resolves with stopReason 'error' instead of throwing
      checkForSilentError(result);

      const usage = assistantUsage(result);
      this.ports.ledger.lastDirect = usage;
      if (usage) {
        this.ports.emitUtilityUsage(options?.usageCategory ?? spec.defaultUsageCategory, usage);
      }

      this.ports.logger.debug(spec.entry, {
        ...spec.logFields,
        durationMs: Date.now() - startMs,
        usage,
      });

      return spec.read(result);
    } catch (err) {
      throw this.surfaceError(err, keyError, options?.signal);
    }
  }

  /**
   * Handle an error thrown by a direct (non-agentic) completion path
   * (directComplete / structuredComplete / utilityComplete).
   *
   * Prefers the original credential-resolution error as the cause when present,
   * since "OAuth refresh failed" / "Vault is sealed" is more actionable than the
   * downstream provider error that results from calling without a key. Classifies
   * and emits the error through onError (so auth failures in THOUGHT/REFLECT/
   * utility phases surface like loop failures), then returns the error to throw.
   */
  private surfaceError(
    err: unknown,
    keyError: Error | undefined,
    signal?: AbortSignal,
  ): Error {
    const downstream = toError(err);
    const aborted =
      this.ports.isAborted() || (signal?.aborted ?? false) || downstream.name === 'AbortError';
    const cause = aborted ? downstream : (keyError ?? downstream);
    this.ports.emitError(cause, aborted);
    return cause;
  }

  private completeOptions(
    apiKey: string | undefined,
    options?: DirectCompletionOptions,
    breakpointIndices?: CacheBreakpointIndices | null,
  ): Record<string, unknown> | undefined {
    const completeOptions: Record<string, unknown> = {};
    const cacheRetention = options?.cacheRetention ?? this.ports.cacheRetention();
    const sessionId = options?.sessionId ?? this.ports.sessionId();

    if (apiKey) completeOptions['apiKey'] = apiKey;
    if (cacheRetention) completeOptions['cacheRetention'] = cacheRetention;
    if (sessionId) completeOptions['sessionId'] = sessionId;
    if (options?.signal) completeOptions['signal'] = options.signal;

    // Structured contexts carry BP2/BP3 indices; stamp them onto the payload
    // via pi-ai's onPayload hook, same as the agentic loop does.
    if (breakpointIndices) {
      completeOptions['onPayload'] = (
        payload: Record<string, unknown>,
        model: Record<string, unknown>,
      ) => {
        if (!model || model['provider'] !== 'anthropic') return undefined;
        return applyCacheBreakpoints(payload, breakpointIndices);
      };
    }

    return Object.keys(completeOptions).length > 0 ? completeOptions : undefined;
  }
}

/**
 * Check if a pi-ai result represents a silent error.
 *
 * Pi-ai's stream wrapper catches errors and resolves the promise with an
 * output object that has stopReason 'error' and errorMessage set, instead
 * of throwing. This means callers never see the error unless they check.
 * This method surfaces those silent errors as thrown exceptions so they
 * propagate properly (e.g., to retry logic).
 */
function checkForSilentError(result: unknown): void {
  if (!result || typeof result !== 'object') return;
  const msg = result as Record<string, unknown>;
  if (msg['stopReason'] === 'error') {
    const errorMessage = typeof msg['errorMessage'] === 'string'
      ? msg['errorMessage']
      : 'Unknown pi-ai error (stopReason=error)';
    throw new Error(`LLM call failed: ${errorMessage}`);
  }
}

/**
 * Surface a caller-aborted completion as a throwable `AbortError`.
 *
 * Pi-ai resolves (it does not throw) with stopReason 'aborted' when the
 * supplied AbortSignal fires mid-flight. We also check the signal directly
 * to cover the race where abortion lands just after a result resolved: the
 * caller signalled they no longer want this completion, so we discard it.
 * Throwing an Error named 'AbortError' lets callers distinguish caller
 * cancellation from genuine failure via the standard `err.name` idiom, and
 * must be checked before `checkForSilentError` so an abort is never
 * misreported as an LLM error.
 */
function throwIfAborted(result: unknown, signal?: AbortSignal): void {
  const resultAborted =
    !!result &&
    typeof result === 'object' &&
    (result as Record<string, unknown>)['stopReason'] === 'aborted';
  if (signal?.aborted || resultAborted) {
    const err = new Error('Completion aborted');
    err.name = 'AbortError';
    throw err;
  }
}
