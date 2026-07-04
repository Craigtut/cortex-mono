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
  helper in place of the shell. It writes the policy JSON to a private
  per-session directory that is never under a writable root (and lists that
  directory in `denyWritePaths`, so a sandboxed command cannot swap the policy
  that governs the next command) and builds the argv
  `helper.exe <policy.json> -- <shell> <shellArgs...> <command>`. It also points
  the child's `TEMP`/`TMP` at a dedicated per-session sandbox temp; the
  machine's real temp root is never a writable root, never granted to the cap
  SID, and never Low-labeled.
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

Known first-build checklist (expected fixes; the scaffold was authored off
Windows and has never compiled):

- **Return-type wrapping.** `windows` crate 0.58 is inconsistent about
  `WIN32_ERROR` / `BOOL` / `HRESULT` returns: some APIs come back as
  `Result<()>`, others as raw `WIN32_ERROR`/`BOOL` values. The scaffold mixes
  `?` and `.is_err()` accordingly, but expect the compiler to disagree in a few
  places; fix the wrapping per call site rather than changing the call sequence.
- **`SETUP_FAILURE_EXIT` (87) is ambiguous.** A real child process can also exit
  87, so the Node side cannot distinguish "sandbox setup failed" from "command
  ran and exited 87" by exit code alone. The helper prints a
  `cortex-sandbox-helper:` line on stderr in the failure case; replace the exit
  code with an unambiguous signal (key on that stderr sentinel or add a
  dedicated status pipe) before relying on the distinction.

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

Because secret reads are NOT denied (below), the provider reports filesystem
**`partial`**, never `enforced`, alongside network `none`.

**Enforced (writes + environment):**

- Writes are confined to the workspace roots + the per-session sandbox temp. A
  `WRITE_RESTRICTED` token means a write must satisfy BOTH the normal token AND a
  restricting capability SID; only the writable roots carry an allow ACE for that
  SID. Reads never consult the restricting list, so the repo, npm/pip/cargo
  caches, and git config stay readable with zero grants. The capability SID name
  is derived per install AND per workspace (base name + a hash of the canonical
  workspace roots), so the grant ACEs that persist on one workspace's
  directories never authorize a session running in another workspace.
- The agent config, `.git/hooks` / `.git/config`, and the policy file's own
  directory get deny-write ACEs for the capability SID. These are effective:
  writes do consult the restricting SID, and deny ACEs are evaluated before
  allows.
- Credential environment variables are stripped from the child by the Node
  provider before the helper is even spawned. On Tier 1 this is the PRIMARY
  credential control (see the read gap below).
- The child's `TEMP`/`TMP` point at the dedicated sandbox temp, and the
  machine's real temp root is excluded from the writable roots.
- With Low integrity on (opt-in, off by default), MIC adds a third write gate on
  top of the DACL checks (see the tradeoff below).
- The child runs in a kill-on-close job object, so it cannot outlive the helper,
  and under image-load mitigations that block DLL loads from remote or
  Low-labeled locations.

**NOT enforced (secret reads):** deny-read ACEs are applied to secret paths
(`~/.ssh`, `~/.aws`, credential files, ...) but they are **inert at Tier 1**. A
same-user `WRITE_RESTRICTED` token evaluates the restricting capability SID for
WRITE access only; reads are checked against the normal token, which can read
the user's own files, so `type %USERPROFILE%\.ssh\id_rsa` succeeds. What Tier 1
delivers against credential theft is the env scrub plus write confinement, not
file-read denial. Read denial requires the elevated Tier-2 dedicated sandbox
user, whose own token simply has no access to the signed-in user's secrets (the
already-applied deny ACEs also become meaningful for such a token). We surface
this plainly rather than implying containment we do not deliver.

