import type { Command } from './index.js';
import { PKG_VERSION } from '../version.js';
import { checkNow } from '../updates/checker.js';

export const updateCommand: Command = {
  name: 'update',
  description: 'Check for a newer Cortex Code version',
  handler: async (session) => {
    const app = session.getApp();
    if (!app) return;

    app.transcript.addNotification('Update', 'Checking for updates...', { severity: 'routine' });

    const info = await checkNow(PKG_VERSION);
    if (!info) {
      app.transcript.addNotification(
        'Update',
        `You're on the latest version (${PKG_VERSION}).`,
        { severity: 'routine' },
      );
      return;
    }

    await session.promptForUpdate(info);
  },
};
