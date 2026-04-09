/**
 * TUI renderer for the provider setup flow.
 *
 * The core rendering logic lives in SetupRenderer, which accepts a Container
 * and TUI instance. Two entry points use it:
 * - runFirstRunSetup(): creates a standalone TUI for the first-run full-screen flow
 * - runSetupInOverlay(): renders inside an overlay of an existing TUI (for /login)
 */

import {
  TUI,
  ProcessTerminal,
  Container,
  Text,
  Spacer,
  SelectList,
  Input,
  Loader,
  Box,
  type SelectItem,
  type OverlayHandle,
  matchesKey,
  Key,
} from '@mariozechner/pi-tui';
import { ProviderManager, type CortexModel, PROVIDER_REGISTRY, OAUTH_PROVIDER_IDS } from '@animus-labs/cortex';
import { ProviderSetupFlow, type SetupResult, type SetupStep } from './setup.js';
import { detectOllama } from './ollama.js';
import { CredentialStore, type CredentialEntry } from '../config/credentials.js';
import { colors, selectListTheme } from '../tui/theme.js';
import { OverlayBox } from '../tui/overlay-box.js';
import { log } from '../logger.js';

export interface SetupTuiResult {
  provider: string;
  model: string;
  modelId: string;
  resolvedModel: CortexModel;
}

// ---------------------------------------------------------------------------
// SetupRenderer: core rendering logic, reusable across contexts
// ---------------------------------------------------------------------------

class SetupRenderer {
  private flow: ProviderSetupFlow;
  private apiKeyInput: string | null = null;
  private customBaseUrl: string | null = null;
  private customApiKey: string | null = null;

  constructor(
    private tui: TUI,
    private contentContainer: Container,
    private providerManager: ProviderManager,
    private credentialStore: CredentialStore,
    private onComplete: (result: SetupResult) => void,
    private onCancel: () => void,
    flow: ProviderSetupFlow,
  ) {
    this.flow = flow;
  }

  start(): void {
    this.renderStep(this.flow.getCurrentStep());
  }

