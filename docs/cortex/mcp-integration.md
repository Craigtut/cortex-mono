# MCP Tool Integration

> **STATUS: RESEARCH** - Not yet implemented.

How Cortex bridges the gap between pi-agent-core's native `AgentTool` interface and the MCP protocol used by consumer domain tools and plugin tools. All external tool sources are consumed through a unified MCP client pattern, while a small set of built-in tools remain as direct in-process registrations.

## Overview

Pi-agent-core has no MCP support. Tools are direct `AgentTool` objects with an `execute()` function registered on the `Agent` instance. Cortex bridges this gap by acting as an MCP client that connects to MCP servers, discovers their tools via `tools/list`, and wraps each discovered tool as an `AgentTool`.

This is a unified approach: both consumer domain tools (e.g., memory, tasks, messaging) and plugin tools (weather, browser, home automation) are consumed through the same MCP client pattern. The only exceptions are built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebFetch, SubAgent) which are native `AgentTool` registrations that run in-process without MCP.

## Architecture

```
CortexAgent
├── Built-in Tools (Bash, Read, Write, Edit, Glob, Grep, WebFetch, SubAgent)
│   └── Direct AgentTool registrations, in-process
│
├── MCP Client Manager
│   ├── Consumer Domain Tools (consumer's MCP tool server)
│   │   └── stdio transport -> tools/list -> AgentTool wrappers
│   │
│   └── Plugin Tools (per-plugin MCP servers)
│       ├── stdio transport (for stdio-based plugins)
│       └── HTTP transport (for HTTP-based plugins)
│       └── tools/list -> AgentTool wrappers
│
└── beforeToolCall hook
    └── Permission gate (resolveToolGate) for all tools
```

Sub-agents may share the same MCP server connection as the parent agent. If the consumer uses a shared bridge process, both the main agent (via Cortex) and sub-agents route tool calls through the same bridge.

## MCP Client Manager

Cortex owns an `McpClientManager` that manages connections to one or more MCP servers. Each connection is identified by a server name (e.g., `'domain'`, `'weather-plugin'`, `'browser-plugin'`). The manager handles four concerns:

1. **Connection lifecycle**: connect and disconnect from MCP servers
2. **Tool discovery**: call `tools/list` on each connected server
3. **Tool wrapping**: convert each MCP tool definition into an `AgentTool`
4. **Dynamic updates**: reconnect on plugin install/uninstall

### Connection Types

| Transport | Mechanism | Used By |
|-----------|-----------|---------|
| **stdio** | Cortex spawns the MCP server as a subprocess, communicates over stdin/stdout with JSON-RPC | Consumer's domain tool server, stdio-based plugins |
| **Streamable HTTP** | Cortex connects to an already-running HTTP server via POST requests | HTTP-based plugins |

Both transports use the `@modelcontextprotocol/sdk` `Client` class, which handles the JSON-RPC protocol, capability negotiation, and transport abstraction.

### Tool Wrapping

For each tool discovered via `tools/list`, the manager creates an `AgentTool`:

```typescript
// Simplified: MCP tool -> AgentTool conversion
function wrapMcpTool(serverName: string, mcpTool: McpTool, client: Client): AgentTool {
  return {
    name: `${serverName}__${mcpTool.name}`,
    description: mcpTool.description,
    parameters: Type.Unsafe(mcpTool.inputSchema),  // JSON Schema wrapped as TypeBox
    execute: async (args) => {
      const result = await client.callTool({
        name: mcpTool.name,        // Original name (no prefix)
        arguments: args,
      });
      return result;
    },
  };
}
```

Key details:

- **`name`**: Prefixed with the server name for namespacing (see below)
- **`description`**: Passed through from the MCP tool definition
- **`parameters`**: JSON Schema from MCP, wrapped via `Type.Unsafe()` (AJV validates at runtime)
- **`execute()`**: Calls `client.callTool()` on the MCP connection, returns the result

### Namespacing

Tools from different MCP servers may have name collisions. Cortex prefixes tool names with the server name, using a double-underscore separator:

| MCP Server | MCP Tool Name | AgentTool Name |
|------------|---------------|----------------|
| `domain` | `search_memories` | `domain__search_memories` |
| `weather` | `get_forecast` | `weather__get_forecast` |
| `browser` | `navigate` | `browser__navigate` |

This mirrors the `mcp__<server>__<tool>` naming pattern used by the Claude SDK. The prefix is stripped when calling back to the MCP server (the server only knows its own tool names).

## Consumer Domain Tool Integration

The consumer provides its own MCP tool server, which Cortex spawns as a stdio subprocess. This server exposes the consumer's domain-specific tools (e.g., memory, tasks, messaging) via the standard MCP protocol.

**Configuration example:**

```typescript
mcpClientManager.connect('domain', {
  transport: 'stdio',
  command: 'node',
  args: ['path/to/domain-mcp-server.ts'],
  env: {
    BRIDGE_PORT: bridgePort,
    TOOL_SET: 'main',
    TASK_ID: 'main',
  },
});
```

- Environment variables are consumer-configured (e.g., bridge port, tool set selection, task ID for context isolation)
- Tool discovery returns the consumer's domain tool names. Each is wrapped as an AgentTool and registered on the pi-agent-core Agent.

### Why MCP for Consumer Domain Tools?

Given that pi-agent-core supports direct in-process tools, why route domain tools through MCP rather than calling handlers directly?

