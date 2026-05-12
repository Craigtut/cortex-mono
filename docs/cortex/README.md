# Cortex Documentation

Start here if you are integrating `@animus-labs/cortex` into an application:

- [Using Cortex](./consumer-guide.md): install, create an agent, configure providers, slots, persistence, permissions, MCP, tools, skills, compaction, and shutdown.
- [Built-in Tools](./tools/README.md): tools registered automatically by `CortexAgent.create()`.
- [Provider Manager](./provider-manager.md): provider discovery, OAuth, API key validation, custom endpoints, and model resolution.

Architecture and implementation references:

- [Product Vision](./product-vision.md)
- [Cortex Architecture](./cortex-architecture.md)
- [Context Manager](./context-manager.md)
- [System Prompt](./system-prompt.md)
- [Working Tags](./working-tags.md)
- [Model Tiers](./model-tiers.md)
- [MCP Integration](./mcp-integration.md)
- [Skill System](./skill-system.md)
- [Observational Memory Architecture](./observational-memory-architecture.md)
- [Classic Compaction Strategy](./compaction-strategy.md)
- [Tool Result Persistence](./tool-result-persistence.md)
- [Error Recovery](./error-recovery.md)
- [Cross-Platform Considerations](./cross-platform-considerations.md)

Most files in this directory are design and implementation notes. The consumer guide is the primary end-user documentation for embedding the package.
