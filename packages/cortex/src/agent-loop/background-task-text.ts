/**
 * Text the loop shows its model about background work: the live
 * <background-tasks> block (running sub-agents and backgrounded Bash
 * commands, view-injected on every call) and the messages that deliver a
 * finished task's result.
 */

import { toolCallSubject } from '../tools/tool-call-subject.js';
import type { BackgroundTask } from '../tools/runtime.js';
import type { SubAgentManager } from '../sub-agent-manager.js';
import type { SubAgentResult, TrackedSubAgent } from '../types.js';
import type { ToolRegistry } from './tool-registry.js';

/**
 * Escape text interpolated into the <background-tasks> block. Task
 * instructions, tool summaries, commands, and stdout tails are untrusted;
 * without escaping they could forge or terminate the block's XML-ish tags.
 */
function escapeBackgroundStateText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Attribute values additionally escape double quotes (they sit inside "..."). */
function escapeBackgroundStateAttribute(value: string): string {
  return escapeBackgroundStateText(value).replaceAll('"', '&quot;');
}

/**
 * Short summary of a tool call's arguments for activity lines (child
 * tool activity in the background-task block and status surfaces).
 */
export function summarizeToolActivity(toolName: string, args: Record<string, unknown>): string {
  const subject = toolCallSubject(toolName, args);
  if ('command' in subject) return String(subject.command ?? '').slice(0, 60);
  if ('path' in subject) return String(subject.path ?? '').split('/').pop() ?? '';
  if ('pattern' in subject) return String(subject.pattern ?? '');
  if ('url' in subject) return String(subject.url ?? '').slice(0, 60);
  return '';
}

/**
 * Build a <background-tasks> block describing running sub-agents and
 * background bash processes. Returns null if nothing is running.
 * Called from transformContext before each LLM call.
 */
export function buildBackgroundTaskState(input: {
  subAgents: readonly TrackedSubAgent[];
  bashTasks: Iterable<[string, BackgroundTask]>;
  now: number;
}): string | null {
  const sections: string[] = [];
  const { now } = input;

  // Running sub-agents
  for (const entry of input.subAgents) {
    const taskId = entry.taskId;

    const durationSec = Math.round((now - entry.spawnedAt) / 1000);
    const childAgent = entry.agent;
    const tokens = (childAgent.currentContextTokenCount / 1000).toFixed(1);
    const budget = childAgent.getBudgetGuard();
    const turnsUsed = budget.getTurnCount();
    const turnsMax = budget.getMaxTurns();
    const turnsStr = turnsMax < Infinity ? `${turnsUsed}/${turnsMax}` : `${turnsUsed}`;
    const instructions = escapeBackgroundStateText(entry.instructions.slice(0, 120));

    let status = 'running';
    let activityLine = '';

    if (entry.pendingPermission) {
      status = 'waiting-for-permission';
      activityLine = `  Waiting for permission: ${escapeBackgroundStateText(entry.pendingPermission.toolName)}`;
    } else if (entry.lastToolName && entry.lastToolStartedAt) {
      const activityAgeSec = Math.round((now - entry.lastToolStartedAt) / 1000);
      const summary = entry.lastToolSummary
        ? ` ${escapeBackgroundStateText(entry.lastToolSummary)}`
        : '';
      activityLine = `  Current: ${escapeBackgroundStateText(entry.lastToolName)}${summary} (started ${activityAgeSec}s ago)`;
    }

    sections.push(
      `<sub-agent id="${escapeBackgroundStateAttribute(taskId)}" status="${status}" duration="${durationSec}s" tools="${entry.toolCount}" tokens="${tokens}k" turns="${turnsStr}">\n` +
      `  Instructions: ${instructions}\n` +
      (activityLine ? `${activityLine}\n` : '') +
      `</sub-agent>`,
    );
  }

  // Running background bash processes
  for (const [taskId, task] of input.bashTasks) {
    if (task.completed) continue;

    const durationSec = Math.round((now - task.startTime) / 1000);
    const command = task.command || taskId;
    const lastLines = task.stdout
      ? escapeBackgroundStateText(task.stdout.split('\n').filter(Boolean).slice(-3).join('\n  '))
      : '';

    let content = '';
    if (lastLines) {
      content = `  Last output:\n  ${lastLines}\n`;
    }

    sections.push(
      `<bash id="${escapeBackgroundStateAttribute(taskId)}" status="running" duration="${durationSec}s" command="${escapeBackgroundStateAttribute(String(command).slice(0, 80))}">\n` +
      content +
      `</bash>`,
    );
  }

  if (sections.length === 0) return null;

  return `<background-tasks>\n${sections.join('\n\n')}\n</background-tasks>`;
}

export function formatBashCompletion(task: BackgroundTask): string {
  const header = task.exitCode === 0
    ? `[Background command ${task.id} completed]`
    : `[Background command ${task.id} failed]`;
  const exit = task.exitCode === null ? 'unknown' : String(task.exitCode);
  const durationSec = ((Date.now() - task.startTime) / 1000).toFixed(1);
  const meta = `\`${task.command}\` (exit code: ${exit}, ${durationSec}s)`;

  const cap = 30000;
  const stdout = task.stdout.length > cap ? task.stdout.slice(-cap) : task.stdout;
  const stderr = task.stderr.length > cap ? task.stderr.slice(-cap) : task.stderr;
  let body = '';
  if (stdout) body += `\n\nOutput:\n${stdout}`;
  if (stderr) body += `\n\nStderr:\n${stderr}`;
  if (!stdout && !stderr) body = '\n\nNo output was produced.';
  return `${header} ${meta}${body}`;
}

export function formatSubAgentCompletion(taskId: string, result: SubAgentResult): string {
  const header = result.status === 'completed'
    ? `[Background sub-agent ${taskId} completed]`
    : result.status === 'timed_out'
      ? `[Background sub-agent ${taskId} timed out; partial output below]`
      : `[Background sub-agent ${taskId} failed]`;

  const usage = `(${result.usage.turns} turns, $${result.usage.cost.toFixed(4)}, ${(result.usage.durationMs / 1000).toFixed(1)}s)`;

  if (result.output) {
    return `${header} ${usage}\n\n${result.output}`;
  }
  return `${header} ${usage}\n\nNo output was produced.`;
}

/** The <background-tasks> block for the next call, or null when nothing runs. */
export function backgroundTaskState(
  subAgentManager: SubAgentManager,
  tools: Pick<ToolRegistry, 'runtime'>,
): string | null {
  const subAgents = subAgentManager.getActiveTaskIds()
    .map((taskId) => subAgentManager.get(taskId))
    .filter((entry): entry is TrackedSubAgent => entry !== undefined);
  return buildBackgroundTaskState({
    subAgents,
    bashTasks: tools.runtime.backgroundTasks.getAll(),
    now: Date.now(),
  });
}
