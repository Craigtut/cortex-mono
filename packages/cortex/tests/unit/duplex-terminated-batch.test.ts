/**
 * Phase 3, item 1: the terminated-batch transcript shape.
 *
 * Nothing in the codebase set `terminate` before duplex, so "a run that ends
 * on a toolResult instead of an assistant message" was an entirely
 * unexercised transcript shape (review-findings R2-A5). It is now the
 * talker's steady state: every control-tool dispatch produces it. This suite
 * drives real talker runs through a pi-shaped tool batch and checks the
 * shape survives everywhere a transcript is consumed: the next utterance,
 * cache-breakpoint simulation, persistence round-trip, and microcompaction.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { AgentLoop } from '../../src/agent-loop.js';
import type { AgentMessage } from '../../src/context-manager.js';
import {
  computeCacheBreakpointIndices,
  applyCacheBreakpoints,
} from '../../src/cache-breakpoints.js';
import { MicrocompactionEngine } from '../../src/compaction/microcompaction.js';
import { findToolCallGroups } from '../../src/compaction/tool-call-groups.js';
import { TOOL_RESULT_WORKING_TAGS_REMINDER } from '../../src/agent-loop.js';
import { SPEAK_NOW_APPENDIX } from '../../src/duplex/prompts.js';
import type { CortexAgentStateV2 } from '../../src/cortex-agent.js';
import { assertNoOrphans, makeToolCallMsg, makeToolResultMsg, makeUserMsg, makeAssistantMsg } from './compaction/helpers.js';
import {
  createDuplexScenario,
  destroyLiveFacades,
  promptTexts,
  roles,
  settle,
  waitUntil,
} from './duplex-scenario-harness.js';
import type { ScriptedPiAgent } from './duplex-scenario-harness.js';

afterEach(destroyLiveFacades);

/** The pi-side transcript, which is what a provider payload is built from. */
function transcript(pi: ScriptedPiAgent): AgentMessage[] {
  return pi.state.messages as AgentMessage[];
}

/** The conversation region, which is what the slot-free shape assertions want. */
function history(loop: AgentLoop): AgentMessage[] {
  return loop.getConversationHistory();
}

function lastOf(messages: AgentMessage[]): AgentMessage {
  return messages[messages.length - 1]!;
}

// ---------------------------------------------------------------------------
// The shape itself
// ---------------------------------------------------------------------------

