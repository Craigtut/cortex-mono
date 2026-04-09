# @animus-labs/cortex

Production-grade agent framework with structured context management. Built on [`pi-agent-core`](https://github.com/nickmarchandpm/pi-agent-core).

Cortex treats the context window as a managed surface, not a flat chat log. Named slots, stability-ordered layout, and three-layer compaction give you fine-grained control over what the model sees while maximizing prompt cache hit rates.

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
});

const result = await agent.runLoop('What files are in this directory?');
```

## Key Features

- **Context Slots**: Named, ordered content blocks with stability-based layout for prompt cache optimization
- **Three-Layer Compaction**: Microcompaction (string trimming), summarization, and emergency truncation
- **Built-in Tools**: Bash, Read, Write, Edit, Glob, Grep, WebFetch, SubAgent, TaskOutput
- **MCP Support**: Integrate external tool servers via the Model Context Protocol
- **Skills**: Progressive disclosure system for dynamically loading capabilities
- **Tool Permissions**: Per-tool permission modes with pre-execution callbacks
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

See the [docs](../../docs/cortex/) directory for architecture guides, API details, and integration patterns.

## License

MIT