1. **Single source of truth**: Sub-agents may share the same MCP server, ensuring one definition for tool schemas and handlers.
2. **Consistency**: All tool sources (consumer domain tools + plugins) use the same integration pattern. No special-casing.
3. **Shared bridge**: A bridge process can stay alive and handle tool execution for both the main agent (via Cortex MCP client) and sub-agents.

## Plugin Tool Integration

When a plugin is installed, the plugin manager provides its MCP server configuration (transport type, command or URL, environment variables). Cortex's `McpClientManager` connects to each plugin's MCP server, discovers its tools, and wraps them as `AgentTool` objects.

### Dynamic Tool Lifecycle

| Event | Action |
|-------|--------|
| Plugin install | `McpClientManager.connect(serverName, config)` discovers tools, registers AgentTools on the agent |
| Plugin uninstall | `McpClientManager.disconnect(serverName)` closes connection, deregisters AgentTools |
| Plugin update | Disconnect old, connect new (tools may have changed) |

No session restart is needed. Tools are added to and removed from the live agent dynamically. A system prompt rebuild is triggered separately to update the "Installed Plugins & Tools" context section.

### Plugin MCP Server Examples

**Stdio plugin** (e.g., weather):

```typescript
mcpClientManager.connect('weather', {
  transport: 'stdio',
  command: 'node',
  args: ['/path/to/weather-plugin/mcp-server.js'],
  env: { API_KEY: decryptedKey },
});
```

**HTTP plugin** (e.g., browser):

```typescript
mcpClientManager.connect('browser', {
  transport: 'http',
  url: 'http://localhost:9222/mcp',
});
```

## Permission Integration

All tools, regardless of source, flow through the same `beforeToolCall` hook on the pi-agent-core Agent. This hook is the single enforcement point for the permission system.

```typescript
agent.beforeToolCall = async (toolName, args) => {
  const gate = await resolveToolGate(toolName, currentContact);

  if (gate.mode === 'off') {
    return { blocked: true, reason: 'Tool is disabled' };
  }

  if (gate.mode === 'ask') {
    // Two-tick approval dance: request approval, wait for user response
    return await requestToolApproval(toolName, args);
  }

  // 'always_allow': proceed
  return { blocked: false };
};
```

Key details:

- `resolveToolGate()` is imported from `tool-gate.ts` (existing implementation)
- Permission modes: `off` (blocked), `ask` (approval flow), `always_allow` (permitted)
- For `ask` mode, the consumer's approval flow is invoked (same two-tick approval pattern as today)
- Permission lookup uses the `tool_permissions` table in system.db
- Permission entries use the namespaced tool name (e.g., `domain__search_memories`, `weather__get_forecast`)
- Built-in tools also pass through this hook

## Schema Conversion

MCP tools provide JSON Schema for their parameters. Pi-agent-core requires TypeBox schemas (used internally by AJV for validation).

The conversion path:

```
MCP tool.inputSchema (JSON Schema)
  -> Type.Unsafe(jsonSchema)  (TypeBox wrapper)
  -> AJV validates at runtime
```

`Type.Unsafe()` wraps the raw JSON Schema as a TypeBox type without transformation. AJV, which understands both TypeBox and raw JSON Schema, validates tool arguments at runtime.

This is the same conversion used for Zod-defined tools (Zod -> JSON Schema -> TypeBox via `Type.Unsafe()`), just skipping the Zod step since MCP already provides JSON Schema directly.

## Error Handling

### Tool Call Errors

MCP tool call errors are caught and returned as AgentTool results with `isError: true`. The agent receives the error as a tool result and can retry or adjust its approach.

### Connection Errors

| Failure | Response |
|---------|----------|
| Subprocess crash (stdio) | Attempt reconnect; if reconnect fails, deregister tools and log the failure |
| HTTP timeout | Retry with backoff; if persistent, deregister tools and log the failure |
| `tools/list` failure | Treat as connection failure (no tools available from this server) |

Connection health is monitored by the `McpClientManager`. On connection loss, the manager attempts reconnect. If reconnect fails, tools from that server are deregistered and the failure is logged. The agent continues operating with its remaining tools.

## Shared Infrastructure with Sub-Agents

The consumer may run a shared bridge process (e.g., an HTTP server within the backend) through which multiple agents route tool calls:

```
Main Agent (Cortex)
  -> MCP client (stdio) -> domain MCP server subprocess -> bridge -> tool handler

Sub-Agent
  -> MCP client (stdio) -> domain MCP server subprocess -> bridge -> tool handler
```

Each agent gets its own MCP server subprocess instance. The bridge distinguishes them by task ID (e.g., `'main'` for the primary agent, UUIDs for sub-agents). Tool permissions are checked at the bridge level for all paths.

## Open Questions

1. **Connection persistence**: Should MCP client connections be persistent (kept alive between ticks) or reconnected per tick? Persistent is more efficient but requires health monitoring. Reconnecting per tick is simpler but adds latency.

2. **MCP resources and prompts**: Should Cortex support MCP resources and prompts in addition to tools? Currently only `tools/list` and `tools/call` are used. Resources could enable richer plugin context injection.

3. **Connection error surfacing**: How should MCP client connection errors be surfaced to the user? Tool errors are visible in agent logs, but connection-level failures (subprocess crash, HTTP server down) may need a dedicated notification path.

4. **Tool count scaling**: As plugins accumulate, the total tool count could grow large. Should Cortex implement tool filtering or pagination, or rely on the LLM's ability to handle large tool lists?
