import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface CortexCodeConfig {
  /** Default model override. */
  defaultModel?: string;
  /** Default provider override. */
  defaultProvider?: string;
  /** Artificial context window limit. */
  contextWindowLimit?: number | null;
  /** Max cost budget per agentic loop. */
  maxCost?: number;
  /** Max turns budget per agentic loop. */
  maxTurns?: number;
  /** Default thinking effort level. Default: 'medium'. */
  defaultEffort?: string;
  /** Optional diagnostics for investigating TUI or prompt freezes. */
  diagnostics?: CortexCodeDiagnosticsConfig;
}

export interface FreezeDiagnosticsConfig {
  /** Whether freeze diagnostics are enabled. Default: false. */
  enabled?: boolean;
  /** Heartbeat interval for TUI diagnostics. Default: 1000ms. */
  heartbeatIntervalMs?: number;
  /** Event-loop delay monitor resolution in milliseconds. Default: 20ms. */
  eventLoopResolutionMs?: number;
  /** Log renders slower than this threshold in milliseconds. Default: 32ms. */
  slowRenderThresholdMs?: number;
  /** Cortex prompt watchdog heartbeat interval in milliseconds. Default: 1000ms. */
  promptWatchdogIntervalMs?: number;
  /** Warn if abort is still waiting after this many milliseconds. Default: 2000ms. */
  abortWaitWarningMs?: number;
}

export interface CortexCodeDiagnosticsConfig {
  freeze?: FreezeDiagnosticsConfig;
}

const GLOBAL_CONFIG_PATH = join(homedir(), '.cortex', 'config.json');
const PROJECT_CONFIG_NAME = '.cortex/config.json';

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Load and merge configuration from global and project-local config files.
 * Project config overrides global config for overlapping keys.
 */
export async function loadConfig(cwd: string): Promise<CortexCodeConfig> {
  const [globalConfig, projectConfig] = await Promise.all([
    readJsonFile<CortexCodeConfig>(GLOBAL_CONFIG_PATH),
    readJsonFile<CortexCodeConfig>(join(cwd, PROJECT_CONFIG_NAME)),
  ]);

  const globalDiagnostics = globalConfig?.diagnostics;
  const projectDiagnostics = projectConfig?.diagnostics;

  const diagnostics = globalDiagnostics || projectDiagnostics
    ? {
        ...globalDiagnostics,
        ...projectDiagnostics,
        freeze: {
          ...globalDiagnostics?.freeze,
          ...projectDiagnostics?.freeze,
        },
      }
    : undefined;

  return {
    ...globalConfig,
    ...projectConfig,
    ...(diagnostics ? { diagnostics } : {}),
  };
}