**NOT enforced (network):** Tier 1 is unelevated and has no network boundary.
Proxy environment variables are the only lever and a command that opens a socket
directly ignores them. The provider therefore reports network **`none`**, never
`partial`, and the Workspace rung's network guarantee does not hold on Windows
until Tier 2 ships. In-process WebFetch is still gated by the app-level
`resolveNetworkAccess` policy, but shell egress is not contained.

**NOT enforced (window station / desktop):** the restricted child runs on the
parent's interactive window station and desktop, which exposes UI-message attack
surface (`SetWindowsHookEx`, `SendMessage`, clipboard) toward same-desktop
windows. A private winsta/desktop for the child is a known Tier-1 gap (TODO in
`process.rs`).

## Two decisions that diverge from the literal design (and why)

The scaffold intentionally departs from two phrases in the original design note.
Both are called out here so a reviewer can weigh them.

1. **Low integrity is opt-in, not the default.** The design note listed
   "drops to Low integrity" as part of the recipe; the shipped default is
   Medium (LUA_TOKEN), matching Codex, with `lowIntegrity: true` as the opt-in.
   Dropping to Low is real defense-in-depth (a third, MIC-level write gate), but
   it comes with costs: the helper must stamp an inheritable Low mandatory label
   on the writable roots so the Low child can write them, that label
   **persists** on the user's real project directory after the command finishes,
   and a Low child can be blocked from editing pre-existing Medium-labeled files
   inside the workspace. The capability-SID `WRITE_RESTRICTED` mechanism fully
   confines writes without Low, so Medium is the safer functional default. When
   Low is enabled, only the workspace roots and the dedicated per-session
   sandbox temp are ever labeled; the machine's real temp root is excluded from
   the writable roots and is never Low-labeled.

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
- Overwrite the session policy file: `echo x > <policyDir>\policy.json`.
- Write to the real temp root: `echo x > %USERPROFILE%\AppData\Local\Temp\escape.txt`
  (the child's `%TEMP%` points at the sandbox temp; the real root is not
  granted).
- DLL plant + load from the Low-labeled workspace (with Low integrity opted in).

And assert these **succeed** (the sandbox must not over-block):

- Read the repo, `%APPDATA%\npm`, `%USERPROFILE%\.cargo`, git config.
- Write inside the workspace and the sandbox temp (including via `%TEMP%`).
- Bind and connect to loopback (a local dev server / MCP over 127.0.0.1).

Do NOT assert that reading a secret (`type %USERPROFILE%\.ssh\id_rsa`) is
denied: at Tier 1 it is expected to SUCCEED (the deny-read ACEs are inert under
a same-user `WRITE_RESTRICTED` token; see above). A test may assert it succeeds
to document the gap; the read-denied assertion belongs to the future Tier-2
dedicated-user suite. Also assert that a credential env var (e.g.
`GITHUB_TOKEN`) is absent inside the sandboxed child, since the env scrub is
Tier 1's credential control.

A silently-broken sandbox is worse than none: if these do not all pass, the
provider must keep reporting UNCONTAINED `none` rather than claim the Tier-1
`partial`.

## Out of scope (future work)

- **Elevated Tier 2 (hard network).** A one-time admin setup that adds WFP
  filters blocking all egress for sandboxed commands except the local filtering
  proxy (WFP filters on IP and port; the proxy still does domain policy). This is
  where real network enforcement on Windows comes from. Not built.
- **Dedicated sandbox users.** Codex's stronger model runs commands as dedicated
  low-privilege accounts (`CodexSandboxOffline`/`Online`) rather than a
  restricted version of the signed-in user. Also a Tier-2 concern, and the
  prerequisite for secret-file READ denial on Windows: a dedicated user's token
  has no access to the signed-in user's files, and the deny-read ACEs Tier 1
  already applies start being evaluated for real.
- **CI signing pipeline.** Automating the build + sign + notarize + bundle on a
  Windows runner is not wired here; the commands above are the manual recipe.
- **ARM64 binary.** The build supports it; producing and bundling it is pending.
