# @animus-labs/cortex

Production-grade agent infrastructure built on top of [`pi-agent-core`](https://github.com/nickmarchandpm/pi-agent-core).

Cortex provides:
- `CortexAgent` for the agentic loop and lifecycle
- `ProviderManager` for provider discovery, auth, and model resolution
- Built-in tools for filesystem, shell, search, web fetch, and sub-agents
- Context management, compaction, working tags, and event normalization
- MCP tool support, skill system, budget guards, and tool permissions

## Requirements

- Node.js 24+

## Install

```bash
npm install @animus-labs/cortex
```

If you use `zodToTypebox()`, install `zod` in the consumer as well.

## Development Notes

- Default imports resolve to `dist/`
- A `source` export is available for workflows that run with `--conditions source`

## Main Exports

- `CortexAgent` - Core agentic loop
- `ProviderManager` - Provider discovery, OAuth, model resolution
- `ContextManager` - Context slot management
- `EventBridge` - Event normalization
- `BudgetGuard` - Token/cost limiting
- Built-in tool factories (`createReadTool`, `createBashTool`, etc.)
- `CompactionManager` - Context compaction
- `SkillRegistry` - Skill loading system
- `McpClientManager` - MCP protocol support

## Model Contract

`CortexAgent` takes a `CortexModel` handle as its public model input. Resolve that handle through `ProviderManager`, then pass it into the agent:

```ts
const providers = new ProviderManager();
const model = await providers.resolveModel('anthropic', 'claude-sonnet-4-20250514');

const agent = await CortexAgent.create({
  model,
  workingDirectory: process.cwd(),
  initialBasePrompt: 'You are the application agent.',
});
```

`ProviderManager.validateApiKey()` returns a structured result, not a boolean, so callers can distinguish invalid credentials from retryable provider failures.

## Documentation

See the [docs](../../docs/) directory for architecture guides, tool references, and integration patterns.

## License

MIT
