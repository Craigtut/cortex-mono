# Cortex Built-in Tools

Built-in tools that ship with `@animus-labs/cortex`. These are general-purpose tools any agent needs regardless of its application. They are **registered automatically** on every working loop, using the `workingDirectory` from the agent config. No consumer-side tool creation is needed.

That means the loop a bare `AgentLoop.create()` builds, and, through `CortexAgent.create()`, the reasoner and its sub-agents. The duplex talker deliberately gets none of them: it holds the conversation and dispatches work, and never touches a file or a shell.

To disable specific built-in tools, use the `disableTools` config option:

```typescript
const agent = await CortexAgent.create({
  model,
  workingDirectory: cwd,
  disableTools: ['WebFetch'], // Exclude specific tools
});
```

Application-specific tools (domain-specific tools, cognitive tools, etc.) are registered by the consumer via MCP servers, not built into Cortex.

## Tool Tiers

### P0: Core (ship in foundation phase)

| Tool | Description |
|------|-------------|
| [Bash](./bash.md) | Execute shell commands |
| [TaskOutput](./task-output.md) | Poll, send input to, or kill backgrounded processes |
| [Read](./read.md) | Read file contents |
| [Write](./write.md) | Create or overwrite files |
| [Edit](./edit.md) | Make precise edits to existing files |
| [UndoEdit](./undo-edit.md) | Revert the most recent Edit or Write on a single file |
| [Glob](./glob.md) | Find files by pattern |
| [Grep](./grep.md) | Search file contents with regex (ripgrep) |
| [WebFetch](./web-fetch.md) | Fetch and parse web content |
| [SubAgent](./sub-agent.md) | Spawn cortex-based sub-agents |

### P3: Future (deferred)

| Tool | Description | Notes |
|------|-------------|-------|
| WebSearch | Search the web | Needs a search backend (Brave API, SearXNG, etc.) |
| Claude/Codex SubAgent | Spawn sub-agents via subprocess-based SDKs | Bridge to external agent runtimes |

### Not in cortex (consumer's responsibility)

- Domain-specific tools (e.g., send_message, read_memory, lookup_contacts)
- Cognitive tools (e.g., record_thought, record_cognitive_state)
