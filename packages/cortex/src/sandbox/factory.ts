/** Platform backends for Cortex-managed sessions and advanced integrations.
 * macOS/Linux use an isolated runtime process; Windows uses the native helper.
 */
import type { SandboxRuntimeProviderOptions } from './backends/runtime.js';
import { SandboxRuntimeProcess } from './backends/runtime-process.js';
import {
  WindowsRestrictedTokenProvider,
  type WindowsRestrictedTokenProviderOptions,
} from './backends/windows.js';
import type { SandboxProvider } from './types.js';

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
  return new SandboxRuntimeProcess(options);
}
