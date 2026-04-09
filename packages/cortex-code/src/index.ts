#!/usr/bin/env node

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

/**
 * @animus-labs/cortex-code
 *
 * CLI entry point for the Cortex Code terminal-based coding agent.
 *
 * Usage:
 *   cortex                          Start interactive session
 *   cortex --resume [session-id]    Resume last (or specific) session
 *   cortex --model <model>          Override default model
 *   cortex --yolo                   Start in YOLO mode (bypass permissions)
 */

import { ProviderManager, type ThinkingLevel } from '@animus-labs/cortex';
import { loadConfig } from './config/config.js';
import { CredentialStore } from './config/credentials.js';
import { Session } from './session.js';
import { BUILD_MODE } from './modes/build.js';
import { listSessions } from './persistence/sessions.js';
import { runFirstRunSetup } from './providers/setup-tui.js';
import { getOllamaHost, getOllamaContextWindow } from './providers/ollama.js';

interface CliArgs {
  resume: string | true | undefined;
  model: string | undefined;
  yolo: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { resume: undefined, model: undefined, yolo: false };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--resume':
        args.resume = argv[i + 1] && !argv[i + 1]!.startsWith('--')
          ? argv[++i]
          : true;
        break;
      case '--model':
        args.model = argv[++i];
        break;
      case '--yolo':
        args.yolo = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      case '--version':
      case '-v':
        console.log(`cortex v${PKG_VERSION}`);
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  return args;
}

function printUsage(): void {
  console.log(`
cortex v0.1.0 - Terminal-based coding agent

Usage:
  cortex                          Start interactive session
  cortex --resume [session-id]    Resume last (or specific) session
  cortex --model <model>          Override default model
  cortex --yolo                   Start in YOLO mode
  cortex --help                   Show this help
  cortex --version                Show version
`.trim());
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();

  // Load config
  const config = await loadConfig(cwd);

  // Initialize ProviderManager (once)
  const providerManager = new ProviderManager();

  // Load credentials
  const credentialStore = new CredentialStore();
  const hasProviders = await credentialStore.hasProviders();

  let provider: string;
  let modelId: string;
  let model: Awaited<ReturnType<ProviderManager['resolveModel']>>;

  if (!hasProviders) {
    // No credentials stored: run first-run setup
    const setupResult = await runFirstRunSetup(providerManager, credentialStore);
    provider = setupResult.provider;
    modelId = setupResult.modelId;
    model = setupResult.resolvedModel;
  } else {
    // Resolve from stored credentials
    const defaults = await credentialStore.getDefaults();
    const resolvedProvider = config.defaultProvider ?? defaults.provider;
    if (!resolvedProvider) {
      console.error('No provider configured. Run cortex to set up a provider.');
      process.exit(1);
    }
    provider = resolvedProvider;
    modelId = args.model ?? config.defaultModel ?? defaults.model ?? getDefaultModel(provider);

    // Ollama/custom connections need createCustomModel; standard providers use resolveModel
    const entry = await credentialStore.getProvider(provider);
    if (entry?.method === 'custom' || provider === 'ollama') {
      const baseUrl = entry?.baseUrl ?? 'http://localhost:11434/v1';
      const contextWindow = provider === 'ollama'
        ? await getOllamaContextWindow(getOllamaHost(entry?.baseUrl), modelId) ?? undefined
        : undefined;
      model = await providerManager.createCustomModel({ baseUrl, modelId, contextWindow });
    } else {
      model = await providerManager.resolveModel(provider, modelId);
    }
  }

  // Handle resume
  let resumeSessionId: string | undefined;
  if (args.resume) {
    if (typeof args.resume === 'string') {
      resumeSessionId = args.resume;
    } else {
      // Resume most recent session
      const sessions = await listSessions();
      if (sessions.length > 0 && sessions[0]) {
        resumeSessionId = sessions[0].id;
        console.log(`Resuming session ${resumeSessionId}`);
      } else {
        console.log('No previous sessions found. Starting new session.');
      }
    }
  }

  // Resolve initial effort: CLI config > persisted default > 'medium'
  const VALID_EFFORTS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'max'];
  const persistedEffort = await credentialStore.getDefaultEffort();
  const configEffort = config.defaultEffort as ThinkingLevel | undefined;
  const rawEffort = configEffort ?? persistedEffort ?? 'medium';
  const initialEffort: ThinkingLevel = VALID_EFFORTS.includes(rawEffort as ThinkingLevel)
    ? rawEffort as ThinkingLevel
    : 'medium';

  // Create and start session
  const session = new Session({
    config,
    mode: BUILD_MODE,
    model,
    provider,
    modelId,
    providerManager,
    credentialStore,
    cwd,
    yoloMode: args.yolo,
    initialEffort,
    resumeSessionId,
  });

  await session.start();

  // If resuming, restore conversation history
  if (resumeSessionId) {
    await session.resume(resumeSessionId);
  }
}

/** Get a sensible default model for a provider. */
function getDefaultModel(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'claude-sonnet-4-6';
    case 'openai': return 'gpt-4.1';
    case 'google': return 'gemini-2.5-flash';
    case 'xai': return 'grok-3';
    case 'groq': return 'llama-3.3-70b-versatile';
    default: return 'claude-sonnet-4-6';
  }
}

// Run
main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
