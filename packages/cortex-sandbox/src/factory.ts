/**
 * Platform factory: hand back the right SandboxProvider for the host.
 *
 *   - win32  -> WindowsRestrictedTokenProvider (native Tier-1 restricted-token helper)
 *   - darwin -> SandboxRuntimeProvider (Seatbelt via sandbox-runtime)
 *   - linux  -> SandboxRuntimeProvider (bubblewrap + seccomp via sandbox-runtime)
 *   - other  -> SandboxRuntimeProvider, which itself reports honest `none`
 *
 * Both implement the same @animus-labs/cortex SandboxProvider interface, so the
 * consumer constructs one of these and wires it into CortexAgent identically.
 * Each provider still reports honest status (Windows Tier 1: filesystem
 * `partial` because writes are confined but secret reads are not denied, and
 * network `none`; POSIX: enforced or a degraded `none` with reasons), so the
 * consumer's warn/degrade/refuse decision is unchanged across platforms.
 */
import { SandboxRuntimeProvider, type SandboxRuntimeProviderOptions } from './provider.js';
import {
  WindowsRestrictedTokenProvider,
  type WindowsRestrictedTokenProviderOptions,
} from './windows.js';
import type { SandboxProvider } from '@animus-labs/cortex';

/**
 * The superset of options across providers. Each provider receives only the
 * subset it understands; the rest are ignored on that platform. `onDegraded`
 * and `credentialEnvVars` are shared; `onNetworkRequest` is POSIX-only (Tier-1
 * Windows has no egress proxy to ask); the helper/cap-SID/integrity knobs are
 * Windows-only.
 */
export interface CreateSandboxProviderOptions
  extends SandboxRuntimeProviderOptions,
    WindowsRestrictedTokenProviderOptions {}

/**
 * Construct the platform-appropriate provider. `platform` is injectable purely
 * so the selection is unit-testable; it defaults to the real process platform
 * and callers should not pass it in production.
 */
export function createSandboxProvider(
  options: CreateSandboxProviderOptions = {},
  platform: NodeJS.Platform = process.platform,
): SandboxProvider {
  if (platform === 'win32') {
    return new WindowsRestrictedTokenProvider(options);
  }
  return new SandboxRuntimeProvider(options);
}
