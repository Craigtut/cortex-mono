import { describe, it, expect } from 'vitest';
import { findToolCallGroups, extractToolCallIds } from '../../../src/compaction/tool-call-groups.js';
import type { AgentMessage } from '../../../src/context-manager.js';
import {
  makeUserMsg,
  makeAssistantMsg,
  makeToolCallMsg,
  makeToolResultMsg,
} from './helpers.js';

describe('extractToolCallIds', () => {
  it('collects ids from toolCall blocks', () => {
    const msg = makeToolCallMsg([
      { id: 'call_1', name: 'Read' },
      { id: 'call_2', name: 'Grep' },
    ], 'text first');
    expect([...extractToolCallIds(msg)]).toEqual(['call_1', 'call_2']);
  });

  it('returns empty set for plain messages', () => {
    expect(extractToolCallIds(makeAssistantMsg('hi')).size).toBe(0);
    expect(extractToolCallIds(makeUserMsg('hi')).size).toBe(0);
  });
});

describe('findToolCallGroups', () => {
  it('groups a single call with its single result', () => {
    const history: AgentMessage[] = [
      makeUserMsg('go'),                                  // 0
      makeToolCallMsg([{ id: 'call_1', name: 'Read' }]),  // 1
      makeToolResultMsg('call_1', 'Read', 'contents'),    // 2
      makeAssistantMsg('done'),                           // 3
    ];
    const groups = findToolCallGroups(history);

    expect(groups.get(1)).toEqual([1, 2]);
    expect(groups.get(2)).toEqual([1, 2]);
    expect(groups.has(0)).toBe(false);
    expect(groups.has(3)).toBe(false);
  });

  it('groups N parallel calls with their N consecutive results', () => {
    const history: AgentMessage[] = [
      makeToolCallMsg([
        { id: 'call_a', name: 'Read' },
        { id: 'call_b', name: 'Grep' },
        { id: 'call_c', name: 'Bash' },
      ]),                                                // 0
      makeToolResultMsg('call_a', 'Read', 'ra'),          // 1
      makeToolResultMsg('call_b', 'Grep', 'rb'),          // 2
      makeToolResultMsg('call_c', 'Bash', 'rc'),          // 3
      makeAssistantMsg('all done'),                       // 4
    ];
    const groups = findToolCallGroups(history);

    for (const idx of [0, 1, 2, 3]) {
      expect(groups.get(idx)).toEqual([0, 1, 2, 3]);
    }
    expect(groups.has(4)).toBe(false);
  });

  it('separates back-to-back groups', () => {
    const history: AgentMessage[] = [
      makeToolCallMsg([{ id: 'call_1', name: 'Read' }]),  // 0
      makeToolResultMsg('call_1', 'Read', 'r1'),          // 1
      makeToolCallMsg([{ id: 'call_2', name: 'Bash' }]),  // 2
      makeToolResultMsg('call_2', 'Bash', 'r2'),          // 3
    ];
    const groups = findToolCallGroups(history);

    expect(groups.get(0)).toEqual([0, 1]);
    expect(groups.get(1)).toEqual([0, 1]);
    expect(groups.get(2)).toEqual([2, 3]);
    expect(groups.get(3)).toEqual([2, 3]);
  });

  it('ends a group at a result referencing a foreign call id', () => {
    const history: AgentMessage[] = [
      makeToolCallMsg([{ id: 'call_1', name: 'Read' }]),  // 0
      makeToolResultMsg('call_1', 'Read', 'r1'),          // 1
      makeToolResultMsg('call_X', 'Bash', 'stray'),       // 2 (malformed)
    ];
    const groups = findToolCallGroups(history);

    expect(groups.get(0)).toEqual([0, 1]);
    expect(groups.has(2)).toBe(false);
  });

  it('keeps an assistant message with calls but no results as a lone group', () => {
    // A pending tool call at the end of history (results not yet appended)
    const history: AgentMessage[] = [
      makeUserMsg('go'),
      makeToolCallMsg([{ id: 'call_1', name: 'Read' }]),
    ];
    const groups = findToolCallGroups(history);

    expect(groups.get(1)).toEqual([1]);
  });

  it('ignores plain conversations', () => {
    const history: AgentMessage[] = [
      makeUserMsg('hello'),
      makeAssistantMsg('hi'),
      makeUserMsg('bye'),
    ];
    expect(findToolCallGroups(history).size).toBe(0);
  });
});
