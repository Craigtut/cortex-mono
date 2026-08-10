# @animus-labs/cortex-code

Terminal-based coding agent built on `@animus-labs/cortex`.

## Install

```bash
npm install -g @animus-labs/cortex-code
```

This installs both `cortex` and `cortex-code` commands. `cortex` is the primary command, and `cortex-code` is provided as an explicit alias.

## What It Does

Cortex Code is an interactive CLI coding agent. It uses Cortex's agentic loop, built-in tools (Bash, Read, Write, Edit, Glob, Grep), and provider management to help you work with codebases from the terminal.

## Usage

```bash
# Start an interactive session
cortex

# Equivalent explicit command
cortex-code

# Resume a previous session
cortex --resume

# Use a specific model
cortex --model claude-sonnet-4-20250514

# Start in YOLO mode (bypass tool permissions)
cortex --yolo

# Run the talker/reasoner duplex agent for one session
cortex --duplex

# Skip the startup check for a newer version
cortex --no-update-check
```

## Agent Mode

Cortex Code runs a single reasoner loop (`passthrough`) by default. The
alternative, `duplex`, puts a fast talker model in front of a persistent
reasoner so the session can answer a question or take a correction while the
reasoner is still working, instead of queueing it behind the task.

Passthrough is the default because a coding CLI streams the reasoner's tool
calls live, so there is little dead air for a talker to fill, and duplex adds a
second model between what you typed and the loop holding the tools. Opt in per
session with `--duplex`, or for good with `"agentMode": "duplex"` in
`~/.cortex/config.json`; `--no-duplex` overrides the config key for one
session. `/status` names the mode in force, and the footer badges `duplex`
while it is on.

Duplex needs a distinct fast model to be worth anything. On a provider whose
models cannot be enumerated (a custom endpoint, or Ollama) the talker falls
back to the primary model, which delivers none of the benefit; that shows up as
a `†` in the footer, with the reason under `/status`.

## Updates

Cortex Code checks npm for a newer version on startup (at most once a day) and
shows a prompt to update or skip. Skipping is remembered per version: the prompt
returns only when a newer version ships, while a subtle banner line keeps
reminding you. Update any time from inside a session with `/update`, or disable
the check with `--no-update-check` or `"updateCheck": false` in
`~/.cortex/config.json`.

## Features

- Interactive terminal UI with streaming responses
- Session persistence and resume
- Multi-provider support (Anthropic, OpenAI, Google, Ollama)
- File editing with diffs, syntax highlighting, and permission controls
- Skill system for extensible capabilities
- Startup update notifications with one-keystroke upgrade

## Requirements

- Node.js 24+

## License

MIT