describe('terminated batch: the shape a control-tool dispatch produces', () => {
  it('ends the run on a toolResult and costs no follow-up model call', async () => {
    const { facade, talkerLoop, talkerPi, reasonerPi } = createDuplexScenario();
    talkerPi.script = [{
      text: 'On it, scanning the repo now.',
      calls: [{ name: 'spawn_task', args: { instructions: 'scan the repo for TODOs' } }],
    }];

    await facade.prompt('can you scan the repo for TODOs?');

    // Zero extra round trips: one model call produced the acknowledgment and
    // the dispatch, and terminate ended the batch there (D8 latency claim).
    expect(talkerPi.modelCalls).toBe(1);
    const last = lastOf(history(talkerLoop));
    expect(last.role).toBe('toolResult');
    expect(last.toolName).toBe('spawn_task');

    // The receipt is bare: no working-tags reminder rides a dispatch receipt.
    const receipt = talkerPi.toolResults[0]!;
    expect(receipt.terminate).toBe(true);
    expect(receipt.text).toBe('Started task-1.');
    expect(receipt.text).not.toContain(TOOL_RESULT_WORKING_TAGS_REMINDER);

    // From the user's side: they were spoken to, and the work really started.
    const log = facade.getLog();
    expect(log.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(['utterance', 'reply', 'directive']),
    );
    expect(log.find((entry) => entry.type === 'reply')!.content)
      .toContain('On it, scanning the repo now.');
    await waitUntil(() => reasonerPi.promptCalls.length === 1, 2000, 'reasoner dispatch');
    expect(promptTexts(reasonerPi)[0]).toContain('scan the repo for TODOs');
  });

  it('leaves no orphaned call or result, including a multi-call batch', async () => {
    const { facade, talkerLoop, talkerPi } = createDuplexScenario();
    talkerPi.script = [{
      text: 'Starting both.',
      calls: [
        { name: 'spawn_task', args: { instructions: 'audit the tests' } },
        { name: 'spawn_task', args: { instructions: 'audit the docs' } },
      ],
    }];

    await facade.prompt('audit the tests and the docs');

    expect(talkerPi.modelCalls).toBe(1);
    assertNoOrphans(history(talkerLoop));
    expect(roles(history(talkerLoop))).toEqual([
      'user', 'assistant', 'toolResult', 'toolResult',
    ]);
    // Both dispatches landed as separate delegations under their aliases.
    expect(facade.getLog().filter((entry) => entry.type === 'directive')).toHaveLength(2);
  });

  it('the next utterance prompts cleanly off a history that ends on a toolResult', async () => {
    const { facade, talkerLoop, talkerPi, reasonerPi } = createDuplexScenario();
    // The reasoner says nothing, so no delivery joins the second run and the
    // shape under test stays the only thing in the transcript.
    reasonerPi.defaultText = '';
    talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'fix the failing test' } }],
    }];
    await facade.prompt('fix the failing test');
    expect(lastOf(history(talkerLoop)).role).toBe('toolResult');

    // The second exchange is an ordinary spoken turn on top of that shape.
    talkerPi.script = [{ text: 'Still running, nothing back yet.' }];
    await facade.prompt('how is it going?');

    expect(talkerPi.promptCalls).toHaveLength(2);
    expect(roles(history(talkerLoop))).toEqual([
      'user', 'assistant', 'toolResult', 'user', 'assistant',
    ]);
    assertNoOrphans(history(talkerLoop));
    const replies = facade.getLog().filter((entry) => entry.type === 'reply');
    expect(replies.map((entry) => entry.content)).toEqual([
      'On it.',
      'Still running, nothing back yet.',
    ]);
  });

  it('a preamble-less dispatch buys exactly one speaking turn, ending on that turn', async () => {
    // D17's empty-spoken-text guard: terminate is suppressed so the silent
    // exchange becomes one short spoken turn. The transcript then ends on an
    // assistant message, not a toolResult, which is the point.
    const { facade, talkerLoop, talkerPi } = createDuplexScenario();
    talkerPi.script = [
      { text: '', calls: [{ name: 'spawn_task', args: { instructions: 'run the suite' } }] },
      { text: 'Running the suite now.' },
    ];

    await facade.prompt('run the suite');

    expect(talkerPi.modelCalls).toBe(2);
    expect(talkerPi.toolResults[0]!.terminate).toBe(false);
    expect(talkerPi.toolResults[0]!.text).toContain(SPEAK_NOW_APPENDIX);
    expect(lastOf(history(talkerLoop)).role).toBe('assistant');
    assertNoOrphans(history(talkerLoop));
    // The user heard something rather than getting a silent exchange.
    expect(facade.getLog().find((entry) => entry.type === 'reply')!.content)
      .toBe('Running the suite now.');
  });
});

// ---------------------------------------------------------------------------
// Cache-breakpoint simulation over the shape
// ---------------------------------------------------------------------------

