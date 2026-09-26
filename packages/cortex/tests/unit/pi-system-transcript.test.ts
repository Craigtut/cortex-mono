/**
 * The system prompt and tool declarations as they reach pi's provider layer.
 *
 * Real pi Agent, real provider catalog, synthetic model responses: each
 * request's TranscriptContext is captured at pi's streamSimple boundary, so
 * these pin what a provider would actually receive, not a Cortex getter.
 * The load-bearing claim is cache-friendliness: once the model has
 * answered, a tool or prompt change must arrive as a later system message,
 * leaving the head (the cached prefix) byte-identical.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import * as piCompat from '@earendil-works/pi-ai/compat';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { AgentLoop } from '../../src/agent-loop.js';
import { ProviderManager } from '../../src/provider-manager.js';
import { TOOL_NAMES } from '../../src/tools/index.js';
import { INSTRUCTIONS_SECTION } from '../../src/agent-loop/system-prompt.js';

vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => ({
  ...await importOriginal<typeof piCompat>(),
}));

type Sent = Array<{ role: string; [key: string]: unknown }>;

function probe(name: string) {
  return {
    name,
    description: `Probe ${name}.`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  };
}

async function createLoop(requests: Sent[]) {
  const stream = vi.spyOn(piCompat, 'streamSimple');
  stream.mockImplementation((rawModel, context) => {
    requests.push(structuredClone(context.messages) as unknown as Sent);
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done' }],
      api: rawModel.api,
      provider: rawModel.provider,
      model: rawModel.id,
      usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    const events = createAssistantMessageEventStream();
    events.push({ type: 'start', partial: message });
    events.push({ type: 'done', reason: 'stop', message });
    return events;
  });
  const manager = new ProviderManager();
  const catalog = await manager.listModels('anthropic');
  const model = await manager.resolveModel('anthropic', catalog[0]!.id);
  return AgentLoop.create({
    model,
    workingDirectory: process.cwd(),
    initialBasePrompt: 'You are the probe host.',
    getApiKey: async () => 'unused-test-key',
    compaction: { strategy: 'classic' },
    disableTools: Object.values(TOOL_NAMES),
    enableSubAgentTool: false,
    enableLoadSkillTool: false,
    tools: [probe('first_probe')],
  });
}

const systemMessages = (sent: Sent) => sent.filter((message) => message.role === 'system');
const toolNames = (sent: Sent) =>
  getCurrentTools(sent as never).map((tool) => tool.name).sort();

describe('system transcript at the provider boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens the first request with one head carrying the sections and the initial tools', async () => {
    const requests: Sent[] = [];
    const loop = await createLoop(requests);
    try {
      await loop.prompt('Hello.');

      const [first] = requests;
      expect(first![0]).toMatchObject({
        role: 'system',
        content: '',
        sections: expect.objectContaining({ [INSTRUCTIONS_SECTION]: 'You are the probe host.' }),
      });
      // pi declared the tools as a separate message before the prompt; the
      // pre-request sync folded it into the head, where native tool-change
      // transports anchor later additions.
      expect(systemMessages(first!)).toHaveLength(1);
      expect((first![0]!['toolsAdded'] as Array<{ name: string }>).map((tool) => tool.name))
        .toEqual(['first_probe']);
      expect(getCurrentSystemPrompt(first! as never)).toBe(loop.getCurrentSystemPrompt());
    } finally {
      await loop.destroy();
    }
  });

  it('declares a tool added after an answer as a later message, leaving the head intact', async () => {
    const requests: Sent[] = [];
    const loop = await createLoop(requests);
    try {
      await loop.prompt('Hello.');
      loop.addConsumerTool(probe('second_probe'));
      await loop.prompt('Now with more tools.');

      const [first, second] = requests;
      expect(second![0]).toEqual(first![0]);
      const later = systemMessages(second!).slice(1);
      expect(later).toHaveLength(1);
      expect((later[0]!['toolsAdded'] as Array<{ name: string }>).map((tool) => tool.name))
        .toEqual(['second_probe']);
      expect(toolNames(second!)).toEqual(['first_probe', 'second_probe']);
      // In time order: after the first exchange, before the new prompt.
      const laterIndex = second!.indexOf(later[0]!);
      expect(second![laterIndex - 1]).toMatchObject({ role: 'assistant' });
      expect(second![laterIndex + 1]).toMatchObject({ role: 'user' });
    } finally {
      await loop.destroy();
    }
  });

  it('sends a prompt change after an answer as a section patch, leaving the head intact', async () => {
    const requests: Sent[] = [];
    const loop = await createLoop(requests);
    try {
      await loop.prompt('Hello.');
      loop.setBasePrompt('You are the renamed probe host.');
      await loop.prompt('Carry on.');

      const [first, second] = requests;
      expect(second![0]).toEqual(first![0]);
      const later = systemMessages(second!).slice(1);
      expect(later).toEqual([expect.objectContaining({
        content: '',
        sections: { [INSTRUCTIONS_SECTION]: 'You are the renamed probe host.' },
      })]);
      expect(getCurrentSystemPrompt(second! as never)).toBe(loop.getCurrentSystemPrompt());
    } finally {
      await loop.destroy();
    }
  });

  it('round-trips history with its system messages through JSON and restores in line', async () => {
    const requests: Sent[] = [];
    const loop = await createLoop(requests);
    try {
      await loop.prompt('Hello.');
      loop.addConsumerTool(probe('second_probe'));
      await loop.prompt('Again.');
      const saved = JSON.parse(JSON.stringify(loop.getConversationHistory()));
      expect(saved.map((message: { role: string }) => message.role))
        .toEqual(['user', 'assistant', 'system', 'user', 'assistant']);

      loop.restoreConversationHistory(saved);
      expect(loop.getConversationHistory()).toEqual(saved);
      await loop.prompt('After restore.');
      const last = requests.at(-1)!;
      // Nothing to re-declare: the restored delta already matches the live tools.
      expect(systemMessages(last)).toHaveLength(2);
      expect(toolNames(last)).toEqual(['first_probe', 'second_probe']);
    } finally {
      await loop.destroy();
    }
  });
});
