# Sandboxing: consumer integration guide

This is the developer guide for wiring OS-level sandboxing into a product built on `@animus-labs/cortex`. It covers the framework API, the two things a consumer supplies, the security contract you are responsible for, and a worked example. For the design and threat model, see `sandboxing.md`. Cortex Code is the reference implementation; this guide generalizes it.

## The model in one paragraph

Cortex separates two axes: containment (what a running command is physically able to do, enforced by the OS) and approval (when the human is asked, enforced in-process). The framework owns the seam and the vocabulary; it ships no enforcement itself. A consumer wires two things: a `SandboxProvider` (the enforcement backend, usually `@animus-labs/cortex-sandbox`) and a small set of decision callbacks (network grants, permission, escalation). Everything else, the trust ladder, the status indicator, the prompts, is UX the consumer builds on top of that seam.

## What you supply

1. A `SandboxProvider` on `CortexAgentConfig.sandbox`. Use `SandboxRuntimeProvider` from `@animus-labs/cortex-sandbox` (macOS Seatbelt, Linux bubblewrap; native Windows is scaffolded). You initialize it with a `SandboxPolicy`, then hand it to `CortexAgent.create`.
2. `CortexAgentConfig.resolveNetworkAccess`, the single egress decision. Cortex calls it from in-process WebFetch, and you wire the same function into the provider's network ask-callback, so shell egress and WebFetch share one allowlist and one prompt.
3. `CortexAgentConfig.resolvePermission`, which you already implement for tool permissions. It additionally receives sandbox escalation requests under a distinct tool name (below), so you prompt to run one command outside the box.

That is the whole framework contract. The provider does the OS work; your callbacks own the human decisions.

## Quickstart

```ts
import { CortexAgent } from '@animus-labs/cortex';
import { SandboxRuntimeProvider, buildDefaultPolicy } from '@animus-labs/cortex-sandbox';

// 1. Build a policy for the workspace. Writable roots come from TRUSTED config,
//    never from model input (see the security contract below).
const provider = new SandboxRuntimeProvider({
  // Called for a domain not already on the allowlist. Return true to allow.
  onNetworkRequest: (req) => resolveNetworkAccess({ ...req, via: 'shell' }).then((d) => d.decision === 'allow'),
  onDegraded: (reasons) => log.warn('sandbox degraded', { reasons }),
});
const policy = buildDefaultPolicy('workspace', {
  workspaceRoots: [cwd],
  extraDenyWrite: [join(home, '.myapp')],       // your own config/creds tree
  extraDenyRead: [join(home, '.myapp', 'credentials.json')],
});
const status = await provider.initialize(policy);
if (status.backend === 'none') log.warn('sandbox not enforced', { reasons: status.degradations });

// 2. Hand the provider and the shared decision function to the agent.
const agent = await CortexAgent.create({
  // ...your normal config...
  sandbox: provider,
  resolveNetworkAccess,        // same function used above for the shell path
  resolvePermission,           // your existing permission callback (handles escalation, below)
});
```

## The framework API surface

From `@animus-labs/cortex`:

- Config: `CortexAgentConfig.sandbox?: SandboxProvider`, `.resolveNetworkAccess?: ResolveNetworkAccess`, `.resolvePermission?`.
- Policy vocabulary: `SandboxRung` (`restricted` | `workspace` | `trusted` | `off`), `SandboxPolicy` (`filesystem: { writableRoots, denyRead, denyWrite, allowRead? }`, `network: { mode, allowedDomains, deniedDomains, allowLocalBinding? }`).
- Status (the honesty contract): `SandboxStatus` (`filesystem`/`network`: `enforced` | `partial` | `none`, `backend`, `degradations: string[]`). Never claims more than is enforced.
- Provider contract: `SandboxProvider` (`initialize`, `wrapSpawn`, optional `classifyFailure`, `scrubCredentialEnv`, `status`, `dispose`).
- Network decision: `NetworkAccessRequest` (`{ host, port?, via: 'shell' | 'webfetch', url? }`), `NetworkAccessDecision` (`{ decision: 'allow' | 'deny', scope? }`), `ResolveNetworkAccess`.
- Escalation: `BASH_ESCALATION_PERMISSION_NAME` (`'Bash(escalate)'`), `isBashEscalationRequest(args)`.

From `@animus-labs/cortex-sandbox`:

- `SandboxRuntimeProvider`, `SandboxRuntimeProviderOptions`.
- `buildDefaultPolicy(rung, opts)` and the building blocks `defaultSecretReadDenies`, `defaultDangerousWriteDenies`, `SEEDED_REGISTRY_DOMAINS`, `DEFAULT_CREDENTIAL_ENV_VARS`.
- `matchesDomainPattern` / `matchesAnyDomainPattern` (use these so your in-process allow decisions match the OS proxy exactly).

## Your security responsibilities (the contract)