describe('terminated batch: cache-breakpoint simulation', () => {
  /**
   * Mirror of the merge rule under test, applied to a REAL transcript: pi-ai
   * emits one API message per Cortex message except that consecutive
   * toolResult messages merge. Every transcript this is used on is asserted
   * free of the content-empty messages the converter would also skip, so the
   * merge is the only rule in play.
   */
  function expectedApiMessages(messages: AgentMessage[]): AgentMessage[][] {
    for (const message of messages) {
      const empty = typeof message.content === 'string'
        ? message.content.trim().length === 0
        : !Array.isArray(message.content) || message.content.length === 0;
      expect(empty, `unexpected content-empty ${String(message.role)} message`).toBe(false);
    }
    const groups: AgentMessage[][] = [];
    for (const message of messages) {
      const previous = groups[groups.length - 1];
      if (message.role === 'toolResult' && previous?.[0]?.role === 'toolResult') {
        previous.push(message);
        continue;
      }
      groups.push([message]);
    }
    return groups;
  }

  /** A duplex scenario whose slot region is fully populated ahead of history. */
  function withSlot() {
    const harness = createDuplexScenario({ slots: ['identity'] });
    const contextManager = harness.talkerLoop.getContextManager();
    for (const name of contextManager.slots) {
      contextManager.setSlot(name, `slot content for ${name}`);
    }
    harness.reasonerPi.defaultText = '';
    return harness;
  }

  it('BP3 lands on the merged trailing toolResult of a real terminated batch', async () => {
    const { facade, talkerLoop, talkerPi } = withSlot();
    talkerPi.script = [{
      text: 'Starting both.',
      calls: [
        { name: 'spawn_task', args: { instructions: 'audit the tests' } },
        { name: 'spawn_task', args: { instructions: 'audit the docs' } },
      ],
    }];
    await facade.prompt('audit the tests and the docs');

    // The loop keeps slot messages at the head of the same array the payload
    // is built from, so this IS the array the converter would see.
    const slotCount = talkerLoop.getContextManager().slotCount;
    expect(slotCount).toBeGreaterThan(0);
    const messages = transcript(talkerPi);
    const api = expectedApiMessages(messages);
    // The two control-tool results really do collapse into one API message.
    expect(api).toHaveLength(messages.length - 1);
    expect(api[api.length - 1]).toHaveLength(2);

    const indices = computeCacheBreakpointIndices(messages, {
      slotCount,
      boundary: messages.length,
    });
    expect(indices.bp2ApiIndex).toBe(slotCount - 1);
    // Not messages.length - 1: the merge has to be accounted for, or the
    // breakpoint index runs off the end of the API array and is dropped.
    expect(indices.bp3ApiIndex).toBe(api.length - 1);
    expect(messages.length - 1).toBeGreaterThan(api.length - 1);
  });

  it('stamps the breakpoint onto the merged toolResult rather than dropping it', async () => {
    const { facade, talkerLoop, talkerPi } = withSlot();
    talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'scan the repo' } }],
    }];
    await facade.prompt('scan the repo');

    const messages = transcript(talkerPi);
    const indices = computeCacheBreakpointIndices(messages, {
      slotCount: talkerLoop.getContextManager().slotCount,
      boundary: messages.length,
    });

    // An Anthropic payload the shape the converter would build from this
    // transcript: one API message per group, toolResults merged.
    const api = expectedApiMessages(messages);
    const payload: Record<string, unknown> = {
      system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'spawn_task', cache_control: { type: 'ephemeral' } }],
      messages: api.map((group) => ({
        role: group[0]!.role === 'assistant' ? 'assistant' : 'user',
        content: group.map((message) => ({ type: 'text', text: String(message.role) })),
      })),
    };
    applyCacheBreakpoints(payload, indices);

    const apiMessages = payload['messages'] as Array<{ content: Array<Record<string, unknown>> }>;
    const stamped = apiMessages
      .map((message, index) => ({ index, block: message.content[message.content.length - 1]! }))
      .filter((entry) => entry.block['cache_control'] !== undefined)
      .map((entry) => entry.index);
    // BP2 on the last slot, BP3 on the tool_result message that ends the
    // batch. Both stamped means neither index ran off the end.
    expect(stamped).toEqual([indices.bp2ApiIndex, indices.bp3ApiIndex]);
    expect(apiMessages[indices.bp3ApiIndex]!.content[0]!['text']).toBe('toolResult');
    // The redundant tool breakpoint is stripped (the 4-breakpoint budget).
    expect((payload['tools'] as Array<Record<string, unknown>>)[0]!['cache_control'])
      .toBeUndefined();
  });

  it('an empty spoken turn before the call does not shift the trailing indices', () => {
    // The D17 guard produces assistant messages whose only text block is
    // empty; convertMessages drops a content-empty assistant message, and
    // dropping it breaks a toolResult run rather than merging across it.
    const messages: AgentMessage[] = [
      makeUserMsg('slot'),
      makeUserMsg('do the thing'),
      makeToolCallMsg([{ id: 'c1', name: 'spawn_task' }]),
      makeToolResultMsg('c1', 'spawn_task', 'Started task-1.'),
      // The D17 empty-spoken shape: a content ARRAY whose only text is empty.
      { role: 'assistant', content: [{ type: 'text', text: '' }], timestamp: 0 } as AgentMessage,
      makeToolResultMsg('c1', 'spawn_task', 'Started task-1.'),
    ];
    const indices = computeCacheBreakpointIndices(messages, {
      slotCount: 1,
      boundary: messages.length,
    });
    // slot=0, user=1, assistant=2, toolResult=3, (empty assistant skipped,
    // and it BREAKS the run), toolResult=4.
    expect(indices.bp2ApiIndex).toBe(0);
    expect(indices.bp3ApiIndex).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Persistence round-trip over the shape
// ---------------------------------------------------------------------------

describe('terminated batch: restore round-trip', () => {
  it('round-trips a transcript that ends on a toolResult and keeps prompting', async () => {
    const source = createDuplexScenario();
    source.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'scan the repo' } }],
    }];
    await source.facade.prompt('scan the repo');

    const state = await source.facade.getState() as CortexAgentStateV2;
    expect(state.version).toBe(2);
    const savedTalker = state.talkerHistory as AgentMessage[];
    expect(savedTalker[savedTalker.length - 1]!.role).toBe('toolResult');
    assertNoOrphans(savedTalker);

    // Restore into a fresh session and confirm nothing about the shape was
    // lost: roles, tool linkage, and the receipt text.
    const target = createDuplexScenario();
    target.facade.restore(state);
    const restored = target.talkerLoop.getConversationHistory();
    expect(roles(restored)).toEqual(roles(savedTalker));
    assertNoOrphans(restored);
    const restoredResult = restored[restored.length - 1]!;
    expect(restoredResult.toolCallId).toBe(savedTalker[savedTalker.length - 1]!.toolCallId);
    expect(String(JSON.stringify(restoredResult.content))).toContain('Started task-1.');

    // And the restored session takes the next utterance without complaint.
    target.talkerPi.script = [{ text: 'Still going.' }];
    await target.facade.prompt('any news?');
    expect(target.talkerPi.promptCalls).toHaveLength(1);
    assertNoOrphans(target.talkerLoop.getConversationHistory());
  });

  it('restores a terminated batch whose receipt was checkpointed empty', () => {
    // The restore sanitizer replaces empty content so a provider never sees
    // a blank block. The tool linkage has to survive that rewrite, or the
    // restored transcript is a hard provider error on the next call.
    const target = createDuplexScenario();
    const history: AgentMessage[] = [
      makeUserMsg('scan the repo'),
      makeToolCallMsg([{ id: 'c1', name: 'spawn_task' }], 'On it.'),
      { role: 'toolResult', toolCallId: 'c1', toolName: 'spawn_task', content: [], timestamp: 0 } as AgentMessage,
    ];
    target.talkerLoop.restoreConversationHistory(history);

    const restored = target.talkerLoop.getConversationHistory();
    expect(restored[2]!.role).toBe('toolResult');
    expect(restored[2]!.toolCallId).toBe('c1');
    expect(JSON.stringify(restored[2]!.content)).toContain('(no output)');
    assertNoOrphans(restored);
  });
});

