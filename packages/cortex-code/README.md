# @animus-labs/cortex-code

Terminal-based coding agent built on [`@animus-labs/cortex`](../cortex/).

> **Status: In Development.** This package is under active development and not yet published to npm.

## What It Does

Cortex Code is an interactive CLI coding agent. It uses Cortex's agentic loop, built-in tools (Bash, Read, Write, Edit, Glob, Grep), and provider management to help you work with codebases from the terminal.

## Usage

```bash
# Start an interactive session
cortex

# Resume a previous session
cortex --resume

# Use a specific model
cortex --model claude-sonnet-4-20250514

# Start in YOLO mode (bypass tool permissions)
cortex --yolo
```

## Features

- Interactive terminal UI with streaming responses
- Session persistence and resume
- Multi-provider support (Anthropic, OpenAI, Google, Ollama)
- File editing with diffs, syntax highlighting, and permission controls
- Skill system for extensible capabilities

## Requirements

- Node.js 24+

## License

MIT
