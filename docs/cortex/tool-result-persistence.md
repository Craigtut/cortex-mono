# Tool Result Persistence

Cortex's proactive system for handling oversized tool results. Sits at the
tool execution boundary in `CortexAgent.refreshTools()` and processes every
tool's output before it enters the conversation.

## Why

Some tools (SubAgent, Bash, WebFetch, Grep, TaskOutput, MCP tools) can
produce results that are tens or hundreds of thousands of tokens. Letting
that flow into the conversation history wastes context, blows the prompt
cache prefix, and forces premature compaction.

The persistence interceptor catches oversized results at the moment a tool
returns, *before* they enter conversation history, and either:

1. **Persists** the full content to disk (when a `persistResult` callback is
   configured) and replaces the result with a bookend preview plus a file
   reference the agent can Read.
2. **Bookends** the result (when no callback is configured), keeping the
   first and last 1,500 chars and noting the truncation.

The same `PersistResultFn` callback also flows to the reactive paths in
compaction (microcompaction trim, aggregate budget enforcement). Consumers
configure it once at the top level.

## How It Fits

| Layer | When | Threshold | Action |
|-------|------|-----------|--------|
| **Per-tool interceptor** | Tool execution boundary | 25K tokens | Persist or bookend |
| Aggregate budget | `transformContext` after parallel tools complete | 150K tokens/turn | Persist or bookend largest first |
| `capToolResult` insertion-time | Insertion safety net | 50K tokens | Bookend (no persist) |
| Microcompaction trim | Threshold-driven trim of historic results | Variable by category | Persist or bookend |
| L3 emergency truncate | Context overflow | Hard cap | Truncate to fit |

The per-tool interceptor is the *first* line of defense. Subsequent layers
catch results that slip through (large MCP results, custom tools that
opt-out, etc.).

## The Callback

```typescript
type PersistResultFn = (
  content: string,
  metadata: {
    toolName: string;
    category: ToolCategory;
    /** Present when called from the proactive interceptor. */
    toolCallId?: string;
    /** Present when called from compaction. */
    messageIndex?: number;
  },
) => Promise<string>; // returns the file path
```

The consumer implements the actual I/O. Cortex passes the full content and
metadata; the consumer writes it somewhere (usually under
`~/.cortex/sessions/{session-id}/tool-results/`) and returns the absolute
path. The path is embedded in the replacement text so the agent can use the
Read tool to access the full content on demand.

## Configuration

```typescript
const agent = await CortexAgent.create({
  model: ...,
  systemPrompt: ...,
  
  persistResult: async (content, { toolName, toolCallId }) => {
    const filename = `${toolName}-${toolCallId ?? Date.now()}.md`;
    const fullPath = path.join(myToolResultsDir, filename);
    await fs.promises.writeFile(fullPath, content);
    return fullPath;
  },
});
```

That single callback flows down to:
- The proactive per-tool interceptor (this module)
- `MicrocompactionConfig.persistResult` for reactive trim/clear paths
- `capIncomingToolResults` aggregate budget enforcement

If both `config.persistResult` and `config.compaction.microcompaction.persistResult`
are set, the top-level wins (and the override is logged at debug level).

## Consumer Integration Guide

Cortex doesn't prescribe *where* to write files, only that the returned path
is absolute and readable for the remainder of the conversation. A few
practices make life easier for consumers:

**Session-segment the output directory.** Tool results belong to the
conversation that produced them. Write under a per-session subdirectory
(e.g. `~/.cortex/sessions/{sessionId}/tool-results/`) so they're easy to
garbage-collect when a session is deleted and trivially scoped during
debugging.

**Pick filenames that are stable when you have a `toolCallId` and
content-derived when you don't.**

- **Proactive path** (`toolCallId` present): `{toolName}-{toolCallId}.md` is
  stable and idempotent. If the same tool call is persisted twice, the
  second write overwrites the first with identical content.
- **Reactive path** (`messageIndex` present, `toolCallId` absent):
  `messageIndex` alone is not unique — a single message can contain multiple
  tool results. Suffix with a short hash of the content (e.g.
  `{toolName}-msg{messageIndex}-{sha8}.md`) to avoid collisions.

**Lazy-create the directory on first call.** Don't pre-create an empty
`tool-results/` dir for sessions that never persist anything; `mkdir
{ recursive: true }` on the first invocation is enough.

