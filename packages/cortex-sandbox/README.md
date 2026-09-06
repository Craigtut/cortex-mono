# Cortex sandbox

OS sandbox providers for `@animus-labs/cortex`. Requires Node.js 24 or newer
and Cortex `^0.6.0`.

```bash
npm install @animus-labs/cortex@^0.6.0 @animus-labs/cortex-sandbox
```

The package exports `createSandboxProvider()` for platform selection and
`buildDefaultPolicy()` for policy construction. The consumer initializes the
provider, checks its reported enforcement, passes it through Cortex's
`sandbox` configuration, and disposes it when the session ends.

macOS uses Seatbelt. Linux uses bubblewrap through
`@anthropic-ai/sandbox-runtime` and requires the backend's OS dependencies.
Enforcement depends on the host; consumers must inspect the initialization
result before treating execution as contained.

The Windows provider requires a native helper. Version 0.1.0 does not bundle
a signed helper, so Windows reports no containment unless the consumer supplies
one. Cortex Code defaults Windows containment to off and offers
`sandbox.requireEnforcement` to refuse shell execution without enforcement.

See `docs/cortex/sandboxing.md` and `docs/cortex/windows-sandbox-build.md` in the
repository for integration and platform details.
