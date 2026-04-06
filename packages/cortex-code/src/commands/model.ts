import { SelectList, Text, Container, type SelectItem } from '@mariozechner/pi-tui';
import type { Command } from './index.js';
import { selectListTheme, colors } from '../tui/theme.js';
import { OverlayBox } from '../tui/overlay-box.js';
import { CredentialStore } from '../config/credentials.js';
import { detectOllama } from '../providers/ollama.js';
import { log } from '../logger.js';

export const modelCommand: Command = {
  name: 'model',
  description: 'Switch provider and/or model',
  handler: async (session) => {
    const agent = session.getAgent();
    const app = session.getApp();
    if (!agent || !app) return;

    // Build list of available providers from credentials + auto-detected Ollama
    const store = session.getCredentialStore();
    const credFile = await store.load();
    const providerIds = Object.keys(credFile.providers);
    const currentProvider = session.getProvider();
    const currentModelId = session.getModelId();

    // Auto-detect running Ollama and include it even without a credential entry
    if (!providerIds.includes('ollama')) {
      const ollama = await detectOllama();
      if (ollama.running && ollama.models.length > 0) {
        providerIds.push('ollama');
      }
    }

    if (providerIds.length > 1) {
      // Multiple providers: show provider picker first
      await showProviderPicker(session, providerIds, currentProvider, currentModelId);
    } else {
      // Single provider: go straight to model list
      await showModelPicker(session, currentProvider, currentModelId);
    }
  },
};

async function showProviderPicker(
  session: any,
  providerIds: string[],
  currentProvider: string,
  currentModelId: string,
): Promise<void> {
  const app = session.getApp();
  if (!app) return;

  const items: SelectItem[] = providerIds.map(id => {
    const isCurrent = id === currentProvider;
    const item: SelectItem = {
      value: id,
      label: isCurrent ? `${id} \u2190 current` : id,
    };
    return item;
  });

  const list = new SelectList(items, Math.min(items.length, 8), selectListTheme);
  const overlayBox = new OverlayBox(list, 'Select Provider');
  const handle = app.tui.showOverlay(overlayBox, {
    anchor: 'center',
    width: '50%',
    maxHeight: 12,
  });

  return new Promise<void>((resolve) => {
    list.onSelect = async (item) => {
      handle.hide();

      if (item.value === currentProvider) {
        // Same provider: show model picker
        await showModelPicker(session, currentProvider, currentModelId);
      } else {
        // Different provider: switch and show model picker
        await showModelPicker(session, item.value, '');
      }
      app.focusEditor();
      resolve();
    };

    list.onCancel = () => {
      handle.hide();
      app.focusEditor();
      resolve();
    };
  });
}

