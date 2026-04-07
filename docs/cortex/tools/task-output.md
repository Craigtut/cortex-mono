# TaskOutput Tool

Poll, send input to, or kill a backgrounded process. This is a companion tool to the Bash tool, automatically registered alongside it. It provides the agent with the ability to interact with long-running commands that were backgrounded (either explicitly via `background: true` or automatically via auto-yield).

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `task_id` | string | Yes | The task ID returned by a backgrounded Bash command |
| `action` | string | Yes | Action to perform: `poll`, `send`, or `kill` |
| `input` | string | No | Input to send to the process stdin. Only used with the `send` action. |
| `signal` | string | No | Signal to send to the process. Only used with the `kill` action. Default: `SIGTERM`. Options: `SIGINT`, `SIGTERM`, `SIGKILL`. |

## Returns

**`content`** (sent to the LLM):
- For `poll`: status line (running/completed/failed with exit code), truncated stdout (max ~30,000 characters from the tail), and stderr if non-empty
- For `send`: confirmation that input was sent, or an error if the process has already completed
- For `kill`: confirmation that the signal was sent, or a note that the process has already completed

**`details`** (sent to UI/logs only):
- Task ID
- Action performed
- Status: `running`, `completed`, `failed`, or `not_found`
- Exit code (null if still running)
- Full stdout and stderr (untruncated)

## Actions

### poll

Retrieve the latest output and status of a backgrounded process. This is the most commonly used action.

- If the process is still running, status is `running`
- If the process exited with code 0, status is `completed`
- If the process exited with a non-zero code, status is `failed`
- Output is truncated to the last ~30,000 characters if it exceeds that limit

### send

Send input to a running process's stdin. Useful for processes that prompt for user input (e.g., confirmation prompts, interactive installers).

- A newline is automatically appended to the input
- Returns an error if the process has already completed
- The `input` parameter is required for this action (defaults to empty string if omitted)

### kill

Send a signal to a running process. Useful for stopping long-running processes or sending interrupt signals.

- Default signal is `SIGTERM`
- Use `SIGINT` for a graceful interrupt (equivalent to Ctrl+C)
- Use `SIGKILL` for a forced kill when the process is unresponsive
- Returns a note if the process has already completed

## Relationship to Bash Tool

TaskOutput is not registered independently. It is created and registered automatically alongside the Bash tool as a companion. When the Bash tool backgrounds a command (either via `background: true` or auto-yield after the configurable threshold), it returns a task ID. That task ID is the key used by TaskOutput to interact with the process.

The typical workflow is:

1. Agent runs a command via Bash with `background: true` (or the command auto-yields)
2. Bash returns a task ID in the response
3. Agent uses TaskOutput with `action: "poll"` to check on progress
4. When a backgrounded process completes, the agent is notified via pi-agent-core's follow-up message mechanism, so repeated polling is usually unnecessary
5. If the process needs to be stopped, the agent uses `action: "kill"`

Both tools share the same background task store via the `CortexToolRuntime`, ensuring they reference the same set of running processes.

## Implementation Notes

### Task Store

Background tasks are tracked in a shared store (`globalBackgroundTaskStore` or a runtime-scoped store). Each entry contains:
- The `ChildProcess` handle
- Accumulated stdout and stderr
- Completion status and exit code

### Error Handling

| Condition | Behavior |
|-----------|----------|
| Unknown task ID | Return "Task not found: {id}" with status `not_found` |
| Send to completed process | Return error noting the process has already completed |
| Kill completed process | Return note that the process has already completed |
| Stdin write failure | Return error with the failure message |
| Kill signal failure | Return error with the failure message |
| Unknown action | Return "Unknown action: {action}" |

### System Prompt Guidance

The system prompt should instruct the model to use TaskOutput for interacting with backgrounded processes rather than attempting to use Bash to check on them. The agent should prefer `poll` to check status, `send` to provide input, and `kill` to terminate processes that are no longer needed.
