/**
 * The session's model choice: primary provider and model, the utility model,
 * and thinking effort reconciled against what the current model supports.
 *
 * Owns `provider` and `modelId` for the whole session. Everything else that
 * displays or records them (footer, environment block, session meta, the
 * custom-endpoint credential fallback) reads them from here.
 */

import type { CortexAgent, CortexModel, ProviderManager, ThinkingLevel } from '@animus-labs/cortex';
import type { CortexCodeConfig } from '../config/config.js';
import type { CredentialStore } from '../config/credentials.js';
import { resolveConfiguredModel } from '../providers/model-resolution.js';
import type { App } from '../tui/app.js';
import type { TranscriptManager } from '../tui/transcript.js';
import { log } from '../logger.js';

/** The agent surface model and effort changes go through. */
export type ModelSelectionAgent = Pick<
  CortexAgent,
  | 'setModel'
  | 'setUtilityModel'
  | 'resetUtilityModel'
  | 'getModelThinkingCapabilities'
  | 'clampThinkingLevel'
  | 'setThinkingLevel'
  | 'effectiveContextWindow'
>;

/** The TUI surface model and effort changes report to. */
export type ModelSelectionApp = Pick<App, 'updateStatus'> & {
  transcript: Pick<TranscriptManager, 'addNotification'>;
};

export interface ModelSelectionOptions {
  provider: string;
  modelId: string;
  initialEffort: ThinkingLevel;
  config: CortexCodeConfig;
  providerManager: ProviderManager;
  credentialStore: CredentialStore;
  getAgent: () => ModelSelectionAgent | null;
  getApp: () => ModelSelectionApp | null;
}

export interface EffortReconciliation {
  effective: ThinkingLevel;
  clamped: boolean;
  reason?: string;
}

function formatEffortLabel(level: ThinkingLevel): string {
  return level === 'max'
    ? 'Max'
    : level.charAt(0).toUpperCase() + level.slice(1);
}

export class ModelSelection {
  private currentProvider: string;
  private currentModelId: string;
  /** The user's desired effort level. Persists across model switches within a session. */
  private preferredEffort: ThinkingLevel;
  /** The actual effort level applied to the agent (may differ from preferred due to model limits). */
  private effectiveEffort: ThinkingLevel;
  private readonly config: CortexCodeConfig;
  private readonly providerManager: ProviderManager;
  private readonly credentialStore: CredentialStore;
  private readonly getAgent: () => ModelSelectionAgent | null;
  private readonly getApp: () => ModelSelectionApp | null;

  constructor(options: ModelSelectionOptions) {
    this.currentProvider = options.provider;
    this.currentModelId = options.modelId;
    this.preferredEffort = options.initialEffort;
    this.effectiveEffort = options.initialEffort;
    this.config = options.config;
    this.providerManager = options.providerManager;
    this.credentialStore = options.credentialStore;
    this.getAgent = options.getAgent;
    this.getApp = options.getApp;
  }

  get provider(): string { return this.currentProvider; }
  get modelId(): string { return this.currentModelId; }
  getPreferredEffort(): ThinkingLevel { return this.preferredEffort; }
  getEffectiveEffort(): ThinkingLevel { return this.effectiveEffort; }

  /**
   * Reconcile the preferred effort with the current model's capabilities.
   * Sets the effective effort on the agent and returns whether it was clamped.
   */
  async reconcileEffort(): Promise<EffortReconciliation> {
    const agent = this.getAgent();
    if (!agent) {
      return { effective: this.preferredEffort, clamped: false };
    }

    const caps = await agent.getModelThinkingCapabilities();

    let effective = this.preferredEffort;
    let clamped = false;
    let reason: string | undefined;

    if (!caps.supportedLevels.includes(this.preferredEffort)) {
      effective = await agent.clampThinkingLevel(this.preferredEffort);
      clamped = effective !== this.preferredEffort;
      const preferredLabel = formatEffortLabel(this.preferredEffort);
      const effectiveLabel = formatEffortLabel(effective);
      reason = caps.supportsThinking
        ? `${this.currentModelId} does not support ${preferredLabel} effort. Using ${effectiveLabel}.`
        : `${this.currentModelId} does not support thinking. Using ${effectiveLabel}.`;
    }

    this.effectiveEffort = effective;
    agent.setThinkingLevel(effective);
    const result: EffortReconciliation = { effective, clamped };
    if (reason) result.reason = reason;
    return result;
  }

