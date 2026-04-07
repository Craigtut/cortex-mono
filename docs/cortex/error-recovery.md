# Error Recovery

> **STATUS: IMPLEMENTED**

How Cortex classifies, surfaces, and recovers from errors. Covers the error classifier module, auth failure detection, rate limit backoff, and integration with the 5-phase pipeline.

## Error Classification

Pi-ai surfaces all errors as plain `Error` objects with string messages. No error codes, no HTTP status codes, no structured types. The only structured detection pi-ai provides is `isContextOverflow()` (14+ provider-specific regex patterns).

Cortex implements a regex-based error classifier (`error-classifier.ts`) that maps error strings to actionable categories. This follows the same pattern pi-ai uses for context overflow detection, extended to cover other error types.

### Categories

Adapted from the existing `AgentErrorCategory` in `@animus-labs/agents`, simplified to categories that are actionable:

| Category | Severity | Description |
|----------|----------|-------------|
| `authentication` | fatal | Invalid API key, expired token, missing credentials |
| `rate_limit` | retry | Provider rate limit hit (429 equivalent) |
| `context_overflow` | recoverable | Context window exceeded. Handled by compaction. |
| `server_error` | retry | Provider 5xx or internal server error |
| `network` | retry | Connection failure, DNS resolution, timeout |
| `cancelled` | recoverable | Agent aborted by user or system |
| `unknown` | recoverable | Catch-all for unclassified errors |

Removed from the existing system (not actionable at the cortex level): `authorization`, `execution`, `resource_exhausted`, `not_found`, `invalid_input`, `unsupported`. These either don't apply to LLM calls or are too granular to classify from error strings.

### Classification Patterns

The classifier checks error strings against provider-specific regex patterns. Patterns are checked in priority order (first match wins).

**Authentication:**
```
/invalid.api.key/i
/unauthorized/i
/not.logged.in/i
/authentication.required/i
/expired.*token/i
/invalid.*credentials/i
/api.key.*invalid/i
/permission.denied.*key/i
/Could not resolve API key/i
```

**Rate Limit:**
```
/rate.limit/i
/too.many.requests/i
/429/
/rate_limit_exceeded/i
/throttl/i
/request.limit.reached/i
/quota.exceeded/i
```

**Context Overflow:**
Delegates to pi-ai's `isContextOverflow(message, contextWindow)` which already has 14+ patterns. Not duplicated in cortex.

**Server Error:**
```
/internal.server.error/i
/500/
/502.*bad.gateway/i
/503.*service.unavailable/i
/504.*gateway.timeout/i
/server.*error/i
/overloaded/i
```

**Network:**
```
/ECONNREFUSED/
/ENOTFOUND/
/ETIMEDOUT/
/ECONNRESET/
/network.*error/i
/fetch.failed/i
/socket.hang.up/i
/DNS.*resolution/i
```

**Cancelled:**
Detected by checking `agent.state.error` after abort, or `stopReason === "aborted"` on the response.

### Classifier API

```typescript
interface ClassifiedError {
  category: ErrorCategory;
  severity: 'fatal' | 'retry' | 'recoverable';
  originalMessage: string;
  suggestedAction?: string;
}

function classifyError(error: Error | string, options?: ClassifyErrorOptions): ClassifiedError;

interface ClassifyErrorOptions {
  /** Context window size in tokens. Used for context overflow detection. */
  contextWindow?: number;
  /** Whether the agent was aborted (user or system cancellation). When true, the error is immediately classified as 'cancelled'. */
  wasAborted?: boolean;
}
```

The classifier is a pure function. It does not throw, does not modify state. It takes an error (or error string) and returns a classification.

**Suggested actions** per category:
- `authentication`: "Check your API key or re-authenticate in Settings."
- `rate_limit`: "Rate limit hit. The next tick will be delayed."
- `context_overflow`: "Context window exceeded. Compaction will run."
- `server_error`: "The provider is experiencing issues. Retrying."
- `network`: "Network error. Check your connection."
- `cancelled`: null (user-initiated, no action needed)
- `unknown`: null

## Error Event Flow

When a pi-ai call fails:

```
Pi-ai error (plain Error)
  → classifyError() produces ClassifiedError
  → CortexAgent emits onError(ClassifiedError) event
  → Consumer (backend) receives and routes:
      → Log the error (always)
      → EventBus 'system:error' (for auth, rate_limit, server_error)
      → Frontend receives via onSystemError tRPC subscription
      → SystemErrorCard rendered in conversation view
```

