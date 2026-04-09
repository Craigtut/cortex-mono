# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x (latest) | Yes |
| < 0.1.0 | No |

Only the latest 0.1.x release receives security fixes.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

- **Preferred**: Open a [GitHub Security Advisory](https://github.com/Craigtut/cortex-mono/security/advisories/new) on this repository. This allows private discussion before public disclosure.
- **Alternative**: Email craig@muselab.io with a description of the vulnerability.

Please include:
- A description of the issue and its potential impact
- Steps to reproduce (if applicable)
- Any suggested fixes

We aim to acknowledge reports within 48 hours and provide an initial assessment within one week.

## Credential Storage

Cortex Code stores provider credentials locally on the user's machine. The storage behavior varies by platform:

**macOS (with Keychain)**:
- API keys are stored in the macOS Keychain via the `security` CLI tool, under the service name `cortex-code`. They are not written to disk in plaintext.
- OAuth credential blobs (tokens, refresh tokens, metadata) are stored in a plaintext JSON file at `~/.cortex/credentials.json`. Keychain integration does not yet cover OAuth credentials.

**Linux and non-Keychain systems**:
- All credentials (API keys and OAuth blobs) fall back to plaintext JSON storage in `~/.cortex/credentials.json`.

The credential file is created with mode `0o600` (owner read/write only). This is a known limitation; extending secure storage to cover OAuth credentials and supporting Linux secret stores are planned improvements.

## File Permissions

Sensitive files (credentials, permission rules, MCP trust store) are created with restrictive permissions (`0o600`). Enforcement on pre-existing files is an area for improvement. If a file was created by an earlier version or external process with broader permissions, the current code does not retroactively tighten permissions on every read.

Sensitive file locations:
- `~/.cortex/credentials.json` (provider credentials)
- `~/.cortex/settings.json` (permission rules)
- `~/.cortex/trusted-mcp.json` (MCP trust-on-first-use store)

## Local Logging

Cortex Code logs session context locally for debugging purposes. These logs remain on the user's machine and are not transmitted to any external service. Planned improvements include sensitivity-level configuration and optional redaction of prompt content.

## General Security Considerations

- Cortex Code executes shell commands and file operations as directed by the LLM. The built-in permission system (`beforeToolCall` hook, permission rules) provides a gate for tool execution, but users should review tool calls before approving them.
- MCP tool servers run as local subprocesses. The trust-on-first-use system requires explicit approval before project-level MCP configurations are activated.
- No credentials or session data are sent to third parties beyond the configured LLM provider APIs.
