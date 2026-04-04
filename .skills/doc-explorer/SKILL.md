---
name: doc-explorer
description: Explore Cortex project documentation. Use when you need context about the agent framework architecture, tools, compaction, skills, providers, or any project documentation.
allowed-tools: Read Grep Glob
---

# Cortex Documentation Explorer

You are exploring the Cortex project documentation to gather context. The docs live in `/docs/cortex/` at the project root.

## How to Use This Skill

**If invoked with arguments** (`/doc-explorer <topic>`): Focus your exploration on the specific topic requested. Use the index below to identify which files are relevant, then read them.

**If invoked without arguments**: Provide a summary of all available documentation topics and ask what the user wants to explore.

**If invoked automatically by Claude**: Read the specific files relevant to your current task. Don't read everything, be targeted.

## Topic: $ARGUMENTS

## Documentation Index

Use this index to find the right files to read.

### Core Architecture

| File | Covers |
|------|--------|
| `docs/cortex/cortex-architecture.md` | `@animus-labs/cortex` package design: always-warm session, context management (slots + ephemeral), MCP client (unified tool integration), built-in tools (Bash/Read/Write), pi-ai model access, tool permissions, budget guards, compaction, skill system, event bridge, system prompt management |
| `docs/cortex/context-manager.md` | ContextManager design: message array layout (slots + history + ephemeral + prompt), prefix caching strategy, slot API, ephemeral context API, composability with transformContext |
| `docs/cortex/compaction-strategy.md` | Three-layer compaction: microcompaction (tool result trimming), conversation summarization, emergency truncation. Token tracking, configuration |
| `docs/cortex/system-prompt.md` | Cortex system prompt assembly: consumer content + cortex operational rules, 5 operational sections, rebuild triggers |
| `docs/cortex/working-tags.md` | Working tags response delivery: `<working>` XML tags for separating internal reasoning from user-facing text, `AgentTextOutput` type, parsing utilities, channel-aware delivery |
| `docs/cortex/error-recovery.md` | Error classification, recovery strategies |
| `docs/cortex/cross-platform-considerations.md` | Platform differences (macOS, Linux, Windows) |
| `docs/cortex/model-tiers.md` | Model tier selection, primary vs utility defaults |

### Provider & Auth

| File | Covers |
|------|--------|
| `docs/cortex/provider-manager.md` | ProviderManager: standalone class wrapping pi-ai for provider discovery, OAuth login/refresh, API key validation, model resolution, custom endpoint creation. IProviderManager interface, envelope pattern for OAuth credentials, CortexModel opaque type, provider registry |

### Tools

| File | Covers |
|------|--------|
| `docs/cortex/tools/README.md` | Overview of built-in tools and their design |
| `docs/cortex/tools/bash.md` | Bash tool: command execution, safety classifier, timeout, preflight checks |
| `docs/cortex/tools/read.md` | Read tool: file reading with line ranges |
| `docs/cortex/tools/write.md` | Write tool: file creation and overwriting |
| `docs/cortex/tools/edit.md` | Edit tool: string replacement in files |
| `docs/cortex/tools/glob.md` | Glob tool: file pattern matching |
| `docs/cortex/tools/grep.md` | Grep tool: content search via ripgrep |
| `docs/cortex/tools/web-fetch.md` | WebFetch tool: HTTP requests with caching |
| `docs/cortex/tools/sub-agent.md` | SubAgent tool: spawning and managing sub-agents |

### Skills & MCP

| File | Covers |
|------|--------|
| `docs/cortex/skill-system.md` | Cortex skill system: progressive disclosure (advertise/load/use), SKILL.md format, SkillRegistry (config-driven), load_skill AgentTool, ephemeral injection, dynamic context injection preprocessor, consumer pre-loading API |
| `docs/cortex/mcp-integration.md` | MCP tool integration: Cortex as unified MCP client, McpClientManager, tool wrapping (MCP to AgentTool), namespacing, permission integration, schema conversion |

## Exploration Strategy

1. **Identify the topic area** from the index above
2. **Read the most relevant file(s)**, don't read everything
3. **For architecture overview**: Start with `docs/cortex/cortex-architecture.md`
4. **For tool work**: Start with `docs/cortex/tools/README.md` then the specific tool doc
5. **For context/caching work**: Read `docs/cortex/context-manager.md`
6. **For compaction work**: Read `docs/cortex/compaction-strategy.md`
7. **For skill system**: Read `docs/cortex/skill-system.md`
8. **For provider/auth**: Read `docs/cortex/provider-manager.md`

## Topic Keyword Guide

- **cortex, agent, agentic loop, always-warm session, context slots** -> `docs/cortex/cortex-architecture.md`
- **context manager, slots, ephemeral context, prefix caching, message layout** -> `docs/cortex/context-manager.md`
- **compaction, summarization, token tracking, microcompaction, tool trimming** -> `docs/cortex/compaction-strategy.md`
- **system prompt, operational rules, prompt rebuild** -> `docs/cortex/system-prompt.md`
- **working tags, response delivery, internal reasoning, user-facing text, tag stripping** -> `docs/cortex/working-tags.md`
- **provider manager, OAuth, API key, model resolution, CortexModel, pi-ai** -> `docs/cortex/provider-manager.md`
- **skill, skills, SKILL.md, progressive disclosure, skill registry, load_skill** -> `docs/cortex/skill-system.md`
- **MCP, MCP client, tool wrapping, McpClientManager, namespacing** -> `docs/cortex/mcp-integration.md`
- **error, recovery, classification** -> `docs/cortex/error-recovery.md`
- **platform, cross-platform, macOS, Windows, Linux** -> `docs/cortex/cross-platform-considerations.md`
- **model tier, primary, utility, defaults** -> `docs/cortex/model-tiers.md`
- **bash, shell, command, safety** -> `docs/cortex/tools/bash.md`
- **read, file reading** -> `docs/cortex/tools/read.md`
- **write, file creation** -> `docs/cortex/tools/write.md`
- **edit, string replacement** -> `docs/cortex/tools/edit.md`
- **glob, file pattern, matching** -> `docs/cortex/tools/glob.md`
- **grep, search, ripgrep** -> `docs/cortex/tools/grep.md`
- **web fetch, HTTP, cache** -> `docs/cortex/tools/web-fetch.md`
- **sub-agent, spawn, delegation** -> `docs/cortex/tools/sub-agent.md`