  private renderStep(step: SetupStep): void {
    log.debug('Setup renderer: step', { type: step.type, provider: step.provider });
    this.contentContainer.clear();

    switch (step.type) {
      case 'tier-selection':
      case 'provider-selection':
      case 'ollama-models':
      case 'model-selection': {
        if (step.message) {
          this.contentContainer.addChild(new Text(`  ${colors.white(step.message)}`, 0, 0));
          this.contentContainer.addChild(new Spacer(1));
        }

        const items: SelectItem[] = (step.options ?? []).map(o => {
          const item: SelectItem = { value: o.value, label: o.label };
          if (o.description) item.description = o.description;
          return item;
        });

        const list = new SelectList(items, Math.min(items.length, 12), selectListTheme);
        list.onSelect = (item) => {
          const nextStep = this.flow.advance(item.value);
          this.handleStep(nextStep);
        };
        list.onCancel = () => {
          const currentStep = this.flow.getCurrentStep();
          if (currentStep.type === 'tier-selection') {
            this.onCancel();
          } else {
            this.renderStep(this.flow.goBack());
          }
        };

        this.contentContainer.addChild(list);
        this.tui.setFocus(list);
        break;
      }

      case 'api-key-entry': {
        this.contentContainer.addChild(new Text(`  ${colors.white(step.message ?? 'Enter API key:')}`, 0, 0));
        this.contentContainer.addChild(new Spacer(1));

        const input = new Input();
        input.handleInput = (data: string) => {
          if (matchesKey(data, Key.enter)) {
            const text = (input as unknown as { text: string }).text?.trim();
            if (text) {
              this.apiKeyInput = text;
              const nextStep = this.flow.advance(text);
              this.handleStep(nextStep);
            }
          } else if (matchesKey(data, Key.escape)) {
            this.renderStep(this.flow.goBack());
          } else {
            Input.prototype.handleInput.call(input, data);
          }
        };

        this.contentContainer.addChild(input);
        this.tui.setFocus(input);
        break;
      }

      case 'api-key-validation': {
        // pi-tui Loader auto-starts in its constructor.
        const loader = new Loader(this.tui, colors.primary, colors.muted, step.message ?? 'Validating...');
        this.contentContainer.addChild(loader);

        const provider = step.provider ?? '';
        if (this.apiKeyInput) {
          this.providerManager.validateApiKey(provider, this.apiKeyInput).then(async (result) => {
            loader.stop();
            if (result.status === 'valid') {
              const entry: CredentialEntry = {
                provider,
                method: 'api_key',
                apiKey: this.apiKeyInput!,
                addedAt: Date.now(),
              };
              await this.credentialStore.setProvider(provider, entry);

              this.contentContainer.clear();
              this.contentContainer.addChild(new Text(`  ${colors.success('\u2713')} Connected to ${provider}`, 0, 0));
              this.contentContainer.addChild(new Spacer(1));

              try {
                const models = await this.providerManager.listModels(provider);
                const modelStep = this.flow.advance('valid');
                modelStep.options = models.map(m => {
                  const opt: { value: string; label: string; description?: string } = { value: m.id, label: m.id };
                  if (m.name !== m.id) opt.description = m.name;
                  return opt;
                });
                this.renderStep(modelStep);
              } catch {
                const modelStep = this.flow.advance('valid');
                this.renderStep(modelStep);
              }
            } else {
              this.contentContainer.clear();
              this.contentContainer.addChild(new Text(`  ${colors.error('\u2717')} Invalid API key: ${result.message ?? 'validation failed'}`, 0, 0));
              setTimeout(() => {
                this.flow.goBack();
                this.renderStep(this.flow.goBack());
              }, 2000);
            }
          }).catch(() => {
            loader.stop();
            this.contentContainer.clear();
            this.contentContainer.addChild(new Text(`  ${colors.error('\u2717')} Validation failed`, 0, 0));
            setTimeout(() => {
              this.flow.goBack();
              this.renderStep(this.flow.goBack());
            }, 2000);
          });
        }
        break;
      }

      case 'oauth-auth': {
        // pi-tui Loader auto-starts in its constructor.
        const loader = new Loader(this.tui, colors.primary, colors.muted, step.message ?? 'Waiting for browser...');
        this.contentContainer.addChild(loader);

        const provider = step.provider ?? '';
        this.providerManager.initiateOAuth(provider, {
          onAuth: (urlOrInfo: string | { url: string; instructions?: string }) => {
            const url = typeof urlOrInfo === 'string' ? urlOrInfo : urlOrInfo.url;
            const instructions = typeof urlOrInfo === 'object' ? urlOrInfo.instructions : undefined;
            loader.setMessage(instructions ?? `Opening browser...`);
            import('node:child_process').then(cp => {
              const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
              cp.execFile(cmd, [url], () => {});
            });
          },
          onPrompt: async (prompt) => {
            loader.setMessage(prompt.message);
            return '';
          },
          onProgress: (message) => {
            loader.setMessage(message);
          },
        }).then(async (result) => {
          loader.stop();

          const entry: CredentialEntry = {
            provider,
            method: 'oauth',
            oauthCredentials: result.credentials,
            oauthMeta: result.meta,
            addedAt: Date.now(),
          };
          await this.credentialStore.setProvider(provider, entry);

          this.contentContainer.clear();
          this.contentContainer.addChild(new Text(`  ${colors.success('\u2713')} Signed in to ${provider}`, 0, 0));
          this.contentContainer.addChild(new Spacer(1));

          try {
            const models = await this.providerManager.listModels(provider);
            const modelStep = this.flow.advance('oauth-complete');
            modelStep.options = models.map(m => {
              const opt: { value: string; label: string; description?: string } = { value: m.id, label: m.id };
              if (m.name !== m.id) opt.description = m.name;
              return opt;
            });
            this.renderStep(modelStep);
          } catch {
            const modelStep = this.flow.advance('oauth-complete');
            this.renderStep(modelStep);
          }
        }).catch((err) => {
          loader.stop();
          this.contentContainer.clear();
          this.contentContainer.addChild(new Text(
            `  ${colors.error('\u2717')} OAuth failed: ${err instanceof Error ? err.message : String(err)}`,
            0, 0,
          ));
          setTimeout(() => {
            this.flow.goBack();
            this.renderStep(this.flow.goBack());
          }, 2000);
        });
        break;
      }

      case 'custom-entry': {
        this.contentContainer.addChild(new Text(`  ${colors.white('Base URL:')}`, 0, 0));
        const urlInput = new Input();
        urlInput.handleInput = (data: string) => {
          if (matchesKey(data, Key.enter)) {
            const text = (urlInput as unknown as { text: string }).text?.trim();
            if (text) {
              this.customBaseUrl = text;
              this.flow.advance(text);
              this.handleStep({
                type: 'custom-validation',
                loading: true,
                message: 'Testing connection...',
              });
            }
          } else if (matchesKey(data, Key.escape)) {
            this.renderStep(this.flow.goBack());
          } else {
            Input.prototype.handleInput.call(urlInput, data);
          }
        };
        this.contentContainer.addChild(urlInput);
        this.tui.setFocus(urlInput);
        break;
      }

      case 'custom-validation': {
        // pi-tui Loader auto-starts in its constructor.
        const loader = new Loader(this.tui, colors.primary, colors.muted, 'Testing connection...');
        this.contentContainer.addChild(loader);

        this.providerManager.createCustomModel({
          baseUrl: this.customBaseUrl ?? '',
          modelId: 'default',
        }).then(async () => {
          loader.stop();
          const entry: CredentialEntry = {
            provider: 'custom',
            method: 'custom',
            connectionName: 'custom',
            addedAt: Date.now(),
          };
          if (this.customBaseUrl) entry.baseUrl = this.customBaseUrl;
          if (this.customApiKey) entry.apiKey = this.customApiKey;
          await this.credentialStore.setProvider('custom', entry);

          this.contentContainer.clear();
          this.contentContainer.addChild(new Text(`  ${colors.success('\u2713')} Connected`, 0, 0));

          const modelStep = this.flow.advance('valid');
          this.renderStep(modelStep);
        }).catch(() => {
          loader.stop();
          this.contentContainer.clear();
          this.contentContainer.addChild(new Text(`  ${colors.error('\u2717')} Connection failed`, 0, 0));
          setTimeout(() => {
            this.flow.goBack();
            this.renderStep(this.flow.goBack());
          }, 2000);
        });
        break;
      }

      case 'complete':
        break;
    }
  }

