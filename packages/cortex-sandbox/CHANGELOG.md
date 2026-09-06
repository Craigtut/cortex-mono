# Changelog

All notable changes to `@animus-labs/cortex-sandbox` are documented here.

## Unreleased

## 0.1.0

- Initial release, requiring Cortex `^0.6.0`.
- Add macOS Seatbelt and Linux bubblewrap providers through sandbox-runtime.
- Add platform selection, default policies, network domain matching, credential scrubbing, and per-session temporary-directory support.
- Contain shell and direct subprocess execution, classify denials, and report degraded enforcement when the backend cannot launch.
- Add the native Windows provider interface. This package does not include a signed Windows helper binary; without a separately supplied helper, Windows reports no containment. Signing and Windows release automation remain pending.
