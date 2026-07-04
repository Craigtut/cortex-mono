# Windows sandbox helper: build, sign, ship

How the native Windows Tier-1 sandbox helper is produced, signed, and bundled,
plus exactly what it does and does not enforce. This is the operational
companion to the design in [`sandboxing.md`](./sandboxing.md) ("Layer 3: native
Windows (no WSL2)").

> **Status: scaffolded, unverified.** The helper crate
> (`packages/cortex-sandbox/windows-helper`) was authored on macOS following the
> Codex-shipped restricted-token recipe. It has **not** been compiled, run,
> tested, or code-signed. The Win32 call sequence and flags are the deliverable;
> the exact `windows`-crate symbol paths and return-type wrapping may need small
> adjustments on the first real Windows build. Nothing here is a verified
> security boundary until a Windows engineer completes the build/test/sign loop
> below and the adversarial containment tests pass.

## What ships, and how the pieces fit

- **Rust helper** (`packages/cortex-sandbox/windows-helper`): a small exe,
  `cortex-sandbox-helper.exe`, built for Windows and Authenticode-signed.
- **TS provider** (`packages/cortex-sandbox/src/windows.ts`,
  `WindowsRestrictedTokenProvider`): on win32, Cortex's Bash tool spawns the
  helper in place of the shell. It writes the policy to a temp JSON file and
  builds the argv `helper.exe <policy.json> -- <shell> <shellArgs...> <command>`.
- **Factory** (`createSandboxProvider`): returns the Windows provider on win32
  and the sandbox-runtime provider (Seatbelt/bubblewrap) on macOS/Linux.
- The JS install never builds Rust. The signed binary is prebuilt on Windows CI
  and shipped in the package under `vendor/win32-x64/`. If it is absent at
  runtime, the provider reports honest UNCONTAINED `none` and passes commands
  through unchanged (the Node layer owns the "run uncontained" decision; the
  helper itself never runs a command uncontained).

## Build

Prerequisites on the Windows build agent:

- Rust stable with the MSVC toolchain (`rustup default stable-msvc`).
- The target: `rustup target add x86_64-pc-windows-msvc` (and
  `aarch64-pc-windows-msvc` for ARM64). `rust-toolchain.toml` pins both.
- Visual Studio Build Tools (the MSVC linker; the `windows` crate links against
  the Windows SDK import libs).

```powershell
cd packages\cortex-sandbox\windows-helper
cargo build --release --target x86_64-pc-windows-msvc
cargo test  --target x86_64-pc-windows-msvc   # policy + command-line unit tests
```

The `windows` crate feature flags in `Cargo.toml` are scoped to only the module
trees the recipe touches. If a `cargo build` reports a missing symbol, it is
almost always a feature that needs adding or a symbol path that moved between
`windows` crate versions; fix the feature list / import rather than widening the
recipe.

Output: `target\x86_64-pc-windows-msvc\release\cortex-sandbox-helper.exe`.

## Sign (mandatory) and timestamp

An unsigned exe that manipulates tokens, edits ACLs, and spawns child processes
is exactly the behavior profile Microsoft Defender, SmartScreen, and third-party
EDR flag as malware. **Ship only a signed, timestamped binary.**

```powershell
signtool sign `
  /fd SHA256 `
  /a `
  /tr http://timestamp.digicert.com `
  /td SHA256 `
  target\x86_64-pc-windows-msvc\release\cortex-sandbox-helper.exe

signtool verify /pa /v cortex-sandbox-helper.exe
```

- Use an OV or EV Authenticode code-signing certificate. EV (or enrolling the
  product in the Microsoft Trusted Signing / former Partner Center program)
  builds SmartScreen reputation fastest; a fresh OV cert still shows "unknown
  publisher" warnings until reputation accrues.
- **Always timestamp** (`/tr` + `/td SHA256`). Without a countersignature the
  signature expires with the certificate; with one it stays valid after the cert
  expires.
- The app manifest (`app.manifest`, embedded by `build.rs`) sets
  `requestedExecutionLevel=asInvoker`: the helper is unelevated and must never
  raise a UAC prompt.

## Ship / bundle

Place the signed binary where the provider looks for it (see
`defaultHelperPath()` in `src/windows.ts`):

```
packages/cortex-sandbox/vendor/win32-x64/cortex-sandbox-helper.exe
```

The package's `files` allowlist must include `vendor/` so the binary is
published in the npm tarball. A consumer that stores the helper elsewhere passes
an explicit `helperPath` to the provider. The build is wired as an npm script
(`build:helper:win`) that runs only on Windows; it is deliberately **not** part
of the default `build`, so `npm install`/`npm run build` on macOS/Linux/CI never
requires a Rust toolchain.

## Min-OS matrix

| OS | Tier 1 (this helper) |
|----|----------------------|
| Windows 10 1809 (build 17763) | Floor. Restricted tokens, capability SIDs, job objects, and the process mitigations used here are all available. |
| Windows 10 1903+ / Windows 11 | Supported. |
| Windows Server 2019 / 2022 | Supported (same API surface). |
| Windows 10 < 1809, Windows 8.1, 7 | Not supported. The provider should report `none`; do not ship the helper for these. |

Architectures: `x86_64` (primary) and `aarch64` (Windows on ARM). Build and sign
one binary per architecture and bundle under `vendor/win32-x64` and
`vendor/win32-arm64`; extend `defaultHelperPath()` to select by `process.arch`
when the ARM64 binary is added.

## What Tier 1 enforces (and what it does not)

**Enforced (filesystem):**

- Writes are confined to the workspace roots + the per-session sandbox temp. A
  `WRITE_RESTRICTED` token means a write must satisfy BOTH the normal token AND a
  restricting capability SID; only the writable roots carry an allow ACE for that
  SID. Reads never consult the restricting list, so the repo, npm/pip/cargo
  caches, and git config stay readable with zero grants.
- Secret paths (`~/.ssh`, `~/.aws`, credential files, ...) get deny-read ACEs for
  the capability SID; the agent config and `.git/hooks` / `.git/config` get
  deny-write ACEs.
- Credential environment variables are stripped from the child by the Node
  provider before the helper is even spawned, so the environment is not an
  exfil path either.
- With Low integrity on (default), MIC adds a third write gate on top of the
  DACL checks (see the tradeoff below).
- The child runs in a kill-on-close job object, so it cannot outlive the helper,
  and under image-load mitigations that block DLL loads from remote or
  Low-labeled locations.

**NOT enforced (network):** Tier 1 is unelevated and has no network boundary.
Proxy environment variables are the only lever and a command that opens a socket
directly ignores them. The provider therefore reports network **`none`**, never
`partial`, and the Workspace rung's network guarantee does not hold on Windows
until Tier 2 ships. We surface this plainly rather than implying containment we
do not deliver. In-process WebFetch is still gated by the app-level
`resolveNetworkAccess` policy, but shell egress is not contained.

## Two decisions that diverge from the literal design (and why)

The scaffold intentionally departs from two phrases in the original design note.
Both are called out here so a reviewer can weigh them.

1. **Low integrity persistently Low-labels the writable roots.** Dropping the
   token to Low is real defense-in-depth, but MIC then blocks the Low child from
   writing the (Medium) workspace unless the workspace itself is Low-labeled. The
   helper stamps an inheritable Low mandatory label on the writable roots. That
   label **persists** on the user's real project directory after the command
   finishes (harmless functionally: the default `NO_WRITE_UP` policy still lets
   the user's own Medium processes write there, and it is reused rather than
   re-applied because the capability SID is stable). A consumer who finds a
   persistent Low label on their repo undesirable sets `lowIntegrity: false` in
   the policy; the capability-SID `WRITE_RESTRICTED` mechanism still fully
   confines writes without it. This is why Codex ships Medium (LUA_TOKEN) by
   default; we default Low for the extra gate but keep the escape hatch.

2. **The most aggressive process mitigations are wired but disabled by default.**
   The design lists "win32k lockdown, MS-signed-binary, image-load restrictions."
   The image-load restrictions (no remote, no Low-label, prefer System32) and
   extension-point-disable are enabled: they harden a coding agent without
   breaking it. But `BLOCK_NON_MICROSOFT_BINARIES` would block loading
   `node.exe`, `git.exe`, `python.exe`, `cargo.exe` (all non-Microsoft-signed) —
   i.e. the entire toolchain — and `WIN32K_SYSTEM_CALL_DISABLE` /
   `PROHIBIT_DYNAMIC_CODE` break GUI-linked tools and every JIT (Node/V8, .NET,
   PowerShell). Enabling them by default would make the sandbox unusable, so they
   are present as named constants with a single flip point (`DEFAULT_MITIGATIONS`
   in `process.rs`) for a hardened deployment that runs only Microsoft-signed,
   non-JIT console tools. Codex likewise does not enable them.

## Adversarial containment tests (run on Windows before trusting it)

Mirror the macOS/Linux adversarial suite. With the helper active at the
Workspace rung, assert each of these is **denied** (non-zero, access-denied):

- Write outside the workspace: `echo x > %USERPROFILE%\escape.txt`.
- Write the agent config: `echo x > %USERPROFILE%\.cortex\settings.json`.
- Write a git hook: `echo x > <repo>\.git\hooks\pre-commit`.
- Read a secret: `type %USERPROFILE%\.ssh\id_rsa`.
- DLL plant + load from the Low-labeled workspace (with Low integrity on).

And assert these **succeed** (the sandbox must not over-block):

- Read the repo, `%APPDATA%\npm`, `%USERPROFILE%\.cargo`, git config.
- Write inside the workspace and the sandbox temp.
- Bind and connect to loopback (a local dev server / MCP over 127.0.0.1).

A silently-broken sandbox is worse than none: if these do not all pass, the
provider must keep reporting a degraded status rather than claim `enforced`.

## Out of scope (future work)

- **Elevated Tier 2 (hard network).** A one-time admin setup that adds WFP
  filters blocking all egress for sandboxed commands except the local filtering
  proxy (WFP filters on IP and port; the proxy still does domain policy). This is
  where real network enforcement on Windows comes from. Not built.
- **Dedicated sandbox users.** Codex's stronger model runs commands as dedicated
  low-privilege accounts (`CodexSandboxOffline`/`Online`) rather than a
  restricted version of the signed-in user. Also a Tier-2 concern.
- **CI signing pipeline.** Automating the build + sign + notarize + bundle on a
  Windows runner is not wired here; the commands above are the manual recipe.
- **ARM64 binary.** The build supports it; producing and bundling it is pending.
