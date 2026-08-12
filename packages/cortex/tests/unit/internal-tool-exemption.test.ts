/**
 * Internal-tool permission exemption (`permissionExempt` on CortexTool).
 *
 * Cortex-internal orchestration tools are in-process dispatches with no side
 * effect a consumer could meaningfully gate. Routing them through the
 * consumer's resolvePermission produced a live defect: a reasoner's Deliver
 * call surfaced as a "Permission Required" dialog, blocking delivery of the
 * very answer the user was waiting on. These tests pin the classification
 * (which tools carry the flag), the lookup rules (registry-based, MCP
 * refused), and the end-to-end behavior (the gate never consults the
 * resolver for an exempt tool).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Type } from 'typebox';
import { buildDeliverTool, buildSteerSubAgentTool } from '../../src/duplex/reasoner-tools.js';
import { buildControlTools, CONTROL_TOOL_NAMES } from '../../src/duplex/control-tools.js';
import type { ControlDispatchTarget } from '../../src/duplex/control-tools.js';
import { createRecallTool } from '../../src/compaction/observational/recall-tool.js';
import { createLoadSkillTool } from '../../src/skill-tool.js';
import { createSubAgentTool } from '../../src/tools/sub-agent.js';
import { createToolSearchTool } from '../../src/tools/tool-search/index.js';
import type { CortexTool } from '../../src/tool-contract.js';
import {
  createDuplexScenario,
  destroyLiveFacades,
  entriesOfType,
  installPermissionGate,
  waitUntil,
} from './duplex-scenario-harness.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await destroyLiveFacades();
});

// ---------------------------------------------------------------------------
// Classification: every internal orchestration tool carries the flag
// ---------------------------------------------------------------------------

describe('internal tools carry permissionExempt', () => {
  const fakeRouter: ControlDispatchTarget = {
    dispatchSpawn: () => 'ok',
    dispatchSteer: () => 'ok',
    dispatchCancel: () => 'ok',
    dispatchLookup: () => 'ok',
    dispatchAnswerAsk: () => 'ok',
  };

  it('Deliver and SteerSubAgent are exempt', () => {
    const deliver = buildDeliverTool({
      deliverFromReasoner: () => ({ delivered: true }),
    });
    const steer = buildSteerSubAgentTool({
      steerSubAgent: () => true,
      getActiveSubAgents: () => [],
    });
    expect(deliver.permissionExempt).toBe(true);
    expect(steer.permissionExempt).toBe(true);
  });

  it('all five talker control tools are exempt', () => {
    const tools = buildControlTools(fakeRouter);
    expect(tools.map((t) => t.name).sort()).toEqual([...CONTROL_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.permissionExempt, tool.name).toBe(true);
    }
  });

  it('recall, load_skill, SubAgent, and ToolSearch are exempt', () => {
    const recall = createRecallTool({} as never);
    const loadSkill = createLoadSkillTool({
      getAvailableSkillsSummary: () => 'none',
    } as never);
    const subAgent = createSubAgentTool({} as never);
    const toolSearch = createToolSearchTool({} as never);
    expect(recall.permissionExempt).toBe(true);
    expect(loadSkill.permissionExempt).toBe(true);
    expect(subAgent.permissionExempt).toBe(true);
    expect(toolSearch.permissionExempt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lookup rules: registry-based, MCP refused
// ---------------------------------------------------------------------------

function makeTool(overrides: Partial<CortexTool> & { name: string }): CortexTool {
  return {
    description: 'test tool',
    parameters: Type.Object({}),
    execute: async () => 'ok',
    ...overrides,
  };
}

describe('AgentLoop.isToolPermissionExempt', () => {
  it('exempts duplex internal tools registered on the reasoner, and only those', () => {
    const h = createDuplexScenario();
    // The facade registered Deliver and SteerSubAgent on the reasoner.
    expect(h.reasonerLoop.isToolPermissionExempt('Deliver')).toBe(true);
    expect(h.reasonerLoop.isToolPermissionExempt('SteerSubAgent')).toBe(true);
    // Legacy name check, kept alongside the flag.
    expect(h.reasonerLoop.isToolPermissionExempt('SubAgent')).toBe(true);
    // Side-effecting built-ins are never exempt.
    expect(h.reasonerLoop.isToolPermissionExempt('Bash')).toBe(false);
    expect(h.reasonerLoop.isToolPermissionExempt('Write')).toBe(false);
    // Unknown names are not exempt: exemption is a property of a registered
    // tool object, never of a call.
    expect(h.reasonerLoop.isToolPermissionExempt('no_such_tool')).toBe(false);
  });

  it('honors the flag on a consumer tool but refuses it on an MCP wrapper', () => {
    const h = createDuplexScenario();
    h.reasonerLoop.addConsumerTool(makeTool({
      name: 'consumer_internal',
      permissionExempt: true,
    }));
    h.reasonerLoop.addConsumerTool(makeTool({
      name: 'mcp_self_exempt',
      permissionExempt: true,
      isMcp: true,
    }));
    expect(h.reasonerLoop.isToolPermissionExempt('consumer_internal')).toBe(true);
    // A remote server declaring the field must gain nothing by it.
    expect(h.reasonerLoop.isToolPermissionExempt('mcp_self_exempt')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End to end: the regression that motivated the flag
// ---------------------------------------------------------------------------

describe('the permission gate never consults the resolver for exempt tools', () => {
  it("a reasoner Deliver bypasses a resolver that would deny it, and the delivery lands", async () => {
    const h = createDuplexScenario();
    const seen: string[] = [];
    // A resolver that denies everything it sees. If the gate consulted it
    // for Deliver, the delivery would be blocked and this test would fail
    // twice over: `seen` non-empty, and no delivery entry in the log.
    installPermissionGate(h.reasonerLoop, h.reasonerPi, async (toolName) => {
      seen.push(toolName);
      return { decision: 'deny', reason: 'the gate must never see internal tools' };
    });

    h.talkerPi.script = [
      {
        text: 'On it.',
        calls: [{ name: 'spawn_task', args: { instructions: 'do the thing' } }],
      },
      { text: 'Done: the result is in.' },
    ];
    h.reasonerPi.script = [{
      text: '',
      calls: [{
        name: 'Deliver',
        args: { content: 'the result', wake: 'when_idle' },
      }],
    }];

    await h.facade.prompt('please do the thing');
    await waitUntil(
      () => entriesOfType(h.facade, 'delivery').length >= 1,
      2000, 'delivery landed without a permission ask',
    );

    expect(seen).toEqual([]);
    expect(entriesOfType(h.facade, 'ask')).toHaveLength(0);
  });
});
