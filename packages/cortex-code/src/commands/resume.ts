import { SelectList, type SelectItem } from '@mariozechner/pi-tui';
import type { Command } from './index.js';
import { listSessions } from '../persistence/sessions.js';
import { selectListTheme } from '../tui/theme.js';
import { OverlayBox } from '../tui/overlay-box.js';

export const resumeCommand: Command = {
  name: 'resume',
  description: 'Resume a previous session',
  handler: async (session) => {
    const app = session.getApp();
    if (!app) return;

    const sessions = await listSessions();
    if (sessions.length === 0) {
      app.transcript.addNotification('Resume', 'No previous sessions found.');
      return;
    }

    const items: SelectItem[] = sessions.slice(0, 20).map(s => {
      const date = new Date(s.updatedAt).toLocaleDateString();
      const time = new Date(s.updatedAt).toLocaleTimeString();
      return {
        value: s.id,
        label: `${s.mode} - ${s.model}`,
        description: `${date} ${time} (${(s.tokenCount / 1000).toFixed(1)}k tokens)`,
      };
    });

    const list = new SelectList(items, Math.min(items.length, 10), selectListTheme);
    const overlayBox = new OverlayBox(list, 'Resume Session');
    const handle = app.tui.showOverlay(overlayBox, {
      anchor: 'center',
      width: '70%',
      maxHeight: 16,
    });

    list.onSelect = async (item) => {
      handle.hide();
      await session.resume(item.value);
    };

    list.onCancel = () => {
      handle.hide();
    };
  },
};
