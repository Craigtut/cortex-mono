/**
 * Cache breakpoint computation and payload stamping for Anthropic prompt caching.
 *
 * Cortex manages a 4-breakpoint budget on Anthropic requests:
 *   BP1: system prompt (set by pi-ai by default)
 *   BP2: after the last slot message (stable for the session lifetime)
 *   BP3: at the stable-context boundary (see below)
 *   BP4: last user message (set by pi-ai by default)
 *
 * Pi-ai also sets a breakpoint on the last tool definition; Cortex strips it
 * (along with extra OAuth identity system blocks) to stay within Anthropic's
 * 4-breakpoint limit.
 *
 * BP3 semantics differ by caller:
 * - Agentic loop: BP3 sits after the injected ephemeral/skill messages. Those
 *   are stable across ticks WITHIN a turn, so each tick reads the full prefix
 *   while new tick content (and churning background-task state) stays after
 *   the breakpoint.
 * - Direct completions: BP3 sits at the end of consumer-supplied history.
 *   Direct calls are one-shot, so the value is cross-call reuse of the
 *   slots+history prefix; per-call ephemeral content stays after BP3.
 *
 * Shared by the agentic loop (transformContext + onPayload hooks in
 * agent-loop.ts) and the direct completion endpoints (directComplete,
 * structuredComplete, utilityComplete).
 *
 * Reference: context-manager.md
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * API-level message indices where cache_control breakpoints are stamped.
 * Indices refer to positions in the final Anthropic `messages` array (after
 * pi-ai's convertMessages), not Cortex's internal message array. -1 means
 * the breakpoint does not apply.
 */
export interface CacheBreakpointIndices {
  bp2ApiIndex: number;
  bp3ApiIndex: number;
}

/**
 * Region boundaries in the Cortex-side message array.
 * - slotCount: messages [0, slotCount) are slot messages; BP2 lands on the
 *   last one that survives API conversion.
 * - boundary: messages [0, boundary) are the stable prefix; BP3 lands on the
 *   last surviving message before the boundary.
 */
export interface CacheBreakpointRegions {
  slotCount: number;
  boundary: number;
}

/**
 * Raw direct completion context: caller-assembled messages passed to pi-ai
 * verbatim. No Cortex context structuring, no BP2/BP3 breakpoints (pi-ai's
 * default system + last-user-message breakpoints still apply).
 */
export interface RawCompletionContext {
  systemPrompt: string;
  messages: unknown[];
}

/**
 * Structured direct completion context: the caller supplies the same
 * opinionated context regions the agentic loop uses, and Cortex assembles
 * the message array and applies its breakpoint strategy on top.
 *
 * Assembled order: [slots][history][ephemeral][prompt].
 *
 * Caching contract: byte-identical prefixes across calls are what produce
 * cache reads. Keep slots ordered most-stable-first and byte-stable across
 * calls; treat history as append-only.
 */
export interface StructuredCompletionContext {
  systemPrompt: string;
  /**
   * Stable context blocks, ordered most stable first. Each becomes a
   * user-role message before history. Empty/whitespace-only entries are
   * dropped. BP2 is placed after the last slot.
   */
  slots?: string[];
  /**
   * Consumer-managed conversation history in pi-ai message format
   * (role user/assistant/toolResult). Cortex stores nothing; pass the same
   * (append-only) array across calls to get prefix cache reads. BP3 is
   * placed at the end of history.
   */
  history?: unknown[];
  /**
   * Volatile per-call content, injected between history and the prompt.
   * Sits after BP3 so it never invalidates the cached prefix.
   */
  ephemeral?: string;
  /** The latest user message. Must be non-empty. */
  prompt: string;
}

export type DirectCompletionContext = RawCompletionContext | StructuredCompletionContext;

/**
 * A resolved direct completion context, ready to hand to pi-ai.
 * indices is null for raw contexts and for structured contexts that produced
 * no applicable breakpoints (no slots and no history).
 */
export interface ResolvedCompletionContext {
  systemPrompt: string;
  messages: unknown[];
  indices: CacheBreakpointIndices | null;
}

// ---------------------------------------------------------------------------
// API index computation
// ---------------------------------------------------------------------------

interface LooseMessage {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
}

/**
 * Would pi-ai's transformMessages remove this message entirely?
 * Errored/aborted assistant messages are dropped before conversion, so they
 * neither produce an API message nor break a consecutive toolResult run.
 */
function isRemovedByTransform(msg: LooseMessage): boolean {
  return (
    msg.role === 'assistant' &&
    (msg.stopReason === 'error' || msg.stopReason === 'aborted')
  );
}

/**
 * Would pi-ai's convertMessages emit no API message for this message?
 * Unlike transform-level removal, these messages are still present during
 * the consecutive-toolResult lookahead, so they DO break a merge run.
 */
