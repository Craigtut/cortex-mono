# Cortex

Production-grade agent framework with structured context management. By [Animus Labs](https://github.com/Animus-Labs).

Cortex treats the LLM context window as a managed surface, not a flat chat log. Named slots with stability-ordered layout maximize prompt cache hit rates. Three-layer compaction (string trimming, summarization, emergency truncation) keeps long-running agents within context limits without cliff-edge failures.

Built on [`pi-agent-core`](https://github.com/nickmarchandpm/pi-agent-core) for the agentic loop and model access.

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| [`@animus-labs/cortex`](packages/cortex/) | Core agent framework | 0.1.0 |
| [`@animus-labs/cortex-code`](packages/cortex-code/) | Terminal-based coding agent | In development |

## Getting Started

```bash
npm install @animus-labs/cortex
```

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

## Key Capabilities

- **Context Slots**: Named, ordered content blocks optimized for prompt cache stability
- **Three-Layer Compaction**: Microcompaction, summarization, and emergency truncation
- **Built-in Tools**: Bash, Read, Write, Edit, Glob, Grep, WebFetch, SubAgent
- **MCP Support**: Integrate external tool servers via the Model Context Protocol
- **Skills**: Progressive disclosure system for dynamic capability loading
- **Provider Management**: Multi-provider support (Anthropic, OpenAI, Google, Ollama) with OAuth
- **Budget Guards**: Token and cost limits to prevent runaway execution

## Development

Requires Node.js 24+.

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm run test:run

# Type check
npm run typecheck
```

## Documentation

Architecture guides, tool references, and integration patterns live in [`docs/cortex/`](docs/cortex/).

## License

MIT