### CortexAgent Error Event

```typescript
cortexAgent.onError((error: ClassifiedError) => {
  // Consumer handles routing
});
```

This fires for any error during the agentic loop (LLM call failures, not tool execution errors; those are handled by pi-agent-core internally and don't crash the loop).

### Consumer Error Routing

Consumers receive classified errors and decide how to handle them (retry, notify users, escalate, delay). A typical consumer error handler routes errors to its own event/notification system:

```typescript
cortexAgent.onError((error) => {
  log.error(`Agent error [${error.category}]:`, error.originalMessage);

  if (error.category === 'authentication') {
    // Surface to UI, halt processing
    notifyUser({
      category: 'authentication',
      message: error.originalMessage,
      recoverable: false,
      suggestedAction: error.suggestedAction,
    });
  }

  if (error.category === 'rate_limit') {
    // Notify user, delay next operation
    notifyUser({
      category: 'rate_limit',
      message: error.originalMessage,
      recoverable: true,
      suggestedAction: error.suggestedAction,
    });
    scheduler.delayNext(backoffMs);  // see Rate Limit Backoff below
  }

  if (error.category === 'server_error') {
    // Notify user, may retry
    notifyUser({
      category: 'server_error',
      message: error.originalMessage,
      recoverable: true,
      suggestedAction: error.suggestedAction,
    });
  }
});
```

The consumer decides which categories warrant user notification, which trigger retries, and which are silently logged.

## Auth Failure Detection

Two detection points:

### Pre-Call (Credential Resolution)

The `CortexCredentialService.resolveApiKey()` callback (provided to pi-ai via `getApiKey`) throws if:
- No API key is configured for the provider
- The encrypted key cannot be decrypted (vault locked)

These throw before the LLM call happens. The `CortexAgent` catches them and classifies as `authentication` / `fatal`.

### Post-Call (Provider Rejection)

The LLM call fails with an auth error string (e.g., "Invalid API key"). The error classifier detects this via regex patterns.

### Auth Event

Both detection points result in the same consumer event. The backend emits `system:error` with `category: 'authentication'`, which the frontend renders as a SystemErrorCard with the suggested action to check API keys.

## Automatic Retry for Transient Errors

Cortex provides built-in retry logic for transient errors (`rate_limit`, `server_error`, `network`). This runs inside `CortexAgent.prompt()`, wrapping the pi-agent-core agent loop. Retry is opt-in via the `retry` config field.

### Why Cortex Owns This

Provider-level retries exist but are inconsistent:
- **Anthropic SDK**: 2 retries (built-in)
- **Google Gemini CLI**: 3 retries with exponential backoff (custom in pi-ai)
- **OpenAI Codex**: 3 retries (custom in pi-ai)
- **OpenAI, Mistral, Google SDK**: SDK built-in (varies)
- **Groq, xAI, Cerebras, OpenRouter, etc.**: No retry at all

Pi-agent-core has no retry at the agent loop level. When an LLM call fails after provider-level retries are exhausted, the agent catches the error, appends an error message (`stopReason: "error"`), and stops. The consumer must handle retry.

Cortex sits at the right layer: above the inconsistent provider behavior, below the consumer. Every consumer benefits from uniform retry behavior without duplicating logic.

### Mechanism

Pi-agent-core provides `agent.continue()` for resuming after errors. Cortex wraps `prompt()` with retry logic that calls `continue()` after transient failures:

```typescript
// Inside CortexAgent.prompt()
let attempt = 0;
while (true) {
  try {
    const result = attempt === 0
      ? await this.agent.prompt(input)
      : await this.agent.continue();
    return result;
  } catch (err) {
    const classified = classifyError(err);

    if (classified.severity !== 'retry' || attempt >= this.retryConfig.maxRetries) {
      // Not retryable, or retries exhausted: emit error and throw
      this.emitError(classified);
      throw err;
    }

    attempt++;
    const delayMs = this.retryConfig.baseDelayMs * Math.pow(2, attempt - 1);

    // Emit retry event so consumers can show UI feedback
    this.emitRetry({ attempt, maxRetries: this.retryConfig.maxRetries, delayMs, error: classified });

    await sleep(delayMs);
  }
}
```

### Configuration

```typescript
interface RetryConfig {
  /** Maximum number of retry attempts. Default: 5. Set to 0 to disable. */
  maxRetries: number;
  /** Base delay in milliseconds for exponential backoff. Default: 2000. */
  baseDelayMs: number;
  /** Maximum delay in milliseconds. Default: 32000 (32 seconds). */
  maxDelayMs: number;
}
```

Default backoff schedule: 2s, 4s, 8s, 16s, 32s (5 retries, exponential with 32s cap).

### Events

Two new events on CortexAgent:

- **`onRetry(handler)`**: Fired before each retry attempt. Receives `{ attempt, maxRetries, delayMs, error }`. Consumers use this for UI feedback (e.g., "Rate limited, retrying in 8s...").
- **`onRetriesExhausted(handler)`**: Fired when all retries are exhausted. Receives the final `ClassifiedError`. Consumers use this to prompt the user (e.g., "Rate limited after 5 retries. Send another message to try again.").

### Error Categories and Retry Behavior

| Category | Severity | Retried? | Notes |
|----------|----------|----------|-------|
| `rate_limit` | retry | Yes | 429 or rate limit patterns |
| `server_error` | retry | Yes | 500, 502, 503, 504 |
| `network` | retry | Yes | Connection failure, DNS, timeout |
| `authentication` | fatal | No | Invalid key, expired token |
| `context_overflow` | recoverable | No | Handled by compaction, not retry |
| `cancelled` | recoverable | No | User abort |
| `unknown` | recoverable | No | Unclassified errors |

### Interaction with Provider-Level Retries

Provider SDKs retry internally before the error reaches Cortex. If a provider retries 2 times and Cortex retries 5 times, the total attempt count is higher. This is acceptable: the provider handles quick transient blips, and Cortex handles longer outages (e.g., a 30-second rate limit window that exceeds provider SDK retry budgets).

The `maxRetryDelayMs` option in pi-ai (used by Google Gemini CLI) caps server-requested delays at 60 seconds. If the server requests a longer delay, pi-ai throws immediately rather than waiting. Cortex's retry catches this throw and applies its own backoff schedule.

## Consumer-Specific Rate Limit Handling

The automatic retry above handles transient errors within a single `prompt()` call. Consumers may also need higher-level backoff between prompts:

### Heartbeat Consumers (e.g., Animus)

For consumers with autonomous tick loops, rate limits should also delay the next tick:

```typescript
cortexAgent.onRetriesExhausted((error) => {
  if (error.category === 'rate_limit') {
    consecutiveRateLimits++;
    const backoffMs = Math.min(
      30000 * Math.pow(2, consecutiveRateLimits - 1),
      300000  // max 5 minutes
    );
    tickQueue.delayNext(backoffMs);
  }
});

// On successful prompt completion
consecutiveRateLimits = 0;
```

### Interactive Consumers (e.g., Cortex Code)

For TUI consumers, the retry events drive UI feedback:

```typescript
cortexAgent.onRetry(({ attempt, maxRetries, delayMs }) => {
  tui.showRetryCountdown(attempt, maxRetries, delayMs);
});

cortexAgent.onRetriesExhausted((error) => {
  tui.showError(`${error.suggestedAction} Send another message to retry.`);
});
```

No additional retry logic needed in Cortex Code. The framework handles it.

## Integration with the 5-Phase Pipeline

Each phase of the pipeline (THOUGHT, AGENTIC LOOP, REFLECT) can fail independently. The error classifier runs on any failure. The per-phase failure handling sits above the classifier:

| Phase | On Error | Classification Used For |
|-------|----------|------------------------|
| THOUGHT | Skip thought, continue to agentic loop with no thought in context | Log + surface to UI. Auth errors halt the tick. |
| AGENTIC LOOP | Cortex automatic retry handles transient errors. If retries exhausted, check if any turns completed. If yes, use partial results. If no, use safe fallback output. | Log + surface to UI. Auth errors halt the tick. |
| REFLECT | Retry up to 3 times. If all fail, skip reflection (emotions/decisions for this tick are lost). | Log + surface to UI. Auth errors halt the tick. |
| Any phase | If `authentication`: halt the tick entirely, surface to UI, do not retry. | Auth is always fatal. |

### Context Overflow During Agentic Loop

Detected via pi-ai's `isContextOverflow()`. Handled by the compaction system (see `compaction-strategy.md`):
1. Reactive compaction triggers
2. The loop retries with the compacted context
3. If compaction fails, the emergency truncation layer fires
