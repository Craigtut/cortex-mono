# Sandboxing

Status: accepted design. Phase 0 (core seam) and Phase 1 (macOS/Linux enforcement, cortex-code wiring) implemented; Phase 2's unified network access (one policy and one prompt for shell egress and WebFetch) implemented 2026-07-03. MCP egress and the later phases are pending. The decisions in the final section are settled.

This document specifies OS-level sandboxing for Cortex: what it protects against, how it is structured so users can progressively opt out (all the way to fully off), how it stays transparent, and the build plan. It is written to be understandable, because the prior art (Codex in particular) is powerful but hard to reason about. The guiding idea here is a small number of clean concepts, not a pile of platform mechanics.

## Why sandbox at all

Cortex runs a model that executes arbitrary shell commands, reads and writes files, and reaches the network. Two things can go wrong even when the user is acting in good faith:

1. Prompt injection. Content the agent reads (a file, a web page, a tool result, an MCP response) can carry instructions that redirect the agent into exfiltrating secrets or running destructive commands. This is the dominant threat and it does not require a malicious user.
2. Mistakes. The model runs `rm` in the wrong directory, writes outside the workspace, or installs from a typosquatted package.

Permission prompts alone do not solve this. When users are asked to approve nearly everything, they approve nearly everything: Anthropic measured that users approved about 93% of prompts, so the prompt had stopped carrying signal. The fix is to make the agent safe to run without asking, by constraining what a command is *able* to do rather than guessing from the command string whether it *should* run. Anthropic reports sandboxing cut permission prompts by 84%; Cursor reports sandboxed agents stop 40% less often. Sandboxing is a throughput win as much as a safety one: the agent works freely inside a boundary instead of interrupting for confirmation.

## The two axes (the core model)

Everything below rests on separating two things that Codex blends together and that are the source of most confusion:

- Containment: what the running process is physically capable of doing. Enforced by the OS (filesystem scope, network scope). If a command is not contained, no amount of approval logic limits its blast radius.
- Approval: when the human is asked before something happens. Enforced in-process, before a tool runs, by the permission system Cortex already has.

