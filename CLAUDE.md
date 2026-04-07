# Cortex

**Organization**: Animus Labs (`@animus-labs` on npm)

Production-grade agent infrastructure built on `pi-agent-core`. Cortex wraps `@mariozechner/pi-agent-core` into a full-featured agent framework with capabilities the core deliberately omits: MCP tool support, tool permissions, budget guards, context compaction, a skill system, event logging, built-in tools, and provider management.

## Key Principle

**Cortex is a general-purpose framework, not an application.** It must never contain application-specific logic. If a consumer needs Cortex to do something domain-specific, Cortex provides a hook or callback that the consumer implements. If no suitable hook exists, add a general-purpose hook that any consumer could use.

## Monorepo Structure

```
/packages
  /cortex       - Core agent framework (published as @animus-labs/cortex)
  /cortex-code  - Coding agent built on Cortex (in development)
/docs           - Architecture docs, tool references, development plans
```

## Tech Stack

- Node.js 24+, TypeScript strict, ESM
- `@mariozechner/pi-agent-core` + `@mariozechner/pi-ai` for the agentic loop and model access
- `@modelcontextprotocol/sdk` for MCP protocol support
- `@sinclair/typebox` for JSON schema
- `@vscode/ripgrep` for fast file searching
- Vitest for testing

## The Cortex Package (`@animus-labs/cortex`)

Two main exports, fully independent:

- **`CortexAgent`**: The agentic loop, tools, context management, compaction, skills. Always-warm session, no cold/warm state machine.
- **`ProviderManager`**: Provider discovery, OAuth flows, API key validation, model resolution. Wraps pi-ai's multi-provider ecosystem.

### Key Design Patterns

- **No persistence**: Cortex is in-memory only. It provides `getConversationHistory()`, `restoreConversationHistory()`, and `onLoopComplete` hooks. The consumer decides where and when to persist.
- **No application logic**: No thoughts, emotions, personas, goal tracking, or decision handling. Those are consumer concerns.
- **Callback-driven integration**: `getApiKey` callback for credentials, `beforeToolCall` hook for permissions, `transformContext` for ephemeral context injection, `onBeforeCompaction`/`onPostCompaction` for domain-specific coordination.
- **Consumer-provided system prompt**: Cortex appends operational rules after the consumer's content. The consumer owns identity and domain instructions.

### Architecture Highlights

- **Context Management**: Named slots for organizing context, slot-based composition, prefix caching optimization
- **Built-in Tools**: Bash, Read, Write, Edit, Glob, Grep, WebFetch, SubAgent, TaskOutput (auto-registered, disable via `disableTools` config)
- **Tool Permissions**: Per-tool permission modes (off/ask/always_allow), pre-execution callbacks
- **Compaction**: Three-layer strategy (microcompaction, conversation summarization, emergency truncation)
- **Skills**: Progressive disclosure system (advertise/load/use), SKILL.md format, dynamic context injection
- **MCP**: Unified MCP client for integrating external tool servers
- **Budget Guards**: Token and cost limits to prevent runaway execution
- **Event Bridge**: Normalized event stream for logging and observability

### Sanitized Boundary

**Cortex must never import from any consumer package.** Consumers import from Cortex, never the reverse. Cortex's only dependencies are `pi-agent-core`, `pi-ai`, `@modelcontextprotocol/sdk`, `@sinclair/typebox`, `@vscode/ripgrep`, and `zod-to-json-schema`.

## Development Guidelines

### Running Locally

```bash
# Prerequisites: Node.js 24+
npm install

# Build
npm run build

# Type check
npm run typecheck

# Tests
npm run test:run
```

### Testing Requirements

Every feature must have unit test coverage. Use Vitest for testing.

```bash
npm run test        # Watch mode
npm run test:run    # Single run
npm run test:coverage
```

### Code Style

- Use TypeScript strict mode
- Validate all external input with Zod schemas
- Keep functions small and focused
- Prefer composition over inheritance
- Use meaningful variable names
- Add comments only for non-obvious logic

### Writing Style

- **Never use em dashes** when writing copy. Use alternative punctuation (commas, colons, semicolons, parentheses, or separate sentences) instead.

### Commit Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/).

**Format (single line only, no body, no footer, no co-authors):**
```
<type>(<scope>): <description>
```

**Examples:**
```
feat(cortex): add adaptive threshold to compaction manager
fix(cortex-code): show rejected edits as errors in TUI
docs(cortex): sync documentation with implemented codebase
refactor(cortex): extract provider registry into separate module
```

**Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `style`

**Scopes:** `cortex`, `cortex-code`, `docs`, `ci`, `release`

**Rules:**
- Single line only. No message body, no footer, no `Co-Authored-By`.
- Commit early and often. Small, focused commits are preferred.
- Each commit should be one logical change.
- Write in imperative mood: "add feature" not "added feature".
- Keep the first line under 100 characters.
- Always use `git commit -m "..."` with a single-line message.

## Documentation

Detailed documentation lives in `/docs/cortex/`. Use `/doc-explorer <topic>` to explore.

### Key Docs

- **Product Vision**: `docs/cortex/product-vision.md` (why Cortex exists, core insight, design principles)
- **Architecture**: `docs/cortex/cortex-architecture.md` (core design, exports, patterns)
- **Context**: `docs/cortex/context-manager.md` (slots, prefix caching, ephemeral context)
- **Compaction**: `docs/cortex/compaction-strategy.md` (three-layer strategy, token tracking)
- **Skills**: `docs/cortex/skill-system.md` (progressive disclosure, SKILL.md format, registry)
- **Providers**: `docs/cortex/provider-manager.md` (discovery, OAuth, model resolution)
- **MCP**: `docs/cortex/mcp-integration.md` (MCP client, tool wrapping, namespacing)
- **Tools**: `docs/cortex/tools/` (per-tool documentation)
- **System Prompt**: `docs/cortex/system-prompt.md` (prompt assembly, operational rules)
- **Working Tags**: `docs/cortex/working-tags.md` (response delivery, tag system)
- **Error Recovery**: `docs/cortex/error-recovery.md` (error classification, strategies)
- **Cross-Platform**: `docs/cortex/cross-platform-considerations.md` (platform differences)
- **Model Tiers**: `docs/cortex/model-tiers.md` (tier selection, defaults)
## File Locations

- Cortex source: `/packages/cortex/src/`
- Cortex tools: `/packages/cortex/src/tools/`
- Cortex compaction: `/packages/cortex/src/compaction/`
- Cortex tests: `/packages/cortex/tests/`
- Cortex Code source: `/packages/cortex-code/src/`
- Cortex documentation: `/docs/cortex/`
- Tool docs: `/docs/cortex/tools/`

## Consumers

The primary consumer of Cortex is [Animus](https://github.com/Craigtut/animus), an autonomous AI assistant with persistent inner life. Animus uses Cortex for its mind session (agentic loop), sub-agent orchestration, and provider management. Animus-specific integration documentation lives in the Animus repository under `docs/cortex/`.
