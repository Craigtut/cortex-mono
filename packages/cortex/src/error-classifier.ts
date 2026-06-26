/**
 * Error classifier for LLM and network errors.
 *
 * Maps error strings to actionable categories using regex pattern matching.
 * Follows the same pattern pi-ai uses for context overflow detection,
 * extended to cover authentication, rate limits, server errors, and network errors.
 *
 * The classifier is a pure function. It does not throw, does not modify state.
 * It takes an error (or error string) and returns a classification.
 *
 * Reference: error-recovery.md
 */

import type { ClassifiedError, ErrorCategory, ErrorSeverity } from './types.js';

// ---------------------------------------------------------------------------
// Pattern definitions per category (checked in priority order)
// ---------------------------------------------------------------------------

const AUTHENTICATION_PATTERNS: RegExp[] = [
  /invalid.api.key/i,
  /unauthorized/i,
  /\b401\b/,
  /not.logged.in/i,
  /login.*required/i,
  /please.*log.?in/i,
  /authentication.required/i,
  /re-?authenticate/i,
  /expired.*token/i,
  /token.*expired/i,
  /token.*(revoked|invalid)/i,
  /refresh.*token/i,
  /oauth.*(fail|error|expire|invalid|denied|revoke)/i,
  /session.*expired/i,
  /invalid.*credentials/i,
  /api.key.*invalid/i,
  /permission.denied.*key/i,
  /Could not resolve API key/i,
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate.limit/i,
  /too.many.requests/i,
  /\b429\b/,
  /rate_limit_exceeded/i,
  /throttl/i,
  /request.limit.reached/i,
  /quota.exceeded/i,
];

// Full context overflow detection delegates to pi-ai's isContextOverflow() when available.
// These minimal patterns serve as a fallback when pi-ai is not installed.
const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /context.*overflow/i,
  /too.many.tokens/i,
  /token.limit/i,
  /prompt.is.too.long/i,
];

const SERVER_ERROR_PATTERNS: RegExp[] = [
  /internal.server.error/i,
  /\b500\b/,
  /\b502\b.*bad.gateway/i,
  /\b503\b.*service.unavailable/i,
  /\b504\b.*gateway.timeout/i,
  /server.*error/i,
  /overloaded/i,
];

const NETWORK_PATTERNS: RegExp[] = [
  /ECONNREFUSED/,
  /ENOTFOUND/,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /network.*error/i,
  /fetch.failed/i,
  /socket.hang.up/i,
  /DNS.*resolution/i,
  // Anthropic SDK surfaces transient connection failures with these canonical
  // messages after its own retries are exhausted (APIConnectionError /
  // APIConnectionTimeoutError). Match them so they classify as network/retry
  // rather than falling through to unknown.
  /connection error/i,
  /timed out/i,
];

// ---------------------------------------------------------------------------
// Severity and action mappings
// ---------------------------------------------------------------------------

const SEVERITY_MAP: Record<ErrorCategory, ErrorSeverity> = {
  authentication: 'fatal',
  rate_limit: 'retry',
  context_overflow: 'recoverable',
  server_error: 'retry',
  network: 'retry',
  cancelled: 'recoverable',
  unknown: 'recoverable',
};

const SUGGESTED_ACTIONS: Record<ErrorCategory, string | undefined> = {
  authentication: 'Check your API key or re-authenticate in Settings.',
  rate_limit: 'Rate limit hit. The next tick will be delayed.',
  context_overflow: 'Context window exceeded. Compaction will run.',
  server_error: 'The provider is experiencing issues. Retrying.',
  network: 'Network error. Check your connection.',
  cancelled: undefined,
  unknown: undefined,
};

// ---------------------------------------------------------------------------
// Pattern matching helpers
// ---------------------------------------------------------------------------

