# cortex-sandbox-helper (Windows Tier-1)

Small, code-signed Rust helper that `@animus-labs/cortex-sandbox` spawns in place
of the shell on Windows to give Cortex real **filesystem** containment without
admin rights or WSL2. This is the unelevated Tier 1 of the design in
[`docs/cortex/sandboxing.md`](../../../docs/cortex/sandboxing.md); the full build,
signing, and limits are in
[`docs/cortex/windows-sandbox-build.md`](../../../docs/cortex/windows-sandbox-build.md).

> **Status: scaffold, NOT compiled/run/verified.** Authored on macOS following
> the Codex-shipped restricted-token recipe. The Win32 call sequence and flags
> are the deliverable; the exact `windows`-crate symbol paths and return-type
> wrapping may need small fixes on the first real Windows build. Do not ship
> without a green `cargo build`/`cargo test` on Windows and Authenticode signing.

## Invocation

```
cortex-sandbox-helper.exe <policy.json> -- <shell> <shellArgs...> <command>
```

- `policy.json` is written by the Node provider (`WindowsHelperPolicy` in
  `../src/windows.ts`); its schema is `src/policy.rs::Policy`. Both carry a
  `version` and refuse a mismatch.
- Everything after `--` is the command to run, verbatim.
- stdio is inherited straight through to the Node parent; the helper exits with
  the child's exit code. Setup failure exits `87` (fail closed, command NOT run).

## Recipe (what each module does)

| Module | Win32 sequence |
|--------|----------------|
| `policy.rs` | Deserialize + validate the policy JSON (serde). Pure; unit-tested. |
| `sid.rs` | `DeriveCapabilitySidsFromName` (stable per-install cap SID), `CreateWellKnownSid` (Everyone, Low label), scan `TokenGroups` for the logon SID. |
| `token.rs` | `OpenProcessToken` -> `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE \| LUA_TOKEN \| WRITE_RESTRICTED)` with `[cap, logon, Everyone]` restricting SIDs; permissive token default DACL; re-enable `SeChangeNotifyPrivilege`. |
| `acl.rs` | `GetNamedSecurityInfoW` -> `SetEntriesInAclW` -> `SetNamedSecurityInfoW`: grant cap-SID write on writable roots, deny-read secrets, deny-write agent config. Inheritable ACEs. |
| `integrity.rs` | `SetTokenInformation(TokenIntegrityLevel)` to Low; `AddMandatoryAce` + `SetNamedSecurityInfoW(LABEL_SECURITY_INFORMATION)` to Low-label the writable roots. |
| `job.rs` | `CreateJobObjectW` + `SetInformationJobObject` (`KILL_ON_JOB_CLOSE`, active-process cap, optional memory cap) + `AssignProcessToJobObject`. |
| `process.rs` | `STARTUPINFOEXW` + `UpdateProcThreadAttribute` (mitigation policy + stdio handle list) -> `CreateProcessAsUserW(CREATE_SUSPENDED)` -> assign to job -> `ResumeThread` -> wait -> `GetExitCodeProcess`. |
| `main.rs` | Orchestrate the above, fail closed on any error. |

## Why this shape (and not others)

- **WRITE_RESTRICTED, not AppContainer.** AppContainer default-denies the whole
  user profile (repo + tool caches vanish) and blocks loopback. A restricted
  token keeps **reads broad** (they never consult the restricting SID list) while
  confining **writes** to where the capability SID is granted. Loopback works.
- **Reads broad, writes confined** is the coding-agent shape: the repo, npm/pip/
  cargo caches, and git config stay readable with zero grants.
- **Network is NOT enforced here.** Tier 1 is honest about this: only proxy env
  vars constrain egress and a direct socket ignores them, so the provider reports
  network `none`. Hard network enforcement is the future elevated Tier 2 (WFP).

## Build & sign (summary)

```powershell
cargo build --release --target x86_64-pc-windows-msvc
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  target\x86_64-pc-windows-msvc\release\cortex-sandbox-helper.exe
```

Ship the signed exe to `packages/cortex-sandbox/vendor/win32-x64/cortex-sandbox-helper.exe`.
Signing is mandatory: an unsigned token-manipulating, child-spawning exe looks
like malware to Defender/SmartScreen/EDR. Full steps, the min-OS matrix, and
what is out of scope are in the runbook.