Core enforces the boundary, but a few properties are the consumer's to uphold. These are exactly the places the framework cannot protect you from yourself.

- Sandbox posture comes from trusted config only. Derive the rung, the writable roots, and the allowed domains from your global/user config, never from a file in the workspace working tree. A cloned untrusted repo must not be able to weaken its own sandbox.
- Writable roots are never model-controlled. Do not feed a tool's `cwd` argument into `writableRoots`; the model would make anywhere writable by changing directory (CVE-2025-59532).
- Deny your own config tree. Add your product's settings, permission rules, network grants, and credential files to `denyWrite` (and the credential file to `denyRead`), so a sandboxed command cannot forge a grant or disable the sandbox. Also project the policy's `denyWrite`/`denyRead` onto your in-process file tools (Write/Edit/UndoEdit/Read), resolving symlinks, since those tools bypass the OS boundary; Cortex Code does this in its permission preflight as a hard floor above its auto-approve mode.
- Your `resolvePermission` must actually gate escalation. Core routes an escalation request to you under `BASH_ESCALATION_PERMISSION_NAME` and fails closed if you have no resolver, but a resolver that blindly allows would auto-approve leaving the sandbox. Prompt for it (see below).
- Rung changes are a human action. Never expose a way for the model to move to a less-contained rung or to Off.

## The network prompt (one decision, both paths)

Implement `resolveNetworkAccess` once. It is the single source of truth for "may the agent reach this host," called from both WebFetch (in-process) and, via the provider's ask-callback, from shell egress. A grant applies to both.

```ts
async function resolveNetworkAccess(req: NetworkAccessRequest): Promise<NetworkAccessDecision> {
  if (matchesAnyDomainPattern(req.host, policy.network.allowedDomains)) return { decision: 'allow' };
  if (isGranted(req.host)) return { decision: 'allow' };
  const choice = await promptUser(`Allow the agent to reach ${req.host}? (${req.via})`); // once / session / always / deny
  if (choice === 'deny') return { decision: 'deny' };
  if (choice === 'always') persistGrant(req.host);
  else if (choice === 'session') sessionGrant(req.host);
  return { decision: 'allow', scope: choice };
}
```

Fail closed: if the prompt throws or is dismissed, return `deny`. The seeded registries (`SEEDED_REGISTRY_DOMAINS`) are pre-allowed, so normal installs do not prompt.

## Single-command escalation

When the sandbox blocks a command, the model may set the Bash param `escalateOutsideSandbox: true` to request running that one command uncontained. Cortex re-presents that call to your `resolvePermission` under `BASH_ESCALATION_PERMISSION_NAME` so you can render a distinct prompt:

```ts
async function resolvePermission(toolName, args) {
  if (toolName === BASH_ESCALATION_PERMISSION_NAME) {
    // A deliberate exit from the boundary. Always a fresh human decision.
    const ok = await promptUser(`Run this command OUTSIDE the sandbox?\n${args.command}`); // allow-once / deny
    return ok ? true : { decision: 'block' };
  }
  // ...your normal permission flow...
}
```

Guarantees the framework provides: escalation never bypasses the catastrophic-command floor, an existing plain-`Bash` deny rule still blocks it, it is per-command and never persists, and an approved escalation still has its credential env vars scrubbed (it loses OS containment, not the secret invariant). Do not offer an "always" scope for escalation.

## Transparency

Read `provider.status()` (a `SandboxStatus`) to show an always-visible indicator: the active rung, and whether it is `enforced`, `partial`, or `none`. Show `none` honestly when enforcement is unavailable rather than implying containment. When a sandboxed command fails, `provider.classifyFailure(failure)` returns a `SandboxDenial` (reliable on macOS, best-effort on Linux) so you can tell the model the failure looks like a denial and that escalation is available.

## Embeddability (floor and ceiling)

For a consumer-facing product, you decide how much of the ladder to expose:

- Pin a minimum rung and hide the dial: compute the policy from a fixed rung and never surface `/sandbox off`. End users cannot weaken it.
- Or expose the full ladder for a developer tool: let the user pick a rung, persisted per workspace, with the network and escalation prompts above.

Either way the framework enforces, your product governs, and the end user operates within the bounds you set.

## Not yet covered (know the gaps)

Subprocess reads are contained: the Grep tool's ripgrep and stdio MCP servers now run through the provider's `wrapExec`, so `denyRead` applies to them, and Grep's in-process JS fallback is disabled under an enforcing sandbox so it cannot be used to retry a denied read. Still open: in-process egress beyond WebFetch (the provider API endpoint, MCP HTTP, which has no subprocess to wrap) is not routed through the boundary. These are named in `sandboxing.md` under coverage gaps. Native Windows enforcement is scaffolded but pending a Windows build; until it is built Windows reports `none` and runs uncontained, which the status honestly reflects.
