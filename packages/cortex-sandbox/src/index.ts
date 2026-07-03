/**
 * @animus-labs/cortex-sandbox
 *
 * OS-level SandboxProvider for @animus-labs/cortex, built on
 * @anthropic-ai/sandbox-runtime (macOS Seatbelt, Linux bubblewrap + seccomp).
 * See docs/cortex/sandboxing.md.
 *
 * Usage:
 *   const provider = new SandboxRuntimeProvider({ onNetworkRequest });
 *   await provider.initialize(buildDefaultPolicy('workspace', { workspaceRoots: [cwd] }));
 *   const agent = await CortexAgent.create({ ..., sandbox: provider });
 */
export { SandboxRuntimeProvider } from './provider.js';
export type { SandboxRuntimeProviderOptions } from './provider.js';
export {
  buildDefaultPolicy,
  defaultSecretReadDenies,
  defaultDangerousWriteDenies,
  SEEDED_REGISTRY_DOMAINS,
} from './policy.js';
export type { DefaultPolicyOptions } from './policy.js';
