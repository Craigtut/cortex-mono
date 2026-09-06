# vendor/win32-x64

The signed Tier-1 sandbox helper binary ships here:

```
cortex-sandbox-helper.exe
```

It is **not** built by the JS install. It is produced on Windows CI from
`../../windows-helper` and Authenticode-signed, then dropped in this directory
and published in the npm tarball (see the package `files` allowlist and
`docs/cortex/windows-sandbox-build.md`).

`defaultHelperPath()` in `../../src/windows.ts` resolves to
`<package>/vendor/win32-x64/cortex-sandbox-helper.exe`. When the binary is
absent (e.g. a source checkout, or a platform where it was never built), the
`WindowsRestrictedTokenProvider` reports honest UNCONTAINED `none` and passes
commands through unchanged rather than failing.

The ARM64 binary, when built, goes in a sibling `vendor/win32-arm64/` directory.
