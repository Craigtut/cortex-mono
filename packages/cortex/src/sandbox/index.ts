/**
 * Sandbox seam (public surface).
 *
 * Type-only: core defines the vocabulary and provider contract; enforcement is
 * supplied by a consumer package. See docs/cortex/sandboxing.md.
 */
export type {
  SandboxRung,
  SandboxFilesystemPolicy,
  SandboxNetworkMode,
  SandboxNetworkPolicy,
  SandboxPolicy,
  SandboxEnforcement,
  SandboxBackend,
  SandboxStatus,
  SandboxSpawnSpec,
  WrappedSpawn,
  SandboxDenial,
  SandboxProvider,
  NetworkAccessRequest,
  NetworkAccessScope,
  NetworkAccessDecision,
  ResolveNetworkAccess,
} from './types.js';