  private handleStep(step: SetupStep): void {
    if (step.type === 'complete') {
      const result = this.flow.getResult();
      if (result) {
        this.onComplete(result);
      }
    } else {
      this.renderStep(step);
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: create the flow
// ---------------------------------------------------------------------------

async function createFlow(providerManager: ProviderManager): Promise<ProviderSetupFlow> {
  const ollamaStatus = await detectOllama();
  const oauthProviders = OAUTH_PROVIDER_IDS ?? [];
  const apiKeyProviders = PROVIDER_REGISTRY
    .filter(p => p.authMethods?.includes('api_key') ?? true)
    .map(p => ({ id: p.id, envVar: p.envVar ?? `${p.id.toUpperCase()}_API_KEY` }));

  const ollamaModels = ollamaStatus.models.map(m => {
    const entry: { name: string; parameterSize?: string; quantization?: string } = { name: m.name };
    if (m.details?.parameter_size) entry.parameterSize = m.details.parameter_size;
    if (m.details?.quantization_level) entry.quantization = m.details.quantization_level;
    return entry;
  });

  return new ProviderSetupFlow(ollamaStatus.running, oauthProviders, apiKeyProviders, ollamaModels);
}

// ---------------------------------------------------------------------------
// Model resolution: handles standard providers vs Ollama/custom
// ---------------------------------------------------------------------------

async function resolveModelForResult(
  providerManager: ProviderManager,
  result: SetupResult,
): Promise<CortexModel> {
  if (result.method === 'custom' || result.provider === 'ollama') {
    // Ollama and custom connections use createCustomModel with a base URL
    const baseUrl = result.baseUrl ?? 'http://localhost:11434/v1';
    return providerManager.createCustomModel({
      baseUrl,
      modelId: result.model,
    });
  }
  return providerManager.resolveModel(result.provider, result.model);
}

// ---------------------------------------------------------------------------
// Entry point 1: First-run (standalone TUI)
// ---------------------------------------------------------------------------

export async function runFirstRunSetup(
  providerManager: ProviderManager,
  credentialStore: CredentialStore,
): Promise<SetupTuiResult> {
  const flow = await createFlow(providerManager);

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const mainContainer = new Container();
  tui.addChild(mainContainer);

  // Banner
  const banner = [
    '',
    colors.primary('   ██████╗ ██████╗ ██████╗ ████████╗███████╗██╗  ██╗'),
    colors.primary('  ██╔════╝██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝'),
    colors.primary('  ██║     ██║   ██║██████╔╝   ██║   █████╗   ╚███╔╝'),
    colors.primary('  ██║     ██║   ██║██╔══██╗   ██║   ██╔══╝   ██╔██╗'),
    colors.primary('  ╚██████╗╚██████╔╝██║  ██║   ██║   ███████╗██╔╝ ██╗'),
    colors.primary('   ╚═════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝'),
    '',
    `  ${colors.white('Welcome! Let\'s connect to a provider to get started.')}`,
    '',
  ].join('\n');
  mainContainer.addChild(new Text(banner));

  const contentContainer = new Container();
  mainContainer.addChild(contentContainer);

  // Ctrl+C exits
  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl('c'))) {
      tui.stop();
      process.exit(0);
    }
    return undefined;
  });

  tui.start();

  return new Promise<SetupTuiResult>((resolve) => {
    const renderer = new SetupRenderer(
      tui,
      contentContainer,
      providerManager,
      credentialStore,
      async (result: SetupResult) => {
        // Save defaults
        await credentialStore.setDefaults(result.provider, result.model);

        try {
          const resolvedModel = await resolveModelForResult(providerManager, result);

          // Show completion
          contentContainer.clear();
          contentContainer.addChild(new Text([
            `  ${colors.success('\u2713')} Setup complete!`,
            '',
            `  Provider: ${result.provider}`,
            `  Model: ${result.model}`,
            '',
            `  ${colors.muted('You can add more providers later with /login')}`,
            `  ${colors.muted('You can switch models with /model')}`,
          ].join('\n'), 0, 0));

          setTimeout(() => {
            tui.stop();
            // Clear terminal so the main app starts on a clean screen
            process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
            resolve({
              provider: result.provider,
              model: result.model,
              modelId: result.model,
              resolvedModel,
            });
          }, 1500);
        } catch (err) {
          contentContainer.clear();
          contentContainer.addChild(new Text(
            `  ${colors.error('\u2717')} Failed to resolve model: ${err instanceof Error ? err.message : String(err)}`,
            0, 0,
          ));
        }
      },
      () => {
        // Cancel: exit
        tui.stop();
        process.exit(0);
      },
      flow,
    );

    renderer.start();
  });
}

// ---------------------------------------------------------------------------
// Entry point 2: In-session overlay (for /login)
// ---------------------------------------------------------------------------

export async function runSetupInOverlay(
  tui: TUI,
  providerManager: ProviderManager,
  credentialStore: CredentialStore,
): Promise<SetupResult | null> {
  const flow = await createFlow(providerManager);

  const innerContent = new Container();

  const overlayBox = new OverlayBox(innerContent, 'Add a provider');

  const handle = tui.showOverlay(overlayBox, {
    anchor: 'center',
    width: '70%',
    maxHeight: '80%',
  });

  return new Promise<SetupResult | null>((resolve) => {
    const renderer = new SetupRenderer(
      tui,
      innerContent,
      providerManager,
      credentialStore,
      async (result) => {
        log.info('Setup overlay: complete', { provider: result.provider, model: result.model });
        await credentialStore.setDefaults(result.provider, result.model);
        handle.hide();
        tui.hideOverlay(); // Ensure overlay stack is cleared
        resolve(result);
      },
      () => {
        log.info('Setup overlay: cancelled');
        handle.hide();
        tui.hideOverlay();
        resolve(null);
      },
      flow,
    );

    renderer.start();
  });
}