// ---------------------------------------------------------------------------
// Microcompaction over the shape
// ---------------------------------------------------------------------------

describe('terminated batch: microcompaction of a control-tool result', () => {
  /** Filler that pushes older messages past the hot zone. */
  function filler(count: number): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < count; i++) {
      messages.push(makeUserMsg(`follow-up ${i}: ${'x'.repeat(400)}`));
      messages.push(makeAssistantMsg(`reply ${i}: ${'y'.repeat(400)}`));
    }
    return messages;
  }

  it('trims a control-tool receipt in place without orphaning its call', async () => {
    const history: AgentMessage[] = [
      makeUserMsg('scan the repo'),
      makeToolCallMsg([{ id: 'c1', name: 'spawn_task', arguments: { instructions: 'scan' } }], 'On it.'),
      makeToolResultMsg('c1', 'spawn_task', 'Started task-1.'),
      ...filler(30),
    ];
    const before = roles(history);

    const engine = new MicrocompactionEngine({ hotZoneMinTokens: 100, trimFloorRatio: 0.1 });
    const after = await engine.apply(history, 4_000, 3_000, { cacheCold: true });

    // In place: the trimmer rewrites content, it never removes messages.
    expect(after).toHaveLength(history.length);
    expect(roles(after)).toEqual(before);
    assertNoOrphans(after);

    const trimmed = after[2]!;
    expect(trimmed.role).toBe('toolResult');
    expect(trimmed.toolCallId).toBe('c1');
    expect(Array.isArray(trimmed.content)).toBe(true);
    // It really was trimmed (otherwise this test proves nothing).
    expect(JSON.stringify(trimmed.content)).not.toBe(JSON.stringify(history[2]!.content));

    // The structural pairing compaction relies on still holds.
    const groups = findToolCallGroups(after);
    expect(groups.get(1)).toEqual([1, 2]);
  });

  it('keeps a two-result terminated batch atomic under trimming', async () => {
    const history: AgentMessage[] = [
      makeUserMsg('audit both'),
      makeToolCallMsg([
        { id: 'c1', name: 'spawn_task' },
        { id: 'c2', name: 'spawn_task' },
      ], 'Starting both.'),
      makeToolResultMsg('c1', 'spawn_task', 'Started task-1.'),
      makeToolResultMsg('c2', 'spawn_task', 'Started task-2.'),
      ...filler(30),
    ];

    const engine = new MicrocompactionEngine({ hotZoneMinTokens: 100, trimFloorRatio: 0.1 });
    const after = await engine.apply(history, 4_000, 3_000, { cacheCold: true });

    assertNoOrphans(after);
    expect(after[2]!.toolCallId).toBe('c1');
    expect(after[3]!.toolCallId).toBe('c2');
    expect(findToolCallGroups(after).get(1)).toEqual([1, 2, 3]);
  });

  it('a warm cache leaves the terminated batch untouched', async () => {
    const history: AgentMessage[] = [
      makeUserMsg('scan the repo'),
      makeToolCallMsg([{ id: 'c1', name: 'spawn_task' }], 'On it.'),
      makeToolResultMsg('c1', 'spawn_task', 'Started task-1.'),
      ...filler(30),
    ];
    const engine = new MicrocompactionEngine({ hotZoneMinTokens: 100, trimFloorRatio: 0.1 });
    const after = await engine.apply(history, 4_000, 3_000, { cacheCold: false });
    expect(after).toBe(history);
  });
});

// ---------------------------------------------------------------------------
// The error path: an errored control call is the one shape that reopens
// ---------------------------------------------------------------------------

describe('terminated batch: the errored-call exception', () => {
  it('an error result (no terminate) buys one recovery turn and then ends', async () => {
    const { facade, talkerLoop, talkerPi } = createDuplexScenario();
    talkerPi.script = [
      // A tool pi does not know: its error result carries no terminate, so
      // the loop reopens exactly once, which is the intended behavior.
      { text: 'Let me try that.', calls: [{ name: 'not_a_control_tool' }] },
      { text: 'Sorry, I could not do that.' },
    ];

    await facade.prompt('do the impossible');
    await settle();

    expect(talkerPi.modelCalls).toBe(2);
    expect(talkerPi.toolResults[0]!.terminate).toBe(false);
    expect(lastOf(history(talkerLoop)).role).toBe('assistant');
    assertNoOrphans(history(talkerLoop));
  });
});
