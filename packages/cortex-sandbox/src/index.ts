/**
 * @animus-labs/cortex-sandbox
 *
 * OS-level SandboxProvider for @animus-labs/cortex:
 *   - macOS Seatbelt and Linux bubblewrap + seccomp via @anthropic-ai/sandbox-runtime
 *   - native Windows Tier-1 restricted-token helper (write confinement +
 *     env-credential scrub: filesystem partial, network none; secret-read
 *     denial needs the future Tier-2 dedicated-user backend)
 * See docs/cortex/sandboxing.md and docs/cortex/windows-sandbox-build.md.
 *
 * Usage (platform-agnostic, recommended):
 *   const provider = createSandboxProvider({ onNetworkRequest });
 *   await provider.initialize(buildDefaultPolicy('workspace', { workspaceRoots: [cwd] }));
 *   const agent = await CortexAgent.create({ ..., sandbox: provider });
 */
export { SandboxRuntimeProvider } from './provider.js';
export type { SandboxRuntimeProviderOptions } from './provider.js';
export {
  WindowsRestrictedTokenProvider,
  serializeWindowsPolicy,
  buildHelperInvocation,
  deriveWorkspaceCapabilitySidName,
  defaultHelperPath,
  WINDOWS_POLICY_VERSION,
  DEFAULT_CAPABILITY_SID_NAME,
} from './windows.js';
export type {
  WindowsRestrictedTokenProviderOptions,
  WindowsHelperPolicy,
} from './windows.js';
export { createSandboxProvider } from './factory.js';
export type { CreateSandboxProviderOptions } from './factory.js';
export { denialFromViolations, denialFromFailureHeuristic } from './classify.js';
export type { ViolationLike, DenialCorroborationContext } from './classify.js';
export {
  buildDefaultPolicy,
  defaultSecretReadDenies,
  defaultDangerousWriteDenies,
  matchesDomainPattern,
  matchesAnyDomainPattern,
  SEEDED_REGISTRY_DOMAINS,
  DEFAULT_CREDENTIAL_ENV_VARS,
} from './policy.js';
export type { DefaultPolicyOptions } from './policy.js';
