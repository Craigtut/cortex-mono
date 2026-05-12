# @animus-labs/cortex

Production-grade agent framework with structured context management. Built on `@earendil-works/pi-agent-core`.

Cortex treats the context window as a managed surface, not a flat chat log. Named slots, stability-ordered layout, observational memory, and classic compaction controls give you fine-grained control over what the model sees while maximizing prompt cache hit rates.

## Install

```bash
npm install @animus-labs/cortex
```

Requires Node.js 24+.

## Quick Start

```typescript
import { CortexAgent, ProviderManager } from '@animus-labs/cortex';

const providers = new ProviderManager();
const model = await providers.resolveModel('anthropic', 'claude-sonnet-4-20250514');

const agent = await CortexAgent.create({
  model,
  workingDirectory: process.cwd(),
  initialBasePrompt: 'You are a helpful assistant.',
  // Optional. If omitted, pi-ai falls back to provider environment variables.
  getApiKey: async (provider) => {
    if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      return process.env.ANTHROPIC_API_KEY;
    }
    throw new Error(`No API key configured for ${provider}`);
  },
});

agent.onTurnComplete((output) => {
  if (output.userFacing) console.log(output.userFacing);
});

await agent.prompt('What files are in this directory?');
await agent.destroy();
```

## Key Features

- **Context Slots**: Named, stability-ordered content blocks for prompt cache optimization. Ephemeral context provides fresh per-loop state without accumulating in persistent history.
- **Compaction**: Observational memory by default, with classic microcompaction, summarization, and emergency truncation available via config
- **Built-in Tools**: Bash, TaskOutput, Read, Write, Edit, UndoEdit, Glob, Grep, WebFetch, SubAgent
- **MCP Support**: Integrate external tool servers via the Model Context Protocol
- **Skills**: Progressive disclosure system for dynamically loading capabilities
- **Tool Permissions**: Consumer-provided resolver hook for allow, block, or approval-required decisions
- **Budget Guards**: Token and cost limits to prevent runaway execution
- **Provider Management**: Multi-provider support with OAuth flows and model resolution
- **Event Bridge**: Normalized event stream for logging and observability

## Main Exports

- `CortexAgent` - Core agentic loop with context management
- `ProviderManager` - Provider discovery, OAuth, and model resolution

## Design Principles

1. **Context is a managed surface.** Structure it, order it for caching, update it granularly.
2. **Mechanism, not policy.** Cortex provides hooks and callbacks. Consumers implement domain logic.
3. **No persistence opinions.** The consumer owns storage. Cortex owns the in-memory context surface.

## Documentation

Start with the [consumer guide](../../docs/cortex/consumer-guide.md). The [docs](../../docs/cortex/) directory also contains architecture notes, API details, and tool references.

## License

MIT
