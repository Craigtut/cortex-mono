/**
 * Which arguments identify a built-in tool call: the command, path,
 * pattern, URL, or task it acts on, without content or results.
 *
 * Several surfaces name a call (log lines, the background-task block, the
 * duplex headline, permission renderings); they share this one reading of
 * the arguments and each keeps its own presentation (truncation, basename,
 * verbatim JSON). Values are returned raw because presentation differs in
 * how it treats a non-string.
 */

import { TOOL_NAMES } from './index.js';

export interface ToolCallSubject {
  /** Bash: the command line. */
  command?: unknown;
  /** File tools: the file acted on (`file_path`, or a legacy `path`). */
  path?: unknown;
  /** Glob/Grep: the pattern searched for. */
  pattern?: unknown;
  /** Glob/Grep: the directory searched (their `path` argument). */
  scope?: unknown;
  /** WebFetch: the URL fetched. */
  url?: unknown;
  /** TaskOutput: the task read. */
  taskId?: unknown;
}

/** The identifying arguments of a call; empty for a tool without any. */
export function toolCallSubject(toolName: string, args: unknown): ToolCallSubject {
  const p = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  switch (toolName) {
    case TOOL_NAMES.Bash:
      return { command: p['command'] };
    case TOOL_NAMES.Read:
    case TOOL_NAMES.Write:
    case TOOL_NAMES.Edit:
    case TOOL_NAMES.UndoEdit:
      return { path: p['file_path'] ?? p['path'] };
    case TOOL_NAMES.Glob:
    case TOOL_NAMES.Grep:
      return { pattern: p['pattern'], scope: p['path'] };
    case TOOL_NAMES.WebFetch:
      return { url: p['url'] };
    case TOOL_NAMES.TaskOutput:
      return { taskId: p['task_id'] };
    default:
      return {};
  }
}
