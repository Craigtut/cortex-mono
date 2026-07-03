/**
 * First-run provider setup state machine.
 * Logic only, no rendering. The TUI drives this by calling getCurrentStep()
 * to present each step and advance(input) to move forward.
 */

export type SetupTier = 'oauth' | 'api_key' | 'ollama' | 'custom';

export type SetupStepType =
  | 'tier-selection'
  | 'provider-selection'
  | 'oauth-auth'
  | 'api-key-entry'
  | 'api-key-validation'
  | 'ollama-models'
  | 'custom-entry'
  | 'custom-validation'
  | 'model-selection'
  | 'complete';

export interface SetupStep {
  type: SetupStepType;
  tier?: SetupTier;
  provider?: string;
  /** Options for selection steps. */
  options?: Array<{ value: string; label: string; description?: string }>;
  /** Message for display steps. */
  message?: string;
  /** Whether this step is waiting for an async operation. */
  loading?: boolean;
}

export interface SetupResult {
  provider: string;
  method: 'oauth' | 'api_key' | 'custom';
  model: string;
  apiKey?: string;
  oauthCredentials?: string;
  baseUrl?: string;
  connectionName?: string;
}

export class ProviderSetupFlow {
  private currentStep: SetupStep;
  private tier: SetupTier | null = null;
  private provider: string | null = null;
  private model: string | null = null;
  private result: SetupResult | null = null;
  private history: SetupStep[] = [];
  private customBaseUrl: string | null = null;
  private customApiKey: string | null = null;

  constructor(
    private ollamaDetected: boolean,
    private oauthProviders: string[],
    private apiKeyProviders: Array<{ id: string; envVar: string }>,
    private ollamaModels: Array<{ name: string; parameterSize?: string; quantization?: string }> = [],
  ) {
    this.currentStep = this.buildTierSelection();
  }

  getCurrentStep(): SetupStep {
    return this.currentStep;
  }

  getResult(): SetupResult | null {
    return this.result;
  }

  /**
   * Record the custom-endpoint connection details captured by the renderer so
   * they can be threaded into the final result. The custom tier has no static
   * provider entry, so baseUrl (and any API key) must be carried explicitly.
   */
  setCustomConnection(baseUrl: string, apiKey?: string): void {
    this.customBaseUrl = baseUrl;
    this.customApiKey = apiKey && apiKey.length > 0 ? apiKey : null;
  }

  isComplete(): boolean {
    return this.currentStep.type === 'complete';
  }

  /**
   * Advance the flow with user input.
   * Returns the next step to display.
   */
  advance(input: string): SetupStep {
    this.history.push({ ...this.currentStep });

    switch (this.currentStep.type) {
      case 'tier-selection':
        this.tier = input as SetupTier;
        this.currentStep = this.buildProviderSelection();
        break;

      case 'provider-selection':
        this.provider = input;
        this.currentStep = this.buildAuthStep();
        break;

      case 'api-key-entry':
        // Input is the API key; next step is validation
        this.currentStep = {
          type: 'api-key-validation',
          tier: this.tier!,
          provider: this.provider!,
          loading: true,
          message: 'Validating...',
        };
        break;

      case 'api-key-validation':
        // Validation complete; move to model selection
        this.currentStep = {
          type: 'model-selection',
          provider: this.provider!,
          message: 'Select a primary model:',
        };
        break;

      case 'oauth-auth':
        // OAuth complete; move to model selection
        this.currentStep = {
          type: 'model-selection',
          provider: this.provider!,
          message: 'Select a primary model:',
        };
        break;

      case 'ollama-models':
        this.model = input;
        this.result = {
          provider: 'ollama',
          method: 'custom',
          model: input,
          baseUrl: process.env['OLLAMA_HOST'] ?? 'http://localhost:11434/v1',
        };
        this.currentStep = { type: 'complete' };
        break;

      case 'custom-entry':
        // Input is JSON with baseUrl, apiKey, connectionName
        this.currentStep = {
          type: 'custom-validation',
          loading: true,
          message: 'Testing connection...',
        };
        break;

      case 'custom-validation':
        this.currentStep = {
          type: 'model-selection',
          provider: this.provider!,
          message: 'Select a model:',
        };
        break;

      case 'model-selection': {
        this.model = input;
        const result: SetupResult = {
          provider: this.provider!,
          method: this.tier === 'oauth' ? 'oauth' : this.tier === 'custom' ? 'custom' : 'api_key',
          model: input,
        };
        // Custom endpoints have no registry entry, so carry the connection
        // details through to model resolution and credential storage.
        if (this.tier === 'custom') {
          if (this.customBaseUrl) result.baseUrl = this.customBaseUrl;
          if (this.customApiKey) result.apiKey = this.customApiKey;
        }
        this.result = result;
        this.currentStep = { type: 'complete' };
        break;
      }
    }

    return this.currentStep;
  }

  /** Go back to the previous step. */
  goBack(): SetupStep {
    const prev = this.history.pop();
    if (prev) {
      this.currentStep = prev;
    }
    return this.currentStep;
  }

  private buildTierSelection(): SetupStep {
    const options = [
      { value: 'oauth', label: 'Sign in with OAuth', description: '(quickest)' },
      { value: 'api_key', label: 'Enter an API key', description: '' },
    ];

    if (this.ollamaDetected) {
      options.push({ value: 'ollama', label: 'Connect to Ollama', description: '(local, detected)' });
    } else {
      options.push({ value: 'ollama', label: 'Connect to Ollama', description: '(local)' });
    }

    options.push({ value: 'custom', label: 'Custom connection', description: '' });

    return { type: 'tier-selection', options };
  }

  private buildProviderSelection(): SetupStep {
    switch (this.tier) {
      case 'oauth':
        return {
          type: 'provider-selection',
          tier: 'oauth',
          options: this.oauthProviders.map(p => ({
            value: p,
            label: p.charAt(0).toUpperCase() + p.slice(1),
          })),
        };

      case 'api_key':
        return {
          type: 'provider-selection',
          tier: 'api_key',
          options: this.apiKeyProviders.map(p => ({
            value: p.id,
            label: p.id.charAt(0).toUpperCase() + p.id.slice(1),
            description: p.envVar,
          })),
        };

      case 'ollama':
        return {
          type: 'ollama-models',
          tier: 'ollama',
          provider: 'ollama',
          message: 'Select a model:',
          options: this.ollamaModels.map(m => {
            const details = [m.parameterSize, m.quantization].filter(Boolean).join(', ');
            const opt: { value: string; label: string; description?: string } = {
              value: m.name,
              label: m.name,
            };
            if (details) opt.description = details;
            return opt;
          }),
        };

      case 'custom':
        // The custom tier skips provider-selection, so pin the provider id here
        // (used for the model-selection step and the final result).
        this.provider = 'custom';
        return {
          type: 'custom-entry',
          tier: 'custom',
          message: 'Enter connection details:',
        };

      default:
        return this.buildTierSelection();
    }
  }

  private buildAuthStep(): SetupStep {
    switch (this.tier) {
      case 'oauth':
        return {
          type: 'oauth-auth',
          tier: 'oauth',
          provider: this.provider!,
          loading: true,
          message: 'Opening browser for authentication...',
        };

      case 'api_key':
        return {
          type: 'api-key-entry',
          tier: 'api_key',
          provider: this.provider!,
          message: `Enter your ${this.provider} API key:`,
        };

      default:
        return this.buildTierSelection();
    }
  }
}
