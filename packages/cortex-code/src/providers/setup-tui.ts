/**
 * TUI renderer for the provider setup flow.
 *
 * The core rendering logic lives in SetupRenderer, which accepts a Container
 * and TUI instance. Two entry points use it:
 * - runFirstRunSetup(): creates a standalone TUI for the first-run full-screen flow
 * - runSetupInOverlay(): renders inside an overlay of an existing TUI (for /login)
 */

import {
  TuiMainScreen,
  type TUI,
  ProcessTerminal,
  Container,
  Text,
  Spacer,
  SelectList,
  Input,
  Loader,
  Box,
  type Component,
  type SelectItem,
  type OverlayHandle,
  matchesKey,
  Key,
} from '@earendil-works/pi-tui';
import { ProviderManager, type CortexModel, PROVIDER_REGISTRY, OAUTH_PROVIDER_IDS } from '@animus-labs/cortex';
import { ProviderSetupFlow, type SetupResult, type SetupStep } from './setup.js';
import { detectOllama, getOllamaContextWindow, getOllamaHost } from './ollama.js';
import { CredentialStore, type CredentialEntry } from '../config/credentials.js';
import { renderOAuthCallbackPage } from './oauth-callback-page.js';
import { colors, selectListTheme } from '../tui/theme.js';
import { addSplitFlapBoard } from '../tui/split-flap.js';
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
    /**
     * How to focus an inner component. Defaults to tui.setFocus (correct for
     * the standalone first-run TUI). The in-session overlay injects a variant
     * that keeps focus on the OverlayBox and routes input through it, since
     * pi-tui won't dispatch input to an overlay's detached children.
     */
    private focusComponent?: (component: Component) => void,
  ) {
    this.flow = flow;
  }

  start(): void {
    this.renderStep(this.flow.getCurrentStep());
  }

  /** Focus an inner setup component via the injected strategy (or tui directly). */
  private focus(component: Component): void {
    if (this.focusComponent) {
      this.focusComponent(component);
    } else {
      this.tui.setFocus(component);
    }
    this.paint();
  }

  /**
   * Schedule a repaint.
   *
   * Mutating a Container does not schedule one, and neither does setFocus:
   * pi-tui repaints on keystrokes and on whatever component asks. Every step
   * of this flow that lands from a promise (OAuth returning, a key validating,
   * an endpoint answering) therefore paints nothing on its own, and the last
   * frame a Loader animated stays on screen. That is how a completed OAuth
   * login looked frozen on "Exchanging authorization code for tokens...": the
   * model list was live and focused underneath it, one repaint away.
   *
   * So every method here that touches the container ends with this call,
   * including the synchronous ones, where it is redundant but cheap: a
   * requestRender that nothing needs coalesces into the frame the keystroke
   * was already going to draw.
   */
  private paint(): void {
    this.tui.requestRender();
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
        this.focus(list);
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
        this.focus(input);
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
              this.paint();

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
              this.paint();
              setTimeout(() => {
                this.flow.goBack();
                this.renderStep(this.flow.goBack());
              }, 2000);
            }
          }).catch(() => {
            loader.stop();
            this.contentContainer.clear();
            this.contentContainer.addChild(new Text(`  ${colors.error('\u2717')} Validation failed`, 0, 0));
            this.paint();
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
          onAuth: ({ url, instructions }) => {
            loader.setMessage(instructions ?? `Opening browser...`);
            import('node:child_process').then(cp => {
              const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
              cp.execFile(cmd, [url], () => {});
            });
          },
          onPrompt: async (prompt) => this.promptOAuthText(prompt.message, loader, prompt.allowEmpty ?? false),
          onManualCodeInput: async () => this.awaitManualCodeOnDemand(loader),
          onSelect: async (prompt) => this.promptOAuthSelect(prompt, loader),
          onProgress: (message) => {
            loader.setMessage(message);
          },
          renderCallbackPage: renderOAuthCallbackPage,
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
          this.paint();

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
          this.paint();
          setTimeout(() => {
            this.flow.goBack();
            this.renderStep(this.flow.goBack());
          }, 2000);
        });
        break;
      }

      case 'custom-entry': {
        this.contentContainer.addChild(new Text(`  ${colors.white('Base URL:')}`, 0, 0));
        this.contentContainer.addChild(new Spacer(1));
        const urlInput = new Input();
        urlInput.handleInput = (data: string) => {
          if (matchesKey(data, Key.enter)) {
            const text = (urlInput as unknown as { text: string }).text?.trim();
            if (text) {
              this.customBaseUrl = text;
              // Base URL captured; collect the API key before validating.
              this.renderCustomApiKeyEntry();
            }
          } else if (matchesKey(data, Key.escape)) {
            this.renderStep(this.flow.goBack());
          } else {
            Input.prototype.handleInput.call(urlInput, data);
          }
        };
        this.contentContainer.addChild(urlInput);
        this.focus(urlInput);
        break;
      }

      case 'custom-validation': {
        // pi-tui Loader auto-starts in its constructor.
        const loader = new Loader(this.tui, colors.primary, colors.muted, 'Testing connection...');
        this.contentContainer.addChild(loader);

        this.providerManager.createCustomModel({
          baseUrl: this.customBaseUrl ?? '',
          modelId: 'default',
          ...(this.customApiKey ? { apiKey: this.customApiKey } : {}),
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

          // Carry the connection details into the flow so the completed result
          // resolves against this endpoint (not the Ollama fallback).
          this.flow.setCustomConnection(this.customBaseUrl ?? '', this.customApiKey ?? undefined);

          this.contentContainer.clear();
          this.contentContainer.addChild(new Text(`  ${colors.success('\u2713')} Connected`, 0, 0));
          this.contentContainer.addChild(new Spacer(1));
          this.paint();

          // Advance to model selection and populate it from the endpoint's
          // /models listing. If the endpoint advertises none, fall back to a
          // free-text model entry so setup can still complete.
          const modelStep = this.flow.advance('valid');
          const modelIds = await listCustomEndpointModels(
            this.customBaseUrl ?? '',
            this.customApiKey ?? undefined,
          );
          if (modelIds.length > 0) {
            modelStep.options = modelIds.map(id => ({ value: id, label: id }));
            this.renderStep(modelStep);
          } else {
            this.renderCustomModelEntry();
          }
        }).catch(() => {
          loader.stop();
          this.contentContainer.clear();
          this.contentContainer.addChild(new Text(`  ${colors.error('\u2717')} Connection failed`, 0, 0));
          this.paint();
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

  /**
   * Second step of the custom tier: collect the API key (optional; many local
   * OpenAI-compatible servers are keyless), then advance to validation.
   */
  private renderCustomApiKeyEntry(): void {
    this.contentContainer.clear();
    this.contentContainer.addChild(new Text(`  ${colors.white('API key (leave blank if not required):')}`, 0, 0));
    this.contentContainer.addChild(new Spacer(1));

    const input = new Input();
    input.handleInput = (data: string) => {
      if (matchesKey(data, Key.enter)) {
        const text = (input as unknown as { text: string }).text?.trim() ?? '';
        this.customApiKey = text.length > 0 ? text : null;
        this.flow.advance(text); // custom-entry -> custom-validation
        this.handleStep({
          type: 'custom-validation',
          loading: true,
          message: 'Testing connection...',
        });
      } else if (matchesKey(data, Key.escape)) {
        // Back to the base-URL entry.
        this.renderStep(this.flow.getCurrentStep());
      } else {
        Input.prototype.handleInput.call(input, data);
      }
    };
    this.contentContainer.addChild(input);
    // Through focus(), not tui.setFocus(): in the overlay, focusing an inner
    // child directly gets redirected back to the OverlayBox and the input is
    // dropped. Same reason every other step in this flow uses focus().
    this.focus(input);
  }

  /**
   * Fallback model entry for custom endpoints that do not advertise a /models
   * listing. Lets the operator type the model id so setup can complete.
   */
  private renderCustomModelEntry(): void {
    this.contentContainer.clear();
    this.contentContainer.addChild(new Text(`  ${colors.white('Model ID:')}`, 0, 0));
    this.contentContainer.addChild(new Spacer(1));

    const input = new Input();
    input.handleInput = (data: string) => {
      if (matchesKey(data, Key.enter)) {
        const text = (input as unknown as { text: string }).text?.trim();
        if (text) {
          // flow is at model-selection; advancing produces the complete result.
          this.handleStep(this.flow.advance(text));
        }
      } else {
        Input.prototype.handleInput.call(input, data);
      }
    };
    this.contentContainer.addChild(input);
    this.focus(input);
  }

  /**
   * Manual-code fallback for OAuth, surfaced on demand instead of forced.
   *
   * pi-ai invokes this callback the moment the flow starts and races it against
   * the localhost callback server (see loginAnthropic in pi-ai). On the same
   * machine the callback captures the code automatically and this promise stays
   * pending forever (harmless). So we must NOT immediately render a paste field,
   * or every login would demand a manual paste even though the browser callback
   * already handles it. Instead we keep the "waiting" loader visible and only
   * reveal the paste input when the user presses 'p' (needed when the browser is
   * on another machine and the localhost callback can't reach back).
   */
  private awaitManualCodeOnDemand(loader: Loader): Promise<string> {
    // Loader has no typed handleInput, but the TUI dispatches keystrokes to
    // whatever component is focused, so we attach one to catch the reveal key.
    const keyTarget = loader as unknown as { handleInput?: (data: string) => void };
    return new Promise<string>((resolve) => {
      const armRevealKey = () => {
        loader.setMessage("Waiting for browser...  (on another machine? press 'p' to paste the URL)");
        this.focus(loader);
        keyTarget.handleInput = (data: string) => {
          if (data !== 'p' && data !== 'P') return;
          keyTarget.handleInput = () => {};
          void this.promptOAuthText("Paste the full redirect URL from your browser's address bar:", loader, false)
            .then((input) => {
              // Empty means the user backed out (Esc); keep waiting for the
              // browser callback and let them retry the manual path with 'p'.
              if (input) resolve(input);
              else armRevealKey();
            });
        };
      };
      armRevealKey();
    });
  }

  private promptOAuthText(message: string, loader: Loader, allowEmpty: boolean): Promise<string> {
    this.contentContainer.clear();
    this.contentContainer.addChild(new Text(`  ${colors.white(message)}`, 0, 0));
    this.contentContainer.addChild(new Spacer(1));

    const input = new Input();
    this.contentContainer.addChild(input);
    this.focus(input);

    return new Promise<string>((resolve) => {
      input.handleInput = (data: string) => {
        if (matchesKey(data, Key.enter)) {
          const text = (input as unknown as { text: string }).text?.trim() ?? '';
          if (text || allowEmpty) {
            this.contentContainer.clear();
            this.contentContainer.addChild(loader);
            this.paint();
            resolve(text);
          }
        } else if (matchesKey(data, Key.escape)) {
          this.contentContainer.clear();
          this.contentContainer.addChild(loader);
          this.paint();
          resolve('');
        } else {
          Input.prototype.handleInput.call(input, data);
        }
      };
    });
  }

  private promptOAuthSelect(
    prompt: { message: string; options: Array<{ id: string; label: string }> },
    loader: Loader,
  ): Promise<string | undefined> {
    this.contentContainer.clear();
    this.contentContainer.addChild(new Text(`  ${colors.white(prompt.message)}`, 0, 0));
    this.contentContainer.addChild(new Spacer(1));

    const items: SelectItem[] = prompt.options.map(option => ({
      value: option.id,
      label: option.label,
    }));
    const list = new SelectList(items, Math.min(items.length, 10), selectListTheme);
    this.contentContainer.addChild(list);
    this.focus(list);

    return new Promise<string | undefined>((resolve) => {
      list.onSelect = (item) => {
        this.contentContainer.clear();
        this.contentContainer.addChild(loader);
        this.paint();
        resolve(item.value);
      };
      list.onCancel = () => {
        this.contentContainer.clear();
        this.contentContainer.addChild(loader);
        this.paint();
        resolve(undefined);
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Helper: enumerate models from a custom OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

/**
 * Query GET {baseUrl}/models on an OpenAI-compatible endpoint and return the
 * advertised model ids. Best-effort: any failure (unreachable, non-JSON, no
 * /models route) yields an empty list, and the caller falls back to manual
 * model entry.
 */
async function listCustomEndpointModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  if (!baseUrl) return [];
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return [];
    const json = await res.json() as { data?: Array<{ id?: unknown }> };
    return (json.data ?? [])
      .map(m => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
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
    // Ollama and custom connections use createCustomModel with a base URL.
    // For Ollama, query the model's real trained context length so we don't
    // fall back to createCustomModel's generic 128k default (which overflows
    // small-context local models). Mirrors the stored-credentials path in index.ts.
    const baseUrl = result.baseUrl ?? 'http://localhost:11434/v1';
    const contextWindow = result.provider === 'ollama'
      ? await getOllamaContextWindow(getOllamaHost(result.baseUrl), result.model) ?? undefined
      : undefined;
    return providerManager.createCustomModel({
      baseUrl,
      modelId: result.model,
      contextWindow,
      ...(result.apiKey ? { apiKey: result.apiKey } : {}),
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
  const tui = new TuiMainScreen(terminal);
  const mainContainer = new Container();
  tui.addChild(mainContainer);

  // Banner: the wordmark as a settled split-flap board, then a terse prompt.
  mainContainer.addChild(new Text(''));
  addSplitFlapBoard(mainContainer, tui, { animate: false });
  mainContainer.addChild(
    new Text(`\n  ${colors.muted('Connect a provider to get started.')}\n`),
  );

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
          // Same reason as SetupRenderer.paint(): this lands from a promise,
          // and nothing else schedules a frame once the step's loader stopped.
          tui.requestRender();

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
          tui.requestRender();
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
    let settled = false;
    let removeCtrlCListener: (() => void) | undefined;

    const cleanup = () => {
      removeCtrlCListener?.();
      handle.hide();
      tui.hideOverlay(); // Ensure overlay stack is cleared
    };
    const complete = (result: SetupResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    };

    // Escape hatch: while the overlay is up, Ctrl+C dismisses it and returns to
    // the editor. Registered as a TUI input listener so it runs ahead of (and
    // independently of) whichever inner component holds focus. Without this,
    // the only Ctrl+C handler lives on the editor, which does not have focus
    // while the overlay is open, so there is no way to abort the flow.
    removeCtrlCListener = tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl('c'))) {
        log.info('Setup overlay: cancelled via Ctrl+C');
        cancel();
        return { consume: true };
      }
      return undefined;
    });

    const renderer = new SetupRenderer(
      tui,
      innerContent,
      providerManager,
      credentialStore,
      async (result) => {
        log.info('Setup overlay: complete', { provider: result.provider, model: result.model });
        await credentialStore.setDefaults(result.provider, result.model);
        complete(result);
      },
      () => {
        log.info('Setup overlay: cancelled');
        cancel();
      },
      flow,
      // Keep focus on the OverlayBox (the registered overlay component) and let
      // it forward input to the active child. Focusing inner children directly
      // gets redirected back to the overlay by pi-tui, dropping all input.
      (component) => {
        overlayBox.setActiveChild(component);
        tui.setFocus(overlayBox);
      },
    );

    renderer.start();
  });
}