  /**
   * Set the user's preferred effort level.
   * Reconciles with current model capabilities and applies the effective level.
   */
  async setPreferredEffort(level: ThinkingLevel): Promise<void> {
    this.preferredEffort = level;
    const reconciled = await this.reconcileEffort();
    this.getApp()?.updateStatus({ effortLevel: reconciled.effective });
    this.announceClamp(reconciled);
    // Persist across sessions
    await this.credentialStore.setDefaultEffort(level);
  }

  /** Apply the utility model chosen at launch. Best-effort: a failure is logged, not thrown. */
  async applyInitialUtilityModel(modelId: string): Promise<void> {
    try {
      await this.applyUtilityModel(modelId, false);
    } catch (err) {
      log.warn('Failed to apply initial utility model', {
        provider: this.currentProvider,
        model: modelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async setUtilityModel(modelId: string): Promise<void> {
    await this.applyUtilityModel(modelId, true);
  }

  async resetUtilityModel(): Promise<void> {
    this.getAgent()!.resetUtilityModel();
    await this.credentialStore.setDefaultUtilityModel(this.currentProvider, null);
  }

  /** Switch the primary model. Throws if the model cannot be resolved. */
  async switchModel(modelId: string): Promise<void> {
    const newModel = await this.resolveProviderModel(this.currentProvider, modelId);
    const agent = this.getAgent()!;
    agent.setModel(newModel);
    this.currentModelId = modelId;
    // Reconcile effort with new model's capabilities
    const reconciled = await this.reconcileEffort();
    this.getApp()?.updateStatus({ model: modelId, effortLevel: reconciled.effective, contextTokenLimit: agent.effectiveContextWindow });
    this.announceClamp(reconciled);
    await this.credentialStore.setDefaults(this.currentProvider, modelId);
  }

  /** Switch to a different provider and model. Used by /login after adding a new provider. */
  async switchProvider(newProvider: string, newModelId: string): Promise<void> {
    log.info('Switching provider', { from: this.currentProvider, to: newProvider, model: newModelId });

    const newModel = await this.resolveProviderModel(newProvider, newModelId);

    const agent = this.getAgent()!;
    agent.setModel(newModel);
    this.currentProvider = newProvider;
    this.currentModelId = newModelId;
    await this.applyStoredUtilityModelForProvider(newProvider);
    // Reconcile effort with new model's capabilities
    const reconciled = await this.reconcileEffort();
    this.getApp()?.updateStatus({ provider: newProvider, model: newModelId, effortLevel: reconciled.effective, contextTokenLimit: agent.effectiveContextWindow });
    this.announceClamp(reconciled);
    await this.credentialStore.setDefaults(newProvider, newModelId);
  }

  private announceClamp({ clamped, reason }: EffortReconciliation): void {
    if (clamped && reason) {
      this.getApp()?.transcript.addNotification('Effort', reason);
    }
  }

  private async resolveProviderModel(provider: string, modelId: string): Promise<CortexModel> {
    const entry = await this.credentialStore.getProvider(provider);
    return resolveConfiguredModel(this.providerManager, provider, modelId, entry, this.config.ollama, this.config.contextWindowLimit);
  }

  private async applyUtilityModel(modelId: string, persist: boolean): Promise<void> {
    const utilityModel = await this.resolveProviderModel(this.currentProvider, modelId);
    this.getAgent()!.setUtilityModel(utilityModel);
    if (persist) {
      await this.credentialStore.setDefaultUtilityModel(this.currentProvider, modelId);
    }
  }

  private async applyStoredUtilityModelForProvider(provider: string): Promise<void> {
    const utilityModelId = this.config.defaultUtilityModel
      ?? await this.credentialStore.getDefaultUtilityModel(provider);
    if (!utilityModelId) {
      this.getAgent()!.resetUtilityModel();
      return;
    }

    try {
      await this.applyUtilityModel(utilityModelId, false);
    } catch (err) {
      this.getAgent()!.resetUtilityModel();
      log.warn('Failed to apply stored utility model', {
        provider,
        model: utilityModelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