**Returned paths must survive your session save/load cycle.** Cortex embeds
the path in the message `content` (not in a sidecar field), so as long as
your persistence layer preserves message content, the path survives reload
and the agent can continue to Read it in later turns.

**Cleanup is your concern.** Cortex never deletes files it didn't create.
If you delete a session, delete its `tool-results/` subdirectory along with
it; a recursive `rm` of the session directory handles this naturally.

**`.md` vs `.txt`.** Either works. Markdown renders nicely if the file is
ever opened by a human, and the agent (which is most often the reader) is
comfortable with either.

A reference implementation lives in
`packages/cortex-code/src/persistence/sessions.ts` (`createToolResultPersistor`).

## Preview Format

**With persistence:**

```
[Result persisted: /path/to/tool-results/SubAgent-abc123.txt (45,230 chars, ~11,308 tokens)]

{first 1,500 chars of original content}

... [~9,500 tokens trimmed] ...

{last 1,500 chars of original content}

Use the Read tool with offset/limit to examine specific sections.
```

**Without persistence (bookend only):**

```
[Result truncated: ~11,308 tokens exceeded 25,000 token limit]

{first 1,500 chars}

... [~9,500 tokens trimmed] ...

{last 1,500 chars}
```

## Tool Skip Set

Tools whose results bypass the interceptor entirely:

| Tool | Why |
|------|-----|
| `Read` | Content is already on disk; the agent can re-Read with a smaller offset/limit |
| `Edit` | Returns a short confirmation string |
| `Write` | Returns a short confirmation string |
| `Glob` | Capped at 100 file paths (always small) |

All other built-in tools (Grep, Bash, WebFetch, SubAgent, TaskOutput) and
all MCP tools flow through the interceptor.

## Constants and Per-Tool Thresholds

```typescript
export const MAX_RESULT_TOKENS = 25_000;
export const BOOKEND_CHARS = 1_500;     // head + tail each
export const SKIP_RESULT_PERSISTENCE = new Set([
  'Read', 'Edit', 'Write', 'Glob',
]);
export const DEFAULT_TOOL_THRESHOLDS: Record<string, number> = {
  Bash: 7_500,
};
```

The 25K threshold sits below `capToolResult`'s 50K insertion-time ceiling so
the interceptor catches oversized results first. Bookend size of
1,500 chars ≈ 375 tokens per side; preview total ≈ 750 tokens.

### Per-Tool Threshold Resolution

Different tools have different output characteristics. Bash output is
verbose with low signal density (logs, stack traces, build spam), so it's
capped tighter at 7,500 tokens by default. Grep results, by contrast, are
dense matches and use the full 25K. Other tools default to 25K unless
listed in `DEFAULT_TOOL_THRESHOLDS`.

**Resolution order:**
1. Consumer override on `CortexAgentConfig.toolResultThresholds`
2. Built-in `DEFAULT_TOOL_THRESHOLDS`
3. `MAX_RESULT_TOKENS` (25,000)

Consumers can tune any tool (built-in, MCP, custom) without forking:

```typescript
const agent = await CortexAgent.create({
  // ...
  toolResultThresholds: {
    'mcp__playwright__browser_snapshot': 5_000,  // very chatty
    'CustomDeepResearchTool': 50_000,            // valuable, keep more
    'Bash': 12_000,                              // override built-in default
  },
});
```

## Implementation Notes

- The interceptor only operates on `text` content parts. Image parts
  (returned by Read for image files) pass through unchanged.
- Persistence failures fall back gracefully to bookend-only — no errors
  surface to the agent.
- Image and other non-text parts in the same result are preserved
  unchanged; only text parts that exceed the threshold are processed.
- The `toolCategories` from `MicrocompactionConfig` are reused for category
  resolution, so consumers don't need to declare them separately.

## File Locations

- `packages/cortex/src/tool-result-persistence.ts` — the interceptor module
- `packages/cortex/src/cortex-agent.ts` — wired into `refreshTools()` and
  `applyToolResultPersistence()` private method
- `packages/cortex/src/types.ts` — `PersistResultFn` type, `persistResult`
  on `CortexAgentConfig`
- `packages/cortex/src/compaction/microcompaction.ts` — `applyBookend()`
  reused for preview formatting
- `packages/cortex/src/compaction/index.ts` — `capIncomingToolResults()`
  uses the same callback for aggregate budget enforcement

See also: `docs/cortex/compaction-strategy.md` for how the reactive paths
fit together with the proactive interceptor.
