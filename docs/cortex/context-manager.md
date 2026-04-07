# Context Manager

> **STATUS: IMPLEMENTED**

The `ContextManager` is the core abstraction in `@animus-labs/cortex` for managing the content an agent sees. It owns two distinct responsibilities: **slots** (persistent, named content blocks in the message array) and **ephemeral context** (per-call content injected via `transformContext`, never stored). These are separate concepts with different lifecycles and APIs.

## Message Array Layout

The message array has four regions. The ContextManager owns the first and third; pi-agent-core organically grows the second; the fourth is the prompt input.

```
┌─────────────────────────────────────────────────┐
│  SLOT REGION (positions 0..N-1)                 │  Owned by ContextManager
│  Persistent, named, stability-ordered           │  Updated immediately via setSlot()
├─────────────────────────────────────────────────┤
│  CONVERSATION HISTORY (old, positions N..M)      │  Owned by pi-agent-core
│  Grows organically as agent runs                │  ContextManager does NOT touch this
│  User messages, assistant responses,            │
│  tool_use/tool_result pairs                     │
├ ─ ─ ─ ─ ─ ─ PREFIX CACHE BOUNDARY ─ ─ ─ ─ ─ ─ ┤
│  EPHEMERAL CONTEXT (injected in transformContext)│  Owned by ContextManager + Cortex
│  Consumer ephemeral, background task state,     │  Rebuilt every LLM call
│  loaded skill instructions                      │  Never stored in agent.state.messages
├─────────────────────────────────────────────────┤
│  CURRENT TICK CONTENT + USER PROMPT             │  New tool results + prompt
│  Content from the current agentic loop turn     │  Appended by pi-agent-core
└─────────────────────────────────────────────────┘
```

Consecutive user-role messages are valid: the Anthropic API auto-merges them into a single turn. No custom `convertToLlm` is needed.

### Prefix Caching

The layout is ordered so stable content is at the top and volatile content is at the bottom. All three major providers cache the longest unchanged prefix from the start of the request:

| Provider | Mode | Cache Read Discount | Min Tokens |
|----------|------|-------------------|------------|
| Anthropic | Explicit + automatic | 90% | 1,024-4,096 |
| OpenAI | Fully automatic | 50% | 1,024 |
| Google Gemini | Explicit + implicit | 75-90% | 1,024-4,096 |

When a slot in the middle changes, the prefix before it survives in cache; everything from the change point onward is billed at full input price. Conversation history that has not changed also benefits from caching since it sits between the stable slots and the volatile tail.

Ephemeral context and the user prompt sit below the cache boundary. They change every call, so they are never cached. This is intentional: placing them at the end means they do not invalidate the cache for everything above.

## Slots

Slots are persistent, named content blocks stored as user-role messages at the start of `agent.state.messages`. They are defined at `ContextManager` creation time as an ordered list. The order defines their position in the message array: first slot = position 0 (most stable, best cache life), last slot = position N-1 (least stable among slots). Slot count and names are static for the lifetime of the agent.

### API

```typescript
interface ContextManagerConfig {
  slots: string[];    // Ordered list of slot names. Order = position in message array.
}

class ContextManager {
  constructor(agent: Agent, config: ContextManagerConfig);

  // Update a slot's content. Immediately updates the corresponding
  // message in agent.state.messages at the slot's position.
  // Content is the raw string (including any formatting the consumer chooses).
  setSlot(name: string, content: string): void;

  // Read current slot content. If the underlying message uses a content
  // array (rather than a plain string), text parts are concatenated.
  // Returns null if the slot has not been set.
  getSlot(name: string): string | null;

  // Set ephemeral content for the next LLM call(s).
  // Injected at the end of the message array inside the transformContext hook.
  // Never written to agent.state.messages.
  // Pass null to clear.
  setEphemeral(content: string | null): void;

  // Read the current ephemeral content.
  getEphemeral(): string | null;

  // Returns a transformContext hook function that appends the ephemeral
  // content. The consumer registers this with the Agent (or composes it
  // with other transformContext logic like compaction).
  getTransformContextHook(): (context: AgentContext) => AgentContext;
}
```

### Constructor Initialization

When the ContextManager is constructed, it automatically reserves space for all declared slots by pushing empty user-role messages (`{ role: 'user', content: '' }`) into `agent.state.messages` at positions 0 through N-1 (where N is the number of slots). This ensures the message array always has the correct length from the start, so `setSlot()` can safely overwrite any position without gaps.

### Usage: How a Consumer Configures Slots

The consumer defines slots at startup and populates them with content built from its own data sources:

**Startup (once per process)**:

```typescript
const cm = new ContextManager(agent, {
  // Order = position. Most stable first for best prefix caching.
  // The constructor pre-initializes all slot positions with empty messages.
  slots: ['credentials', 'user-profile', 'project-context', 'history']
});

// Initial population from application state
cm.setSlot('credentials', buildCredentialContext(credentialStore));
cm.setSlot('user-profile', buildUserProfileContext(userStore));
cm.setSlot('project-context', buildProjectContext(projectStore));
cm.setSlot('history', buildHistoryContext(historyStore));
```

**Each tick (GATHER phase)**:

