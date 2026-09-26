/**
 * The live tool list on a sub-agent's transcript row.
 *
 * A child agent's tool calls do not get transcript rows of their own; they
 * update the parent SubAgent row, which lists what the child is doing.
 */

import type { CortexEvent } from '@animus-labs/cortex';
import type { TranscriptManager } from '../tui/transcript.js';
import { readToolEnd, readToolStart } from './tool-events.js';

interface ChildToolActivity { name: string; status: string; summary?: string }

export class SubAgentActivity {
  private readonly tasks = new Map<string, Map<string, ChildToolActivity>>();

  constructor(
    private readonly getApp: () => { transcript: Pick<TranscriptManager, 'updateToolCall'> } | null,
  ) {}

  /** A sub-agent was spawned: start an empty tool list for it. */
  open(taskId: string): void {
    this.tasks.set(taskId, new Map());
  }

  /** A sub-agent finished, either way: drop its tool list. */
  close(taskId: string): void {
    this.tasks.delete(taskId);
  }

  /** Create a short summary of tool args for display. */
  private summarizeToolArgs(toolName: string, args: unknown): string {
    const a = args as Record<string, unknown>;
    switch (toolName) {
      case 'Bash':
        return String(a['command'] ?? '').slice(0, 80);
      case 'Read':
        return String(a['file_path'] ?? a['path'] ?? '');
      case 'Write':
        return String(a['file_path'] ?? a['path'] ?? '');
      case 'Edit':
        return String(a['file_path'] ?? a['path'] ?? '');
      case 'Glob':
        return String(a['pattern'] ?? '');
      case 'Grep':
        return `${String(a['pattern'] ?? '')}`;
      case 'WebFetch':
        return String(a['url'] ?? '').slice(0, 80);
      case 'SubAgent': {
        const desc = String(a['description'] ?? a['instructions'] ?? '');
        return desc.slice(0, 60);
      }
      default:
        return JSON.stringify(args).slice(0, 60);
    }
  }

  /** A child agent started a tool: add it to the parent row as pending. */
  toolStarted(event: CortexEvent): void {
    if (!event.childTaskId || !this.getApp()) return;

    const { toolName, toolCallId, args } = readToolStart(event);
    const summary = this.summarizeToolArgs(toolName, args);

    this.update(event.childTaskId, toolCallId, {
      name: toolName,
      status: 'pending',
      summary,
    });
  }

  /** A child agent finished a tool: settle its entry on the parent row. */
  toolEnded(event: CortexEvent): void {
    if (!event.childTaskId || !this.getApp()) return;

    const { toolName, toolCallId, isError } = readToolEnd(event);
    const existing = this.tasks.get(event.childTaskId)?.get(toolCallId);

    this.update(event.childTaskId, toolCallId, {
      name: existing?.name ?? toolName,
      status: isError ? 'error' : 'success',
      ...(existing?.summary ? { summary: existing.summary } : {}),
    });
  }

  private update(
    taskId: string,
    toolCallId: string,
    activity: ChildToolActivity,
  ): void {
    let tools = this.tasks.get(taskId);
    if (!tools) {
      tools = new Map();
      this.tasks.set(taskId, tools);
    }

    tools.set(toolCallId, activity);
    this.getApp()?.transcript.updateToolCall(taskId, {
      toolCalls: [...tools.values()],
    });
  }
}
