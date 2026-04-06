# Cortex Code: Context Design

This document describes how Cortex Code composes the context window using Cortex's context management architecture. The "system prompt" is one piece of the context surface; slots and ephemeral regions are equally important and serve different purposes.

## Cortex Context Architecture (Recap)

Cortex structures the context window into four regions, ordered for prefix cache stability:

```
┌─────────────────────────────────────────────────┐
│  SLOT REGION                                    │  Named, persistent, stability-ordered
│  Most stable content at the top                 │  
├─────────────────────────────────────────────────┤
│  CONVERSATION HISTORY                           │  Grows with the agentic loop
│  Managed by compaction                          │  
├ ─ ─ ─ ─ ─ PREFIX CACHE BOUNDARY ─ ─ ─ ─ ─ ─ ─ ┤
│  EPHEMERAL CONTEXT                              │  Rebuilt every LLM call
│  Never persisted, never invalidates cache above │  
├─────────────────────────────────────────────────┤
│  CURRENT PROMPT                                 │  User input for this turn
└─────────────────────────────────────────────────┘
```

Stable content at the top, volatile content at the bottom. Slots at the top rarely change and get the best cache life. Ephemeral content at the bottom changes every call without invalidating anything above.

## What Cortex Handles Automatically

Several context concerns are handled by Cortex internally. Cortex Code does not need to manage these:

- **System prompt operational rules**: Cortex appends its own operational sections (response delivery, system rules, taking action, tool usage, executing with care, environment info) after the consumer's base prompt. The consumer only provides identity and domain-specific content.
- **Tool schemas**: Cortex registers all tools (built-in, consumer-provided, MCP-discovered) and syncs them to pi-agent-core. Tool schemas appear in the API request automatically.
- **Skill listing and injection**: Cortex surfaces skill names and descriptions through the `load_skill` tool's description. When a skill is loaded, its content is injected into the message array automatically as `<skill-instructions>` blocks. The consumer just calls `registerSkill()`.
- **Permission handling**: Purely at the tool-call level via the `beforeToolCall` hook. The system prompt includes a generic line about the permission system. No per-tool permission state is injected into context.
- **Compaction**: Cortex's three-layer compaction (microcompaction, summarization, emergency truncation) manages the conversation history region automatically. Slots are never touched by compaction.

## What Cortex Code Must Provide

### Slots

Cortex Code defines slots at agent creation and populates them via `setSlot(name, content)`. Slots occupy the front of the message array in declared order. Cortex does not auto-populate any slot.

| Position | Slot Name | Content | Update Frequency |
|----------|-----------|---------|------------------|
| 0 | `system-prompt` | Base prompt: identity, behavioral rules, coding guidelines | Never changes during a session |
| 1 | `project-context` | Merged content from `agents.md` / `claude.md` walk-up discovery | Changes only if user changes CWD |

Position 0 gets the best cache life. The system prompt never changes mid-session, so it sits first.

### Base System Prompt (Slot 0)

This is the base prompt passed via `initialBasePrompt`. Cortex appends its own operational rules after this content. The base prompt should be minimal: under 500 tokens, covering only identity and domain-specific behavioral rules that Cortex does not already handle.

```
You are a coding assistant operating inside Cortex Code, a terminal-based coding agent.

You help users by reading files, executing commands, editing code, and writing new files.
You have access to tools for interacting with the filesystem and running shell commands.

## Guidelines

- Be concise. Lead with the answer or action, not the reasoning.
- Read files before modifying them. Understand existing code before suggesting changes.
- Prefer dedicated tools over shell commands for file operations (use Read instead of cat, Edit instead of sed, Glob instead of find, Grep instead of grep).
- Make the smallest change that solves the problem. Do not refactor surrounding code, add unnecessary abstractions, or make improvements beyond what was asked.
- Do not add comments, docstrings, or type annotations to code you did not change.
- When editing code, preserve the existing style and conventions of the codebase.
- Be careful not to introduce security vulnerabilities. Validate at system boundaries.

## Safety

- Do not run destructive commands (rm -rf, git reset --hard, force push) without explicit user approval.
- Do not commit, push, or modify shared state without being asked.
- Do not create files unless necessary. Prefer editing existing files.
- Never write secrets, credentials, or API keys to files.

## Communication

- Show file paths clearly when referencing code.
- When referencing functions or code locations, use the format file_path:line_number.
- If you are unsure about something, say so. Do not guess.
```

### Design Principles for the Base Prompt

1. **Lean.** Under 500 tokens. Cortex already appends extensive operational rules (tool usage patterns, action safety, response delivery). The base prompt only needs to cover what Cortex does not: identity and coding-specific guidelines.

2. **Behavioral, not aspirational.** Every instruction should be something the model can concretely follow or violate. No vague directives like "be helpful" or "think step by step."

3. **Static.** The base prompt does not change during a session. Everything dynamic goes in the ephemeral region.

4. **Mode-specific.** Other modes would provide a different base prompt. The build mode prompt is coding-focused.

### Project Context (Slot 1)

Concatenated content from the `agents.md` / `claude.md` walk-up discovery. Files are collected from CWD up to root and concatenated root-first, closest-last. The global file at `~/.cortex/agents.md` is concatenated first. There is no structured merge or override; all files are included in full.

This slot contains whatever the user and project define: coding conventions, architecture notes, team rules, repo-specific instructions. Cortex Code does not interpret or transform this content; it passes it through as-is, wrapped in a clear delimiter:

```
<project-context>
## /path/to/root/agents.md
[content]

## /path/to/package/agents.md
[content]
</project-context>
```

### Ephemeral Context

Set via `contextManager.setEphemeral(content)`. Rebuilt before each LLM call. Changes here never invalidate the prefix cache. This is where volatile, per-call information lives:

| Content | Example |
|---------|---------|
| Current working directory | `/Users/dev/my-project` |
| Current date | `2026-04-04` |
| Git status summary | `branch: main, 2 modified files` |
| Active model | `claude-sonnet-4-6` |
| YOLO mode indicator | `YOLO mode is active: all tools auto-approved` |
| Token budget remaining | `Budget: 42k / 100k tokens used` |

Format:

```
<environment>
Current date: 2026-04-04
Current working directory: /Users/dev/my-project
Git branch: main (2 modified, 1 untracked)
Model: claude-sonnet-4-6
</environment>
```

The ephemeral content is updated before each LLM call. Git status, token counts, and YOLO state can all change between turns.

## What Does NOT Go in Context

- **Tool schemas**: Handled by Cortex automatically.
- **Skill listings**: Handled by Cortex via the `load_skill` tool description.
- **Permission rules**: Handled at the tool-call level, not in context.
- **Loaded skill content**: Injected by Cortex automatically when skills are loaded.
- **Conversation history management**: Owned by Cortex's compaction system.
- **Operational rules**: Appended by Cortex after the base prompt.

## Context Budget

For a 200k token context window, approximate budget allocation:

| Region | Budget | Notes |
|--------|--------|-------|
| Slots (base prompt + project context) | ~3k tokens | Should stay well under this |
| Cortex operational rules | ~2k tokens | Appended automatically by Cortex |
| Conversation history | ~150k tokens | Managed by Cortex compaction |
| Ephemeral context | ~500 tokens | Small, volatile |
| Current prompt + tool schemas | ~10k tokens | Varies by turn |
| Headroom for compaction | ~35k tokens | Buffer before compaction triggers |

The base prompt (~500 tokens) and ephemeral context (~500 tokens) are intentionally small. The majority of the context window is available for conversation history and tool output, which is where the real work happens.
