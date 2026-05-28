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

# Skip the startup check for a newer version
cortex --no-update-check
```

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