function isSkippedByConversion(msg: LooseMessage): boolean {
  const { role, content } = msg;

  if (role === 'user') {
    if (typeof content === 'string') {
      return content.trim().length === 0;
    }
    if (Array.isArray(content)) {
      // convertMessages keeps image blocks and non-empty text blocks
      return !content.some((block: Record<string, unknown>) =>
        block['type'] === 'image' ||
        (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim().length > 0),
      );
    }
    return false;
  }

  if (role === 'assistant') {
    if (!Array.isArray(content)) return false;
    // convertMessages keeps toolCall blocks, thinking blocks (redacted or
    // non-empty), and non-empty text blocks
    return !content.some((block: Record<string, unknown>) => {
      if (block['type'] === 'toolCall') return true;
      if (block['type'] === 'thinking') {
        return block['redacted'] === true ||
          (typeof block['thinking'] === 'string' && block['thinking'].trim().length > 0);
      }
      if (block['type'] === 'text') {
        return typeof block['text'] === 'string' && block['text'].trim().length > 0;
      }
      return false;
    });
  }

  return false;
}

/**
 * Compute API message indices for cache breakpoints BP2 and BP3.
 *
 * Walks the Cortex-side message array and counts how messages will appear in
 * the final Anthropic API params after pi-ai's transformMessages and
 * convertMessages process them:
 * - errored/aborted assistant messages are removed (transform level)
 * - empty user messages and content-empty user/assistant messages are
 *   skipped (conversion level)
 * - consecutive `toolResult`-role messages merge into a single API message
 *
 * Known approximation: transformMessages can insert synthetic toolResult
 * messages for orphaned tool calls (assistant toolCall with no result before
 * the next user message). That shifts indices by the insertion count. It does
 * not occur in normal Cortex flows (pi-agent-core always appends results and
 * marks interrupted turns errored/aborted), and the cost of a miss is a
 * suboptimal breakpoint, not a request failure.
 *
 * BP2/BP3 use candidate assignment: each region's index is the API index of
 * the last message in that region that survives conversion. This keeps BP2
 * valid when trailing slots are empty and BP3 valid when the message at the
 * boundary edge is skipped.
 *
 * @param messages - The Cortex-side message array (post-injection for the loop)
 * @param regions - Region boundaries (see CacheBreakpointRegions)
 * @returns API indices for BP2 and BP3, -1 where not applicable
 */
export function computeCacheBreakpointIndices(
  messages: readonly unknown[],
  regions: CacheBreakpointRegions,
): CacheBreakpointIndices {
  const { slotCount } = regions;
  // A boundary beyond the array means the stable prefix is inconsistent with
  // the messages being sent; produce no BP3 rather than stamping churning content.
  const boundary = regions.boundary > messages.length ? -1 : regions.boundary;

  let apiIndex = -1;
  let bp2ApiIndex = -1;
  let bp3ApiIndex = -1;
  let inToolResultRun = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as LooseMessage | null | undefined;
    if (!msg || typeof msg !== 'object') {
      inToolResultRun = false;
      continue;
    }

    if (isRemovedByTransform(msg)) {
      // Removed before merging: does not break a toolResult run
      continue;
    }

    if (isSkippedByConversion(msg)) {
      // Present during merging but emits nothing: breaks a toolResult run
      inToolResultRun = false;
      continue;
    }

    if (msg.role === 'toolResult') {
      if (!inToolResultRun) {
        apiIndex++;
        inToolResultRun = true;
      }
      // else: merged into the same API message, don't increment
    } else {
      inToolResultRun = false;
      apiIndex++;
    }

    if (i < slotCount) {
      bp2ApiIndex = apiIndex;
    }
    if (i < boundary) {
      bp3ApiIndex = apiIndex;
    }
  }

  // BP3 only exists when the boundary region extends past the slot region
  // with content of its own; a duplicate breakpoint would waste a slot.
  if (bp3ApiIndex === bp2ApiIndex) {
    bp3ApiIndex = -1;
  }

  return { bp2ApiIndex, bp3ApiIndex };
}

// ---------------------------------------------------------------------------
// Payload stamping
// ---------------------------------------------------------------------------

/**
 * Add a cache_control marker to the last content block of an API message,
 * converting string content to a block array if needed.
 */
export function addCacheControlToMessage(
  message: Record<string, unknown>,
  cacheControl: unknown,
): void {
  const content = message['content'];
  if (Array.isArray(content) && content.length > 0) {
    const lastBlock = content[content.length - 1] as Record<string, unknown>;
    lastBlock['cache_control'] = cacheControl;
  } else if (typeof content === 'string') {
    message['content'] = [{
      type: 'text',
      text: content,
      cache_control: cacheControl,
    }];
  }
}

