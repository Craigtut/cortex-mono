# Using Cortex

> **STATUS: IMPLEMENTED CONSUMER GUIDE**

This guide is for applications that want to embed `@animus-labs/cortex`. Cortex gives you the agent loop, providers, tools, context management, compaction, skills, MCP, and lifecycle hooks. Your application still owns identity, product behavior, persistence, credentials storage, UI approvals, and any domain-specific tools.

## Install

```bash
npm install @animus-labs/cortex
```

Cortex requires Node.js 24 or newer and uses ESM.

## Minimal Agent

```typescript
import { CortexAgent, ProviderManager } from '@animus-labs/cortex';

const providers = new ProviderManager();
const model = await providers.resolveModel('anthropic', 'claude-sonnet-4-20250514');

const agent = await CortexAgent.create({
  model,
  workingDirectory: process.cwd(),
  initialBasePrompt: 'You are a helpful assistant.',
  getApiKey: async (provider) => {
    if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      return process.env.ANTHROPIC_API_KEY;
    }
    throw new Error(`No API key configured for ${provider}`);
  },
});

agent.onTurnComplete((output) => {
  if (output.userFacing) {
    console.log(output.userFacing);
  }
});

await agent.prompt('List the top-level files in this workspace.');
await agent.destroy();
```

`prompt()` runs one agentic loop. The return value is the underlying pi-agent-core result and should be treated as opaque. Most applications display assistant text from `onTurnComplete()`, using `output.userFacing` when working tags are enabled.

If `getApiKey` is omitted, pi-ai falls back to provider environment variables such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

## Provider Setup

Use `ProviderManager` during onboarding and settings screens:

```typescript
const providers = new ProviderManager();

const providerChoices = providers.listProviders();
const models = await providers.listModels('anthropic');

const validation = await providers.validateApiKey('anthropic', apiKey);
if (!validation.valid) {
  throw new Error(validation.message ?? 'Invalid API key');
}

const model = await providers.resolveModel('anthropic', models[0]!.id);
```

OAuth providers use callbacks supplied by your UI:

```typescript
const result = await providers.initiateOAuth('github-copilot', {
  onAuth: ({ url, instructions }) => {
    openBrowser(url);
    if (instructions) showInstructions(instructions);
  },
  onPrompt: async ({ message, placeholder }) => promptUser(message, placeholder),
  onProgress: (message) => showStatus(message),
  onSelect: async ({ message, options }) => chooseOption(message, options),
});

await credentialStore.saveEncrypted(result.credentials);
```

Store OAuth credentials as opaque encrypted strings. Later, resolve them inside your `getApiKey` callback:

```typescript
const agent = await CortexAgent.create({
  model,
  workingDirectory,
  initialBasePrompt,
  getApiKey: async (provider) => {
    const saved = await credentialStore.load(provider);
    if (saved.type === 'oauth') {
      const refreshed = await providers.resolveOAuthApiKey(provider, saved.credentials);
      if (refreshed.changed) await credentialStore.update(provider, refreshed.credentials);
      return refreshed.apiKey;
    }
    return saved.apiKey;
  },
});
```

## Core Configuration

Common `CortexAgent.create()` fields:

| Field | Purpose |
|-------|---------|
| `model` | Required `CortexModel` from `ProviderManager.resolveModel()` or `createCustomModel()` |
| `workingDirectory` | Required base directory for file tools |
| `initialBasePrompt` | Your application prompt. Cortex appends operational rules after it |
| `getApiKey` | Optional async provider credential resolver |
| `slots` | Optional ordered persistent context slots |
| `workingTags.enabled` | Defaults to `true`; controls `<working>` response parsing guidance |
| `budgetGuard.maxTurns` / `maxCost` | Optional per-loop safety limits |
| `disableTools` | Built-in tool names to exclude |
| `resolvePermission` | Optional permission gate for tool calls |
| `compaction` | Optional compaction strategy and thresholds |
| `persistResult` | Optional callback for storing oversized tool results |
| `deferredTools` | Optional schema deferral for large MCP tool sets |

Built-in tools are registered automatically: `Bash`, `TaskOutput`, `Read`, `Write`, `Edit`, `UndoEdit`, `Glob`, `Grep`, `WebFetch`, and `SubAgent`. `ToolSearch` is registered automatically when `deferredTools.enabled` is true. The `load_skill` tool is registered automatically for parent agents.

## Context Slots

Slots are persistent messages at the front of context. Use them for application state that should survive across loops and benefit from prefix caching.

```typescript
const agent = await CortexAgent.create({
  model,
  workingDirectory,
  initialBasePrompt,
  slots: ['app-config', 'user-profile', 'workspace'],
});

const context = agent.getContextManager();
context.setSlot('app-config', '<app-config>...</app-config>');
context.setSlot('user-profile', '<user-profile>...</user-profile>');
context.setSlot('workspace', '<workspace>...</workspace>');
```

Ephemeral context is rebuilt by your application before a loop and is not stored in conversation history:

```typescript
context.setEphemeral('<request-context>Triggered by a scheduled job</request-context>');
await agent.prompt('Continue from current state.');
context.setEphemeral(null);
```

When observational memory is active, Cortex adds an internal `_observations` slot. When deferred tools are enabled, Cortex adds an internal `_available_tools` slot. Consumers should not set either slot manually.

## Persistence

Cortex is in-memory only. Persist the pieces you care about in your own storage.

```typescript
agent.onLoopComplete(() => {
  saveSession({
    history: agent.getConversationHistory(),
    usage: agent.getSessionUsage(),
    observations: agent.getObservationalMemoryState(),
  });
});
```

Restore after creating a new agent:

```typescript
const agent = await CortexAgent.create(config);

agent.restoreConversationHistory(saved.history);
agent.restoreSessionUsage(saved.usage);
if (saved.observations) {
  agent.restoreObservationalMemoryState(saved.observations);
}

const context = agent.getContextManager();
context.setSlot('app-config', buildCurrentAppConfig());
```

Slots should usually be rebuilt from current application state instead of restored from prior serialized messages.

## Permissions

`resolvePermission` is the single public hook for tool permissions. Return `true` or `{ decision: 'allow' }` to proceed. Return `false`, `{ decision: 'block' }`, or `{ decision: 'ask' }` to block the tool call with a reason. Cortex does not run an in-band approval UI for `ask`; your application should collect approval and retry or steer the agent as appropriate.

```typescript
const agent = await CortexAgent.create({
  model,
  workingDirectory,
  initialBasePrompt,
  resolvePermission: async (toolName, args) => {
    if (toolName === 'Bash') {
      return { decision: 'ask', reason: 'Shell commands require approval.' };
    }
    if (toolName === 'Write' || toolName === 'Edit') {
      return isAllowedPath(args) ? true : { decision: 'block', reason: 'Path is outside workspace.' };
    }
    return true;
  },
});
```

The `SubAgent` tool invocation itself is treated as internal orchestration. Tool calls made by child agents still go through the parent permission resolver.

## MCP Tools

Connect MCP servers at runtime. Tool names are namespaced as `serverName__toolName`.

```typescript
await agent.connectMcpServer('memory', {
  transport: 'stdio',
  command: 'node',
  args: ['/absolute/path/to/mcp-server.js'],
  cwd: '/absolute/path/to/server',
  env: { NODE_ENV: 'production' },
});

console.log(agent.getMcpClientManager().getServerToolNames('memory'));

await agent.disconnectMcpServer('memory');
```

For large MCP tool sets, enable deferred tools so schemas are loaded on demand:

```typescript
const agent = await CortexAgent.create({
  model,
  workingDirectory,
  initialBasePrompt,
  deferredTools: {
    enabled: true,
    deferMcp: true,
    alwaysLoad: ['memory__search'],
  },
});
```

## Consumer Tools

You can pass in-process tools at creation or add them later. Tools use Cortex's `execute(params, context?)` contract.

```typescript
import { z } from 'zod';
import { CortexAgent, zodToTypebox, type CortexTool } from '@animus-labs/cortex';

const getProjectTool: CortexTool = {
  name: 'get_project',
  description: 'Return metadata for the active project.',
  parameters: zodToTypebox(z.object({ id: z.string() })),
  async execute(params) {
    const { id } = params as { id: string };
    const project = await loadProject(id);
    return {
      content: [{ type: 'text', text: JSON.stringify(project) }],
      details: { id },
    };
  },
};

const agent = await CortexAgent.create({
  model,
  workingDirectory,
  initialBasePrompt,
  tools: [getProjectTool],
});

agent.addConsumerTool(getProjectTool);
agent.removeConsumerTool('get_project');
```

If you already have a pi-agent-core style tool with `execute(toolCallId, params, signal, onUpdate)`, adapt it with `fromPiAgentTool()` before passing it to Cortex.

## Skills

Register SKILL.md files explicitly. Cortex does not scan directories.

```typescript
agent.getSkillRegistry().addSkill({
  path: '/absolute/path/to/my-skill/SKILL.md',
  source: 'user',
  variables: { PROJECT_ROOT: workingDirectory },
});

agent.setPreprocessorVariables({ WORKSPACE: workingDirectory });
agent.setScriptContext({ userId: currentUser.id });
```

The model sees a compact skill list in the `load_skill` tool description. Full skill content is loaded into ephemeral context only when `load_skill` is called or when your app preloads it:

```typescript
await agent.loadSkill('my-skill', 'optional args');
await agent.prompt('Use the loaded skill for this task.');
```

Skill content is cleared automatically when the loop ends. You can also call `clearSkillBuffer()`.

## Compaction

The default compaction strategy is observational memory. It compresses older conversation history into an internal observation slot and keeps emergency truncation as a failsafe.

```typescript
const agent = await CortexAgent.create({
  model,
  workingDirectory,
  initialBasePrompt,
  compaction: {
    strategy: 'observational',
  },
});
```

Use classic compaction when you want traditional summarization:

```typescript
const agent = await CortexAgent.create({
  model,
  workingDirectory,
  initialBasePrompt,
  compaction: {
    strategy: 'classic',
  },
});
```

For oversized tool results, provide `persistResult` so Cortex can replace context-heavy output with a bookend preview and a file reference:

```typescript
const agent = await CortexAgent.create({
  model,
  workingDirectory,
  initialBasePrompt,
  persistResult: async (content, metadata) => {
    return writeToolResultFile(content, metadata);
  },
});
```

## Direct Model Calls

Use `prompt()` for tool-using agent loops. Use direct completion helpers for single LLM calls that should not use tools or mutate conversation history.

```typescript
const text = await agent.directComplete({
  systemPrompt: 'Summarize the input.',
  messages: [{ role: 'user', content: '...' }],
});

const data = await agent.structuredComplete(
  {
    systemPrompt: 'Extract fields.',
    messages: [{ role: 'user', content: '...' }],
  },
  zodToTypebox(z.object({ title: z.string(), tags: z.array(z.string()) })),
);

const usage = agent.getLastDirectUsage();
```

## Shutdown

Always destroy long-lived agents during application shutdown. This aborts active loops, cancels sub-agents, closes MCP connections, kills tracked subprocesses, clears buffers, and removes event listeners.

```typescript
process.once('SIGINT', async () => {
  await agent.destroy();
  process.exit(0);
});
```
