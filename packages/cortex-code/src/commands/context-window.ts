import { SelectList, type SelectItem } from '@mariozechner/pi-tui';
import type { Command } from './index.js';
import { selectListTheme } from '../tui/theme.js';
import { OverlayBox } from '../tui/overlay-box.js';

export const contextWindowCommand: Command = {
  name: 'context-window',
  description: 'Adjust context window limit',
  handler: async (session) => {
    const agent = session.getAgent();
    const app = session.getApp();
    if (!agent || !app) return;

    const maxWindow = agent.effectiveContextWindow;
    const currentLimit = agent.contextWindowLimit;

    // Build 10% increment options
    const items: SelectItem[] = [];
    for (let pct = 10; pct <= 100; pct += 10) {
      const tokens = Math.round((maxWindow * pct) / 100);
      const label = `${(tokens / 1000).toFixed(0)}k  (${pct}%)`;
      const isCurrent = currentLimit !== null && Math.abs(tokens - currentLimit) < 1000;
      items.push({
        value: String(tokens),
        label: isCurrent ? `${label} \u2190 current` : label,
      });
    }

    const list = new SelectList(items, 10, selectListTheme);
    const overlayBox = new OverlayBox(list, 'Context Window Limit');
    const handle = app.tui.showOverlay(overlayBox, {
      anchor: 'center',
      width: '50%',
      maxHeight: 16,
    });

    list.onSelect = (item) => {
      const limit = parseInt(item.value, 10);
      agent.setContextWindowLimit(limit);
      handle.hide();
      app.updateStatus({ tokenLimit: limit });
      app.transcript.addNotification(
        'Context Window',
        `Limit set to ${(limit / 1000).toFixed(0)}k tokens`,
      );
    };

    list.onCancel = () => {
      handle.hide();
    };
  },
};