/**
 * Apply Cortex's cache breakpoint strategy to an Anthropic API payload.
 *
 * Mutates the payload in place:
 * 1. Strips cache_control from all system blocks except the last. OAuth
 *    tokens cause pi-ai to prepend an identity block with its own
 *    cache_control, consuming an extra breakpoint slot.
 * 2. Strips cache_control from tool definitions. Pi-ai sets it on the last
 *    tool, but Cortex manages its own 4-breakpoint budget (system, BP2, BP3,
 *    last user message) and the tool breakpoint is redundant.
 * 3. Stamps BP2 and BP3 onto the messages at the computed API indices,
 *    reusing the cache_control value pi-ai placed on the system prompt.
 *
 * Callers are responsible for provider gating (Anthropic only).
 *
 * @param payload - The Anthropic API params object (from pi-ai's onPayload hook)
 * @param indices - Precomputed API indices for BP2 and BP3
 * @returns The mutated payload, or undefined when no cache_control is active
 *   (e.g. cacheRetention 'none') or the payload has no messages
 */
export function applyCacheBreakpoints(
  payload: Record<string, unknown>,
  indices: CacheBreakpointIndices,
): Record<string, unknown> | undefined {
  const systemBlocks = payload['system'] as Array<Record<string, unknown>> | undefined;
  if (!systemBlocks || systemBlocks.length === 0) return undefined;
  const cacheControl = systemBlocks[systemBlocks.length - 1]!['cache_control'];
  if (!cacheControl) return undefined;

  for (let i = 0; i < systemBlocks.length - 1; i++) {
    delete systemBlocks[i]!['cache_control'];
  }

  const tools = payload['tools'] as Array<Record<string, unknown>> | undefined;
  if (tools) {
    for (const tool of tools) {
      delete tool['cache_control'];
    }
  }

  const messages = payload['messages'] as Array<Record<string, unknown>> | undefined;
  if (!messages) return undefined;

  if (indices.bp2ApiIndex >= 0 && indices.bp2ApiIndex < messages.length) {
    addCacheControlToMessage(messages[indices.bp2ApiIndex]!, cacheControl);
  }

  if (indices.bp3ApiIndex >= 0 && indices.bp3ApiIndex < messages.length &&
      indices.bp3ApiIndex !== indices.bp2ApiIndex) {
    addCacheControlToMessage(messages[indices.bp3ApiIndex]!, cacheControl);
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Direct completion context resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a direct completion context (raw or structured) into a message
 * array and breakpoint indices ready for a pi-ai complete() call.
 *
 * Raw contexts pass through untouched with null indices. Structured contexts
 * are assembled as [slots][history][ephemeral][prompt]:
 * - BP2 lands after the last non-empty slot
 * - BP3 lands at the end of history (ephemeral churns per call, so it stays
 *   outside the cached prefix)
 * - the prompt is the last user message, where pi-ai places its default
 *   breakpoint (useful when callers append turns to history across calls)
 *
 * @throws Error when the context is neither shape, both shapes, or has an
 *   empty prompt
 */
export function resolveDirectCompletionContext(
  context: DirectCompletionContext,
): ResolvedCompletionContext {
  const raw = context as Partial<RawCompletionContext>;
  const structured = context as Partial<StructuredCompletionContext>;
  const hasMessages = Array.isArray(raw.messages);
  const hasPrompt = typeof structured.prompt === 'string';

  if (hasMessages && hasPrompt) {
    throw new Error(
      'Direct completion context cannot mix shapes: provide either `messages` (raw) ' +
      'or `prompt` with optional `slots`/`history`/`ephemeral` (structured), not both.',
    );
  }

  if (hasMessages) {
    return {
      systemPrompt: raw.systemPrompt ?? '',
      messages: raw.messages as unknown[],
      indices: null,
    };
  }

  if (!hasPrompt) {
    throw new Error(
      'Direct completion context must provide either `messages` (raw) or `prompt` (structured).',
    );
  }

  const prompt = structured.prompt as string;
  if (prompt.trim().length === 0) {
    throw new Error('Structured completion context requires a non-empty `prompt`.');
  }

  const slotContents = (structured.slots ?? []).filter(
    (slot): slot is string => typeof slot === 'string' && slot.trim().length > 0,
  );
  const slotMessages = slotContents.map((content) => ({ role: 'user' as const, content }));
  const history = structured.history ?? [];

  const messages: unknown[] = [...slotMessages, ...history];
  const boundary = messages.length;

  if (typeof structured.ephemeral === 'string' && structured.ephemeral.trim().length > 0) {
    messages.push({ role: 'user' as const, content: structured.ephemeral });
  }
  messages.push({ role: 'user' as const, content: prompt });

  const indices = computeCacheBreakpointIndices(messages, {
    slotCount: slotMessages.length,
    boundary,
  });

  const hasBreakpoints = indices.bp2ApiIndex >= 0 || indices.bp3ApiIndex >= 0;
  return {
    systemPrompt: structured.systemPrompt ?? '',
    messages,
    indices: hasBreakpoints ? indices : null,
  };
}