async function showModelPicker(
  session: any,
  provider: string,
  currentModelId: string,
): Promise<void> {
  const app = session.getApp();
  if (!app) return;

  log.info('/model: fetching models', { provider });
  app.showStatusSpinner('Loading models...');

  // List models for the selected provider
  let models: Array<{ id: string; name: string; contextWindow: number }>;
  try {
    if (provider === 'ollama') {
      // Ollama models come from the local Ollama API, not pi-ai's registry
      const ollama = await detectOllama();
      models = ollama.models.map(m => ({
        id: m.name,
        name: m.details?.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name,
        contextWindow: 128_000,
      }));
    } else {
      const pm = session.getProviderManager();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), 10_000),
      );
      const rawModels = await Promise.race([pm.listModels(provider), timeoutPromise]);
      models = rawModels.map((m: any) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow }));
    }
  } catch (err) {
    log.error('/model: listModels failed', { error: err instanceof Error ? err.message : String(err) });
    models = [];
  }

  app.hideStatusSpinner();
  log.info('/model: got models', { count: models.length });

  if (models.length === 0) {
    app.transcript.addNotification(
      'Model',
      `Could not retrieve model list for ${provider}. Use --model <id> flag at startup.`,
    );
    app.focusEditor();
    return;
  }

  const items: SelectItem[] = models.map(m => {
    const isCurrent = m.id === currentModelId;
    const ctxK = `${(m.contextWindow / 1000).toFixed(0)}k`;
    const item: SelectItem = {
      value: m.id,
      label: isCurrent ? `${m.id} \u2190 current` : m.id,
    };
    if (m.name !== m.id) {
      item.description = `${m.name} (${ctxK})`;
    } else {
      item.description = ctxK;
    }
    return item;
  });

  const list = new SelectList(items, Math.min(items.length, 12), selectListTheme);
  const overlayBox = new OverlayBox(list, `${provider} Models`);
  const handle = app.tui.showOverlay(overlayBox, {
    anchor: 'center',
    width: '60%',
    maxHeight: 18,
  });

  return new Promise<void>((resolve) => {
    list.onSelect = async (item) => {
      handle.hide();
      app.focusEditor();

      const agent = session.getAgent();
      if (!agent) { resolve(); return; }

      if (item.value === currentModelId && provider === session.getProvider()) {
        app.transcript.addNotification('Model', `Already using ${item.value}.`);
        resolve();
        return;
      }

      // Check context window warning
      const selectedModel = models.find(m => m.id === item.value);
      const currentTokens = agent.sessionTokenCount;

      if (selectedModel && currentTokens > selectedModel.contextWindow) {
        await showModelSwitchWarning(session, provider, item.value, currentTokens, selectedModel.contextWindow);
      } else {
        await doModelSwitch(session, provider, item.value);
      }
      resolve();
    };

    list.onCancel = () => {
      handle.hide();
      app.focusEditor();
      resolve();
    };
  });
}

async function showModelSwitchWarning(
  session: any,
  provider: string,
  modelId: string,
  currentTokens: number,
  newContextWindow: number,
): Promise<void> {
  const app = session.getApp();
  if (!app) return;

  const currentK = (currentTokens / 1000).toFixed(1);
  const newK = (newContextWindow / 1000).toFixed(0);

  const warningItems: SelectItem[] = [
    { value: 'compact-first', label: 'Run /compact first, then switch' },
    { value: 'switch-anyway', label: 'Switch anyway (compaction will trigger automatically)' },
    { value: 'cancel', label: 'Cancel' },
  ];

  const container = new Container();
  container.addChild(new Text(
    `Current usage (${currentK}k tokens) exceeds the new model's context window (${newK}k).`,
    0, 0,
  ));
  container.addChild(new Text('', 0, 0));

  const warningList = new SelectList(warningItems, 3, selectListTheme);
  container.addChild(warningList);

  const overlayBox = new OverlayBox(container, 'Warning');
  const warningHandle = app.tui.showOverlay(overlayBox, {
    anchor: 'center',
    width: '65%',
    maxHeight: 12,
  });

  return new Promise<void>((resolve) => {
    warningList.onSelect = async (choice) => {
      warningHandle.hide();
      app.focusEditor();

      switch (choice.value) {
        case 'compact-first': {
          app.showStatusSpinner('Compacting...');
          try {
            await session.getAgent()?.checkAndRunCompaction();
          } catch {
            // Continue anyway
          }
          app.hideStatusSpinner();
          await doModelSwitch(session, provider, modelId);
          break;
        }
        case 'switch-anyway':
          await doModelSwitch(session, provider, modelId);
          break;
        case 'cancel':
          break;
      }
      resolve();
    };

    warningList.onCancel = () => {
      warningHandle.hide();
      app.focusEditor();
      resolve();
    };
  });
}

async function doModelSwitch(session: any, provider: string, modelId: string): Promise<void> {
  const app = session.getApp();
  if (!app) return;

  try {
    if (provider !== session.getProvider()) {
      await session.switchProvider(provider, modelId);
      app.transcript.addNotification('Model', `Switched to ${provider}/${modelId}.`);
    } else {
      await session.switchModel(modelId);
      app.transcript.addNotification('Model', `Switched to ${modelId}.`);
    }
  } catch (err) {
    app.transcript.addNotification(
      'Model Error',
      `Failed to switch: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