These are orthogonal. You can have a fully contained process that still asks before every command (maximum oversight), or an uncontained process that never asks (pi's YOLO). Keeping them separate is what makes the user experience explainable: "what can it do" and "when does it ask me" are different questions with different controls.

Cortex already implements the approval axis (the permission rules engine, catastrophic-command blocks, auto-approve mode). This design adds the containment axis and then connects the two so that strong containment automatically relaxes approval.

## The trust ladder (what users actually touch)

Most users should never think about the two axes directly. They pick one rung on a single ordered dial, per workspace. Each rung is a named preset over both axes.

| Rung | Filesystem | Network | Approval behavior | Use it for |
|------|-----------|---------|-------------------|-----------|
| Restricted | read-only, secrets denied | none | run reads freely; any write or network is blocked | exploring or reviewing code you do not trust |
| Workspace (default) | read broadly, write workspace + temp | allowlist (package registries seeded) | run inside the boundary without asking; asked to step outside | normal development on your own project |
| Trusted | write workspace + temp, secrets still denied | open (HTTP/S via the proxy) | auto-run almost everything; still asked for out-of-workspace writes | a task you trust and want to run with minimal friction |
| Off | full user access, no containment | full | behaves like the current permission-only mode | environments already isolated, or when you accept the risk |

Properties that make this workable:

- On by default at Workspace. This is the "useful all the time" rung. A normal session (read the repo, edit files in it, run tests, install from npm or PyPI) works with no prompts and no denials.
- Two hard invariants hold on every rung except Off: secrets stay unreadable (`~/.ssh`, `~/.aws`, cloud and credential stores, Cortex's own credential files) and the agent's own configuration stays unwritable (settings, permission rules, the sandbox policy itself). The second invariant closes a real attack: a prompt-injected agent editing its own config to widen its permissions has happened in the wild (Amp). These invariants are why Off is a deliberate, visible choice rather than a slope you slide down.
- Off is genuinely off. No containment, full user privileges. It is one setting, remembered per workspace, and always visibly indicated. We do not pretend a rung is "basically off"; if you want it off, it is off.
- Rung changes are a human action. The agent can never move itself to a less-contained rung, or to Off, the same way it cannot write its own config. An injected agent that could request Trusted or Off would defeat the boundary. The only widening the agent may initiate is a single-command escalation, and that still goes to a human.

## Opting out, three different shapes

"Turn off the sandbox" means at least three different things. Each has to be easy, and conflating them is what makes other tools frustrating.

1. Move down the ladder (coarse). Change the rung for this workspace or globally. Restricted to Workspace to Trusted to Off. One command (`/sandbox <rung>`) or one setting, remembered per workspace.
2. Widen one dimension (surgical, the common case). Keep the rung, punch a specific hole: allow network to one domain, allow writes to one extra directory, or run one command outside the sandbox. These are additive exceptions with their own scope (once, this session, always) and they are what you reach for when the agent hits a wall. You almost never need to disable the whole sandbox; you need to let it reach one more thing.
3. Escalate a single command out (reactive). When a command fails specifically because the sandbox blocked it, the agent can request to re-run that one command uncontained. That request goes through the normal approval flow, so it is a human decision, and it does not change the rung.

The design intent: reaching for the surgical option should be so easy that turning the whole thing off is rare. The frustration of "the sandbox stopped my agent from touching X" is answered by "grant X in one keypress," not by "disable sandboxing."

## Consumers versus end users (the embeddability story)

Cortex is a framework. A consumer product built on it (Cortex Code, or a future consumer-facing app) must be able to decide how much of this to expose. The policy resolves in a fixed precedence:

1. Consumer floor. The product sets a minimum containment level that its end users cannot go below, and decides whether the trust dial is exposed at all. A locked-down consumer app can pin Workspace and hide the dial entirely; end users never see an Off switch. A developer tool exposes the full ladder.
2. Consumer defaults. The starting rung and the default policy (writable roots, denied reads, allowed domains) for a fresh workspace.
3. End-user choice. Within [floor, ceiling], the end user picks a rung and grants exceptions, remembered per workspace.

This is the key requirement for consumer-facing use: the framework enforces, the product governs, the end user operates within bounds the product set. A consumer never has to expose "run with no sandbox" if that is wrong for their users, and can still develop against a permissive local config themselves.

## Transparency

The user (and the consumer's end user) must always be able to answer "what can the agent do right now, and what just got blocked." Non-negotiable surfaces:

- Always-visible status. The active rung and enforcement state (enforced / degraded / off) are shown persistently in the TUI, the way an editor shows a "restricted mode" badge. There is never ambiguity about whether you are sandboxed.
- Self-explaining denials, to both human and model. When the sandbox blocks something, the tool result the model sees says what was denied and on which dimension ("blocked by sandbox: network egress to example.com"), and that escalation is available. The model can then adapt or ask instead of blindly retrying, and the human sees the same thing.
- Effective-policy inspector. `/sandbox status` prints the real, resolved policy: writable roots, denied reads, allowed domains, the backend in use, and any degradations. This is the ground truth, not the requested config.
- Honest degradation. If enforcement is not available (Windows before the native helper ships, or bubblewrap blocked by AppArmor on Ubuntu 24.04), Cortex reports the containment state as `partial` or `none` and says so loudly. It never claims to be sandboxed when it is not. The consumer decides whether that warns, degrades, or refuses to run.
- Audit events. Every escalation, grant, and violation emits an event on the bridge so consumers can log it where humans look (a session summary, a PR comment, a dashboard).

## Use-case matrix (the middle grounds)

| Scenario | Rung | Notes |
|----------|------|-------|
| Reviewing a PR or exploring an unfamiliar repo | Restricted | read-only, no network; nothing the injected content says can write or exfiltrate |
| Day-to-day work on your own project | Workspace | the default; no prompts for in-boundary work |
| Big trusted refactor needing broad network and writes | Trusted | or stay on Workspace and grant the specific domains and dirs |
| Command that legitimately must escape (docker, a system install, another repo) | any | surgical grant or single-command escalation, not Off |
| CI or headless automation inside a container or VM | Off or Trusted | the environment is already an isolation boundary; double-sandboxing is friction. Cortex detects a container and can recommend Off, or the operator declares it |
| A consumer product embedding Cortex for its own users | consumer-pinned | product sets floor and defaults, may hide the dial; end users operate within bounds |

The container case matters: when Cortex already runs inside a container or microVM, the OS sandbox is redundant and can break things (loopback, mounts). We detect common container markers and surface a recommendation rather than silently stacking boundaries.

## Architecture

### Layer 1: policy and provider in core (no new dependencies)

Cortex core gains three types and one seam. Core ships no enforcement and takes no new dependency, preserving the sanitized boundary. Enforcement is injected by the consumer, exactly like `getApiKey` and `resolvePermission` today.

```ts
type SandboxRung = 'restricted' | 'workspace' | 'trusted' | 'off';

interface SandboxPolicy {
  rung: SandboxRung;
  filesystem: {
    writableRoots: string[];   // established from trusted session config, never from model input
    denyRead: string[];        // secrets: ~/.ssh, ~/.aws, ~/.kube, credential stores, Cortex creds
    denyWrite: string[];       // agent config, permission rules, this policy, .git/hooks, .git/config
    allowRead?: string[];
  };
  network: {
    mode: 'deny' | 'allowlist' | 'full';
    allowedDomains: string[];  // supports "*.npmjs.org"; seeded with package registries
    deniedDomains: string[];
    allowLocalBinding?: boolean; // loopback for local MCP and dev servers; default true
  };
}

interface SandboxProvider {
  initialize(policy: SandboxPolicy): Promise<SandboxStatus>;
  // Wraps an already-composed spawn. Returns a new file+args+env that launches
  // the same command under the sandbox. Composes with existing shell selection
  // and the cwd-capture suffix untouched.
  wrapSpawn(spec: { file: string; args: string[]; cwd: string; env: Record<string,string> })
    : { file: string; args: string[]; env: Record<string,string> };
  classifyFailure?(failure: SandboxCommandFailure): SandboxDenial | null; // for self-explaining denials
  status?(): SandboxStatus;                                 // current enforcement, for transparency
  dispose(): Promise<void>;
}
// Interactive egress decisions (prompt on first hit to a new domain) live INSIDE
// the provider, which the consumer constructs with an ask callback. They are not
// part of core's spawn seam: the static allowedDomains list is only the
// pre-approved set, and the callback resolves everything else at runtime.

// Core also exposes the unified egress decision as a first-class seam, so
// in-process egress (WebFetch) answers to the same policy as shell commands:

interface NetworkAccessRequest { host: string; port?: number; via: 'shell' | 'webfetch'; url?: string; }
type NetworkAccessScope = 'once' | 'session' | 'always';
interface NetworkAccessDecision { decision: 'allow' | 'deny'; scope?: NetworkAccessScope; }
type ResolveNetworkAccess = (req: NetworkAccessRequest) => Promise<NetworkAccessDecision>;

// CortexAgentConfig.resolveNetworkAccess?: ResolveNetworkAccess
//
// The consumer implements ONE decision function (allowlist + grants + prompt)
// and wires it twice: into CortexAgentConfig.resolveNetworkAccess (WebFetch
// consults it before every fetch) and into the provider's ask callback (the
// egress proxy consults it for shell commands). A domain granted once then
// covers both paths. WebFetch's SSRF/private-IP guard stays separate and
// always on: a private target is blocked even when its host is allowed.

interface SandboxStatus {          // the honesty contract
  filesystem: 'enforced' | 'partial' | 'none';
  network: 'enforced' | 'partial' | 'none';
  backend: 'seatbelt' | 'bubblewrap' | 'win-restricted-token' | 'none';
  degradations: string[];          // human-readable reasons enforcement is reduced
}
```

The seam is the Bash tool spawn. Today `child_process.spawn(shell, [...args, fullCommand], { cwd, env: safeEnv, ... })` runs at `packages/cortex/src/tools/bash/index.ts:353`, after the safe-env build (`:336`) and the cwd-capture suffix (`:350`). We add a `sandbox?: SandboxProvider` field to `BashToolConfig` (`bash/index.ts:84`, alongside `envOverrides` and `onProcessSpawned`) and, when present, pass the composed spawn through `wrapSpawn` immediately before spawning. Sub-agents inherit automatically because their Bash tools spawn through the same path.

Why the spawn site and not the permission hook: pi-agent-core's `beforeToolCall` result is block-only and cannot rewrite arguments, so a sandbox wrapper cannot be injected there. The Bash config seam is also exactly how pi's own opt-in sandbox extension integrates, so this is a proven shape with the same upstream.

Other spawn sites to route through the same provider (in priority order): the skill preprocessor (`skill-preprocessor.ts:214`, which today spawns with raw `process.env` and bypasses even env sanitization, worth fixing regardless), and optionally MCP stdio servers.

### Layer 2: the enforcement package

`@animus-labs/cortex-sandbox` is a separate, optional package implementing `SandboxProvider` on macOS and Linux by translating `SandboxPolicy` into `@anthropic-ai/sandbox-runtime` config and calling its `initialize` / `wrapWithSandbox`. Keeping it out of core honors the dependency-light rule and keeps the heavy, platform-specific, pre-1.0 dependency swappable.

What sandbox-runtime does under the hood (verified): it composes the same OS primitives everyone uses, it does not invent isolation.
- macOS: generates a Seatbelt SBPL profile (`deny default`, then allow reads minus deny paths, writes only to allowed roots, network only to its localhost proxy) and launches via `/usr/bin/sandbox-exec`. No install, no signing. It also tails the unified log for violations, giving real-time denial events.
- Linux: `bwrap` with a read-only root, bind-mounts for writable roots, `--unshare-net` (the process has no network stack at all), plus a shipped static seccomp filter blocking unix-socket and io_uring bypasses. Egress exists only through host proxy sockets bind-mounted in. Requires `bubblewrap` and `socat`.
- Network on both: its own Node egress proxy (HTTP CONNECT + SOCKS5, hostname allowlist, per-session auth token, host-side DNS). The OS layer only guarantees "nothing leaves except through the proxy"; the proxy does the domain policy. The proxy checks the static `allowedDomains`/`deniedDomains` first, then calls an optional consumer-supplied decision callback for any unmatched domain (this is what makes "first hit to a new domain prompts once" work); a granted domain joins the session allowlist. The static list is only the pre-approved set, not the whole policy.

License and dependency due diligence (this is safe for consumer-facing commercial use): `@anthropic-ai/sandbox-runtime` is Apache-2.0 (standard, unmodified, no acceptable-use rider or usage restriction), version 0.0.63, `node >= 20.11`, with four permissive dependencies (`@pondwader/socks5-server`, `commander`, `node-forge`, `zod`). Apache-2.0 includes an explicit patent grant. This is materially different from Anthropic's Claude Code CLI, which is proprietary; the sandbox library is genuinely open.

Not a one-way door: the durable assets are the SBPL profile shape and the bubblewrap flag composition, both readable in sandbox-runtime's source and in Codex's (also Apache-2.0). Rolling our own macOS provider later is small (build an SBPL string, call `sandbox-exec`); Linux is more work but well-trodden. We pin the version and hide its schema behind `SandboxPolicy`, so a breaking change or a full backend swap touches one package.

Provider preflight handles the known Linux gotcha: on Ubuntu 24.04+, unprivileged user namespaces are restricted by AppArmor by default, so `bwrap` fails unless we ship an AppArmor profile or the sysctl is relaxed. The provider detects this and reports `degradations` rather than failing opaquely.

### Layer 3: native Windows (no WSL2)

sandbox-runtime's Windows support is alpha and explicitly "not a security boundary" (same-user restricted token, escapable via Task Scheduler and COM). Claude Code punts to WSL2. We do neither. We build a small signed helper, following the recipe Codex shipped and that our own Windows research independently recommended.

- Tier 1, unelevated (default). A code-signed Rust helper exe (the official `windows` crate covers every API) that Node spawns in place of the shell. It builds a restricted token (`DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`) carrying a synthetic restricting SID, grants that SID write ACEs on the workspace roots and a sandbox temp, layers deny-read ACEs over secrets, drops to Low integrity, and launches the child in a job object (kill-on-close, resource caps) with win32k lockdown. Result: reads stay broad (repo, npm/pip/cargo caches, git config all work with zero grants), writes are confined to the workspace, and loopback works so local MCP and dev servers are unaffected. On network, Tier 1 is honest about being weak: proxy environment variables are the only control, and a command that opens a socket directly ignores them (exactly the gap Codex hit before adding WFP). So `SandboxStatus` reports filesystem `enforced` but network `none`, not `partial`, and the Workspace rung's network guarantee does not hold on Windows until the elevated Tier 2 ships. We surface that plainly rather than implying containment we do not deliver.
- Tier 2, elevated opt-in. A one-time admin setup adds WFP filters that block all egress for sandboxed commands except the local filtering proxy (WFP filters on IP and port, never domain, so the proxy still does domain policy). This is where hard network enforcement on Windows comes from.

Why not AppContainer: it default-denies reads of the entire user profile, so the repo and every tool cache vanish until explicitly re-granted, and it blocks loopback without an admin-only exemption. That is the wrong shape for a coding agent, which is exactly why Codex rejected it. A restricted token is defense-in-depth rather than a Microsoft-serviced boundary; that is the honest trade, and it fits our threat model (prompt injection and mistakes, not a determined attacker with a kernel exploit). Consumers who need a hard boundary plug a microVM provider into the same seam.

Costs to plan for: code-signing the helper (an unsigned token-manipulating, child-spawning exe looks like malware to Defender and EDR), Windows 10 1809+ as the floor, and clean teardown if Tier 2 ever writes WFP filters.

### Unifying in-process tools

A subprocess sandbox does not cover Cortex's in-process tools: WebFetch runs on Node `fetch`, MCP HTTP is in-process, and Read/Write/Edit use `fs` directly. Claude Code solves this by keeping one source of truth for policy and projecting it two ways. We do the same: `SandboxPolicy` is the single source, and the in-process tools read from it.
- WebFetch (implemented): resolves DNS and blocks private IPs as an always-on SSRF guard, and additionally consults the consumer's `resolveNetworkAccess` before every fetch. That is the same decision function the egress proxy's ask callback calls for shell commands, so WebFetch and shell egress share one allowlist (seeded registries + config extras + grants) and one prompt. A policy deny comes back to the model as a readable tool result ("Blocked by network policy: example.com is not allowed"), matching the self-explaining denial rule. In cortex-code, an active policy also auto-allows the WebFetch tool call itself at the permission layer (same shape as sandboxed Bash auto-run): the per-host network decision is the control, so the user is asked one question, not two.
- Write and Edit already contain writes at the app level; they consult `filesystem.writableRoots` and `denyWrite` so their policy matches the shell sandbox exactly.

The field names line up with sandbox-runtime's on purpose, which is why the projection is close to a straight mapping.

## What exists today versus what to build

Already built (kept, and unified under the policy):
- Bash safety layers (env strip, critical-path guard, write-path containment, obfuscation and injection detection, auto-mode classifier) at `packages/cortex/src/tools/bash/safety.ts`. These remain as a complementary pre-exec layer; containment does not replace them, it backstops them.
- WebFetch SSRF guard (`web-fetch/index.ts`), now alongside the unified network policy gate (`resolveNetworkAccess`).
- Write and Edit path containment.
- cortex-code permission rules engine: allow/deny, session/project/user scopes, persisted 0600, catastrophic-command hard block (`findCatastrophicCommand`, already shared from `@animus-labs/cortex`), auto-approve (yolo) mode, serialized TUI prompts, out-of-band decision watching (`packages/cortex-code/src/session.ts:1124`, `permissions/rules.ts`).

To build:
- Core: `SandboxPolicy` / `SandboxProvider` / `SandboxStatus`; the `wrapSpawn` seam in `BashToolConfig`; the skill-preprocessor env fix; bridge events (`sandbox:degraded`, `sandbox:violation`, `sandbox:escalation-requested`, `sandbox:grant-added`). The network projection into WebFetch is built (the `resolveNetworkAccess` seam); Write/Edit projection and MCP HTTP remain.
- `@animus-labs/cortex-sandbox`: the sandbox-runtime-backed provider for macOS and Linux, policy translation, egress proxy wiring, preflight and degradation reporting.
- Windows: the Tier 1 restricted-token helper and its signing pipeline; Tier 2 elevated WFP later.
- cortex-code: built: the `sandbox` block in the settings schema; network surgical grants with once/session/always scope through the unified prompt ("Allow the agent to reach <host>?"), persisted per workspace; the trust ladder (`/sandbox <rung>`, human-only, re-initializes the provider live and remembers the rung per workspace); the effective-policy inspector (`/sandbox status`); the always-visible status-line indicator (enforced / partial / not enforced / off); the folder-trust default (fresh workspaces start at Workspace and remember it); container detection (recommend-only, never auto-disables); and single-command escalation with self-explaining denials (implemented 2026-07-03): a failed sandboxed command gets a best-effort denial note (provider `classifyFailure`: macOS violation log, Linux stderr heuristic), the model may re-issue it with `escalateOutsideSandbox: true`, and that request reaches the permission layer as `Bash(escalate)`, always prompting the human (never auto-approved by yolo, sandbox auto-run, or allow rules; plain-Bash deny rules and the catastrophic floor still block; allow-once only, nothing persists).

## Threat model and non-goals

In scope: prompt-injection-driven exfiltration and destruction, and agent mistakes. The goal is that the default rung makes an injected or mistaken agent unable to read secrets, write outside the workspace, or reach arbitrary network, without the user approving it.

Out of scope: a determined human attacker with a kernel or hypervisor exploit. On Windows specifically, Tier 1 is defense-in-depth, not a serviced security boundary. Treat any single layer as bypassable (both Cursor and Codex have had sandbox-escape CVEs); the two hard invariants (secrets unreadable, agent config unwritable) are the backstop, and strong-isolation deployments use a microVM via the same provider seam.

One design rule from Codex's CVE-2025-59532: writable roots come from trusted session config, never from a model-controlled parameter such as a tool's `cwd` argument. Otherwise the model makes anywhere writable by changing directory.

### Known coverage gaps (named, not hidden)

- MCP servers. A stdio MCP server is arbitrary consumer-configured code with its own filesystem and network access, and it is a live injection-to-exfiltration path. Routing MCP stdio spawns through the same provider is a Phase 2+ item; until then, an MCP tool is an uncontained egress path even when Bash is contained. A consumer whose threat model needs this closed should know it is open.
- In-process egress (partially closed). WebFetch is now covered by the unified network model: it consults the same decision function and allowlist as shell egress, so it is no longer an ungated exfiltration channel. Still open: MCP HTTP runs in-process and unmatched, and the LLM provider's own API calls are trusted by design (treating the provider endpoint as an exfil channel is out of scope for now).
- Denial attribution is platform-asymmetric. sandbox-runtime surfaces real violation events on macOS (it taps the unified log) but only an `EPERM` on Linux, so self-explaining denials and auto-escalation are precise on macOS and best-effort on Linux.
- Grep reads bypass the boundary. The built-in Grep tool spawns ripgrep directly, not through the shell seam, so a Grep with a `path` under a denied secret store returns file contents regardless of `denyRead`. Routing Grep through the provider (or projecting `denyRead` into its path check) is a Phase 2 item; until then Grep is the one built-in that can read a denied path.
- Only top-level `.git` internals are protected. `denyWrite` covers `<root>/.git/hooks` and `<root>/.git/config` per workspace root, not nested repos or submodules. Glob-expanding `**/.git/hooks` is a Phase 2 item; the related `GIT_CONFIG*` env-redirection vector is already blocked in the env sanitizer.
- "Trusted" network is proxy-mediated, not raw. `full` still routes egress through the HTTP/SOCKS proxy (sandbox-runtime cannot express filesystem-contained + network-unrestricted), so tools that ignore proxy env vars (ssh, raw TCP to a database) fail on Trusted; those belong on Off.

## Build plan

Phase 0, core seam (small, no new dependencies). The three types, the `wrapSpawn` hook in `BashToolConfig`, bridge events, the skill-preprocessor env fix, and the policy-root-hygiene rule. Ships as a no-op default (no provider means no behavior change). Unblocks everything else.

Phase 1, macOS and Linux enforcement (roughly one to two weeks). `@animus-labs/cortex-sandbox` on pinned sandbox-runtime, the default Workspace policy, the escalation and surgical-grant loop, and cortex-code UX: status indicator, ladder command, self-explaining denials, settings schema, folder-trust default, container detection. This is where on-by-default and the prompt reduction land. Because a silently-broken sandbox is worse than none, every backend ships with adversarial containment tests (attempt to write outside the workspace, read a denied secret, and reach a blocked domain, asserting each is denied) run per platform. When on-by-default enforcement cannot initialize, the default is warn-and-continue with `SandboxStatus` reported as `none`, surfaced to the user; a consumer can opt into refuse-to-run instead. That silent-downgrade tension is an explicit choice, not a hidden default.

Phase 2, network completion. Implemented for WebFetch: the `resolveNetworkAccess` seam in core, the unified decision function in cortex-code (seeded allowlist auto-allow, once/session/always grants with the "Always" grant persisted per workspace under `network.allowedDomains`, prompts serialized with the permission lock), wired into both the egress proxy's ask callback and WebFetch. One grant covers both paths; denied hosts fail with self-explaining results on both. Remaining: projecting the policy into MCP HTTP.

Phase 3, native Windows (multi-week). The Tier 1 restricted-token helper and signing pipeline, then the optional elevated WFP tier. Status: **scaffolded, unverified, pending a Windows build.** The Rust helper crate (`packages/cortex-sandbox/windows-helper`) and the TS provider (`WindowsRestrictedTokenProvider` + `createSandboxProvider` factory in `packages/cortex-sandbox/src/windows.ts`) are written to the Codex-shipped restricted-token recipe, with honest status (`win-restricted-token`, filesystem `enforced`, network `none`) when the helper is present and UNCONTAINED `none` when it is absent. The TS side and its tests build and pass on macOS/Linux; the Rust helper cannot be compiled or verified off Windows and has not been built, run, or code-signed. See [`windows-sandbox-build.md`](./windows-sandbox-build.md) for the build/sign/ship runbook, the min-OS matrix, the two documented divergences (persistent Low-labeling of writable roots; the aggressive mitigations wired but disabled by default), and the adversarial containment tests to run before trusting it. Until that loop is green, Windows runs policy-only with honest `none` status. The elevated Tier 2 (WFP network filters, dedicated sandbox users) remains future work. Watch sandbox-runtime's Windows rewrite, which is heading toward Codex's dedicated-user design; if it matures first we may get a stronger tier for less.

Phase 4, hardening and scale (later, optional). TLS-terminating egress proxy and credential masking (sandbox-runtime already has both), consumer-level managed policy, and a documented microVM provider for strong-isolation deployments.

## Resolved decisions

These forks were decided (2026-07-03):

- Default posture for cortex-code: sandbox ON by default at Workspace with auto-run inside the boundary (the Cursor and Codex posture).
- Windows first ship: Tier 1 unelevated (real filesystem confinement, weak network) is the first native release; hard network is a later elevated opt-in.
- Network default: seed the allowlist with common package registries (npm, PyPI, crates.io, GitHub, and similar) so builds work out of the box; the first hit to a new domain prompts once.
- `.git` protection: deny-write only `.git/hooks` and `.git/config`, leaving the rest of `.git` writable so commits work in-sandbox.
