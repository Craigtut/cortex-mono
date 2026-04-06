import type { Command } from './index.js';
import { runSetupInOverlay } from '../providers/setup-tui.js';
import { log } from '../logger.js';

export const loginCommand: Command = {
  name: 'login',
  description: 'Add a provider',
  handler: async (session) => {
    const app = session.getApp();
    if (!app) return;

    log.info('/login: starting setup overlay');
    try {
      const result = await runSetupInOverlay(
        app.tui,
        session.getProviderManager(),
        session.getCredentialStore(),
      );

      log.info('/login: overlay completed', { result: result ? result.provider : 'cancelled' });

      if (result) {
        // Switch the active agent to the new provider and model
        try {
          await session.switchProvider(result.provider, result.model);
          app.transcript.addNotification(
            'Provider Added',
            `Switched to ${result.provider}/${result.model}.`,
          );
        } catch (err) {
          log.error('/login: switch failed', { error: err instanceof Error ? err.message : String(err) });
          app.transcript.addNotification(
            'Provider Added',
            `Connected to ${result.provider} with model ${result.model}.\nNote: Could not switch active model. Use /model to switch manually.`,
          );
        }
        app.refreshCommands(session.getCwd());
      }
    } catch (err) {
      log.error('/login: error', { error: err instanceof Error ? err.message : String(err) });
      app.transcript.addNotification('Login Error', err instanceof Error ? err.message : String(err));
    }

    // Ensure focus returns to editor after overlay
    app.focusEditor();
  },
};
