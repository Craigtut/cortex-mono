import { SelectList, type SelectItem } from '@mariozechner/pi-tui';
import type { Command } from './index.js';
import { CredentialStore } from '../config/credentials.js';
import { selectListTheme } from '../tui/theme.js';
import { OverlayBox } from '../tui/overlay-box.js';

export const logoutCommand: Command = {
  name: 'logout',
  description: 'Remove provider credentials',
  handler: async (session) => {
    const app = session.getApp();
    if (!app) return;

    const store = new CredentialStore();
    const file = await store.load();
    const providerIds = Object.keys(file.providers);

    if (providerIds.length === 0) {
      app.transcript.addNotification('Logout', 'No providers configured.');
      return;
    }

    const items: SelectItem[] = providerIds.map(id => {
      const entry = file.providers[id]!;
      return {
        value: id,
        label: id.charAt(0).toUpperCase() + id.slice(1),
        description: `(${entry.method})`,
      };
    });

    const list = new SelectList(items, Math.min(items.length, 8), selectListTheme);
    const overlayBox = new OverlayBox(list, 'Remove Provider');
    const handle = app.tui.showOverlay(overlayBox, {
      anchor: 'center',
      width: '50%',
      maxHeight: 14,
    });

    list.onSelect = async (item) => {
      handle.hide();
      await store.removeProvider(item.value);
      app.transcript.addNotification('Logout', `Removed credentials for ${item.value}.`);
    };

    list.onCancel = () => {
      handle.hide();
    };
  },
};