```typescript
// Only update slots whose source data actually changed.
// The mind tracks this via event bus signals (plugin:changed, persona:updated, etc.)
if (credentialsChanged) {
  cm.setSlot('credentials', buildCredentialContext(credentialStore));
}
if (contactsChanged) {
  cm.setSlot('contacts', buildContactsContext(contactStore));
}
if (coreSelfChanged) {
  cm.setSlot('core-self', buildCoreSelfContext(memoryStore));
}
if (workingMemoryChanged) {
  cm.setSlot('working-memory', buildWorkingMemoryContext(memoryStore, contactId));
}

// Each observation stream is tracked independently.
// Thoughts and experiences compress at different rates. Message observations
// are per-contact scoped and update when the observer processes that contact's
// messages. Splitting allows finer-grained cache preservation: if only thought
// observations update, the experience and message observation slots remain cached.
if (thoughtObservationsChanged) {
  cm.setSlot('thought-observations', buildThoughtObservationContext(memoryStore));
}
if (experienceObservationsChanged) {
  cm.setSlot('experience-observations', buildExperienceObservationContext(memoryStore));
}
if (messageObservationsChanged) {
  cm.setSlot('message-observations', buildMessageObservationContext(memoryStore, contactId));
}

if (goalsChanged) {
  cm.setSlot('goals', buildGoalContext(goalStore));
}
if (tasksChanged) {
  cm.setSlot('tasks', buildTaskContext(taskStore));
}

// Ephemeral context is always rebuilt every tick
cm.setEphemeral(buildTickContext(emotions, energy, trigger, retrievedMemories));
```

**Run the agentic loop**:

```typescript
await agent.prompt(tickPrompt);
```

The `build*Context()` functions are the mind's responsibility (they live in the backend's context builder). The ContextManager does not know or care what content goes into each slot. It just places the string at the correct position in the message array.

### Why Observations Are Split Into Three Slots

The observational memory system has three distinct streams (thoughts, experiences, messages), each with its own watermark and compression cycle. Splitting them into separate slots gives finer-grained cache preservation:

- **Thought observations** update when the thought observer compresses recent thoughts.
- **Experience observations** update when the experience observer compresses recent experiences. Thought and experience compression run independently, so one can update without affecting the other's cache.
- **Message observations** are per-contact scoped and update when the observer processes a specific contact's messages. They change on a completely different cadence from the other two.

If all three were combined in a single `observations` slot, any one stream updating would invalidate the cache for the entire block. With separate slots, only the changed slot forces a cache miss; the other two remain cached.

### How setSlot() Works

`setSlot()` replaces the entire message object at the corresponding position in `agent.state.messages` with a new `{ role: 'user', content }` object. This is a full replacement, not a merge. Because the constructor pre-initializes all slot positions with empty messages, there is always a valid entry at every slot index before the first `setSlot()` call.

### Content Formatting

The ContextManager does not impose any formatting. The consumer provides the full message content string, including any XML wrapping (e.g., `<app-context type="plugins">...</app-context>`). This keeps the ContextManager general-purpose.

## Ephemeral Context

Ephemeral context is per-call content that the LLM should see but that should NOT persist in `agent.state.messages`. It is appended at the end of the message array inside `transformContext`, after all conversation history, so it does not invalidate the prefix cache.

### What Goes in Ephemeral Context

There are two sources of ephemeral content, injected as separate user-role messages at the boundary position:

**1. Consumer ephemeral content** (via `setEphemeral()`): Anything the consumer wants the LLM to see per-call. Examples: environment info (cwd, git branch, model), runtime state, active contact context, emotional state, retrieved memories.

**2. Background task state** (automatic, framework-level): Cortex automatically builds and injects a `<background-tasks>` block describing running sub-agents and background bash processes. This gives the parent agent visibility into long-running work without requiring a tool call. Only running tasks are included; completed tasks deliver their results through the normal completion flow.

The background task block includes:
- **Running sub-agents**: task ID, instructions, duration, tool count, current tool activity (with "started N seconds ago" for hang detection), token usage, turn count with budget ceiling, and whether the sub-agent is waiting on a permission prompt
- **Running bash processes**: task ID, command, duration, last few lines of stdout

This block is omitted entirely when no background tasks are running.

### Composability

The consumer may need `transformContext` for other purposes (compaction, dynamic system prompt updates). The ContextManager provides its hook as a composable function, not as something that replaces the entire `transformContext` pipeline:

```typescript
const cm = new ContextManager(agent, { slots: [...] });

const agent = new Agent({
  transformContext: async (context) => {
    // 1. ContextManager injects ephemeral content
    context = cm.getTransformContextHook()(context);
    // 2. Consumer's own logic (compaction, etc.)
    context = await compactionHook(context);
    return context;
  },
  // ...
});
```

## What the ContextManager Does NOT Do

- **Manage conversation history**: The organic message accumulation from agent turns is entirely pi-agent-core's responsibility.
- **Format content**: No XML wrapping, no tags. The consumer formats content however they want.
- **Handle persistence**: Serializing `agent.state.messages` for crash recovery is the consumer's responsibility. Cortex provides `getConversationHistory()` and `restoreConversationHistory()` on the `CortexAgent`, not on the ContextManager.
- **Compact conversation history**: Compaction is a separate cortex capability that composes with the ContextManager via `transformContext`.
