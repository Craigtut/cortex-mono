/**
 * Names of the built-in tools, as the model and the permission layer see
 * them. A leaf with no imports, so modules that only need to recognize a
 * tool by name do not load the tool implementations.
 */

export const TOOL_NAMES = {
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  UndoEdit: 'UndoEdit',
  Glob: 'Glob',
  Grep: 'Grep',
  Bash: 'Bash',
  TaskOutput: 'TaskOutput',
  WebFetch: 'WebFetch',
  SubAgent: 'SubAgent',
} as const;

export type BuiltInToolName = keyof typeof TOOL_NAMES;

/**
 * Synthetic tool name a Bash escalation request is presented under at the
 * permission layer. A call with `escalateOutsideSandbox: true` (while a sandbox
 * provider is configured) reaches the consumer's resolvePermission under this
 * name instead of "Bash", so rules and auto-approve paths keyed on plain Bash
 * never silently approve an uncontained run, and the consumer can render a
 * distinct "run outside the sandbox?" prompt.
 */
export const BASH_ESCALATION_PERMISSION_NAME = 'Bash(escalate)';