function matchesAny(message: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

// ---------------------------------------------------------------------------
// Cause-chain extraction
// ---------------------------------------------------------------------------

const MAX_CAUSE_DEPTH = 6;
const MAX_CAUSE_LENGTH = 200;

/**
 * Walk an error's `cause` chain (and any AggregateError children) to build a
 * concise detail string describing the underlying failure.
 *
 * Node's fetch (undici) and the Anthropic SDK nest the real reason several
 * levels below a generic top-level message:
 *
 *   APIConnectionError("Connection error.")
 *     -> cause: TypeError("fetch failed")
 *       -> cause: Error { code: "ECONNRESET", message: "read ECONNRESET" }
 *
 * The top-level message ("Connection error.") tells the user nothing, so we
 * collect distinct, informative fragments from below it (error codes and
 * messages) and join them into e.g. "fetch failed: read ECONNRESET".
 *
 * Only the chain BELOW the top-level error is inspected; the top-level message
 * is already surfaced as `originalMessage`. Returns undefined when the chain
 * adds nothing (bare string, or no `cause`).
 */
export function extractCauseDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;

  const fragments: string[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown, depth: number): void => {
    if (value == null || depth > MAX_CAUSE_DEPTH || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Error) {
      const code = (value as { code?: unknown }).code;
      if (typeof code === 'string' && code.length > 0) fragments.push(code);
      const msg = value.message.trim();
      if (msg.length > 0) fragments.push(msg);
      // AggregateError holds sibling failures (e.g. DNS: every address attempt
      // failed). Visit them so at least one concrete reason surfaces.
      const errors = (value as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        for (const child of errors) visit(child, depth + 1);
      }
      visit((value as { cause?: unknown }).cause, depth + 1);
    } else if (typeof value === 'string') {
      const s = value.trim();
      if (s.length > 0) fragments.push(s);
    }
  };

  // Start at the cause (and any aggregated siblings), not the top-level error.
  const topErrors = (error as { errors?: unknown }).errors;
  if (Array.isArray(topErrors)) {
    for (const child of topErrors) visit(child, 1);
  }
  visit((error as { cause?: unknown }).cause, 1);

  if (fragments.length === 0) return undefined;

  // Dedupe, dropping any fragment fully contained in another already kept
  // (e.g. the bare code "ECONNRESET" inside "read ECONNRESET"). The longer,
  // more descriptive fragment wins.
  const kept: string[] = [];
  for (const frag of fragments) {
    if (kept.includes(frag) || kept.some((k) => k.includes(frag))) continue;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (frag.includes(kept[i]!)) kept.splice(i, 1);
    }
    kept.push(frag);
  }

  const detail = kept.join(': ');
  return detail.length > MAX_CAUSE_LENGTH
    ? `${detail.slice(0, MAX_CAUSE_LENGTH - 1)}…`
    : detail;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for the error classifier.
 */
export interface ClassifyErrorOptions {
  /**
   * The model's context window size in tokens.
   * Used for context overflow detection when delegating to pi-ai.
   */
  contextWindow?: number;

  /**
   * Whether the agent was aborted (user or system cancellation).
   * When true, the error is immediately classified as 'cancelled'.
   * The caller checks agent.state or AbortSignal.aborted and passes this flag;
   * the classifier itself remains pure.
   */
  wasAborted?: boolean;
}

/**
 * Classify an error into an actionable category.
 *
 * Checks error strings against regex patterns in priority order (first match wins):
 * 1. Cancelled (if wasAborted is true)
 * 2. Authentication (18 patterns)
 * 3. Rate limit (7 patterns)
 * 4. Context overflow (4 fallback patterns; delegates to pi-ai isContextOverflow when available)
 * 5. Server error (7 patterns)
 * 6. Network (8 patterns)
 * 7. Unknown (catch-all)
 *
 * @param error - The error to classify (Error object or string)
 * @param options - Optional classification options
 * @returns A ClassifiedError with category, severity, original message, and suggested action
 */
export function classifyError(
  error: Error | string,
  options?: ClassifyErrorOptions,
): ClassifiedError {
  const message = typeof error === 'string' ? error : error.message;
  // Pull the real reason out of the `cause` chain (undici/SDK bury it). Used
  // both to enrich the surfaced detail and to match patterns against, so a
  // buried code (e.g. ECONNRESET) routes correctly when the top message is
  // opaque ("Connection error.").
  const causeDetail = extractCauseDetail(error);
  const matchTarget = causeDetail ? `${message}\n${causeDetail}` : message;

  // 1. Cancelled (highest priority if wasAborted flag is set)
  if (options?.wasAborted) {
    return buildResult('cancelled', message, causeDetail);
  }

  // 2. Authentication
  if (matchesAny(matchTarget, AUTHENTICATION_PATTERNS)) {
    return buildResult('authentication', message, causeDetail);
  }

  // 3. Rate limit
  if (matchesAny(matchTarget, RATE_LIMIT_PATTERNS)) {
    return buildResult('rate_limit', message, causeDetail);
  }

  // 4. Context overflow
  // Uses built-in patterns. In Phase 1B, this will also delegate to
  // pi-ai's isContextOverflow() when available.
  if (matchesAny(matchTarget, CONTEXT_OVERFLOW_PATTERNS)) {
    return buildResult('context_overflow', message, causeDetail);
  }

  // 5. Server error
  if (matchesAny(matchTarget, SERVER_ERROR_PATTERNS)) {
    return buildResult('server_error', message, causeDetail);
  }

  // 6. Network
  if (matchesAny(matchTarget, NETWORK_PATTERNS)) {
    return buildResult('network', message, causeDetail);
  }

  // 7. Unknown (catch-all)
  return buildResult('unknown', message, causeDetail);
}

/**
 * Build a ClassifiedError from a category, original message, and optional
 * cause detail.
 */
function buildResult(
  category: ErrorCategory,
  originalMessage: string,
  causeDetail?: string,
): ClassifiedError {
  const action = SUGGESTED_ACTIONS[category];
  const result: ClassifiedError = {
    category,
    severity: SEVERITY_MAP[category],
    originalMessage,
  };
  // Only attach when it adds information beyond the original message.
  if (causeDetail !== undefined && causeDetail !== originalMessage) {
    result.causeDetail = causeDetail;
  }
  if (action !== undefined) {
    result.suggestedAction = action;
  }
  return result;
}
