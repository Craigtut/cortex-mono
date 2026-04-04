# Cortex

Production-grade agent infrastructure built on [`pi-agent-core`](https://github.com/nickmarchandpm/pi-agent-core).

Cortex wraps `pi-agent-core` into a full-featured agent framework with capabilities the core deliberately omits: MCP tool support, tool permissions, budget guards, context compaction, a skill system, event logging, built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebFetch), and provider management.

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| [`@animus-labs/cortex`](packages/cortex/) | Core agent framework | Published |
| [`@animus-labs/cortex-code`](packages/cortex-code/) | Coding agent built on Cortex | In development |

## Requirements

- Node.js 24+

## Getting Started

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

## Using Cortex

```bash
npm install @animus-labs/cortex
```

```typescript
import { CortexAgent, ProviderManager } from '@animus-labs/cortex';
```

See the [documentation](docs/) for architecture details, tool references, and integration guides.

## License

MIT
