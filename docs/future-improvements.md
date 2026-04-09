# Future Improvements

Planned improvements to security, privacy, and operational hardening.

## Credential Storage

- Extend macOS Keychain integration to cover OAuth credential blobs, not just API keys
- Add Linux secure storage support (e.g., libsecret/Secret Service API) so credentials are not stored in plaintext JSON on Linux systems
- Investigate Windows Credential Manager integration for Windows support

## Logging

- Add sensitivity-level configuration so consumers can control what gets logged
- Implement optional redaction of prompt content in local logs
- Add an opt-in diagnostics mode for troubleshooting that captures additional context

## Permission Enforcement

- Systematic `chmod 0o600` enforcement on all sensitive files, including retroactive tightening on pre-existing files with overly broad permissions
- Audit and harden file permission handling across all config and credential paths

## File Permission Audit

- Verify that `~/.cortex/credentials.json`, `~/.cortex/settings.json`, and `~/.cortex/trusted-mcp.json` all consistently use `0o600` on creation and on update
- Add startup check that warns if sensitive files have permissions broader than `0o600`
